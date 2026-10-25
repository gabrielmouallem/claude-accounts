'use strict';
// Runs the app against a throwaway home: its own config.json and user data, fake demo accounts, launching disabled.
// Nothing touches your real ~/.config/claude-accounts, the app's settings, or Claude itself.
//
//   npm run sandbox [-- --empty] [-- --light|--dark]     open it and click through
//
//   const { launch } = require('./scripts/sandbox');     drive it with Playwright (see .claude/skills/run-app)
//   const { app, page, home } = await launch({ theme: 'light' });
//   await page.screenshot({ path: 'repos.png' }); await app.close();
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

// A fresh sandbox folder (a given `dir` is emptied first); with `demo`, scripts/demo-config.sh fills it with fake
// repositories and accounts.
function prepare({ demo = true, dir, theme } = {}) {
  if (dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
  else dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-sandbox-'));
  // Repository paths are saved resolved, and macOS keeps temp folders behind a symlink (/var -> /private/var):
  // HOME has to be the resolved path too, or the app can't show them as ~/code/...
  dir = fs.realpathSync(dir);
  if (demo) execFileSync(path.join(__dirname, 'demo-config.sh'), [dir], { stdio: 'ignore' });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CA_NO_LAUNCH: '1',
                CA_CONFIG: path.join(home, '.config', 'claude-accounts', 'config.json') };
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CA_ACCOUNT', 'CA_THEME', 'CA_PREVIEW_PLATFORM']) delete env[k];
  if (theme) env.CA_THEME = theme;
  return { dir, home, env, args: [ROOT, `--user-data-dir=${path.join(dir, 'user-data')}`] };
}

// Launches it under Playwright and waits for the first view. `preview` draws the macOS window chrome into the page
// (screenshots leave out the real traffic lights) and, on Linux, renders the macOS layout under Xvfb.
async function launch({ demo = true, theme = 'dark', dir, preview = false, args = [] } = {}) {
  const { _electron } = require('playwright-core');
  const s = prepare({ demo, dir, theme });
  const linux = process.platform === 'linux';
  const env = { ...s.env, ...(preview ? { CA_PREVIEW_PLATFORM: 'darwin' } : {}), ...(linux ? { DISPLAY: process.env.DISPLAY || ':99' } : {}) };
  const app = await _electron.launch({ executablePath: require('electron'), env,
    args: [...s.args, ...(linux ? ['--no-sandbox'] : []), ...(theme === 'dark' ? ['--force-dark-mode'] : []), ...args] });
  const page = await app.firstWindow();
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.waitForSelector('.sidebar .nav');
  return { app, page, ...s };
}

if (require.main === module) {
  const flags = process.argv.slice(2);
  const s = prepare({ demo: !flags.includes('--empty'), theme: flags.includes('--light') ? 'light' : flags.includes('--dark') ? 'dark' : undefined });
  console.log(`Sandbox in ${s.dir}. Launching is disabled: buttons copy their command instead.`);
  spawn(require('electron'), s.args, { env: s.env, stdio: 'inherit' }).on('exit', code => process.exit(code ?? 0));
}

module.exports = { prepare, launch };
