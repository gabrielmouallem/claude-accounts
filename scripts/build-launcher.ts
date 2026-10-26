// Compiles launcher/launcher.swift, the program inside every account's Dock launcher (src/launchers.ts), into
// out/launcher/ClaudeAccountsLauncher: one file for Apple silicon and Intel, macOS 13 and later. It needs Xcode or its
// Command Line Tools. Compiling takes a while, so a build is kept in node_modules/.cache under the source's hash.
//
//   node scripts/build-launcher.ts      or   import { buildLauncher } from './build-launcher.ts'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'launcher', 'launcher.swift');
export const LAUNCHER = path.join(ROOT, 'out', 'launcher', 'ClaudeAccountsLauncher');
const FLAGS = ['-O', '-swift-version', '5'];

// Returns its path, or null off macOS or without a Swift compiler; the app then offers no Dock launchers.
export function buildLauncher({ quiet = false }: { quiet?: boolean } = {}): string | null {
  if (process.platform !== 'darwin') return null;
  let compiler: string;
  try { compiler = execFileSync('xcrun', ['swiftc', '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { console.warn('No Swift compiler, so no Dock launchers. To get one: xcode-select --install'); return null; }
  const key = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).update(compiler).update(FLAGS.join(' ')).digest('hex').slice(0, 16);
  const cached = path.join(ROOT, 'node_modules', '.cache', 'claude-accounts', `launcher-${key}`);
  if (!fs.existsSync(cached)) {
    const tmp = `${cached}.${process.pid}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const slices = ['arm64', 'x86_64'].map(arch => {
      const out = path.join(tmp, arch);
      execFileSync('xcrun', ['swiftc', ...FLAGS, '-target', `${arch}-apple-macos13`, SOURCE, '-o', out], { stdio: quiet ? 'pipe' : 'inherit' });
      return out;
    });
    execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', path.join(tmp, 'ClaudeAccountsLauncher')]);
    for (const s of slices) fs.rmSync(s);
    fs.renameSync(tmp, cached);
  }
  fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
  fs.copyFileSync(path.join(cached, 'ClaudeAccountsLauncher'), LAUNCHER);
  return LAUNCHER;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!buildLauncher()) process.exitCode = 1;
}
