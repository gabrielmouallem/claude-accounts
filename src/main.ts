// Electron main process: IPC handlers, launching (terminal, Docker, Desktop), tray, menus and the config watcher.
// It runs as the CommonJS bundle out/main.cjs (scripts/build.ts), so __dirname is the out folder.
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray, nativeImage, nativeTheme, session } from 'electron';
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn, type ExecFileOptions } from 'node:child_process';
import * as ca from './core.ts';
import * as V from './validate.ts';
import type { Account, AppEvent, Channel, CliStatus, Config, Engine, Launch, Prefs, Results, State } from './types.ts';

const IS_MAC = process.platform === 'darwin', IS_WIN = process.platform === 'win32';
const PREVIEW = process.env.CA_PREVIEW_PLATFORM || '';        // screenshot mode on Linux: renders the macOS layout
const LAUNCH_DISABLED = process.env.CA_NO_LAUNCH === '1';      // demo/screenshot mode: never spawn anything
const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER).href;

app.setName('Claude Accounts');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win: BrowserWindow | null = null, tray: Tray | null = null, userPath = process.env.PATH || '';

// ---------------------------------------------------------------- environment
// GUI apps on macOS get a minimal PATH; ask the login shell once so `claude` is found.
function resolveUserPath(): Promise<void> {
  const extra = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local'), ...(IS_WIN ? [] : ['/opt/homebrew/bin', '/usr/local/bin'])];
  const merge = (p: string) => Array.from(new Set([...p.split(path.delimiter), ...extra].filter(Boolean))).join(path.delimiter);
  // Windows reads a PATH entry without a drive against the current folder (see ca.absoluteDirs)
  if (IS_WIN) { userPath = ca.absoluteDirs(merge(userPath)); return Promise.resolve(); }
  return new Promise(resolve => {
    const sh = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
    execFile(sh, ['-ilc', 'printf "__CA_PATH__%s__CA_PATH__" "$PATH"'], { timeout: 4000, env: process.env }, (_err, out) => {
      const m = /__CA_PATH__(.*)__CA_PATH__/.exec(out || '');
      userPath = merge((m ? m[1] + path.delimiter : '') + userPath); resolve();
    });
  });
}
const baseEnv = (): ca.Env => ({ ...process.env, PATH: userPath });

// ---------------------------------------------------------------- prefs (app-only, not shared with the CLI)
const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json');
const THEME = process.env.CA_THEME;
const DEFAULT_PREFS: Prefs = { theme: THEME === 'dark' || THEME === 'light' ? THEME : 'system', terminal: IS_MAC ? 'Terminal' : 'default', onboarded: false, tray: true };
function getPrefs(): Prefs {
  let saved: unknown = {};
  try { saved = JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')); } catch {}
  return V.savedPrefs(saved, DEFAULT_PREFS);
}
function setPrefs(patch: Partial<Prefs>): Prefs {
  const p = { ...getPrefs(), ...patch };
  fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true });
  fs.writeFileSync(PREFS_FILE(), JSON.stringify(p, null, 2), { mode: 0o600 });
  return p;
}

// ---------------------------------------------------------------- state
function state(): State {
  const cfg = ca.load();
  const names = Object.keys(cfg.accounts).sort();
  const repos = ca.rows(cfg);
  const accounts = names.map((n, i) => {
    const a = cfg.accounts[n]!;
    return { name: n, color: i, config_dir: a.config_dir, desktop_user_data_dir: a.desktop_user_data_dir, docker_config_dir: a.docker_config_dir,
             login: ca.loginState(a), docker_login: ca.dockerLoginState(a), repoCount: repos.filter(r => r.account === n).length,
             desktop_cmd: ca.desktopCmd(a), login_cmd: ca.loginCmd(a) };
  });
  return { accounts, repos, configPath: ca.configPath(), system: ca.SYSTEM, previewPlatform: PREVIEW, prefs: getPrefs(),
           launchDisabled: LAUNCH_DISABLED, version: app.getVersion(), home: os.homedir() };
}

