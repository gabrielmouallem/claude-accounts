// Dock launchers, macOS only. Every account's Claude Desktop is the same Claude.app, with the same name and icon, so
// the Dock can't tell them apart. An account can have a small app of its own instead: "<account> (Claude)" in
// ~/Applications/Claude Accounts, its icon the account's name under Claude's mark, that opens the account's Claude
// Desktop or brings it forward (launcher/launcher.swift). The app builds, renames and removes them, also for accounts
// that ca renames or removes: it watches config.json, and checks again when it starts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { CaError, configPath, norm, withoutVars, type Env } from './core.ts';
import type { Account, Config } from './types.ts';

export const LAUNCHER_PREFIX = 'dev.gabriel.claude-accounts.launcher.';
const MANAGED_BY = 'dev.gabriel.claude-accounts';
const EXE = 'ClaudeAccountsLauncher';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export interface Launcher {
  app: string; id: string; account: string; desktopDir: string; configDir: string; configPath: string;
  label: string; stub: string;
}
// `stub` is the program every launcher runs (out/launcher/ClaudeAccountsLauncher, or the copy in the app's Resources).
export interface LauncherOptions { stub: string; version: string; dir?: string }

export function launchersDir(): string { return process.env.CA_LAUNCHERS_DIR || path.join(os.homedir(), 'Applications', 'Claude Accounts'); }
// Keyed by the account's Desktop folder, which a rename keeps
export function launcherId(desktopDir: string): string {
  return LAUNCHER_PREFIX + crypto.createHash('sha1').update(norm(desktopDir).toLowerCase()).digest('hex').slice(0, 12);
}
export function appName(account: string): string { return `${account} (Claude)`; }
export function appPath(account: string, dir = launchersDir()): string { return path.join(dir, `${appName(account)}.app`); }

// What the icon says: the account's name in capitals, or for a long name its first word, when no other account's
// name starts with that word ("grade-account" is GRADE). The icon shrinks a long label to fit.
export function launcherLabel(name: string, names: readonly string[]): string {
  const first = (n: string) => n.split(/[-_.]+/)[0]!.toLowerCase();
  if (name.length <= 10) return name.toUpperCase();
  const word = first(name);
  return (word.length >= 2 && !names.some(n => n !== name && first(n) === word) ? word : name).toUpperCase();
}

// ---------------------------------------------------------------- Info.plist
// control characters, which XML can't hold (tab and newlines aside)
const NOT_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function infoPlist(l: Omit<Launcher, 'app'>, version: string): string {
  const strings: [string, string][] = [
    ['CFBundleDevelopmentRegion', 'en'], ['CFBundleDisplayName', appName(l.account)], ['CFBundleExecutable', EXE],
    ['CFBundleIconFile', 'AppIcon'], ['CFBundleIdentifier', l.id], ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleName', appName(l.account)], ['CFBundlePackageType', 'APPL'], ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version], ['LSMinimumSystemVersion', '13.0'], ['NSPrincipalClass', 'NSApplication'],
    ['NSAppleEventsUsageDescription', `${appName(l.account)} brings back this account's Claude window after you close it, the way clicking Claude in the Dock does.`],
    // read back by readLauncher and by the launcher itself
    ['CAAccount', l.account], ['CAUserDataDir', l.desktopDir], ['CAConfigDir', l.configDir], ['CAConfigPath', l.configPath],
    ['CALabel', l.label], ['CAStub', l.stub], ['CAManagedBy', MANAGED_BY],
  ];
  for (const [, v] of strings) if (NOT_XML.test(v)) throw new CaError(`can't make a launcher for ${l.account}: a folder path has a control character`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', '<dict>',
    ...strings.map(([k, v]) => `\t<key>${k}</key>\n\t<string>${escape(v)}</string>`),
    '\t<key>LSMultipleInstancesProhibited</key>\n\t<true/>', '\t<key>NSHighResolutionCapable</key>\n\t<true/>',
    '</dict>', '</plist>', '',
  ].join('\n');
}
// A launcher this app made, or null for anything else in the folder
export function readLauncher(app: string): Launcher | null {
  let xml: string;
  try { xml = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8'); } catch { return null; }
  const v = new Map<string, string>();
  for (const m of xml.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) v.set(m[1]!, unescape(m[2]!));
  const id = v.get('CFBundleIdentifier') ?? '';
  if (v.get('CAManagedBy') !== MANAGED_BY || !id.startsWith(LAUNCHER_PREFIX)) return null;
  const s = (k: string) => v.get(k) ?? '';
  return { app, id, account: s('CAAccount'), desktopDir: s('CAUserDataDir'), configDir: s('CAConfigDir'), configPath: s('CAConfigPath'),
           label: s('CALabel'), stub: s('CAStub') };
}
export function listLaunchers(dir = launchersDir()): Launcher[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => n.endsWith('.app') && !n.startsWith('.')).flatMap(n => readLauncher(path.join(dir, n)) ?? []);
}
export function launcherFor(acc: Account, dir = launchersDir()): Launcher | null {
  const id = launcherId(acc.desktop_user_data_dir);
  return listLaunchers(dir).find(l => l.id === id) ?? null;
}

