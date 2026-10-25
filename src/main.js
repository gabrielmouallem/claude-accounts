'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, Tray, nativeImage, nativeTheme, session } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const ca = require('./core');
const V = require('./validate');

const IS_MAC = process.platform === 'darwin', IS_WIN = process.platform === 'win32';
const PREVIEW = process.env.CA_PREVIEW_PLATFORM || '';        // screenshot mode on Linux: renders the macOS layout
const LAUNCH_DISABLED = process.env.CA_NO_LAUNCH === '1';      // demo/screenshot mode: never spawn anything
const RENDERER = path.join(__dirname, 'renderer', 'index.html');
const RENDERER_URL = require('node:url').pathToFileURL(RENDERER).href;

app.setName('Claude Accounts');
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null, tray = null, userPath = process.env.PATH || '';

// ---------------------------------------------------------------- environment
// GUI apps on macOS get a minimal PATH; ask the login shell once so `claude` is found.
function resolveUserPath() {
  const extra = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin'];
  const merge = p => Array.from(new Set([...p.split(path.delimiter), ...extra].filter(Boolean))).join(path.delimiter);
  if (IS_WIN) { userPath = merge(userPath); return Promise.resolve(); }
  return new Promise(resolve => {
    const sh = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
    execFile(sh, ['-ilc', 'printf "__CA_PATH__%s__CA_PATH__" "$PATH"'], { timeout: 4000, env: process.env }, (err, out) => {
      const m = /__CA_PATH__(.*)__CA_PATH__/.exec(out || '');
      userPath = merge((m ? m[1] + path.delimiter : '') + userPath); resolve();
    });
  });
}
const baseEnv = () => ({ ...process.env, PATH: userPath });

// ---------------------------------------------------------------- prefs (app-only, not shared with the CLI)
const PREFS_FILE = () => path.join(app.getPath('userData'), 'prefs.json');
const DEFAULT_PREFS = { theme: ['dark', 'light'].includes(process.env.CA_THEME) ? process.env.CA_THEME : 'system', terminal: IS_MAC ? 'Terminal' : 'default', onboarded: false, tray: true };
function getPrefs() { try { return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf8')) }; } catch { return { ...DEFAULT_PREFS }; } }
function setPrefs(patch) {
  const p = { ...getPrefs(), ...patch };
  fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true });
  fs.writeFileSync(PREFS_FILE(), JSON.stringify(p, null, 2), { mode: 0o600 });
  return p;
}

// ---------------------------------------------------------------- state
function state() {
  const cfg = ca.load();
  const names = Object.keys(cfg.accounts).sort();
  const repos = ca.rows(cfg);
  const accounts = names.map((n, i) => {
    const a = cfg.accounts[n];
    return { name: n, color: i, config_dir: a.config_dir, desktop_user_data_dir: a.desktop_user_data_dir, docker_config_dir: a.docker_config_dir,
             login: ca.loginState(a), docker_login: ca.dockerLoginState(a), repoCount: repos.filter(r => r.account === n).length,
             desktop_cmd: ca.desktopCmd(a), login_cmd: ca.loginCmd(a) };
  });
  return { accounts, repos, configPath: ca.configPath(), system: ca.SYSTEM, previewPlatform: PREVIEW, prefs: getPrefs(),
           launchDisabled: LAUNCH_DISABLED, version: app.getVersion(), home: os.homedir() };
}

