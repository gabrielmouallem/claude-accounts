// The ca CLI as people get it: compiled with Bun for this machine, run against a throwaway config. A fake claude
// records what it receives, and the repository holds a claude and a node of its own that must never run. macOS and
// Linux; the CLI doesn't run on Windows yet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Account } from '../src/types.ts';

const WIN = process.platform === 'win32';
const skip = WIN && "the CLI doesn't run on Windows yet";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-cli-'));
process.env.CA_CONFIG = path.join(TMP, 'cfg', 'config.json');
// Loaded once CA_CONFIG is set, so nothing here can reach the real config
const ca = await import('../src/core.ts');
const { BUN, buildCli } = await import('../scripts/build-cli.ts');
const CA = WIN ? '' : buildCli({ outfile: path.join(TMP, 'bin', 'ca'), quiet: true });
// The tests run ca the way Settings installs it: through the script that starts it with DO_NOT_TRACK=1
const WRAPPED = path.join(TMP, 'bin', 'ca-script');
if (!WIN) fs.writeFileSync(WRAPPED, ca.cliWrapper(CA), { mode: 0o755 });

const real = (p: string) => fs.realpathSync.native(p);
const FAKE = path.join(TMP, 'fake'), HOME = path.join(TMP, 'home'), LOG = path.join(TMP, 'calls.jsonl');
const r1 = path.join(TMP, 'repo-work'), r2 = path.join(TMP, 'repo-personal');
// "." and an empty entry both mean the current folder, which is where the repository's own claude and node wait.
// node's own folder comes before the rest, for the fake claude's `env node`.
const PATH = ['.', '', FAKE, path.dirname(process.execPath), process.env.PATH].join(':');
// What a test sets about telemetry is all there is, whatever the shell running the tests has
const QUIET_VARS = ['DO_NOT_TRACK', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY', 'CA_WRAPPER', 'CA_CALLER_DO_NOT_TRACK'];
function sh(args: string[], { cwd = TMP, env = {}, exe = WRAPPED }: { cwd?: string; env?: Record<string, string>; exe?: string } = {}) {
  return spawnSync(exe, args, { cwd, env: { ...ca.withoutVars(process.env, ...QUIET_VARS), PATH, HOME, CA_TEST_LOG: LOG, ...env }, encoding: 'utf8', timeout: 60000 });
}
function ok(args: string[], opts?: Parameters<typeof sh>[1]): string {
  const r = sh(args, opts);
  assert.equal(r.status, 0, `ca ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
function account(name: string): Account {
  const acc = ca.load().accounts[name];
  assert.ok(acc, `no account ${name}`);
  return acc;
}
// `dnt` is DO_NOT_TRACK, and `quiet` CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and DISABLE_TELEMETRY
interface Call { argv: string[]; cwd: string; config: string | null; keys: string[]; dnt: string | null; quiet: (string | null)[] }
const PLAIN = { keys: [], dnt: null, quiet: [null, null] };
function calls(): Call[] {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
}

before(() => {
  if (WIN) return;
  for (const dir of [FAKE, HOME, r1, r2]) fs.mkdirSync(dir);
  // The fake claude: records its arguments, folder, account, any spelling of the API key and what it was told about
  // telemetry, then answers `auth status`, and ends with the exit status or signal a test asks for. It starts the way
  // npm's claude does, with `env node`, which looks node up on PATH.
  fs.writeFileSync(path.join(FAKE, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), env = process.env;
fs.appendFileSync(env.CA_TEST_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), config: env.CLAUDE_CONFIG_DIR ?? null,
  keys: Object.keys(env).filter(k => k.toUpperCase() === 'ANTHROPIC_API_KEY'), dnt: env.DO_NOT_TRACK ?? null,
  quiet: [env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null, env.DISABLE_TELEMETRY ?? null] }) + '\\n');
if (process.argv[2] === 'auth' && process.argv[3] === 'status')
  console.log(JSON.stringify({ loggedIn: true, email: 'fake@example.com', subscriptionType: 'max', accessToken: 'sk-ant-fake' }));
if (env.CA_TEST_SIGNAL) process.kill(process.pid, env.CA_TEST_SIGNAL);
process.exitCode = Number(env.CA_TEST_EXIT || 0);
`, { mode: 0o755 });
  for (const name of ['claude', 'node']) fs.writeFileSync(path.join(r1, name), `#!/bin/sh\ntouch "${path.join(TMP, 'PLANTED')}"\n`, { mode: 0o755 });
  ok(['add-account', 'work']); ok(['add-account', 'personal']);
  ok(['bind', r1, 'work']); ok(['bind', r2, 'personal', '--mode', 'docker']);
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('add-account and bind write the config the app reads', { skip }, () => {
  const cfg = JSON.parse(fs.readFileSync(ca.configPath(), 'utf8'));
  assert.deepEqual(Object.keys(cfg.accounts).sort(), ['personal', 'work']);
  for (const a of Object.values<Account>(cfg.accounts)) {
    assert.deepEqual(Object.keys(a).sort(), ['config_dir', 'desktop_user_data_dir', 'docker_config_dir']);
    assert.equal(fs.statSync(a.config_dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(cfg.repos[real(r1)], { account: 'work', mode: 'terminal' });
  assert.equal(cfg.repos[real(r2)].mode, 'docker');
  // adding it again keeps its folders, and its sign-in
  ok(['add-account', 'work']);
  assert.deepEqual(account('work'), cfg.accounts.work);
  assert.equal(fs.statSync(ca.configPath()).mode & 0o777, 0o600);
});

test('bind and add-account refuse what they cannot use', { skip }, () => {
  for (const args of [['bind', r1, 'nope'], ['bind', '/does/not/exist', 'work'], ['add-account', 'bad/name'], ['add-account', '../escape']]) {
    const r = sh(args);
    assert.equal(r.status, 1, `ca ${args.join(' ')}`);
    assert.match(r.stderr, /^ca: /);
  }
  // folders ignore case on macOS, so "WORK" would share the "work" login
  assert.match(sh(['add-account', 'WORK']).stderr, /"work" already exists/);
});

test('env --shell sets the account inside a bound repository and clears it outside', { skip }, () => {
  const acc = account('work');
  assert.equal(ok(['env', '--shell'], { cwd: path.join(r1) }), ca.envShell(ca.load(), r1) + '\n');
  assert.ok(ok(['env', '--shell', r1]).includes(`export CLAUDE_CONFIG_DIR=${ca.shQuote(acc.config_dir)}; export CA_ACCOUNT=work`));
  assert.match(ok(['env', '--shell']), /unset CLAUDE_CONFIG_DIR/);
  assert.equal(ok(['env', r1]), `CLAUDE_CONFIG_DIR=${acc.config_dir}\n`);
  assert.equal(ok(['env']), 'not bound\n');
});

test('run --print prints the command the app runs', { skip }, () => {
  const acc = account('work');
  assert.equal(ok(['run', r1, '--print', '--worktree', 'feat-x', '--', '--model', 'opus']),
    ca.terminalCmd(real(r1), acc, 'feat-x', ['--model', 'opus']) + '\n');
  assert.match(ok(['run', r1, '--print', '-w']), /claude --worktree$/m);
  assert.match(ok(['run', '--print', '--worktree=feat-y'], { cwd: r1 }), /claude --worktree feat-y$/m);
  const bad = sh(['run', r1, '--print', '-w', 'x&calc']);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /invalid worktree name/);
});

test('ca run starts claude from PATH in the repository, as the account, without the API key', { skip }, () => {
  fs.rmSync(LOG, { force: true });
  const r = sh(['run', '--', '--model', 'opus', 'fix the bug'], { cwd: r1, env: { ANTHROPIC_API_KEY: 'sk-test', anthropic_api_key: 'sk-test' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[ca\] repo-work -> account 'work'/);
  assert.deepEqual(calls(), [{ argv: ['--model', 'opus', 'fix the bug'], cwd: real(r1), config: account('work').config_dir, ...PLAIN }]);
  assert.ok(!fs.existsSync(path.join(TMP, 'PLANTED')), "the repository's own claude or node ran");
});

test('ca run ends the way claude did', { skip }, () => {
  assert.equal(sh(['run', r1], { env: { CA_TEST_EXIT: '3' } }).status, 3);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) assert.equal(sh(['run', r1], { env: { CA_TEST_SIGNAL: signal } }).signal, signal);
  // Any other signal, such as a crash's SIGSEGV, comes back as 128 plus its number, since sent to ca it would look like
  // Bun crashing. SIGUSR2 stands in for one: a real crash leaves a macOS crash report, and node keeps SIGUSR1.
  const other = sh(['run', r1], { env: { CA_TEST_SIGNAL: 'SIGUSR2' } });
  assert.deepEqual([other.status, other.signal], [128 + os.constants.signals.SIGUSR2, null]);
});

test('ca login signs in from home, as the account', { skip }, () => {
  fs.rmSync(LOG, { force: true });
  ok(['login', 'work'], { cwd: r1, env: { ANTHROPIC_API_KEY: 'sk-test' } });
  assert.deepEqual(calls(), [{ argv: ['auth', 'login'], cwd: real(HOME), config: account('work').config_dir, ...PLAIN }]);
  assert.equal(ok(['login', 'work', '--print']), ca.loginCmd(account('work')) + '\n');
  assert.match(sh(['login', 'nope']).stderr, /unknown account "nope"/);
});

test('status --deep asks claude who each account is signed in as, and prints nothing else', { skip }, () => {
  fs.rmSync(LOG, { force: true });
  const out = ok(['status', '--deep'], { cwd: r1 });
  assert.match(out, /^ {2}work +cli=not-logged-in +container=not-logged-in +\S+ {2}\[signed in as fake@example\.com \(max\)\]$/m);
  assert.match(out, /^CWD: bound to work via /m);
  assert.ok(!out.includes('sk-ant'));
  const all = calls();
  assert.deepEqual(all.map(c => [c.argv, c.cwd, c.config]).sort(), [
    [['auth', 'status'], real(HOME), account('personal').config_dir],
    [['auth', 'status'], real(HOME), account('work').config_dir],
  ].sort());
  // nobody asked for these runs, so claude is told to send nothing beyond the answer
  for (const c of all) assert.deepEqual([c.dnt, ...c.quiet], ['1', '1', '1']);
});

test('rename-account moves the bindings and keeps the folders', { skip }, () => {
  const before = account('personal');
  assert.equal(ok(['rename-account', 'personal', 'home']), 'personal -> home\n');
  try {
    const cfg = ca.load();
    assert.deepEqual(cfg.accounts.home, before); assert.equal(cfg.repos[real(r2)]?.account, 'home');
    for (const [args, err] of [[['rename-account', 'nope', 'x'], /unknown account/], [['rename-account', 'home', 'Work'], /already exists/],
                               [['rename-account', 'home', '../x'], /invalid account name/]] as const) {
      const r = sh([...args]); assert.equal(r.status, 1); assert.match(r.stderr, err);
    }
    assert.equal(sh(['rename-account', 'home']).status, 2);
  } finally { ok(['rename-account', 'home', 'personal']); }
});

test('a .env or bunfig.toml in the folder ca runs in does nothing', { skip }, () => {
  const dir = path.join(TMP, 'hostile'), ran = path.join(dir, 'RAN'), evil = path.join(TMP, 'evil', 'config.json');
  fs.mkdirSync(dir); fs.mkdirSync(path.dirname(evil));
  // The bait: a .env that points CA_CONFIG at a config with an account of its own, and a bunfig.toml that preloads code
  const elsewhere = path.join(TMP, 'evil', 'account');
  fs.writeFileSync(evil, JSON.stringify({ accounts: { evil: { config_dir: elsewhere, desktop_user_data_dir: elsewhere, docker_config_dir: elsewhere } }, repos: {} }));
  fs.writeFileSync(path.join(dir, '.env'), `CA_CONFIG=${evil}\n`);
  fs.writeFileSync(path.join(dir, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
  fs.writeFileSync(path.join(dir, 'preload.ts'), `require('fs').writeFileSync(${JSON.stringify(ran)}, '');\n`);
  // A .env never replaces a variable that is set, so these runs have no CA_CONFIG, and a home of their own. The control
  // build has no script to set DO_NOT_TRACK, so it gets it here.
  const env = { ...ca.withoutVars(process.env, 'CA_CONFIG'), PATH, HOME: fs.mkdtempSync(path.join(TMP, 'home-')), DO_NOT_TRACK: '1' };
  // The bait works: an executable built with Bun's defaults reads both
  const control = path.join(TMP, 'bin', 'control');
  execFileSync(BUN, ['build', path.join(import.meta.dirname, '..', 'cli', 'ca.ts'), '--compile', `--outfile=${control}`], { stdio: 'pipe' });
  assert.match(execFileSync(control, ['list'], { cwd: dir, env, encoding: 'utf8' }), /^ {2}evil /m, 'the control build should have read the .env');
  assert.ok(fs.existsSync(ran), 'the control build should have preloaded the bait');
  fs.rmSync(ran); fs.rmSync(control);
  // ca reads neither
  assert.doesNotMatch(execFileSync(WRAPPED, ['list'], { cwd: dir, env, encoding: 'utf8' }), /evil/, 'ca read the .env');
  execFileSync(WRAPPED, ['env', '--shell'], { cwd: dir, env });
  assert.ok(!fs.existsSync(ran), 'ca preloaded code from bunfig.toml');
});

test('the installed ca starts the executable with DO_NOT_TRACK=1, and what ca runs gets yours', { skip }, () => {
  // The script on its own, around a program that shows what it got
  const show = path.join(TMP, 'bin', 'show'), shown = path.join(TMP, 'bin', 'show-wrapped');
  fs.writeFileSync(show, '#!/bin/sh\nprintf "%s|%s|%s" "$DO_NOT_TRACK" "${CA_CALLER_DO_NOT_TRACK-unset}" "$CA_WRAPPER"\n', { mode: 0o755 });
  fs.writeFileSync(shown, ca.cliWrapper(show), { mode: 0o755 });
  assert.equal(sh([], { exe: shown }).stdout, `1||${shown}`);
  assert.equal(sh([], { exe: shown, env: { DO_NOT_TRACK: '0' } }).stdout, `1|=0|${shown}`);
  // Around ca: the shell hook runs ca again through the script, and claude gets the caller's DO_NOT_TRACK, or none
  const wrapped = path.join(TMP, 'bin', 'ca-wrapped');
  fs.writeFileSync(wrapped, ca.cliWrapper(CA), { mode: 0o755 });
  assert.ok(ok(['shell-hook', 'zsh'], { exe: wrapped }).includes(`eval "$(${ca.shQuote(wrapped)} env --shell)"`));
  for (const [caller, want] of [[undefined, null], ['0', '0'], ['', '']] as const) {
    fs.rmSync(LOG, { force: true });
    ok(['run', r1], { exe: wrapped, env: caller === undefined ? {} : { DO_NOT_TRACK: caller } });
    assert.deepEqual(calls().map(c => c.dnt), [want], `DO_NOT_TRACK ${JSON.stringify(caller)}`);
  }
});

// Bun uploads a report when it crashes, on macOS and Windows, unless DO_NOT_TRACK is set when it starts. This crashes
// Bun on purpose, which leaves a macOS crash report each time, so it runs in CI or when asked for.
const crashSkip = process.platform !== 'darwin' ? "Bun uploads crash reports by default on macOS and Windows, and ca doesn't run on Windows"
  : !process.env.CI && !process.env.CA_TEST_CRASH && 'crashes Bun on purpose; set CA_TEST_CRASH=1 to run it';
test('the installed ca never uploads a crash report', { skip: crashSkip }, async () => {
  // A program built the way ca is, which crashes Bun itself, and a curl first on PATH that logs instead of sending.
  // The network is closed to all of it, in case Bun ever finds curl some other way.
  const dir = path.join(TMP, 'crash'), log = path.join(dir, 'curl.log');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'crash.ts'), "import { read } from 'bun:ffi';\nread.u8(4096 as never, 0);\n");
  fs.writeFileSync(path.join(dir, 'bin', 'curl'), `#!/bin/sh\necho "$*" >> "${log}"\n`, { mode: 0o755 });
  const crash = buildCli({ entry: path.join(dir, 'crash.ts'), outfile: path.join(dir, 'program'), quiet: true });
  const wrapped = path.join(dir, 'ca');
  fs.writeFileSync(wrapped, ca.cliWrapper(crash), { mode: 0o755 });
  const env = { ...ca.withoutVars(process.env, 'DO_NOT_TRACK', 'BUN_ENABLE_CRASH_REPORTING', 'BUN_CRASH_REPORT_URL'), PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, HOME };
  // Bun starts curl as it exits, so the log is read a few seconds later
  const uploads = async (file: string) => {
    fs.rmSync(log, { force: true });
    assert.notEqual(spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)(deny network*)', file], { env, stdio: 'ignore' }).status, 0);
    for (let i = 0; i < 30 && !fs.existsSync(log); i++) await sleep(100);
    return fs.existsSync(log);
  };
  assert.ok(await uploads(crash), 'the bait: Bun on its own should have run curl');
  assert.ok(!(await uploads(wrapped)), 'the installed ca ran curl to upload a crash report');
});

test('ca desktop --launch says how to sign in to a window that has never opened', { skip: process.platform !== 'darwin' && 'ca opens Claude Desktop on macOS only' }, async () => {
  // A fake open, first on PATH, so nothing really opens
  const opened = path.join(TMP, 'opened.log'), pref = path.join(account('work').desktop_user_data_dir, 'Preferences');
  fs.writeFileSync(path.join(FAKE, 'open'), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 });
  try {
    const first = sh(['desktop', 'work', '--launch']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /isn't signed in yet\. Choose Continue with email there and type the code from the email/);
    fs.writeFileSync(pref, '{}');
    assert.equal(sh(['desktop', 'work', '--launch']).stderr, '');
    // open runs detached, so its log can come a moment later
    for (let i = 0; i < 30 && (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8') : '').split('\n').length < 3; i++) await sleep(100);
    assert.match(fs.readFileSync(opened, 'utf8'), /^-n -a Claude --env CLAUDE_CONFIG_DIR=\S+ --args --user-data-dir=\S+$/m);
  } finally { fs.rmSync(path.join(FAKE, 'open'), { force: true }); fs.rmSync(pref, { force: true }); }
});

test('docker-run prints both engines and runs claude in the container with its arguments', { skip }, () => {
  const acc = account('personal'), repo = real(r2);
  const out = ok(['docker-run', r2, '--print']);
  assert.match(out, /docker build -t claude-code-ca:latest/);
  assert.ok(out.includes(`${acc.docker_config_dir}:/home/node/.claude`) && out.includes(`${repo}:/workspace`));
  assert.match(out, /container run --rm -it/);
  assert.match(fs.readFileSync(path.join(ca.baseDir(), 'docker', 'Dockerfile'), 'utf8'), /npm i -g @anthropic-ai\/claude-code/);
  assert.match(ok(['run', r2, '--print']), /docker run /);   // run follows mode=docker
  assert.ok(ok(['run', r2, '--print', '--', '--version']).includes(`${ca.IMAGE} claude --version`));
  assert.ok(ok(['run', r2, '--print', '-w']).includes(`${ca.IMAGE} claude --worktree`));
  assert.ok(ok(['docker-run', r2, '--print', '-w', 'feat-x', '--', '--model', 'opus']).includes(`${ca.IMAGE} claude --worktree feat-x --model opus`));
});

test('desktop prints the command for each system', { skip }, () => {
  const mac = ok(['desktop', 'work', '--os', 'Darwin']);
  assert.match(mac, /open -n -a "Claude"/); assert.match(mac, /--user-data-dir=/);
  assert.match(ok(['desktop', 'work', '--os', 'Windows']), /claude\.exe/);
  assert.match(ok(['desktop', 'work', '--os', 'Linux']), /No official/);
});

test('the shell hook runs ca again and switches the account on cd', { skip }, () => {
  // through the installed script, or this executable with the DO_NOT_TRACK=1 the script would set
  assert.ok(ok(['shell-hook', 'zsh']).startsWith(`_ca_hook() { eval "$(${ca.shQuote(WRAPPED)} env --shell)"; }`));
  assert.ok(ok(['shell-hook', 'zsh'], { exe: CA, env: { DO_NOT_TRACK: '1' } }).startsWith(`_ca_hook() { eval "$(DO_NOT_TRACK=1 ${ca.shQuote(real(CA))} env --shell)"; }`));
  assert.match(ok(['shell-hook', 'zsh']), /add-zsh-hook chpwd _ca_hook/);
  const hook = ok(['shell-hook', 'bash']), q = ca.shQuote;
  const script = [hook, 'export CLAUDE_CONFIG_DIR=/outer', `cd ${q(TMP)}; _ca_hook; echo "0=$CLAUDE_CONFIG_DIR"`,
    `cd ${q(r1)}; _ca_hook; echo "1=$CA_ACCOUNT"`, `cd ${q(r2)}/; _ca_hook; echo "2=$CA_ACCOUNT"`,
    `cd ${q(TMP)}; _ca_hook; echo "3=$CLAUDE_CONFIG_DIR \${CA_ACCOUNT:-none}"`].join('\n');
  const out = execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, HOME, CA_CONFIG: ca.configPath() }, encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n'), ['0=/outer', '1=work', '2=personal', '3=/outer none']);
});

test('shell-hook direnv prints the account, and --write appends it to .envrc', { skip }, () => {
  const line = `export CLAUDE_CONFIG_DIR=${ca.shQuote(account('work').config_dir)}`;
  assert.equal(ok(['shell-hook', 'direnv', r1]), line + '\n');
  assert.match(ok(['shell-hook', 'direnv', r1, '--write']), /^created .*\.envrc; run: direnv allow /);
  assert.equal(fs.readFileSync(path.join(r1, '.envrc'), 'utf8'), line + '\n');
  // direnv allow approves the whole file, so a file that was already there gets read first
  assert.match(ok(['shell-hook', 'direnv', r1, '--write']), /^appended to .*\.envrc, which was already there\. .* read it first, then run: direnv allow /);
  assert.equal(fs.readFileSync(path.join(r1, '.envrc'), 'utf8'), `${line}\n${line}\n`);
  assert.equal(sh(['shell-hook', 'direnv', TMP]).status, 1);
  // A repository's .envrc that links to a file of yours is left alone
  const yours = path.join(TMP, 'zshrc'), link = path.join(r2, '.envrc');
  fs.writeFileSync(yours, '# mine\n'); fs.symlinkSync(yours, link);
  try {
    const r = sh(['shell-hook', 'direnv', r2, '--write']);
    assert.equal(r.status, 1); assert.match(r.stderr, /\.envrc is a symbolic link, so ca won't write to it/);
    assert.equal(fs.readFileSync(yours, 'utf8'), '# mine\n');
  } finally { fs.rmSync(link); fs.rmSync(yours); }
});

test('the config stays UTF-8 text, and unbind removes a binding', { skip }, () => {
  const r = path.join(TMP, 'Área de Trabalho'); fs.mkdirSync(r);
  ok(['bind', r, 'work']);
  assert.ok(fs.readFileSync(ca.configPath(), 'utf8').includes('Área de Trabalho'));
  assert.ok(Object.hasOwn(ca.load().repos, real(r)));
  ok(['unbind', r]);
  assert.ok(!Object.hasOwn(ca.load().repos, real(r)));
});

test('a binding to a removed account gives a clear error, and the hook still answers', { skip }, () => {
  const cfg = ca.load();
  cfg.repos[real(r1)] = { account: 'gone', mode: 'terminal' }; ca.save(cfg);
  try {
    for (const args of [['env', r1], ['run', r1, '--print']]) {
      const r = sh(args);
      assert.equal(r.status, 1); assert.match(r.stderr, /^ca: account "gone" is not configured/);
    }
    assert.equal(ok(['env', '--shell'], { cwd: r1 }), ok(['env', '--shell']));
  } finally { ok(['bind', r1, 'work']); }
});

test('a config that is not JSON is reported, and the hook leaves the shell alone', { skip }, () => {
  const saved = fs.readFileSync(ca.configPath());
  fs.writeFileSync(ca.configPath(), '{ not json');
  try {
    const r = sh(['list']);
    assert.equal(r.status, 1); assert.match(r.stderr, /isn't valid JSON/);
    const hook = sh(['env', '--shell'], { cwd: r1 });
    assert.equal(hook.status, 0); assert.match(hook.stdout, /unset CLAUDE_CONFIG_DIR/); assert.match(hook.stderr, /isn't valid JSON/);
  } finally { fs.writeFileSync(ca.configPath(), saved); }
});

test('--help, --version, and what ca no longer has', { skip }, () => {
  assert.match(ok(['--help']), /^usage: ca <command>/);
  assert.match(ok(['run', '-h']), /^usage: ca <command>/);
  const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.equal(ok(['--version']), `${version}\n`);
  for (const args of [['ui'], [], ['list', '--deep'], ['bind', r1]]) assert.equal(sh(args).status, 2, `ca ${args.join(' ')}`);
});

test('ca run starts the real claude as the account', { skip: skip || (!ca.program('claude') && 'claude not installed') }, () => {
  const r = spawnSync(WRAPPED, ['run', r1, '--', '--version'], { env: { ...process.env, HOME }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Claude Code/);
});