// ---------------------------------------------------------------- launching
type Outcome = { ok: boolean; message: string };
function run(file: string, args: string[], opts: ExecFileOptions = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 15000, windowsHide: true, ...opts }, (err, _o, stderr) =>
      resolve(err ? { ok: false, error: ((stderr ? String(stderr) : '') || err.message || '').trim().split('\n')[0] ?? '' } : { ok: true }));
  });
}
// Opens a new terminal window. `command` is the shell line for macOS and Linux, and what gets copied. On Windows,
// `windows()` returns a ca.windows* launch instead, which keeps paths and names out of the text cmd parses.
async function openTerminal(command: string, windows: () => ca.WinLaunch): Promise<Outcome> {
  V.typeable(command);
  if (LAUNCH_DISABLED) return { ok: false, message: 'Launching is disabled in demo mode. Command copied.' };
  if (IS_MAC) {
    const iterm = getPrefs().terminal === 'iTerm';
    // The command reaches AppleScript as an argument (argv), so it is never escaped into the script's text.
    const script = iterm
      ? ['tell application "iTerm"', 'activate', 'set w to (create window with default profile)', 'tell current session of w to write text (item 1 of argv)', 'end tell']
      : ['tell application "Terminal"', 'do script (item 1 of argv)', 'activate', 'end tell'];
    const r = await run('osascript', ['-e', 'on run argv', ...script.flatMap(l => ['-e', l]), '-e', 'end run', command]);
    return r.ok ? { ok: true, message: `Opened in ${iterm ? 'iTerm' : 'Terminal'}` } : { ok: false, message: `Could not open terminal: ${r.error}` };
  }
  if (IS_WIN) {
    const l = windows();
    spawn(l.file, l.args, { ...l.options, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, message: 'Opened a command prompt' };
  }
  for (const [t, pre] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']]] as const) {
    const found = userPath.split(':').some(d => { try { fs.accessSync(path.join(d, t), fs.constants.X_OK); return true; } catch { return false; } });
    if (found) { spawn(t, [...pre, 'bash', '-lc', command + '; exec bash'], { detached: true, stdio: 'ignore', env: baseEnv() }).unref(); return { ok: true, message: `Opened ${t}` }; }
  }
  return { ok: false, message: 'No terminal emulator found. Command copied.' };
}
async function launchDesktop(acc: Account): Promise<Outcome> {
  const l = ca.desktopLaunch(acc, ca.SYSTEM, baseEnv());
  if (LAUNCH_DISABLED) return { ok: false, message: 'Launching is disabled in demo mode. Command copied.' };
  if (!l) return { ok: false, message: 'There is no official Claude Desktop for Linux. Command copied.' };
  if (IS_WIN && !fs.existsSync(l.file)) return { ok: false, message: 'Claude Desktop not found in %LOCALAPPDATA%\\AnthropicClaude. Command copied.' };
  if (IS_WIN) { spawn(l.file, l.args, { detached: true, stdio: 'ignore', env: l.env }).unref(); return { ok: true, message: 'Claude Desktop instance launched' }; }
  const r = await run(l.file, l.args, { env: l.env });
  return r.ok ? { ok: true, message: 'Claude Desktop instance launched' } : { ok: false, message: /Unable to find application/i.test(r.error) ? 'Claude Desktop is not installed. Command copied.' : `Launch failed: ${r.error}` };
}
// The Docker launch as one line: build the image on first use, then run it. Shown, copied, and run on macOS and Linux.
function dockerShellCmd(repo: string, acc: Account, engine: Engine, worktree: string | null): string {
  ca.writeDockerfile();
  const [, build, runCmd] = ca.dockerCmds(repo, acc, engine, worktree);
  if (IS_WIN) return `@set "NoDefaultCurrentDirectoryInExePath=1" && ${engine} image inspect ${ca.IMAGE} >nul 2>&1 || ${build} && ${runCmd}`;
  return `(${engine} image inspect ${ca.IMAGE} >/dev/null 2>&1 || ${build}) && ${runCmd}`;
}
function commandFor(p: V.Parsed<'command:get'>, cfg: Config): string {
  if ('account' in p) {
    const acc = V.knownAccount(cfg, p.account);
    return p.kind === 'login' ? ca.loginCmd(acc) : ca.desktopCmd(acc);
  }
  const b = V.boundRepo(cfg, p.repo), acc = ca.accountOf(cfg, b), wt = p.worktree;
  switch (p.kind) {
    case 'terminal': return ca.terminalCmd(p.repo, acc, wt);
    case 'open': return b.mode === 'docker' ? ca.dockerCmds(p.repo, acc, 'docker', wt)[2] : b.mode === 'desktop' ? ca.desktopCmd(acc) : ca.terminalCmd(p.repo, acc, wt);
    case 'docker': return ca.dockerCmds(p.repo, acc, 'docker', wt)[2];
    case 'container': return ca.dockerCmds(p.repo, acc, 'container', wt)[2];
    case 'direnv': return ca.shellHook('direnv', { cfg, repo: p.repo });
  }
}
function withCopy(result: Outcome, command: string): Launch { if (!result.ok && command) clipboard.writeText(V.typeable(command)); return { ...result, command }; }

async function openRepo(repo: string, { worktree = null, forceTerminal = false }: { worktree?: string | null; forceTerminal?: boolean } = {}): Promise<Launch> {
  const cfg = ca.load(), b = V.boundRepo(cfg, repo), acc = ca.accountOf(cfg, b);
  if (!forceTerminal && b.mode === 'desktop') return withCopy(await launchDesktop(acc), ca.desktopCmd(acc));
  if (!forceTerminal && b.mode === 'docker') return openDocker(repo, acc, 'docker', worktree);
  const c = ca.terminalCmd(repo, acc, worktree);
  return withCopy(await openTerminal(c, () => ca.windowsTerminal(repo, acc, worktree, baseEnv())), c);
}
async function openDocker(repo: string, acc: Account, engine: Engine, wt: string | null): Promise<Launch> {
  if (engine === 'container' && !IS_MAC) throw new V.ValidationError('Apple container runs on macOS only.');
  const c = dockerShellCmd(repo, acc, engine, wt);
  return withCopy(await openTerminal(c, () => ca.windowsDocker(repo, acc, wt, baseEnv())), c);
}

// ---------------------------------------------------------------- IPC
// Every channel takes the payload src/validate.ts parses for it and resolves to its entry in Results.
function handle<C extends Channel>(channel: C, fn: (p: V.Parsed<C>) => Results[C] | Promise<Results[C]>): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (!event.senderFrame || event.senderFrame.url.split(/[?#]/)[0] !== RENDERER_URL) throw new Error('forbidden sender');
    try { return { ok: true, data: await fn(V.parse(channel, payload)) }; }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: e instanceof ca.CaError || e instanceof V.ValidationError ? message : `Unexpected error: ${message}` };
    }
  });
}
function mutate<T>(fn: (cfg: Config) => T): T { const cfg = ca.load(); const r = fn(cfg); ca.save(cfg); refreshTray(); return r; }