// ---------------------------------------------------------------- launching
function run(file, args, opts = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 15000, windowsHide: true, ...opts }, (err, _o, stderr) =>
      resolve(err ? { ok: false, error: (stderr || err.message || '').trim().split('\n')[0] } : { ok: true }));
  });
}
// Opens a new terminal window. `command` is the shell line for macOS and Linux, and what gets copied. On Windows,
// `win()` returns a ca.windows* launch instead, which keeps paths and names out of the text cmd parses.
async function openTerminal(command, win) {
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
    const l = win();
    spawn(l.file, l.args, { ...l.options, detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { ok: true, message: 'Opened a command prompt' };
  }
  for (const [t, pre] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']]]) {
    const found = userPath.split(':').some(d => { try { fs.accessSync(path.join(d, t), fs.constants.X_OK); return true; } catch { return false; } });
    if (found) { spawn(t, [...pre, 'bash', '-lc', command + '; exec bash'], { detached: true, stdio: 'ignore', env: baseEnv() }).unref(); return { ok: true, message: `Opened ${t}` }; }
  }
  return { ok: false, message: 'No terminal emulator found. Command copied.' };
}
async function launchDesktop(acc) {
  const l = ca.desktopLaunch(acc, ca.SYSTEM, baseEnv());
  if (LAUNCH_DISABLED) return { ok: false, message: 'Launching is disabled in demo mode. Command copied.' };
  if (!l) return { ok: false, message: 'There is no official Claude Desktop for Linux. Command copied.' };
  if (IS_WIN && !fs.existsSync(l.file)) return { ok: false, message: 'Claude Desktop not found in %LOCALAPPDATA%\\AnthropicClaude. Command copied.' };
  if (IS_WIN) { spawn(l.file, l.args, { detached: true, stdio: 'ignore', env: l.env }).unref(); return { ok: true, message: 'Claude Desktop instance launched' }; }
  const r = await run(l.file, l.args, { env: l.env });
  return r.ok ? { ok: true, message: 'Claude Desktop instance launched' } : { ok: false, message: /Unable to find application/i.test(r.error) ? 'Claude Desktop is not installed. Command copied.' : `Launch failed: ${r.error}` };
}
// The Docker launch as one line: build the image on first use, then run it. Shown, copied, and run on macOS and Linux.
function dockerShellCmd(repo, acc, engine, worktree) {
  ca.writeDockerfile();
  const [, build, runCmd] = ca.dockerCmds(repo, acc, engine, worktree);
  if (IS_WIN) return `${engine} image inspect ${ca.IMAGE} >nul 2>&1 || ${build} && ${runCmd}`;
  return `(${engine} image inspect ${ca.IMAGE} >/dev/null 2>&1 || ${build}) && ${runCmd}`;
}
function commandFor(kind, cfg, p) {
  if (kind === 'login' || kind === 'desktop') {
    const acc = cfg.accounts[V.existingAccount(cfg, p.account)];
    return kind === 'login' ? ca.loginCmd(acc) : ca.desktopCmd(acc);
  }
  const repo = V.boundRepo(cfg, p.repo), b = cfg.repos[repo], acc = ca.accountOf(cfg, b);
  const wt = V.worktree(p.worktree);
  switch (kind) {
    case 'terminal': return ca.terminalCmd(repo, acc, wt);
    case 'open': return b.mode === 'docker' ? ca.dockerCmds(repo, acc, 'docker', wt)[2] : b.mode === 'desktop' ? ca.desktopCmd(acc) : ca.terminalCmd(repo, acc, wt);
    case 'docker': return ca.dockerCmds(repo, acc, 'docker', wt)[2];
    case 'container': return ca.dockerCmds(repo, acc, 'container', wt)[2];
    case 'direnv': return ca.shellHook('direnv', { cfg, repo });
    default: throw new V.ValidationError('invalid command kind');
  }
}
async function withCopy(result, command) { if (!result.ok && command) clipboard.writeText(command); return { ...result, command }; }

async function openRepo(repoPath, { worktree = null, forceTerminal = false } = {}) {
  const cfg = ca.load(), repo = V.boundRepo(cfg, repoPath), b = cfg.repos[repo], acc = ca.accountOf(cfg, b);
  const wt = V.worktree(worktree);
  if (!forceTerminal && b.mode === 'desktop') return withCopy(await launchDesktop(acc), ca.desktopCmd(acc));
  if (!forceTerminal && b.mode === 'docker') return openDocker(repo, acc, 'docker', wt);
  const c = ca.terminalCmd(repo, acc, wt);
  return withCopy(await openTerminal(c, () => ca.windowsTerminal(repo, acc, wt, baseEnv())), c);
}
async function openDocker(repo, acc, engine, wt) {
  if (engine === 'container' && !IS_MAC) throw new V.ValidationError('Apple container runs on macOS only.');
  const c = dockerShellCmd(repo, acc, engine, wt);
  return withCopy(await openTerminal(c, () => ca.windowsDocker(repo, acc, wt, baseEnv())), c);
}

// ---------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    if (!event.senderFrame || event.senderFrame.url.split(/[?#]/)[0] !== RENDERER_URL) throw new Error('forbidden sender');
    try { return { ok: true, data: await fn(payload === undefined ? {} : V.obj(payload)) }; }
    catch (e) { return { ok: false, error: (e instanceof ca.CaError || e instanceof V.ValidationError) ? e.message : `Unexpected error: ${e.message}` }; }
  });
}
const mutate = fn => { const cfg = ca.load(); const r = fn(cfg); ca.save(cfg); refreshTray(); return r; };