// ---------------------------------------------------------------- processes
// null when ps fails, so a check that nothing is open can't pass by mistake
function processes(): { pid: number; args: string }[] | null {
  let out: string;
  try { out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return null; }
  return out.split('\n').flatMap(line => { const m = /^\s*(\d+) (.*)$/.exec(line); return m ? [{ pid: Number(m[1]), args: m[2]! }] : []; });
}
function launcherPids(app: string): number[] {
  const exe = path.join(app, 'Contents', 'MacOS', EXE);
  return (processes() ?? []).filter(p => p.args === exe || p.args.startsWith(`${exe} `)).map(p => p.pid);
}
// The processes of a Claude Desktop open on this account's folder (its helpers too, and those of a renamed copy of
// Claude.app), or null when ps fails. ps joins arguments with spaces, so this looks for the flag the app and the
// launchers pass, followed by a space or the end.
export function desktopPids(acc: Account): number[] | null {
  const flags = [...new Set([acc.desktop_user_data_dir, norm(acc.desktop_user_data_dir)])].map(d => `--user-data-dir=${d}`.toLowerCase());
  return processes()?.filter(p => {
    const a = p.args.toLowerCase();
    return flags.some(f => { const i = a.indexOf(f); return i >= 0 && (i + f.length === a.length || a[i + f.length] === ' '); });
  }).map(p => p.pid) ?? null;
}

