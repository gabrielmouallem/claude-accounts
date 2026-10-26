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
import type { Account, AppEvent, AuthStatus, Channel, CliStatus, Config, Engine, Launch, LoginState, Prefs, Results, State } from './types.ts';

const IS_MAC = process.platform === 'darwin', IS_WIN = process.platform === 'win32';
const PREVIEW = process.env.CA_PREVIEW_PLATFORM || '';        // screenshot mode on Linux: renders the macOS layout
const LAUNCH_DISABLED = process.env.CA_NO_LAUNCH === '1';      // demo/screenshot mode: never spawn anything
const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = pathToFileURL(RENDERER).href;

app.setName('Claude Accounts');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win: BrowserWindow | null = null, tray: Tray | null = null, userPath = process.env.PATH || '';
let userPathReady: Promise<void> = Promise.resolve();

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
  const rows = ca.rows(cfg);
  const accounts = names.map((n, i) => {
    const a = cfg.accounts[n]!, login = signIn(a), known = auth.get(a.config_dir);
    // who it is signed in as means something only while it is signed in
    const who = login === 'logged-in' ? known : undefined;
    return { name: n, color: i, config_dir: a.config_dir, desktop_user_data_dir: a.desktop_user_data_dir, docker_config_dir: a.docker_config_dir,
             login, docker_login: ca.dockerLoginState(a), repoCount: rows.filter(r => r.account === n).length,
             desktop_cmd: ca.desktopCmd(a), login_cmd: ca.loginCmd(a),
             email: who?.email ?? null, plan: who?.plan ?? null, org: who?.org ?? null, note: known && !known.state ? known.note : null,
             checking: asking.has(a.config_dir), signingIn: signingIn.has(a.config_dir), desktopNew: ca.desktopNeverOpened(a) };
  });
  const loginBy = new Map(accounts.map(a => [a.name, a.login]));
  const repos = rows.map(r => r.login === 'keychain?' ? { ...r, login: loginBy.get(r.account) ?? r.login } : r);
  return { accounts, repos, configPath: ca.configPath(), system: ca.SYSTEM, previewPlatform: PREVIEW, prefs: getPrefs(),
           launchDisabled: LAUNCH_DISABLED, version: app.getVersion(), home: os.homedir() };
}