function registerIpc() {
  handle('state:get', () => state());
  handle('account:add', p => mutate(cfg => {
    const name = V.newAccountName(p.name);
    if (cfg.accounts[name]) throw new V.ValidationError(`An account named "${name}" already exists.`);
    ca.addAccount(cfg, name); return name;
  }));
  handle('account:remove', p => mutate(cfg => ca.removeAccount(cfg, V.existingAccount(cfg, p.account))));
  handle('account:deepStatus', p => { const cfg = ca.load(); return ca.deepStatus(cfg.accounts[V.existingAccount(cfg, p.account)], { env: baseEnv() }); });
  handle('repo:bind', p => mutate(cfg => ca.bind(cfg, V.absPath(p.repo), V.existingAccount(cfg, p.account), V.mode(p.mode || 'terminal'))));
  handle('repo:unbind', p => mutate(cfg => ca.unbind(cfg, V.boundRepo(cfg, p.repo))));
  handle('dialog:pickRepo', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a repository folder', properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose' });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = ca.norm(r.filePaths[0]);
    return { path: p, name: path.basename(p), isGit: fs.existsSync(path.join(p, '.git')) };
  });
  handle('action:open', p => openRepo(p.repo, { worktree: p.worktree }));
  handle('action:terminal', p => openRepo(p.repo, { worktree: p.worktree, forceTerminal: true }));
  handle('action:docker', p => {
    const cfg = ca.load(), repo = V.boundRepo(cfg, p.repo);
    return openDocker(repo, ca.accountOf(cfg, cfg.repos[repo]), V.engine(p.engine || 'docker'), V.worktree(p.worktree));
  });
  handle('action:login', async p => {
    const cfg = ca.load(), acc = cfg.accounts[V.existingAccount(cfg, p.account)], c = ca.loginCmd(acc);
    const r = await openTerminal(c, () => ca.windowsLogin(acc, baseEnv()));
    return withCopy(r.ok ? { ...r, message: 'Finish the browser sign-in in the terminal window' } : r, c);
  });
  handle('action:desktop', async p => { const cfg = ca.load(), acc = cfg.accounts[V.existingAccount(cfg, p.account)]; return withCopy(await launchDesktop(acc), ca.desktopCmd(acc)); });
  handle('command:get', p => commandFor(V.oneOf(p.kind, ['terminal', 'open', 'docker', 'container', 'desktop', 'login', 'direnv'], 'kind'), ca.load(), p));
  handle('clipboard:write', p => { clipboard.writeText(V.str(p.text, 'text', 20000)); return true; });
  handle('shell:reveal', p => {
    const cfg = ca.load();
    const target = V.oneOf(p.target, ['config', 'account', 'repo'], 'target');
    const dir = target === 'config' ? ca.baseDir() : target === 'repo' ? V.boundRepo(cfg, p.repo)
      : path.dirname(cfg.accounts[V.existingAccount(cfg, p.account)].config_dir);
    shell.openPath(dir); return true;
  });
  handle('prefs:set', p => {
    const patch = {};
    if ('theme' in p) patch.theme = V.oneOf(p.theme, ['system', 'dark', 'light'], 'theme');
    if ('terminal' in p) patch.terminal = V.oneOf(p.terminal, ['Terminal', 'iTerm', 'default'], 'terminal');
    if ('onboarded' in p) patch.onboarded = p.onboarded === true;
    if ('tray' in p) patch.tray = p.tray === true;
    const prefs = setPrefs(patch);
    if ('theme' in patch) nativeTheme.themeSource = prefs.theme;
    if ('tray' in patch) refreshTray();
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
  handle('hook:get', p => {
    const kind = V.oneOf(p.kind, ['zsh', 'bash'], 'kind');
    return { rc: `eval "$(ca shell-hook ${kind})"`, file: kind === 'zsh' ? '~/.zshrc' : '~/.bashrc' };
  });
}
function cliStatus() {
  const dest = path.join(os.homedir(), '.local', 'bin', IS_WIN ? 'ca.py' : 'ca');
  return { installed: fs.existsSync(dest), path: dest, onPath: userPath.split(path.delimiter).includes(path.dirname(dest)) };
}

// ---------------------------------------------------------------- tray / menu
function trayIcon() {
  const f = path.join(__dirname, '..', 'build', IS_MAC ? 'trayTemplate.png' : 'tray.png');
  const img = nativeImage.createFromPath(f);
  if (IS_MAC) img.setTemplateImage(true);
  return img;
}
function refreshTray() {
  if (!app.isReady()) return;
  if (!getPrefs().tray || (!IS_MAC && !IS_WIN)) { if (tray) { tray.destroy(); tray = null; } return; }
  try {
    if (!tray) { tray = new Tray(trayIcon()); tray.setToolTip('Claude Accounts'); }
    const s = state();
    const repoItems = s.repos.length ? s.repos.map(r => ({
      label: `${r.name}`, sublabel: `${r.account} · ${r.mode}`, toolTip: r.repo, enabled: r.exists,
      click: () => openRepo(r.repo).then(notify, failed),
    })) : [{ label: 'No repositories yet', enabled: false }];
    const accItems = s.accounts.map(a => ({ label: `Open Desktop — ${a.name}`, click: () => launchDesktop(ca.load().accounts[a.name]).then(notify, failed) }));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Repositories', enabled: false }, ...repoItems, { type: 'separator' },
      ...(accItems.length ? [{ label: 'Claude Desktop', submenu: accItems }, { type: 'separator' }] : []),
      { label: 'Show Claude Accounts', click: showWindow }, { label: 'Quit', role: 'quit' },
    ]));
  } catch { /* tray unsupported here */ }
}
function notify(res) { if (win && !win.isDestroyed()) win.webContents.send('app:event', { type: 'toast', ...res }); }
const failed = e => notify({ ok: false, message: e.message });
function send(type, extra = {}) { showWindow(); win.webContents.send('app:event', { type, ...extra }); }
function buildMenu() {
  const dev = !app.isPackaged;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ label: app.name, submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Cmd+,', registerAccelerator: false, click: () => send('nav', { view: 'settings' }) },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Bind Repository…', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => send('bind') },
      { label: 'Add Account…', accelerator: 'CmdOrCtrl+Shift+N', registerAccelerator: false, click: () => send('add-account') },
      { type: 'separator' }, IS_MAC ? { role: 'close' } : { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', registerAccelerator: false, click: () => send('palette') },
      { type: 'separator' },
      { label: 'Repositories', accelerator: 'CmdOrCtrl+1', registerAccelerator: false, click: () => send('nav', { view: 'repos' }) },
      { label: 'Accounts', accelerator: 'CmdOrCtrl+2', registerAccelerator: false, click: () => send('nav', { view: 'accounts' }) },
      { label: 'Settings', accelerator: 'CmdOrCtrl+3', registerAccelerator: false, click: () => send('nav', { view: 'settings' }) },
      { label: 'Refresh Status', accelerator: 'CmdOrCtrl+R', registerAccelerator: false, click: () => send('refresh') },
      ...(dev ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------- window
function createWindow() {
  const mac = IS_MAC || PREVIEW === 'darwin';
  const opts = {
    width: 1200, height: 780, minWidth: 920, minHeight: 600, show: false, title: 'Claude Accounts',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
                      webSecurity: true, spellcheck: false, devTools: !app.isPackaged, webviewTag: false },
  };
  if (IS_MAC) Object.assign(opts, { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' });
  else if (PREVIEW) Object.assign(opts, { frame: false });
  else if (IS_WIN) Object.assign(opts, { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#a1a1a1', height: 44 } });
  win = new BrowserWindow(opts);
  win.loadFile(RENDERER, { query: { platform: PREVIEW || process.platform } });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  const wc = win.webContents;
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-attach-webview', e => e.preventDefault());
}
function showWindow() { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

function watchConfig() {
  let t = null;
  const dir = ca.baseDir();
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  try {
    fs.watch(dir, { persistent: false }, (_e, f) => {
      if (f && f !== 'config.json') return;
      clearTimeout(t); t = setTimeout(() => { refreshTray(); if (win) win.webContents.send('app:event', { type: 'state-changed' }); }, 150);
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
