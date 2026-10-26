'use strict';
// Port of the `ca` prototype's logic. Shares ~/.config/claude-accounts/config.json
// with the Python CLI. Credential files are only stat()ed, never opened.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MODES = ['terminal', 'docker', 'desktop'];
const IMAGE = 'claude-code-ca:latest';
const SYSTEM = { darwin: 'Darwin', win32: 'Windows' }[process.platform] || 'Linux';
// A letter or number first, then letters, numbers, dot, dash or underscore; 64 at most. Same rule in cli/ca.
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Account names become folder names, and Windows can't use these: it drops a trailing dot (so "work." would share
// "work"), and device names such as con or nul, with or without an extension, aren't folders at all.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
// cmd.exe treats these as syntax outside quotes (see winQuote).
const CMD_SPECIAL = /[\s&|<>^(),;=!"%]/;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

const DOCKERFILE = `FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client \\
 && rm -rf /var/lib/apt/lists/* && npm i -g @anthropic-ai/claude-code && npm cache clean --force
USER node
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
WORKDIR /workspace
CMD ["claude"]
`;
// Windows: runs the container from a console that starts in this folder (see windowsDocker) and stays here, outside
// the repository. Paths arrive in environment variables and stay inside quotes, so & ^ ( ) or % in a folder name
// are never read as cmd syntax. Delayed expansion is switched off because a machine can turn it on for every cmd,
// and then ! and ^ would be. The image check and build carry no path, so they use `call`, without which a
// batch-file docker would never return here. `docker run` carries the paths and comes last, without `call`, which
// would expand % and double ^.
const DOCKER_RUN_CMD = [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'rem Written by Claude Accounts on every Docker launch.',
  `call docker image inspect ${IMAGE} >nul 2>&1 || call docker build -t ${IMAGE} . || exit /b 1`,
  'docker run --rm -it --name %CA_CONTAINER% -v "%CA_DOCKER_CONFIG%:/home/node/.claude" -v "%CA_REPO%:/workspace" ' +
    `-w /workspace -e CLAUDE_CONFIG_DIR=/home/node/.claude ${IMAGE} claude %CA_CLAUDE_ARGS%`,
  '',
].join('\r\n');

function configPath() {
  return process.env.CA_CONFIG || path.join(os.homedir(), '.config', 'claude-accounts', 'config.json');
}
function baseDir() { return path.dirname(configPath()); }

function expandUser(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
// Like Python's os.path.realpath: resolves symlinks of the existing prefix, tolerates missing tails.
function norm(p) {
  let abs = path.resolve(expandUser(String(p)));
  const tail = [];
  for (;;) {
    try { const r = fs.realpathSync.native(abs); return tail.length ? path.join(r, ...tail.reverse()) : r; }
    catch { const parent = path.dirname(abs); if (parent === abs) return path.resolve(expandUser(String(p))); tail.push(path.basename(abs)); abs = parent; }
  }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}
function load() {
  const p = configPath();
  if (!fs.existsSync(p)) return { accounts: {}, repos: {} };
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of ['accounts', 'repos']) if (!isObj(cfg[k])) cfg[k] = {};
  return cfg;
}
function save(cfg) {
  fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
  const p = configPath(), tmp = p + '.tmp';
  // same format as Python json.dump(indent=2, sort_keys=True)
  fs.writeFileSync(tmp, JSON.stringify(sortKeys(cfg), null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // the mode above only applies when the file is created; a leftover tmp keeps its own
  fs.renameSync(tmp, p);
}

class CaError extends Error {}

function validAccountName(name) {
  return typeof name === 'string' && ACCOUNT_RE.test(name) && !name.endsWith('.') && !WINDOWS_DEVICE.test(name);
}
function addAccount(cfg, name, configDir, desktopDir, dockerDir) {
  if (!validAccountName(name)) throw new CaError(`invalid account name: ${JSON.stringify(name)}`);
  // folders ignore case on macOS and Windows, so two names that differ only in case would share one login
  const same = Object.keys(cfg.accounts).find(n => n !== name && n.toLowerCase() === name.toLowerCase());
  if (same) throw new CaError(`account ${JSON.stringify(same)} already exists`);
  const root = path.join(baseDir(), 'accounts', name);
  const acc = {
    config_dir: norm(configDir || path.join(root, 'claude')),
    desktop_user_data_dir: norm(desktopDir || path.join(root, 'desktop')),
    // container logins are separate: the macOS Keychain is invisible to a Linux container
    docker_config_dir: norm(dockerDir || path.join(root, 'docker-claude')),
  };
  for (const d of Object.values(acc)) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} }
  cfg.accounts[name] = acc;
  return acc;
}
function removeAccount(cfg, name) {
  if (!hasOwn(cfg.accounts, name)) throw new CaError(`unknown account ${JSON.stringify(name)}`);
  const used = Object.entries(cfg.repos).filter(([, b]) => b.account === name).map(([r]) => r);
  if (used.length) throw new CaError(`account ${name} is still bound to ${used.length} repo(s); rebind or unbind them first`);
  delete cfg.accounts[name]; // folders on disk are kept on purpose
}
function bind(cfg, repo, account, mode = 'terminal') {
  if (!hasOwn(cfg.accounts, account)) throw new CaError(`unknown account ${JSON.stringify(account)}; run: ca add-account ${account}`);
  if (!MODES.includes(mode)) throw new CaError(`mode must be one of ${MODES.join(', ')}`);
  const p = norm(repo);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new CaError(`not a directory: ${p}`);
  cfg.repos[p] = { account, mode };
  return p;
}
function unbind(cfg, repo) { delete cfg.repos[norm(repo)]; }

// The account a binding points to, or a clear error when it is gone from the config.
function accountOf(cfg, binding) {
  if (!hasOwn(cfg.accounts, binding.account))
    throw new CaError(`account ${JSON.stringify(binding.account)} is not configured; add it or bind the repo to another account`);
  return cfg.accounts[binding.account];
}

function findRepo(cfg, p) {
  let cur = norm(p || process.cwd());
  for (;;) {
    if (hasOwn(cfg.repos, cur)) return [cur, cfg.repos[cur]];
    const parent = path.dirname(cur);
    if (parent === cur) return [null, null];
    cur = parent;
  }
}

// ---------------------------------------------------------------- status (existence checks only)
function loginState(acc, system = SYSTEM) {
  const d = acc.config_dir;
  if (fs.existsSync(path.join(d, '.credentials.json'))) return 'logged-in';
  if (system === 'Darwin' && fs.existsSync(path.join(d, '.claude.json'))) return 'keychain?';
  return 'not-logged-in';
}
function dockerLoginState(acc) {
  return fs.existsSync(path.join(acc.docker_config_dir, '.credentials.json')) ? 'logged-in' : 'not-logged-in';
}
// Asks the official CLI (local; prints account/plan, never the token). Only the first line is kept.
function deepStatus(acc, { claude = 'claude', env = process.env, system = SYSTEM } = {}) {
  // Windows: npm installs claude as a .cmd shim, which only cmd can run. The line is fixed text, and cmd runs in a
  // folder of ours (see the Windows launches).
  const win = system === 'Windows';
  const [file, args, opts] = win
    ? [cmdExe(env), ['/d', '/s', '/c', `"${cmdSafe(`${claude} auth status --text`)}"`], { windowsVerbatimArguments: true, cwd: launchDir() }]
    : [claude, ['auth', 'status', '--text'], {}];
  const runEnv = win ? windowsEnv(claudeEnv(acc, env)) : claudeEnv(acc, env);
  return new Promise(resolve => {
    execFile(file, args, { env: runEnv, timeout: 30000, windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (out) return resolve(out.split(/\r?\n/)[0]);
        if (err && err.code === 'ENOENT') return resolve('error: claude CLI not found');
        resolve(err ? `exit ${err.code ?? 'error'}` : 'exit 0');
      });
  });
}

// ---------------------------------------------------------------- commands
// A copy of `base` without the given variables, in any spelling: Windows ignores case in names.
function withoutVars(base, ...names) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !names.includes(k.toUpperCase())));
}
function claudeEnv(acc, base = process.env) {
  // a global ANTHROPIC_API_KEY would override the subscription login
  return { ...withoutVars(base, 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'), CLAUDE_CONFIG_DIR: acc.config_dir };
}
function claudeArgv(worktree = null, extra = []) {
  const argv = ['claude'];
  if (worktree !== null && worktree !== undefined) argv.push('--worktree', ...(worktree ? [worktree] : []));
  return argv.concat(extra);
}
function shQuote(s) { // Python shlex.quote
  s = String(s);
  if (!s) return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}
// One argument for a cmd.exe line that a person copies (the app never runs these through cmd; see windowsConsole).
// Quotes keep & | < > ^ literal; %VAR% still expands inside them, which cmd offers no way around. A double quote
// inside the argument can't be kept: it would end the quoting and expose what follows, so it is refused.
function winQuote(s) {
  s = String(s);
  if (s.includes('"')) throw new CaError(`can't put ${JSON.stringify(s)} in a cmd line: it holds a double quote`);
  if (s && !CMD_SPECIAL.test(s)) return s;
  return `"${s.replace(/\\+$/, m => m + m)}"`; // the program reading it would take \" for an escaped quote
}
function q(s, system = SYSTEM) { return system === 'Windows' ? winQuote(s) : shQuote(s); }

// The Windows lines people copy are for cmd. They start with @, which cmd ignores and PowerShell can't parse: pasted
// there, nothing runs, instead of `set` making PowerShell variables and claude starting on the wrong account. They
// stop cmd from running a program from the current folder by name (see the Windows launches), and pushd also takes
// a network path, where cd can't go.
const WIN_NO_CWD = 'set "NoDefaultCurrentDirectoryInExePath=1"';
function terminalCmd(repo, acc, worktree = null, extra = [], system = SYSTEM) {
  const argv = claudeArgv(worktree, extra).map(a => q(a, system)).join(' ');
  if (system === 'Windows')
    return `@pushd ${q(repo, system)} && ${WIN_NO_CWD} && set "CLAUDE_CONFIG_DIR=${acc.config_dir}" && set "ANTHROPIC_API_KEY=" && ${argv}`;
  return `cd ${q(repo, system)} && env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=${q(acc.config_dir, system)} ${argv}`;
}
function loginCmd(acc, system = SYSTEM) {
  if (system === 'Windows') return `@${WIN_NO_CWD} && set "CLAUDE_CONFIG_DIR=${acc.config_dir}" && set "ANTHROPIC_API_KEY=" && claude auth login`;
  return `env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=${q(acc.config_dir, system)} claude auth login`;
}
function desktopCmd(acc, system = SYSTEM) {
  const ud = acc.desktop_user_data_dir, cd = acc.config_dir;
  if (system === 'Darwin')
    return `open -n -a "Claude" --env CLAUDE_CONFIG_DIR=${shQuote(cd)} --args --user-data-dir=${shQuote(ud)}`;
  if (system === 'Windows')
    return `@set "CLAUDE_CONFIG_DIR=${cd}" && start "" "%LOCALAPPDATA%\\AnthropicClaude\\claude.exe" --user-data-dir="${ud}"`;
  return `# No official Claude Desktop for Linux; use terminal/docker mode.\n# Unofficial builds: CLAUDE_CONFIG_DIR=${shQuote(cd)} claude-desktop --user-data-dir=${shQuote(ud)}`;
}
// argv form used by the app to launch Desktop without a shell
function desktopLaunch(acc, system = SYSTEM, env = process.env) {
  if (system === 'Darwin')
    return { file: 'open', args: ['-n', '-a', 'Claude', '--env', `CLAUDE_CONFIG_DIR=${acc.config_dir}`, '--args', `--user-data-dir=${acc.desktop_user_data_dir}`],
             env: claudeEnv(acc, env) };
  if (system === 'Windows')
    return { file: path.join(env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe'), args: [`--user-data-dir=${acc.desktop_user_data_dir}`],
             env: claudeEnv(acc, env) };
  return null;
}
function containerName(repo) { return 'ca-' + crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8); }
// [build, run] argv for Docker or Apple's `container` CLI (macOS 26, Apple silicon).
function dockerArgv(repo, acc, engine = 'docker', worktree = null, extra = []) {
  return [
    [engine, 'build', '-t', IMAGE, path.join(baseDir(), 'docker')],
    [engine, 'run', '--rm', '-it', '--name', containerName(repo), '-v', `${acc.docker_config_dir}:/home/node/.claude`,
     '-v', `${repo}:/workspace`, '-w', '/workspace', '-e', 'CLAUDE_CONFIG_DIR=/home/node/.claude', IMAGE, ...claudeArgv(worktree, extra)],
  ];
}
function dockerCmds(repo, acc, engine = 'docker', worktree = null, extra = [], system = SYSTEM) {
  const line = argv => argv.map(a => q(a, system)).join(' ');
  const [build, run] = dockerArgv(repo, acc, engine, worktree, extra);
  return [path.join(baseDir(), 'docker'), line(build), line(run)];
}
function writeDockerfile() {
  const ctx = path.join(baseDir(), 'docker');
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, 'Dockerfile'), DOCKERFILE);
  fs.writeFileSync(path.join(ctx, 'run.cmd'), DOCKER_RUN_CMD);
  return ctx;
}

