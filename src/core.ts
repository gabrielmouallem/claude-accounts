// Config handling and command building, for the app and the ca CLI (cli/ca.ts) alike. Both read and write
// ~/.config/claude-accounts/config.json. Credential files are only stat()ed, never opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Account, AuthStatus, Binding, Config, Engine, LoginState, Mode, Row, System } from './types.ts';

export type Env = Record<string, string | undefined>;

export const MODES = ['terminal', 'docker', 'desktop'] as const satisfies readonly Mode[];
export const IMAGE = 'claude-code-ca:latest';
export const SYSTEM: System = process.platform === 'darwin' ? 'Darwin' : process.platform === 'win32' ? 'Windows' : 'Linux';
// A letter or number first, then letters, numbers, dot, dash or underscore; 64 at most.
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A worktree name for `claude --worktree`, up to 100 characters and not an option. Empty lets Claude Code pick one.
export const WORKTREE = /^(?!-)[A-Za-z0-9._/-]{0,100}$/;
// Account names become folder names, and Windows can't use these: it drops a trailing dot (so "work." would share
// "work"), and device names such as con or nul, with or without an extension, aren't folders at all.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
// cmd.exe treats these as syntax outside quotes (see winQuote).
const CMD_SPECIAL = /[\s&|<>^(),;=!"%]/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isMode = (v: unknown): v is Mode => (MODES as readonly unknown[]).includes(v);

export const DOCKERFILE = `FROM node:24-slim
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
export const DOCKER_RUN_CMD = [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'rem Written by Claude Accounts on every Docker launch.',
  `call docker image inspect ${IMAGE} >nul 2>&1 || call docker build -t ${IMAGE} . || exit /b 1`,
  'docker run --rm -it --name %CA_CONTAINER% -v "%CA_DOCKER_CONFIG%:/home/node/.claude" -v "%CA_REPO%:/workspace" ' +
    `-w /workspace -e CLAUDE_CONFIG_DIR=/home/node/.claude ${IMAGE} claude %CA_CLAUDE_ARGS%`,
  '',
].join('\r\n');

export function configPath(): string {
  return process.env.CA_CONFIG || path.join(os.homedir(), '.config', 'claude-accounts', 'config.json');
}
export function baseDir(): string { return path.dirname(configPath()); }

function expandUser(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
// Like Python's os.path.realpath: resolves symlinks of the existing prefix, tolerates missing tails.
export function norm(p: string): string {
  let abs = path.resolve(expandUser(String(p)));
  const tail: string[] = [];
  for (;;) {
    try { const r = fs.realpathSync.native(abs); return tail.length ? path.join(r, ...tail.reverse()) : r; }
    catch { const parent = path.dirname(abs); if (parent === abs) return path.resolve(expandUser(String(p))); tail.push(path.basename(abs)); abs = parent; }
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}
export function load(): Config {
  const p = configPath();
  if (!fs.existsSync(p)) return { accounts: {}, repos: {} };
  let cfg: unknown;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (e instanceof SyntaxError) throw new CaError(`${p} isn't valid JSON (${e.message}); fix it or move it away`); throw e; }
  if (!isObj(cfg)) throw new CaError(`${p} doesn't hold a JSON object; fix it or move it away`);
  for (const k of ['accounts', 'repos']) if (!isObj(cfg[k])) cfg[k] = {};
  return cfg as unknown as Config;
}
export function save(cfg: Config): void {
  fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
  const p = configPath(), tmp = p + '.tmp';
  // same format as Python json.dump(indent=2, sort_keys=True)
  fs.writeFileSync(tmp, JSON.stringify(sortKeys(cfg), null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // the mode above only applies when the file is created; a leftover tmp keeps its own
  fs.renameSync(tmp, p);
}

export class CaError extends Error {}

export function validAccountName(name: unknown): name is string {
  return typeof name === 'string' && ACCOUNT_RE.test(name) && !name.endsWith('.') && !WINDOWS_DEVICE.test(name);
}
export function addAccount(cfg: Config, name: string, configDir?: string, desktopDir?: string, dockerDir?: string): Account {
  if (!validAccountName(name)) throw new CaError(`invalid account name: ${JSON.stringify(name)}`);
  // folders ignore case on macOS and Windows, so two names that differ only in case would share one login
  const same = Object.keys(cfg.accounts).find(n => n !== name && n.toLowerCase() === name.toLowerCase());
  if (same) throw new CaError(`account ${JSON.stringify(same)} already exists`);
  // Adding an account that exists keeps its folders, except the ones given. A new account gets folders of its own: a
  // renamed account keeps its folders and a removed one leaves them behind, so the folder named after this account can
  // still hold another account's sign-in.
  const had = Object.hasOwn(cfg.accounts, name) ? cfg.accounts[name] : undefined;
  let root = path.join(baseDir(), 'accounts', name);
  if (!had) for (let i = 2; inUse(cfg, root) || fs.existsSync(root); i++) root = path.join(baseDir(), 'accounts', `${name}-${i}`);
  const acc: Account = {
    config_dir: norm(configDir || had?.config_dir || path.join(root, 'claude')),
    desktop_user_data_dir: norm(desktopDir || had?.desktop_user_data_dir || path.join(root, 'desktop')),
    // container logins are separate: the macOS Keychain is invisible to a Linux container
    docker_config_dir: norm(dockerDir || had?.docker_config_dir || path.join(root, 'docker-claude')),
  };
  for (const d of Object.values(acc)) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch {} }
  cfg.accounts[name] = acc;
  return acc;
}
export function removeAccount(cfg: Config, name: string): void {
  if (!Object.hasOwn(cfg.accounts, name)) throw new CaError(`unknown account ${JSON.stringify(name)}`);
  const used = Object.entries(cfg.repos).filter(([, b]) => b.account === name).map(([r]) => r);
  if (used.length) throw new CaError(`account ${name} is still bound to ${used.length} repo(s); rebind or unbind them first`);
  delete cfg.accounts[name]; // folders on disk are kept on purpose
}
// Whether an account's folders are `dir` or inside it, compared as real paths (a temp folder on macOS is a symlink
// into /private). Folder names ignore case on macOS and Windows.
function inUse(cfg: Config, dir: string): boolean {
  const d = norm(dir).toLowerCase();
  return Object.values(cfg.accounts).some(a => [a.config_dir, a.desktop_user_data_dir, a.docker_config_dir]
    .some(p => { const l = norm(p).toLowerCase(); return l === d || l.startsWith(d + path.sep); }));
}
// The repositories bound to the account move with it. Its folders stay where they are: Claude Code finds a macOS
// sign-in in the Keychain by the folder's path, so moving them would sign the account out.
export function renameAccount(cfg: Config, from: string, to: string): void {
  if (!Object.hasOwn(cfg.accounts, from)) throw new CaError(`unknown account ${JSON.stringify(from)}`);
  if (!validAccountName(to)) throw new CaError(`invalid account name: ${JSON.stringify(to)}`);
  if (to === from) return;
  const same = Object.keys(cfg.accounts).find(n => n !== from && n.toLowerCase() === to.toLowerCase());
  if (same) throw new CaError(`account ${JSON.stringify(same)} already exists`);
  cfg.accounts[to] = cfg.accounts[from]!;
  delete cfg.accounts[from];
  for (const b of Object.values(cfg.repos)) if (b.account === from) b.account = to;
}
export function bind(cfg: Config, repo: string, account: string, mode: string = 'terminal'): string {
  if (!Object.hasOwn(cfg.accounts, account)) throw new CaError(`unknown account ${JSON.stringify(account)}; run: ca add-account ${account}`);
  if (!isMode(mode)) throw new CaError(`mode must be one of ${MODES.join(', ')}`);
  const p = norm(repo);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new CaError(`not a directory: ${p}`);
  cfg.repos[p] = { account, mode };
  return p;
}
export function unbind(cfg: Config, repo: string): void { delete cfg.repos[norm(repo)]; }

// The account a binding points to, or a clear error when it is gone from the config.
export function accountOf(cfg: Config, binding: Binding): Account {
  const acc = Object.hasOwn(cfg.accounts, binding.account) ? cfg.accounts[binding.account] : undefined;
  if (!acc) throw new CaError(`account ${JSON.stringify(binding.account)} is not configured; add it or bind the repo to another account`);
  return acc;
}

export function findRepo(cfg: Config, p?: string): [string, Binding] | [null, null] {
  let cur = norm(p || process.cwd());
  for (;;) {
    const b = Object.hasOwn(cfg.repos, cur) ? cfg.repos[cur] : undefined;
    if (b) return [cur, b];
    const parent = path.dirname(cur);
    if (parent === cur) return [null, null];
    cur = parent;
  }
}

// ---------------------------------------------------------------- status (existence checks only)
export function loginState(acc: Account, system: System = SYSTEM): LoginState {
  const d = acc.config_dir;
  if (fs.existsSync(path.join(d, '.credentials.json'))) return 'logged-in';
  if (system === 'Darwin' && fs.existsSync(path.join(d, '.claude.json'))) return 'keychain?';
  return 'not-logged-in';
}
export function dockerLoginState(acc: Account): LoginState {
  return fs.existsSync(path.join(acc.docker_config_dir, '.credentials.json')) ? 'logged-in' : 'not-logged-in';
}
// A Desktop folder with nothing in it has never been opened, so that window isn't signed in yet. Only the names of
// its entries are read.
export function desktopNeverOpened(acc: Account): boolean {
  try { return fs.readdirSync(acc.desktop_user_data_dir).length === 0; } catch { return true; }
}
// What turns off Claude Code's traffic beyond the work asked of it: analytics, error reports, update checks, and the
// crash reports of the Bun runtime it is built on
const QUIET = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
// Asks the official CLI who the account is signed in as. It reads the account's folder and the Keychain and prints
// the email and plan, never the token. It runs with QUIET, since nobody asked for this run; like any claude command,
// it may still renew a sign-in that has expired.
export function authStatus(acc: Account, { claude = 'claude', env = process.env, system = SYSTEM }: { claude?: string; env?: Env; system?: System } = {}): Promise<AuthStatus> {
  // It runs from the home folder, never from a repository the caller happens to be in. Windows: npm installs claude
  // as a .cmd shim, which only cmd can run. The line is fixed text, and cmd runs in a folder of ours (see the Windows
  // launches).
  const win = system === 'Windows';
  const [file, args, opts] = win
    ? [cmdExe(env), ['/d', '/s', '/c', `"${cmdSafe(`${claude} auth status`)}"`], { windowsVerbatimArguments: true, cwd: launchDir() }]
    : [claude, ['auth', 'status'], { cwd: os.homedir() }];
  const quiet = { ...withoutVars(claudeEnv(acc, env), ...Object.keys(QUIET)), ...QUIET };
  const runEnv = win ? windowsEnv(quiet) : quiet;
  return new Promise(resolve => {
    execFile(file, args, { env: runEnv, timeout: 30000, windowsHide: true, ...opts },
      (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (out) return resolve(parseAuthStatus(out));
        const note = err && err.code === 'ENOENT' ? 'error: claude CLI not found' : err ? `exit ${err.code ?? 'error'}` : 'exit 0';
        resolve({ state: null, email: null, plan: null, org: null, note });
      });
  });
}
// `claude auth status` prints JSON ({ loggedIn, email, subscriptionType, orgName, … }), which a notice may follow.
// Older versions print text, whose first line is "Login method: …" or "Not logged in…". Only those four fields are
// kept, and none of the answer's text: the note is always one of the fixed ones below.
export function parseAuthStatus(out: string): AuthStatus {
  const none = { email: null, plan: null, org: null };
  const j = jsonObject(out);
  if (j && typeof j.loggedIn === 'boolean') {
    if (!j.loggedIn) return { state: 'not-logged-in', ...none, note: 'not signed in' };
    const str = (v: unknown) => typeof v === 'string' && v.trim() && !/[\x00-\x1f\x7f]/.test(v) ? v.trim().slice(0, 200) : null;
    const email = str(j.email), plan = str(j.subscriptionType), org = str(j.orgName);
    return { state: 'logged-in', email, plan, org, note: `signed in${email ? ` as ${email}` : ''}${plan ? ` (${plan})` : ''}` };
  }
  const line = (out.split(/\r?\n/)[0] ?? '').trim();
  if (/^not logged in/i.test(line)) return { state: 'not-logged-in', ...none, note: 'not signed in' };
  if (/^login method:/i.test(line)) return { state: 'logged-in', ...none, note: 'signed in' };
  return { state: null, ...none, note: 'unrecognized answer' };
}
// The JSON object in `out`: all of it, or from its first { to its last }
function jsonObject(out: string): Record<string, unknown> | null {
  for (const text of [out, out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)]) {
    try { const j: unknown = JSON.parse(text); if (isObj(j)) return j; } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- commands
// A copy of `base` without the given variables, in any spelling: Windows ignores case in names.
export function withoutVars(base: Env, ...names: string[]): Env {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !names.includes(k.toUpperCase())));
}
export function claudeEnv(acc: Account, base: Env = process.env): Env {
  // a global ANTHROPIC_API_KEY would override the subscription login
  return { ...withoutVars(base, 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'), CLAUDE_CONFIG_DIR: acc.config_dir };
}
// `worktree`: null for none, '' to let Claude Code name it
export function claudeArgv(worktree: string | null = null, extra: readonly string[] = []): string[] {
  const argv = ['claude'];
  if (worktree !== null) argv.push('--worktree', ...(worktree ? [worktree] : []));
  return argv.concat(extra);
}
// The absolute entries of a PATH (macOS and Linux). "." or an empty entry means the current folder, which for the CLI
// is often the repository, and a repository could hold its own claude, or a node for npm's claude to run.
export function posixDirs(value = ''): string { return value.split(':').filter(d => d.startsWith('/')).join(':'); }
// A program from PATH by its full path, or null. The CLI doesn't run on Windows.
export function program(name: string, env: Env = process.env): string | null {
  for (const dir of posixDirs(env.PATH).split(':').filter(Boolean)) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch {}
  }
  return null;
}
// The `ca` people run: a small script the app installs, which starts the executable at `program`. ca is a Bun
// executable, and Bun uploads a report when it crashes unless DO_NOT_TRACK is set before it starts, which ca can't do
// for itself. The script hands the caller's own DO_NOT_TRACK to ca, which gives it back to the programs it runs.
export function cliWrapper(program: string): string {
  return ['#!/bin/sh',
    '# ca, installed by Claude Accounts. It runs the program below with DO_NOT_TRACK=1, which turns off the crash reports',
    '# of the Bun runtime inside it. The programs ca starts get your own DO_NOT_TRACK back.',
    'if [ -n "${DO_NOT_TRACK+x}" ]; then CA_CALLER_DO_NOT_TRACK="=$DO_NOT_TRACK"; else CA_CALLER_DO_NOT_TRACK=; fi',
    'export CA_WRAPPER="$0" CA_CALLER_DO_NOT_TRACK DO_NOT_TRACK=1',
    `exec ${shQuote(program)} "$@"`, ''].join('\n');
}
export function shQuote(s: string): string { // Python shlex.quote
  s = String(s);
  if (!s) return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}
// One argument for a cmd.exe line that a person copies (the app never runs these through cmd; see windowsConsole).
// Quotes keep & | < > ^ literal; %VAR% still expands inside them, which cmd offers no way around. A double quote
// inside the argument can't be kept: it would end the quoting and expose what follows, so it is refused.
export function winQuote(s: string): string {
  s = String(s);
  if (s.includes('"')) throw new CaError(`can't put ${JSON.stringify(s)} in a cmd line: it holds a double quote`);
  if (s && !CMD_SPECIAL.test(s)) return s;
  return `"${s.replace(/\\+$/, m => m + m)}"`; // the program reading it would take \" for an escaped quote
}
export function q(s: string, system: System = SYSTEM): string { return system === 'Windows' ? winQuote(s) : shQuote(s); }

// The Windows lines people copy are for cmd. They start with @, which cmd ignores and PowerShell can't parse: pasted
// there, nothing runs, instead of `set` making PowerShell variables and claude starting on the wrong account. They
// stop cmd from running a program from the current folder by name (see the Windows launches), and pushd also takes
// a network path, where cd can't go.
const WIN_NO_CWD = 'set "NoDefaultCurrentDirectoryInExePath=1"';
export function terminalCmd(repo: string, acc: Account, worktree: string | null = null, extra: readonly string[] = [], system: System = SYSTEM): string {
  const argv = claudeArgv(worktree, extra).map(a => q(a, system)).join(' ');
  if (system === 'Windows')
    return `@pushd ${q(repo, system)} && ${WIN_NO_CWD} && set "CLAUDE_CONFIG_DIR=${acc.config_dir}" && set "ANTHROPIC_API_KEY=" && ${argv}`;
  return `cd ${q(repo, system)} && env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=${q(acc.config_dir, system)} ${argv}`;
}
export function loginCmd(acc: Account, system: System = SYSTEM): string {
  if (system === 'Windows') return `@${WIN_NO_CWD} && set "CLAUDE_CONFIG_DIR=${acc.config_dir}" && set "ANTHROPIC_API_KEY=" && claude auth login`;
  // From home, like `ca login`: a window Terminal reopens can start in a repository
  return `cd ~ && env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=${q(acc.config_dir, system)} claude auth login`;
}
export function desktopCmd(acc: Account, system: System = SYSTEM): string {
  const ud = acc.desktop_user_data_dir, cd = acc.config_dir;
  if (system === 'Darwin')
    return `open -n -a "Claude" --env CLAUDE_CONFIG_DIR=${shQuote(cd)} --args --user-data-dir=${shQuote(ud)}`;
  if (system === 'Windows')
    return `@set "CLAUDE_CONFIG_DIR=${cd}" && start "" "%LOCALAPPDATA%\\AnthropicClaude\\claude.exe" --user-data-dir="${ud}"`;
  return `# No official Claude Desktop for Linux; use terminal/docker mode.\n# Unofficial builds: CLAUDE_CONFIG_DIR=${shQuote(cd)} claude-desktop --user-data-dir=${shQuote(ud)}`;
}
// argv form used by the app to launch Desktop without a shell
export function desktopLaunch(acc: Account, system: System = SYSTEM, env: Env = process.env): { file: string; args: string[]; env: Env } | null {
  if (system === 'Darwin')
    return { file: 'open', args: ['-n', '-a', 'Claude', '--env', `CLAUDE_CONFIG_DIR=${acc.config_dir}`, '--args', `--user-data-dir=${acc.desktop_user_data_dir}`],
             env: claudeEnv(acc, env) };
  if (system === 'Windows')
    return { file: path.join(env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe'), args: [`--user-data-dir=${acc.desktop_user_data_dir}`],
             env: claudeEnv(acc, env) };
  return null;
}
export function containerName(repo: string): string { return 'ca-' + crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8); }
// [build, run] argv for Docker or Apple's `container` CLI (macOS 26, Apple silicon).
export function dockerArgv(repo: string, acc: Account, engine: Engine = 'docker', worktree: string | null = null, extra: readonly string[] = []): [string[], string[]] {
  return [
    [engine, 'build', '-t', IMAGE, path.join(baseDir(), 'docker')],
    [engine, 'run', '--rm', '-it', '--name', containerName(repo), '-v', `${acc.docker_config_dir}:/home/node/.claude`,
     '-v', `${repo}:/workspace`, '-w', '/workspace', '-e', 'CLAUDE_CONFIG_DIR=/home/node/.claude', IMAGE, ...claudeArgv(worktree, extra)],
  ];
}
// [build folder, build line, run line]
export function dockerCmds(repo: string, acc: Account, engine: Engine = 'docker', worktree: string | null = null, extra: readonly string[] = [], system: System = SYSTEM): [string, string, string] {
  const line = (argv: string[]) => argv.map(a => q(a, system)).join(' ');
  const [build, run] = dockerArgv(repo, acc, engine, worktree, extra);
  return [path.join(baseDir(), 'docker'), line(build), line(run)];
}
export function writeDockerfile(): string {
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
export function cmdSafe(text: string): string {
  if (!/^[A-Za-z0-9 ._\/:-]*$/.test(text)) throw new CaError(`refusing to pass ${JSON.stringify(text)} through cmd`);
  return text;
}
// The real cmd.exe, by full path: spawn looks for a bare name in the child's working folder first. An empty
// SystemRoot would make the path relative, so it counts as unset.
export function cmdExe(env: Env = process.env): string {
  const root = Object.entries(env).find(([k]) => k.toUpperCase() === 'SYSTEMROOT')?.[1];
  return path.win32.join(root || 'C:\\Windows', 'System32', 'cmd.exe');
}
// The PATH entries that name a drive or a server
export function absoluteDirs(value = ''): string {
  return value.split(';').filter(d => /^"?([A-Za-z]:[\\/]|\\\\[^\\/])/.test(d)).join(';');
}
export function windowsEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, k.toUpperCase() === 'PATH' ? absoluteDirs(v) : v]));
}
// Where consoles start. Nothing in it can stand in for cmd, claude or node.
export function launchDir(): string {
  const dir = path.join(baseDir(), 'launch');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
// spawn(file, args, options) for a new console window
export interface WinLaunch { file: string; args: string[]; options: { cwd: string; env: Env; windowsVerbatimArguments: true } }
// A new console window running `line`. `start` gives it its own console, so it outlives the app; the caller adds
// detached and stdio. /v:off for the reason given at DOCKER_RUN_CMD.
export function windowsConsole(line: string, cwd: string, env: Env): WinLaunch {
  return { file: cmdExe(env), args: ['/d', '/s', '/c', `"start "Claude" cmd /d /v:off /k ${cmdSafe(line)}"`],
           options: { cwd, env: windowsEnv(env), windowsVerbatimArguments: true } };
}
// A console that runs one of our launchers from the folder it lives in. A machine can set
// NoDefaultCurrentDirectoryInExePath for every program, and cmd would then not find the launcher there.
function windowsLauncher(name: string, dir: string, env: Env): WinLaunch {
  return windowsConsole(`call ${name}`, dir, withoutVars(env, 'NODEFAULTCURRENTDIRECTORYINEXEPATH'));
}
// Starts Claude Code in the repository. pushd also takes a network path (\\server\share), where cmd can't start.
// From then on cmd runs nothing from the repository by name, and the console keeps that rule after Claude Code
// exits: a program from the repository runs as .\name. `call` comes back here when Claude Code exits; it reads the
// line twice, which cmdSafe arguments survive. For a network path pushd took a drive letter, which popd gives back.
// A Ctrl+C that reaches cmd while Claude Code isn't reading keys asks "Terminate batch job (Y/N)?". Answering Y,
// or closing the window, skips popd, and the letter stays taken until you sign out.
export const OPEN_CMD = [
  '@echo off',
  'rem Written by Claude Accounts on every launch.',
  'pushd "%CA_REPO%" || exit /b 1',
  'set NoDefaultCurrentDirectoryInExePath=1',
  'call claude %CA_CLAUDE_ARGS%',
  'if "%CA_REPO:~0,2%"=="\\\\" popd',
  '',
].join('\r\n');
export function windowsTerminal(repo: string, acc: Account, worktree: string | null = null, base: Env = process.env): WinLaunch {
  const dir = launchDir();
  fs.writeFileSync(path.join(dir, 'open.cmd'), OPEN_CMD);
  const env = { ...claudeEnv(acc, base), CA_REPO: repo, CA_CLAUDE_ARGS: cmdSafe(claudeArgv(worktree).slice(1).join(' ')) };
  return windowsLauncher('open.cmd', dir, env);
}
export function windowsLogin(acc: Account, base: Env = process.env): WinLaunch {
  return windowsConsole('claude auth login', launchDir(), claudeEnv(acc, base));
}
export function windowsDocker(repo: string, acc: Account, worktree: string | null = null, base: Env = process.env): WinLaunch {
  const env = { ...withoutVars(base, 'ANTHROPIC_API_KEY'), CA_REPO: repo, CA_DOCKER_CONFIG: acc.docker_config_dir,
                CA_CONTAINER: containerName(repo), CA_CLAUDE_ARGS: cmdSafe(claudeArgv(worktree).slice(1).join(' ')) };
  return windowsLauncher('run.cmd', writeDockerfile(), env);
}

// `caCommand` is how the shell should run the CLI: "ca", or its full path, already quoted.
export function shellHook(kind: string, { cfg, repo, caCommand = 'ca' }: { cfg?: Config; repo?: string; caCommand?: string } = {}): string {
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
// when you leave, and a shell that never entered one is left alone.
const ENV_ENTER = 'if [ -z "${CA_ACCOUNT+x}" ] && [ -n "${CLAUDE_CONFIG_DIR+x}" ]; then ' +
  'export CA_OUTER_CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"; fi; ';
const ENV_LEAVE = 'if [ -n "${CA_ACCOUNT+x}" ]; then if [ -n "${CA_OUTER_CLAUDE_CONFIG_DIR+x}" ]; then ' +
  'export CLAUDE_CONFIG_DIR="$CA_OUTER_CLAUDE_CONFIG_DIR"; else unset CLAUDE_CONFIG_DIR; fi; ' +
  'unset CA_ACCOUNT CA_OUTER_CLAUDE_CONFIG_DIR; fi';
export function envShell(cfg: Config, p?: string): string {
  const [, b] = findRepo(cfg, p);
  const acc = b && Object.hasOwn(cfg.accounts, b.account) ? cfg.accounts[b.account] : undefined;
  if (b && acc) return `${ENV_ENTER}export CLAUDE_CONFIG_DIR=${shQuote(acc.config_dir)}; export CA_ACCOUNT=${shQuote(b.account)}`;
  return ENV_LEAVE;
}
export function commandFor(repo: string, b: Binding, cfg: Config, system: System = SYSTEM): string {
  const acc = accountOf(cfg, b);
  const mode = b.mode || 'terminal';
  if (mode === 'docker') return dockerCmds(repo, acc, 'docker', null, [], system)[2];
  if (mode === 'desktop') return desktopCmd(acc, system);
  return terminalCmd(repo, acc, null, [], system);
}
export function rows(cfg: Config, system: System = SYSTEM): Row[] {
  return Object.keys(cfg.repos).sort().map(p => {
    const b = cfg.repos[p]!, acc = Object.hasOwn(cfg.accounts, b.account) ? cfg.accounts[b.account] : undefined;
    const mode = b.mode || 'terminal';
    let exists = false; try { exists = fs.statSync(p).isDirectory(); } catch {}
    return {
      repo: p, name: path.basename(p) || p, account: b.account, mode, exists,
      login: acc ? (mode === 'docker' ? dockerLoginState(acc) : loginState(acc, system)) : 'missing-account',
      command: acc ? commandFor(p, b, cfg, system) : '',
    };
  });
}
