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
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const DOCKERFILE = `FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client \\
 && rm -rf /var/lib/apt/lists/* && npm i -g @anthropic-ai/claude-code && npm cache clean --force
USER node
ENV CLAUDE_CONFIG_DIR=/home/node/.claude
WORKDIR /workspace
CMD ["claude"]
`;

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
  if (!cfg.accounts || typeof cfg.accounts !== 'object') cfg.accounts = {};
  if (!cfg.repos || typeof cfg.repos !== 'object') cfg.repos = {};
  return cfg;
}
function save(cfg) {
  fs.mkdirSync(baseDir(), { recursive: true, mode: 0o700 });
  const p = configPath(), tmp = p + '.tmp';
  // same format as Python json.dump(indent=2, sort_keys=True)
  fs.writeFileSync(tmp, JSON.stringify(sortKeys(cfg), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

class CaError extends Error {}

function validAccountName(name) {
  return typeof name === 'string' && ACCOUNT_RE.test(name) && !/[\/\\ ]/.test(name);
}
function addAccount(cfg, name, configDir, desktopDir, dockerDir) {
  if (!name || /[\/\\ ]/.test(name) || !validAccountName(name)) throw new CaError(`invalid account name: ${JSON.stringify(name)}`);
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
  if (!(name in cfg.accounts)) throw new CaError(`unknown account ${JSON.stringify(name)}`);
  const used = Object.entries(cfg.repos).filter(([, b]) => b.account === name).map(([r]) => r);
  if (used.length) throw new CaError(`account ${name} is still bound to ${used.length} repo(s); rebind or unbind them first`);
  delete cfg.accounts[name]; // folders on disk are kept on purpose
}
function bind(cfg, repo, account, mode = 'terminal') {
  if (!(account in cfg.accounts)) throw new CaError(`unknown account ${JSON.stringify(account)}; run: ca add-account ${account}`);
  if (!MODES.includes(mode)) throw new CaError(`mode must be one of ${MODES.join(', ')}`);
  const p = norm(repo);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new CaError(`not a directory: ${p}`);
  cfg.repos[p] = { account, mode };
  return p;
}
function unbind(cfg, repo) { delete cfg.repos[norm(repo)]; }

function findRepo(cfg, p) {
  let cur = norm(p || process.cwd());
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(cfg.repos, cur)) return [cur, cfg.repos[cur]];
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
function deepStatus(acc, { claude = 'claude', env = process.env } = {}) {
  return new Promise(resolve => {
    execFile(claude, ['auth', 'status', '--text'], { env: claudeEnv(acc, env), timeout: 30000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (out) return resolve(out.split(/\r?\n/)[0]);
        if (err && err.code === 'ENOENT') return resolve('error: claude CLI not found');
        resolve(err ? `exit ${err.code ?? 'error'}` : 'exit 0');
      });
  });
}

// ---------------------------------------------------------------- commands
function claudeEnv(acc, base = process.env) {
  const env = { ...base };
  env.CLAUDE_CONFIG_DIR = acc.config_dir;
  delete env.ANTHROPIC_API_KEY; // don't let a global key override the subscription login
  return env;
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
function winQuote(s) { // Python subprocess.list2cmdline for one arg
  s = String(s);
  if (s && !/[ \t]/.test(s)) return s;
  let out = '"', bs = 0;
  for (const c of s) {
    if (c === '\\') { bs++; continue; }
    if (c === '"') { out += '\\'.repeat(bs * 2) + '\\"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + c; bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}
function q(s, system = SYSTEM) { return system === 'Windows' ? winQuote(s) : shQuote(s); }

function terminalCmd(repo, acc, worktree = null, extra = [], system = SYSTEM) {
  const argv = claudeArgv(worktree, extra).map(a => q(a, system)).join(' ');
  if (system === 'Windows')
    return `cd /d ${q(repo, system)} && set "CLAUDE_CONFIG_DIR=${acc.config_dir}" && set "ANTHROPIC_API_KEY=" && ${argv}`;
  return `cd ${q(repo, system)} && env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=${q(acc.config_dir, system)} ${argv}`;
}
function loginCmd(acc, system = SYSTEM) {
  if (system === 'Windows') return `set "CLAUDE_CONFIG_DIR=${acc.config_dir}" && claude auth login`;
  return `CLAUDE_CONFIG_DIR=${q(acc.config_dir, system)} claude auth login`;
}
function desktopCmd(acc, system = SYSTEM) {
  const ud = acc.desktop_user_data_dir, cd = acc.config_dir;
  if (system === 'Darwin')
    return `open -n -a "Claude" --env CLAUDE_CONFIG_DIR=${shQuote(cd)} --args --user-data-dir=${shQuote(ud)}`;
  if (system === 'Windows')
    return `set "CLAUDE_CONFIG_DIR=${cd}" && start "" "%LOCALAPPDATA%\\AnthropicClaude\\claude.exe" --user-data-dir="${ud}"`;
  return `# No official Claude Desktop for Linux; use terminal/docker mode.\n# Unofficial builds: CLAUDE_CONFIG_DIR=${shQuote(cd)} claude-desktop --user-data-dir=${shQuote(ud)}`;
}
// argv form used by the app to launch Desktop without a shell
function desktopLaunch(acc, system = SYSTEM, env = process.env) {
  if (system === 'Darwin')
    return { file: 'open', args: ['-n', '-a', 'Claude', '--env', `CLAUDE_CONFIG_DIR=${acc.config_dir}`, '--args', `--user-data-dir=${acc.desktop_user_data_dir}`] };
  if (system === 'Windows')
    return { file: path.join(env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe'), args: [`--user-data-dir=${acc.desktop_user_data_dir}`],
             env: { CLAUDE_CONFIG_DIR: acc.config_dir } };
  return null;
}
function containerName(repo) { return 'ca-' + crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8); }
function dockerCmds(repo, acc, engine = 'docker', worktree = null, extra = []) {
  const ctx = path.join(baseDir(), 'docker');
  const inner = claudeArgv(worktree, extra).map(shQuote).join(' ');
  const vol = `${acc.docker_config_dir}:/home/node/.claude`;
  const build = `${engine} build -t ${IMAGE} ${shQuote(ctx)}`;
  const bin = engine === 'container' ? 'container' : 'docker'; // Apple `container` CLI (macOS 26, Apple silicon)
  const run = `${bin} run --rm -it --name ${containerName(repo)} -v ${shQuote(vol)} -v ${shQuote(repo + ':/workspace')} ` +
              `-w /workspace -e CLAUDE_CONFIG_DIR=/home/node/.claude ${IMAGE} ${inner}`;
  return [ctx, build, run];
}
function writeDockerfile() {
  const ctx = path.join(baseDir(), 'docker');
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, 'Dockerfile'), DOCKERFILE);
  return ctx;
}

// `caCommand` is how the shell should invoke the CLI (e.g. "ca" or "python3 /path/ca").
function shellHook(kind, { cfg, repo, caCommand = 'ca' } = {}) {
  if (kind === 'direnv') {
    cfg = cfg || load();
    const [, b] = findRepo(cfg, repo);
    if (!b) throw new CaError('repo not bound; run: ca bind <repo> <account>');
    return `export CLAUDE_CONFIG_DIR=${q(cfg.accounts[b.account].config_dir)}`;
  }
  const fn = `_ca_hook() { eval "$(${caCommand} env --shell)"; }`;
  if (kind === 'zsh') return fn + '\nautoload -U add-zsh-hook; add-zsh-hook chpwd _ca_hook; _ca_hook';
  if (kind === 'bash') return fn + '\nPROMPT_COMMAND="_ca_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"';
  throw new CaError('kind must be direnv|zsh|bash');
}
function envShell(cfg, p) {
  const [, b] = findRepo(cfg, p);
  if (b && b.account in cfg.accounts)
    return `export CLAUDE_CONFIG_DIR=${q(cfg.accounts[b.account].config_dir)}; export CA_ACCOUNT=${q(b.account)}`;
  return 'unset CLAUDE_CONFIG_DIR CA_ACCOUNT';
}
function commandFor(repo, b, cfg, system = SYSTEM) {
  const acc = cfg.accounts[b.account];
  const mode = b.mode || 'terminal';
  if (mode === 'docker') return dockerCmds(repo, acc)[2];
  if (mode === 'desktop') return desktopCmd(acc, system);
  return terminalCmd(repo, acc, null, [], system);
}
function rows(cfg, system = SYSTEM) {
  return Object.keys(cfg.repos).sort().map(p => {
    const b = cfg.repos[p], acc = cfg.accounts[b.account];
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
  MODES, IMAGE, SYSTEM, DOCKERFILE, CaError, configPath, baseDir, norm, load, save, validAccountName,
  addAccount, removeAccount, bind, unbind, findRepo, loginState, dockerLoginState, deepStatus, claudeEnv,
  claudeArgv, shQuote, winQuote, q, terminalCmd, loginCmd, desktopCmd, desktopLaunch, dockerCmds,
  writeDockerfile, shellHook, envShell, commandFor, rows, containerName,
};