function registerIpc(): void {
  handle('state:get', () => state());
  handle('account:add', p => mutate(cfg => {
    if (Object.hasOwn(cfg.accounts, p.name)) throw new V.ValidationError(`An account named "${p.name}" already exists.`);
    ca.addAccount(cfg, p.name); return p.name;
  }));
  handle('account:remove', p => mutate(cfg => ca.removeAccount(cfg, p.account)));
  handle('account:deepStatus', p => ca.deepStatus(V.knownAccount(ca.load(), p.account), { env: baseEnv() }));
  handle('repo:bind', p => mutate(cfg => { V.knownAccount(cfg, p.account); return ca.bind(cfg, p.repo, p.account, p.mode); }));
  handle('repo:unbind', p => mutate(cfg => { V.boundRepo(cfg, p.repo); ca.unbind(cfg, p.repo); }));
  handle('dialog:pickRepo', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { title: 'Choose a repository folder', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose' });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = ca.norm(r.filePaths[0]);
    return { path: p, name: path.basename(p), isGit: fs.existsSync(path.join(p, '.git')) };
  });
  handle('action:open', p => openRepo(p.repo, { worktree: p.worktree }));
  handle('action:terminal', p => openRepo(p.repo, { worktree: p.worktree, forceTerminal: true }));
  handle('action:docker', p => {
    const cfg = ca.load();
    return openDocker(p.repo, ca.accountOf(cfg, V.boundRepo(cfg, p.repo)), p.engine, p.worktree);
  });
  handle('action:login', async p => {
    const acc = V.knownAccount(ca.load(), p.account), c = ca.loginCmd(acc);
    const r = await openTerminal(c, () => ca.windowsLogin(acc, baseEnv()));
    return withCopy(r.ok ? { ...r, message: 'Finish the browser sign-in in the terminal window' } : r, c);
  });
  handle('action:desktop', async p => { const acc = V.knownAccount(ca.load(), p.account); return withCopy(await launchDesktop(acc), ca.desktopCmd(acc)); });
  handle('command:get', p => V.typeable(commandFor(p, ca.load())));
  handle('clipboard:write', p => { clipboard.writeText(V.typeable(p.text)); return true; });
  handle('shell:reveal', p => {
    const cfg = ca.load();
    let dir = ca.baseDir();
    if (p.target === 'repo') { V.boundRepo(cfg, p.repo); dir = p.repo; }
    else if (p.target === 'account') dir = path.dirname(V.knownAccount(cfg, p.account).config_dir);
    shell.openPath(dir); return true;
  });
  handle('prefs:set', p => {
    const prefs = setPrefs(p);
    if (p.theme) nativeTheme.themeSource = prefs.theme;
    if (p.tray !== undefined) refreshTray();
    return prefs;
  });
  handle('cli:status', () => cliStatus());
  handle('cli:install', () => {
    const src = app.isPackaged ? path.join(process.resourcesPath, 'ca') : path.join(__dirname, '..', 'cli', 'ca');
    const dest = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'ca.py' : 'ca');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest); fs.chmodSync(dest, 0o755);
    return cliStatus();
  });
  handle('hook:get', p => ({ rc: `eval "$(ca shell-hook ${p.kind})"`, file: p.kind === 'zsh' ? '~/.zshrc' : '~/.bashrc' }));
}
function cliStatus(): CliStatus {
  const dest = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'ca.py' : 'ca');
  return { installed: fs.existsSync(dest), path: dest, onPath: userPath.split(path.delimiter).includes(path.dirname(dest)) };
}

