// Runs the app against a throwaway home: its own config.json and user data, fake demo accounts, launching disabled.
// Nothing touches your real ~/.config/claude-accounts, the app's settings, or Claude itself. It builds the app first,
// so what opens is the current source.
//
//   npm run sandbox [-- --empty] [-- --light|--dark]     open it and click through
//
//   import { launch } from './scripts/sandbox.ts';       drive it with Playwright (see .claude/skills/run-app)
//   const { app, page, home } = await launch({ theme: 'light' });
//   await page.screenshot({ path: 'repos.png' }); await app.close();
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { build } from './build.ts';

const ROOT = path.join(import.meta.dirname, '..');
// Required from Node, the electron package gives the path of its binary.
const ELECTRON = createRequire(import.meta.url)('electron') as string;
type Theme = 'dark' | 'light';

// A fresh sandbox folder (a given `dir` is emptied first); with `demo`, scripts/demo-config.sh fills it with fake
// repositories and accounts.
export function prepare({ demo = true, dir, theme }: { demo?: boolean; dir?: string; theme?: Theme } = {}) {
  if (dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
  else dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-sandbox-'));
  // Repository paths are saved resolved, and macOS keeps temp folders behind a symlink (/var -> /private/var):
  // HOME has to be the resolved path too, or the app can't show them as ~/code/...
  dir = fs.realpathSync(dir);
  if (demo) execFileSync(path.join(import.meta.dirname, 'demo-config.sh'), [dir], { stdio: 'ignore' });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CA_NO_LAUNCH: '1',
                       CA_CONFIG: path.join(home, '.config', 'claude-accounts', 'config.json') });
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CA_ACCOUNT', 'CA_THEME', 'CA_PREVIEW_PLATFORM']) delete env[k];
  if (theme) env.CA_THEME = theme;
  return { dir, home, env, args: [ROOT, `--user-data-dir=${path.join(dir, 'user-data')}`] };
}

// Builds the app, launches it under Playwright and waits for the first view. `preview` draws the macOS window chrome
// into the page (screenshots leave out the real traffic lights) and, on Linux, renders the macOS layout under Xvfb.
interface LaunchOptions { demo?: boolean; theme?: Theme; dir?: string; preview?: boolean; args?: string[] }
export async function launch({ demo = true, theme = 'dark', dir, preview = false, args = [] }: LaunchOptions = {}) {
  const { _electron } = await import('playwright-core');
  await build();
  const s = prepare({ demo, dir, theme });
  const linux = process.platform === 'linux';
  const env = { ...s.env, ...(preview ? { CA_PREVIEW_PLATFORM: 'darwin' } : {}), ...(linux ? { DISPLAY: process.env.DISPLAY || ':99' } : {}) };
  const app = await _electron.launch({ executablePath: ELECTRON, env,
    args: [...s.args, ...(linux ? ['--no-sandbox'] : []), ...(theme === 'dark' ? ['--force-dark-mode'] : []), ...args] });
  const page = await app.firstWindow();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.waitForSelector('.sidebar .nav');
  return { app, page, ...s };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  await build();
  const s = prepare({ demo: !flags.includes('--empty'), theme: flags.includes('--light') ? 'light' : flags.includes('--dark') ? 'dark' : undefined });
  console.log(`Sandbox in ${s.dir}. Launching is disabled: buttons copy their command instead.`);
  spawn(ELECTRON, s.args, { env: s.env, stdio: 'inherit' }).on('exit', code => process.exit(code ?? 0));
}