// ---------------------------------------------------------------- Windows launches
// cmd.exe parses its command line, & | < > ^ % included, even when they come from a folder name. So the line it runs
// is fixed text plus checked tokens, and paths travel in environment variables that the .cmd launchers expand
// inside quotes.
// Windows also runs a program from the current folder before PATH, and a repository could hold its own cmd.exe,
// claude.cmd, or node.cmd: npm's claude.cmd runs node by name. So cmd.exe is started by its full path, and every cmd
// starts in a folder of ours. The one that moves into the repository, open.cmd, sets
// NoDefaultCurrentDirectoryInExePath before it runs anything there, which stops cmd from looking in the current
// folder. That doesn't cover a PATH entry such as "." or "\tools", which cmd reads against the current folder, so
// PATH keeps only absolute entries.
function cmdSafe(text) {
  if (!/^[A-Za-z0-9 ._\/:-]*$/.test(text)) throw new CaError(`refusing to pass ${JSON.stringify(text)} through cmd`);
  return text;
}
// The real cmd.exe, by full path: spawn looks for a bare name in the child's working folder first.
function cmdExe(env = process.env) {
  const root = Object.entries(env).find(([k]) => k.toUpperCase() === 'SYSTEMROOT');
  return path.win32.join(root ? root[1] : 'C:\\Windows', 'System32', 'cmd.exe');
}
// The PATH entries that name a drive or a server. Same rule in cli/ca.
function absoluteDirs(value = '') {
  return value.split(';').filter(d => /^"?([A-Za-z]:[\\/]|\\\\[^\\/])/.test(d)).join(';');
}
function windowsEnv(env) {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k.toUpperCase() === 'PATH' ? absoluteDirs(v) : v]));
}
// Where consoles start. Nothing in it can stand in for cmd, claude or node.
function launchDir() {
  const dir = path.join(baseDir(), 'launch');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
// spawn(file, args, options) for a new console window running `line`. `start` gives it its own console, so it
// outlives the app; the caller adds detached and stdio. /v:off for the reason given at DOCKER_RUN_CMD.
function windowsConsole(line, cwd, env) {
  return { file: cmdExe(env), args: ['/d', '/s', '/c', `"start "Claude" cmd /d /v:off /k ${cmdSafe(line)}"`],
           options: { cwd, env: windowsEnv(env), windowsVerbatimArguments: true } };
}
// A console that runs one of our launchers from the folder it lives in. A machine can set
// NoDefaultCurrentDirectoryInExePath for every program, and cmd would then not find the launcher there.
function windowsLauncher(name, dir, env) {
  return windowsConsole(`call ${name}`, dir, withoutVars(env, 'NODEFAULTCURRENTDIRECTORYINEXEPATH'));
}
// Starts Claude Code in the repository. pushd also takes a network path (\\server\share), where cmd can't start.
// From then on cmd runs nothing from the repository by name, and the console keeps that rule after Claude Code
// exits: a program from the repository runs as .\name. `call` comes back here when Claude Code exits; it reads the
// line twice, which cmdSafe arguments survive. For a network path pushd took a drive letter, which popd gives back.
// A Ctrl+C that reaches cmd while Claude Code isn't reading keys asks "Terminate batch job (Y/N)?". Answering Y,
// or closing the window, skips popd, and the letter stays taken until you sign out.
const OPEN_CMD = [
  '@echo off',
  'rem Written by Claude Accounts on every launch.',
  'pushd "%CA_REPO%" || exit /b 1',
  'set NoDefaultCurrentDirectoryInExePath=1',
  'call claude %CA_CLAUDE_ARGS%',
  'if "%CA_REPO:~0,2%"=="\\\\" popd',
  '',
].join('\r\n');
function windowsTerminal(repo, acc, worktree = null, base = process.env) {
  const dir = launchDir();
  fs.writeFileSync(path.join(dir, 'open.cmd'), OPEN_CMD);
  const env = { ...claudeEnv(acc, base), CA_REPO: repo, CA_CLAUDE_ARGS: cmdSafe(claudeArgv(worktree).slice(1).join(' ')) };
  return windowsLauncher('open.cmd', dir, env);
}
function windowsLogin(acc, base = process.env) {
  return windowsConsole('claude auth login', launchDir(), claudeEnv(acc, base));
}
function windowsDocker(repo, acc, worktree = null, base = process.env) {
  const env = { ...withoutVars(base, 'ANTHROPIC_API_KEY'), CA_REPO: repo, CA_DOCKER_CONFIG: acc.docker_config_dir,
                CA_CONTAINER: containerName(repo), CA_CLAUDE_ARGS: cmdSafe(claudeArgv(worktree).slice(1).join(' ')) };
  return windowsLauncher('run.cmd', writeDockerfile(), env);
}

// `caCommand` is how the shell should invoke the CLI (e.g. "ca" or "python3 /path/ca").
function shellHook(kind, { cfg, repo, caCommand = 'ca' } = {}) {
  if (kind === 'direnv') {
    cfg = cfg || load();
    const [, b] = findRepo(cfg, repo);
    if (!b) throw new CaError('repo not bound; run: ca bind <repo> <account>');
    return `export CLAUDE_CONFIG_DIR=${shQuote(accountOf(cfg, b).config_dir)}`;
  }
  const fn = `_ca_hook() { eval "$(${caCommand} env --shell)"; }`;
  if (kind === 'zsh') return fn + '\nautoload -U add-zsh-hook; add-zsh-hook chpwd _ca_hook; _ca_hook';
  if (kind === 'bash') return fn + '\nPROMPT_COMMAND="_ca_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"';
  throw new CaError('kind must be direnv|zsh|bash');
}
// The shell hook keeps a CLAUDE_CONFIG_DIR you set yourself: it is saved when you enter a bound repo and put back
// when you leave, and a shell that never entered one is left alone. Same text as env_shell in cli/ca.
const ENV_ENTER = 'if [ -z "${CA_ACCOUNT+x}" ] && [ -n "${CLAUDE_CONFIG_DIR+x}" ]; then ' +
  'export CA_OUTER_CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"; fi; ';
const ENV_LEAVE = 'if [ -n "${CA_ACCOUNT+x}" ]; then if [ -n "${CA_OUTER_CLAUDE_CONFIG_DIR+x}" ]; then ' +
  'export CLAUDE_CONFIG_DIR="$CA_OUTER_CLAUDE_CONFIG_DIR"; else unset CLAUDE_CONFIG_DIR; fi; ' +
  'unset CA_ACCOUNT CA_OUTER_CLAUDE_CONFIG_DIR; fi';
function envShell(cfg, p) {
  const [, b] = findRepo(cfg, p);
  if (b && hasOwn(cfg.accounts, b.account))
    return `${ENV_ENTER}export CLAUDE_CONFIG_DIR=${shQuote(cfg.accounts[b.account].config_dir)}; export CA_ACCOUNT=${shQuote(b.account)}`;
  return ENV_LEAVE;
}
function commandFor(repo, b, cfg, system = SYSTEM) {
  const acc = cfg.accounts[b.account];
  const mode = b.mode || 'terminal';
  if (mode === 'docker') return dockerCmds(repo, acc, 'docker', null, [], system)[2];
  if (mode === 'desktop') return desktopCmd(acc, system);
  return terminalCmd(repo, acc, null, [], system);
}
function rows(cfg, system = SYSTEM) {
  return Object.keys(cfg.repos).sort().map(p => {
    const b = cfg.repos[p], acc = hasOwn(cfg.accounts, b.account) ? cfg.accounts[b.account] : null;
    const mode = b.mode || 'terminal';
    let exists = false; try { exists = fs.statSync(p).isDirectory(); } catch {}
    return {
      repo: p, name: path.basename(p) || p, account: b.account, mode, exists,
      login: acc ? (mode === 'docker' ? dockerLoginState(acc) : loginState(acc, system)) : 'missing-account',
      command: acc ? commandFor(p, b, cfg, system) : '',
    };
  });
}

module.exports = {
  MODES, IMAGE, SYSTEM, DOCKERFILE, DOCKER_RUN_CMD, CaError, configPath, baseDir, norm, load, save, validAccountName,
  addAccount, removeAccount, bind, unbind, accountOf, findRepo, loginState, dockerLoginState, deepStatus, claudeEnv,
  claudeArgv, shQuote, winQuote, q, terminalCmd, loginCmd, desktopCmd, desktopLaunch, dockerArgv, dockerCmds,
  writeDockerfile, cmdSafe, cmdExe, OPEN_CMD, withoutVars, absoluteDirs, windowsEnv, launchDir, windowsConsole,
  windowsTerminal, windowsLogin, windowsDocker,
  shellHook, envShell,
  commandFor, rows, containerName,
};