// ---------------------------------------------------------------- tray / menu
function trayIcon(): Electron.NativeImage {
  const f = path.join(__dirname, '..', 'build', IS_MAC ? 'trayTemplate.png' : 'tray.png');
  const img = nativeImage.createFromPath(f);
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}
function refreshTray(): void {
  if (!app.isReady()) return;
  if (!getPrefs().tray || (!IS_MAC && !IS_WIN)) { if (tray) { tray.destroy(); tray = null; } return; }
  try {
    if (!tray) { tray = new Tray(trayIcon()); tray.setToolTip('Claude Accounts'); }
    const s = state();
    const repoItems: MenuItemConstructorOptions[] = s.repos.length ? s.repos.map(r => ({
      label: `${r.name}`, sublabel: `${r.account} · ${r.mode}`, toolTip: r.repo, enabled: r.exists,
      click: () => { openRepo(r.repo).then(notify, failed); },
    })) : [{ label: 'No repositories yet', enabled: false }];
    const accItems: MenuItemConstructorOptions[] = s.accounts.map(a => ({
      label: `Open Desktop — ${a.name}`, click: () => { desktopFor(a.name).then(notify, failed); },
    }));
    const desktop: MenuItemConstructorOptions[] = accItems.length ? [{ label: 'Claude Desktop', submenu: accItems }, { type: 'separator' }] : [];
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Repositories', enabled: false }, ...repoItems, { type: 'separator' }, ...desktop,
      { label: 'Show Claude Accounts', click: showWindow }, { label: 'Quit', role: 'quit' },
    ]));
  } catch { /* tray unsupported here */ }
}
// The account can be gone by the time its menu item is clicked; that is reported like any failed launch.
async function desktopFor(name: string): Promise<Outcome> { return launchDesktop(V.knownAccount(ca.load(), name)); }
function event(ev: AppEvent): void { if (win && !win.isDestroyed()) win.webContents.send('app:event', ev); }
function notify(res: Outcome & { command?: string }): void { event({ type: 'toast', ...res }); }
const failed = (e: unknown) => notify({ ok: false, message: e instanceof Error ? e.message : String(e) });
function send(ev: AppEvent): void { showWindow(); event(ev); }
function buildMenu(): void {
  const item = (label: string, accelerator: string, ev: AppEvent): MenuItemConstructorOptions => ({ label, accelerator, registerAccelerator: false, click: () => send(ev) });
  const appMenu: MenuItemConstructorOptions[] = IS_MAC ? [{ label: app.name, submenu: [
    { role: 'about' }, { type: 'separator' },
    item('Settings…', 'Cmd+,', { type: 'nav', view: 'settings' }),
    { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : [];
  const devTools: MenuItemConstructorOptions[] = app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...appMenu,
    { label: 'File', submenu: [
      item('Bind Repository…', 'CmdOrCtrl+N', { type: 'bind' }),
      item('Add Account…', 'CmdOrCtrl+Shift+N', { type: 'add-account' }),
      { type: 'separator' }, IS_MAC ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      item('Command Palette', 'CmdOrCtrl+K', { type: 'palette' }),
      { type: 'separator' },
      item('Repositories', 'CmdOrCtrl+1', { type: 'nav', view: 'repos' }),
      item('Accounts', 'CmdOrCtrl+2', { type: 'nav', view: 'accounts' }),
      item('Settings', 'CmdOrCtrl+3', { type: 'nav', view: 'settings' }),
      item('Refresh Status', 'CmdOrCtrl+R', { type: 'refresh' }),
      ...devTools,
      { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------- window
function createWindow(): void {
  const opts: BrowserWindowConstructorOptions = {
    width: 1200, height: 780, minWidth: 920, minHeight: 600, show: false, title: 'Claude Accounts',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
                      webSecurity: true, spellcheck: false, devTools: !app.isPackaged, webviewTag: false },
  };
  if (IS_MAC) Object.assign(opts, { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' });
  else if (PREVIEW) Object.assign(opts, { frame: false });
  else if (IS_WIN) Object.assign(opts, { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#a1a1a1', height: 44 } });
  const w = win = new BrowserWindow(opts);
  w.loadFile(RENDERER, { query: { platform: PREVIEW || process.platform } });
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => { win = null; });
  const wc = w.webContents;
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', e => e.preventDefault());
}
function showWindow(): void { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

function watchConfig(): void {
  let t: NodeJS.Timeout | undefined;
  const dir = ca.baseDir();
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  try {
    fs.watch(dir, { persistent: false }, (_e, f) => {
      if (f && f !== 'config.json') return;
      clearTimeout(t); t = setTimeout(() => { refreshTray(); event({ type: 'state-changed' }); }, 150);
    });
  } catch {}
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('web-contents-created', (_e, wc) => { wc.on('will-navigate', e => e.preventDefault()); wc.setWindowOpenHandler(() => ({ action: 'deny' })); });

app.whenReady().then(async () => {
  // No remote content, ever: only our own file:// pages may load anything.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|devtools):/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  nativeTheme.themeSource = getPrefs().theme;
  registerIpc(); buildMenu(); createWindow(); watchConfig();
  await resolveUserPath();
  refreshTray();
});