// ---------------------------------------------------------------- sign-in status
// An account's folder tells only part of it: on macOS the token lives in the Keychain, and Claude Code writes
// .claude.json before a sign-in finishes. So the app asks `claude auth status` about each account with files, which
// prints the email and plan and never the token (see ca.authStatus). It asks once per folder that has files (at
// start-up, or when a folder first gets them), then again only on Refresh, and every few seconds while it waits for a
// sign-in it opened, until the account is signed in as someone new.
const SIGN_IN_POLL = 3_000, SIGN_IN_WAIT = 5 * 60_000;
const auth = new Map<string, AuthStatus>();   // by config_dir, which a rename keeps
const asking = new Map<string, Promise<AuthStatus>>();
const signingIn = new Map<string, number>();                         // config_dir -> when to stop waiting
// The window refreshes when the answer is new or different.
function ask(acc: Account): Promise<AuthStatus> {
  const dir = acc.config_dir;
  let p = asking.get(dir);
  if (!p) {
    // claude is found on the login shell's PATH, which takes a moment to read when the app starts
    p = userPathReady.then(() => ca.authStatus(acc, { env: baseEnv() }))
      .catch((e: unknown): AuthStatus => ({ state: null, email: null, plan: null, org: null, note: `error: ${e instanceof Error ? e.message : String(e)}` }))
      .then(status => {
        const before = auth.get(dir);
        auth.set(dir, status);
        asking.delete(dir);
        if (JSON.stringify(before) !== JSON.stringify(status)) event({ type: 'state-changed' });
        return status;
      });
    asking.set(dir, p);
  }
  return p;
}
// An account's sign-in state: the last answer when there is one, or else what its folder shows while the first
// answer comes. A folder with no files has never been signed in.
function signIn(acc: Account): LoginState {
  const s = ca.loginState(acc);
  if (s === 'not-logged-in' || LAUNCH_DISABLED) return s;
  const known = auth.get(acc.config_dir);
  if (!known) void ask(acc);
  return known?.state ?? s;
}
// Every account with files, asked again now, for a refresh someone asked for
async function askAll(): Promise<void> {
  if (LAUNCH_DISABLED) return;
  await Promise.all(Object.values(ca.load().accounts).filter(a => ca.loginState(a) !== 'not-logged-in').map(ask));
}
// Waits for a sign-in the app opened, so the account shows who it is signed in as without a refresh. A first
// sign-in, or one as another email, ends the wait; one as the same email reads the same, so it runs to the limit.
function watchSignIn(acc: Account): void {
  const dir = acc.config_dir, was = auth.get(dir);
  const running = signingIn.has(dir);
  signingIn.set(dir, Date.now() + SIGN_IN_WAIT);
  event({ type: 'state-changed' });
  if (running) return;   // the loop below picks up the new limit
  const tick = async () => {
    const now = await ask(acc);
    const done = now.state === 'logged-in' && (was?.state !== 'logged-in' || now.email !== was.email);
    if (!done && Date.now() < (signingIn.get(dir) ?? 0)) { setTimeout(tick, SIGN_IN_POLL); return; }
    signingIn.delete(dir);
    event({ type: 'state-changed' });
    const name = accountNamed(dir);
    if (done && name) event({ type: 'toast', ok: true, message: `“${name}” is signed in${now.email ? ` as ${now.email}` : ''}` });
  };
  setTimeout(tick, SIGN_IN_POLL);
}
// The account's name now: it may have been renamed since
function accountNamed(configDir: string): string | undefined {
  try { return Object.entries(ca.load().accounts).find(([, a]) => a.config_dir === configDir)?.[0]; } catch { return undefined; }
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
      // Terminal opens a window of its own when it starts. A Terminal that wasn't running gets the command there,
      // instead of in a second window, unless it opened several (restored windows, a window group) or that one is
      // already running something, which a profile can start (ssh, tmux).
      : ['set wasRunning to application "Terminal" is running', 'tell application "Terminal"', 'if not wasRunning then reopen',
         'if not wasRunning and (count of windows) is 1 and not (busy of selected tab of window 1) then',
         'do script (item 1 of argv) in window 1', 'else', 'do script (item 1 of argv)', 'end if', 'activate', 'end tell'];
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
  handle('state:get', async p => { if (p.fresh) await askAll(); return state(); });
  handle('account:add', p => mutate(cfg => {
    if (Object.hasOwn(cfg.accounts, p.name)) throw new V.ValidationError(`An account named "${p.name}" already exists.`);
    ca.addAccount(cfg, p.name); return p.name;
  }));
  handle('account:remove', p => mutate(cfg => ca.removeAccount(cfg, p.account)));
  handle('account:rename', p => mutate(cfg => {
    V.knownAccount(cfg, p.account);
    if (p.name !== p.account && Object.hasOwn(cfg.accounts, p.name)) throw new V.ValidationError(`An account named "${p.name}" already exists.`);
    ca.renameAccount(cfg, p.account, p.name); return p.name;
  }));
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
    if (r.ok) watchSignIn(acc);
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
    if (IS_WIN) throw new ca.CaError("The ca CLI doesn't run on Windows yet.");
    // The executable for this machine: bundled with the app, or built by npm run build in a checkout
    const src = BUNDLED_CLI();
    if (!fs.existsSync(src)) throw new ca.CaError(`The ca CLI isn't built (${src}). Run npm run build.`);
    // The executable goes where PATH doesn't look, and ~/.local/bin gets the script that starts it (ca.cliWrapper)
    const { script, program } = CLI();
    installFile(program, fs.readFileSync(src));
    installFile(script, ca.cliWrapper(program));
    return cliStatus();
  });
  handle('hook:get', p => ({ rc: `eval "$(ca shell-hook ${p.kind})"`, file: p.kind === 'zsh' ? '~/.zshrc' : '~/.bashrc' }));
}
const CLI = () => ({ script: path.join(os.homedir(), '.local', 'bin', 'ca'), program: path.join(os.homedir(), '.local', 'lib', 'claude-accounts', 'ca') });
const BUNDLED_CLI = () => app.isPackaged ? path.join(process.resourcesPath, 'cli', 'ca') : path.join(__dirname, 'cli', `${process.platform}-${process.arch}`, 'ca');
// A new file, renamed into place: macOS stops a signed program whose file was rewritten in place. Writing the bytes
// also leaves behind the quarantine flag of a downloaded app, which would make macOS refuse to run ca.
function installFile(dest: string, data: string | Buffer): void {
  const tmp = `${dest}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(tmp, data, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
}
// Installed means this version's script and executable. Anything else at that path (an older ca, such as the Python
// one, or an executable without its script) is outdated, and installing replaces it.
function cliStatus(): CliStatus {
  const { script, program } = CLI(), want = ca.cliWrapper(program);
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return -1; } };
  let installed = false;
  try { installed = size(script) === Buffer.byteLength(want) && fs.readFileSync(script, 'utf8') === want && size(program) === size(BUNDLED_CLI()); } catch {}
  return { installed, outdated: !installed && size(script) >= 0, path: script, onPath: userPath.split(path.delimiter).includes(path.dirname(script)) };
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
      click: () => { if (r.mode !== 'desktop' || !guideFirst(r.account, r.repo)) openRepo(r.repo).then(notify, failed); },
    })) : [{ label: 'No repositories yet', enabled: false }];
    const accItems: MenuItemConstructorOptions[] = s.accounts.map(a => ({
      label: `Open Desktop — ${a.name}`, click: () => { if (!guideFirst(a.name)) desktopFor(a.name).then(notify, failed); },
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
// A Desktop window that has never opened isn't signed in, and a sign-in through the browser can't reach it while
// another Claude is open. So the tray shows how to sign in, in the app's window, instead of opening it.
function guideFirst(account: string, repo?: string): boolean {
  let acc: Account;
  try { acc = V.knownAccount(ca.load(), account); } catch { return false; }   // the launch reports it
  if (!ca.desktopNeverOpened(acc)) return false;
  send({ type: 'desktop-guide', account, ...(repo ? { repo } : {}) });
  return true;
}
function event(ev: AppEvent): void { if (win && !win.isDestroyed()) win.webContents.send('app:event', ev); }
function notify(res: Outcome & { command?: string }): void { event({ type: 'toast', ...res }); }
const failed = (e: unknown) => notify({ ok: false, message: e instanceof Error ? e.message : String(e) });
// Shows the window and sends it `ev`, once it has loaded when it is new
const waiting: AppEvent[] = [];
function send(ev: AppEvent): void {
  if (win && !win.webContents.isLoading()) { showWindow(); event(ev); return; }
  waiting.push(ev);
  showWindow();
}
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
  wc.on('did-finish-load', () => { for (const ev of waiting.splice(0)) event(ev); });
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
  userPathReady = resolveUserPath();
  registerIpc(); buildMenu(); createWindow(); watchConfig();
  await userPathReady;
  refreshTray();
});