// ---------------------------------------------------------------- building
// A launcher's environment reaches its Claude, where these would override the account's sign-in
export function launcherEnv(base: Env = process.env): Env {
  return withoutVars(base, 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR');
}
function run(file: string, args: string[], env?: Env): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 30_000, env }, (err, stdout, stderr) =>
    err ? reject(new CaError(`${path.basename(file)} failed: ${String(stderr || err.message).trim().split('\n')[0]}`)) : resolve(String(stdout).trim())));
}
const stubs = new Map<string, string>();
function stubHash(stub: string): string {
  const key = `${stub}:${fs.statSync(stub).mtimeMs}`;
  if (!stubs.has(key)) stubs.set(key, crypto.createHash('sha1').update(fs.readFileSync(stub)).digest('hex').slice(0, 12));
  return stubs.get(key)!;
}
// What the launcher for `name` should hold
function wanted(cfg: Config, name: string, o: LauncherOptions): Omit<Launcher, 'app'> {
  const acc = cfg.accounts[name]!;
  return { id: launcherId(acc.desktop_user_data_dir), account: name, desktopDir: acc.desktop_user_data_dir, configDir: acc.config_dir,
           configPath: configPath(), label: launcherLabel(name, Object.keys(cfg.accounts)), stub: stubHash(o.stub) };
}
function current(l: Launcher, want: Omit<Launcher, 'app'>, dir: string): boolean {
  return l.app === appPath(want.account, dir) && (Object.keys(want) as (keyof typeof want)[]).every(k => l[k] === want[k]);
}
// Builds the bundle next to its place and moves it in, so a launcher that is open never sees half of one. The
// program is read and written rather than copied: a copy would keep a downloaded app's quarantine flag.
async function build(want: Omit<Launcher, 'app'>, o: LauncherOptions): Promise<Launcher> {
  const dir = o.dir ?? launchersDir(), app = appPath(want.account, dir), tmp = path.join(dir, `.${want.id}.${process.pid}.app`);
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    const contents = path.join(tmp, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'));
    fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist(want, o.version));
    fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
    fs.writeFileSync(path.join(contents, 'MacOS', EXE), fs.readFileSync(o.stub), { mode: 0o755 });
    await run(o.stub, ['--render-icon', path.join(contents, 'Resources', 'AppIcon.icns'), want.label]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', want.id, tmp]);
    const old = `${tmp}.old`;
    try { fs.renameSync(app, old); } catch {}
    fs.renameSync(tmp, app);
    fs.rmSync(old, { recursive: true, force: true });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  await run(LSREGISTER, ['-f', app]).catch(() => {});   // so Finder and Spotlight show the new name and icon
  return { ...want, app };
}
// A launcher's icon. The Dock shows a tile's old icon until it restarts, so a new label, or a newer program that draws
// it differently, restarts the Dock.
function iconOf(app: string): Buffer {
  try { return fs.readFileSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns')); } catch { return Buffer.alloc(0); }
}
async function drop(app: string): Promise<void> {
  await run(LSREGISTER, ['-u', app]).catch(() => {});
  fs.rmSync(app, { recursive: true, force: true });
}

// ---------------------------------------------------------------- Dock
// `tool` runs the Dock edits: the app's own copy of the program, or (from ca) the launcher's.
const toolOf = (l: Launcher) => path.join(l.app, 'Contents', 'MacOS', EXE);
async function dockIds(tool: string): Promise<Set<string>> { return new Set((await run(tool, ['--dock-list'])).split('\n').filter(Boolean)); }
export function restartDock(): Promise<string> { return run('/usr/bin/killall', ['Dock']); }

// Launchers in the Dock, by id
export async function docked(o: LauncherOptions): Promise<Set<string>> { return dockIds(o.stub); }

// Builds the account's launcher if it has none or an old one, and keeps it in the Dock.
export async function keepInDock(cfg: Config, name: string, o: LauncherOptions): Promise<Launcher> {
  const acc = cfg.accounts[name]!, dir = o.dir ?? launchersDir(), old = launcherFor(acc, dir);
  const want = wanted(cfg, name, o), icon = old && iconOf(old.app);
  const l = old && current(old, want, dir) ? old : await rebuild(old, want, o);
  if (await run(o.stub, ['--dock-add', l.id, l.app, appName(name)]) === 'changed' || (icon && !icon.equals(iconOf(l.app)))) await restartDock();
  return l;
}
// Takes the launcher out of the Dock and deletes it. A launcher that is open leaves its Claude open.
export async function removeLauncher(l: Launcher, tool = toolOf(l)): Promise<boolean> {
  for (const pid of launcherPids(l.app)) try { process.kill(pid, 'SIGUSR1'); } catch {}
  const changed = await run(tool, ['--dock-remove', l.id]) === 'changed';
  await drop(l.app);
  return changed;
}
export async function dropFromDock(acc: Account, o?: LauncherOptions): Promise<boolean> {
  const l = launcherFor(acc, o?.dir);
  if (!l) return false;
  const changed = await removeLauncher(l, o?.stub);
  if (changed) await restartDock();
  return true;
}
async function rebuild(old: Launcher | null, want: Omit<Launcher, 'app'>, o: LauncherOptions): Promise<Launcher> {
  // An open launcher leaves (its Claude stays open), and the new one takes over that Claude without coming forward.
  const pids = old ? launcherPids(old.app) : [];
  for (const pid of pids) try { process.kill(pid, 'SIGUSR1'); } catch {}
  const l = await build(want, o);
  if (old && old.app !== l.app) await drop(old.app);
  if (pids.length) await run('/usr/bin/open', ['-g', '-a', l.app, '--args', '--attach'], launcherEnv()).catch(() => {});
  return l;
}

// Keeps launchers in step with the config: a removed account's launcher goes, a renamed one is rebuilt under its new
// name, and every one is rebuilt when the app brings a newer program. The Dock restarts once, if a tile in it changed.
// Launchers made for another config (CA_CONFIG) are left alone, and so is every launcher while no config exists.
export async function syncLaunchers(cfg: Config, o: LauncherOptions): Promise<void> {
  if (!fs.existsSync(configPath())) return;
  const mine = norm(configPath()).toLowerCase();
  const dir = o.dir ?? launchersDir(), all = listLaunchers(dir).filter(l => norm(l.configPath).toLowerCase() === mine);
  if (!all.length) return;
  const byId = new Map(Object.keys(cfg.accounts).map(n => [launcherId(cfg.accounts[n]!.desktop_user_data_dir), n]));
  let inDock: Set<string> | null = null, restart = false;
  for (const old of all) {
    const name = byId.get(old.id);
    if (name === undefined) { restart = await removeLauncher(old, o.stub) || restart; continue; }
    const want = wanted(cfg, name, o);
    if (current(old, want, dir)) continue;
    const icon = iconOf(old.app), l = await rebuild(old, want, o);
    inDock ??= await dockIds(o.stub);
    if (inDock.has(l.id)) {
      const moved = await run(o.stub, ['--dock-add', l.id, l.app, appName(name)]) === 'changed';
      restart ||= moved || !icon.equals(iconOf(l.app));
    }
  }
  if (restart) await restartDock();
}
