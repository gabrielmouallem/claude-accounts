'use strict';
// Port of test_ca.py to node:test (throwaway config, no network, no login).
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'));
process.env.CA_CONFIG = path.join(TMP, 'cfg', 'config.json');
const ca = require('../src/core');
const V = require('../src/validate');
const PY_CA = path.join(__dirname, '..', 'cli', 'ca');
const WIN = process.platform === 'win32';
// The tools some tests drive; on Windows those tests are skipped (test/windows.test.js covers cmd there).
const which = b => !WIN && spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const real = p => fs.realpathSync.native(p);
const r1 = path.join(TMP, 'repo-work'), r2 = path.join(TMP, 'repo-personal');

// Runs Python with cli/ca loaded as a module (same CA_CONFIG); `inp` holds the JSON input and the code prints JSON.
function py(code, input) {
  const prelude = [
    'import importlib.machinery, importlib.util, json, sys',
    `loader = importlib.machinery.SourceFileLoader("ca", ${JSON.stringify(PY_CA)})`,
    'ca = importlib.util.module_from_spec(importlib.util.spec_from_loader("ca", loader)); loader.exec_module(ca)',
    'inp = json.loads(sys.stdin.read())', '',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-I', '-c', prelude + code], { input: JSON.stringify(input), env: process.env, encoding: 'utf8' }));
}

before(() => {
  for (const r of [r1, r2]) { fs.mkdirSync(r); spawnSync('git', ['init', '-q', r]); }
  const cfg = ca.load();
  ca.addAccount(cfg, 'work'); ca.addAccount(cfg, 'personal');
  ca.bind(cfg, r1, 'work'); ca.bind(cfg, r2, 'personal', 'docker');
  ca.save(cfg);
});

test('config shape + private dir perms', () => {
  const cfg = JSON.parse(fs.readFileSync(process.env.CA_CONFIG, 'utf8'));
  assert.deepEqual(new Set(Object.keys(cfg.accounts)), new Set(['work', 'personal']));
  for (const a of Object.values(cfg.accounts)) {
    for (const k of ['config_dir', 'desktop_user_data_dir', 'docker_config_dir']) assert.ok(k in a);
    if (!WIN) assert.equal(fs.statSync(a.config_dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(cfg.repos[real(r1)], { account: 'work', mode: 'terminal' });
  assert.equal(cfg.repos[real(r2)].mode, 'docker');
});

test('bind / add-account errors', () => {
  const cfg = ca.load();
  assert.throws(() => ca.bind(cfg, r1, 'nope'), /unknown account/);
  assert.throws(() => ca.bind(cfg, '/does/not/exist', 'work'), /not a directory/);
  assert.throws(() => ca.addAccount(cfg, 'bad/name'), /invalid account name/);
  assert.throws(() => ca.bind(cfg, r1, 'work', 'vm'), /mode must be/);
});

test('findRepo from a subdirectory', () => {
  const sub = path.join(r1, 'src', 'deep'); fs.mkdirSync(sub, { recursive: true });
  const [r, b] = ca.findRepo(ca.load(), sub);
  assert.equal(r, real(r1)); assert.equal(b.account, 'work');
  assert.deepEqual(ca.findRepo(ca.load(), TMP), [null, null]);
});

test('env construction strips ANTHROPIC_API_KEY', () => {
  const acc = ca.load().accounts.work;
  const env = ca.claudeEnv(acc, { ANTHROPIC_API_KEY: 'x', PATH: '/bin' });
  assert.equal(env.CLAUDE_CONFIG_DIR, acc.config_dir); assert.ok(!('ANTHROPIC_API_KEY' in env));
  // shell text, so a Windows path (C:\...) comes quoted
  assert.ok(ca.envShell(ca.load(), path.join(r1, 'src')).includes(`export CLAUDE_CONFIG_DIR=${ca.shQuote(acc.config_dir)}`));
  assert.ok(ca.envShell(ca.load(), TMP).includes('unset'));
});

test('run command + worktree', () => {
  const cfg = ca.load(), acc = cfg.accounts.work;
  const out = ca.terminalCmd(real(r1), acc, 'feat-x', [], 'Linux');
  assert.ok(out.includes('CLAUDE_CONFIG_DIR=')); assert.ok(out.includes('claude --worktree feat-x'));
  assert.ok(out.includes('env -u ANTHROPIC_API_KEY'));
  assert.ok(ca.terminalCmd(r1, acc, '', [], 'Linux').endsWith('claude --worktree'));
  const win = ca.terminalCmd('C:\\My Repo', acc, null, [], 'Windows');
  assert.ok(win.startsWith('@pushd "C:\\My Repo"')); assert.ok(win.includes('set "ANTHROPIC_API_KEY="'));
  assert.equal(ca.shQuote("it's"), `'it'"'"'s'`); assert.equal(ca.shQuote(''), "''");
});

test('real claude --version under per-account CLAUDE_CONFIG_DIR', { skip: !which('claude') && 'claude not installed' }, () => {
  const acc = ca.load().accounts.work;
  const out = execFileSync('claude', ['--version'], { env: ca.claudeEnv(acc, { ...process.env, ANTHROPIC_API_KEY: 'sk-fake' }), cwd: r1, encoding: 'utf8', timeout: 60000 });
  assert.match(out, /Claude Code/);
});

test('claude auth status is isolated per account', { skip: !which('claude') && 'claude not installed' }, async () => {
  const acc = ca.load().accounts.work;
  const line = await ca.deepStatus(acc);
  assert.match(line, /Not logged in/);
  // the CLI really used the per-account dir (it creates .claude.json there)
  assert.ok(fs.existsSync(path.join(acc.config_dir, '.claude.json')));
});

test('login state uses existence only (unreadable file)', { skip: WIN && 'POSIX file modes' }, () => {
  const acc = ca.load().accounts.personal;
  assert.equal(ca.loginState(acc, 'Linux'), 'not-logged-in');
  const p = path.join(acc.config_dir, '.credentials.json');
  fs.writeFileSync(p, 'FAKE'); fs.chmodSync(p, 0); // unreadable: proves we only stat it
  try { assert.equal(ca.loginState(acc, 'Linux'), 'logged-in'); }
  finally { fs.chmodSync(p, 0o600); fs.rmSync(p); }
  fs.writeFileSync(path.join(acc.config_dir, '.claude.json'), '{}');
  assert.equal(ca.loginState(acc, 'Darwin'), 'keychain?');
  assert.equal(ca.loginState(acc, 'Linux'), 'not-logged-in');
  fs.rmSync(path.join(acc.config_dir, '.claude.json'));
});

test('docker + Apple container commands', () => {
  const cfg = ca.load(), acc = cfg.accounts.personal, repo = real(r2);
  const [ctx, build, run] = ca.dockerCmds(repo, acc);
  assert.ok(build.includes('docker build -t claude-code-ca:latest'));
  assert.ok(run.includes(`${acc.docker_config_dir}:/home/node/.claude`)); assert.ok(run.includes(`${repo}:/workspace`));
  assert.ok(ca.dockerCmds(repo, acc, 'container')[2].startsWith('container run --rm -it'));
  ca.writeDockerfile();
  assert.ok(fs.readFileSync(path.join(ctx, 'Dockerfile'), 'utf8').includes('npm i -g @anthropic-ai/claude-code'));
  assert.ok(ca.rows(cfg).find(r => r.repo === repo).command.startsWith('docker run')); // honours mode=docker
  // arguments after `--` reach claude inside the container
  assert.ok(ca.dockerCmds(repo, acc, 'docker', null, ['--version'], 'Linux')[2].endsWith(`${ca.IMAGE} claude --version`));
});

test('desktop commands per OS', () => {
  const acc = ca.load().accounts.work;
  const mac = ca.desktopCmd(acc, 'Darwin');
  assert.ok(mac.includes('open -n -a "Claude"')); assert.ok(mac.includes('--user-data-dir='));
  assert.ok(ca.desktopCmd(acc, 'Windows').includes('claude.exe'));
  assert.ok(ca.desktopCmd(acc, 'Linux').includes('No official'));
  const l = ca.desktopLaunch(acc, 'Darwin');
  assert.deepEqual(l.args.slice(0, 3), ['-n', '-a', 'Claude']); assert.ok(l.args.includes(`--user-data-dir=${acc.desktop_user_data_dir}`));
});

test('shell hooks switch account on cd (via bundled ca CLI)', { skip: !which('python3') && 'python3 missing' }, () => {
  assert.ok(ca.shellHook('direnv', { repo: r1 }).startsWith('export CLAUDE_CONFIG_DIR='));
  assert.ok(ca.shellHook('zsh').includes('add-zsh-hook chpwd'));
  const hook = ca.shellHook('bash', { caCommand: `python3 ${PY_CA}` });
  const script = `${hook}\ncd ${r1}; _ca_hook; echo A=$CA_ACCOUNT\ncd ${r2}/; _ca_hook; echo B=$CA_ACCOUNT\ncd /; _ca_hook; echo C=\${CA_ACCOUNT:-none}`;
  const out = execFileSync('bash', ['-c', script], { env: process.env, encoding: 'utf8' });
  assert.match(out, /A=work/); assert.match(out, /B=personal/); assert.match(out, /C=none/);
});

test('IPC input validation (replaces web-UI token test)', () => {
  const cfg = ca.load();
  assert.throws(() => V.newAccountName('../x'), V.ValidationError);
  assert.throws(() => V.newAccountName('a b'), V.ValidationError);
  assert.equal(V.newAccountName('client-x'), 'client-x');
  assert.throws(() => V.existingAccount(cfg, '__proto__'), V.ValidationError);
  assert.throws(() => V.boundRepo(cfg, 'relative/path'), V.ValidationError);
  assert.throws(() => V.boundRepo(cfg, '/etc'), /not bound/);
  assert.equal(V.boundRepo(cfg, real(r1)), real(r1));
  assert.throws(() => V.mode('shell'), V.ValidationError);
  assert.throws(() => V.worktree('--dangerous'), V.ValidationError);
  assert.throws(() => V.worktree('a;rm -rf /'), V.ValidationError);
  assert.equal(V.worktree(''), ''); assert.equal(V.worktree(undefined), null);
  assert.throws(() => V.str({ toString: () => 'x' }, 'x'), V.ValidationError);
  // Terminal and iTerm type a command, and a control character in it would act before the shell reads the quoting
  for (const bad of ["cd '/x\u0015open -a Calculator\n'", 'a\u001bb', 'a\u007fb', 'a\tb', 'a\u0000b'])
    assert.throws(() => V.typeable(bad), V.ValidationError, JSON.stringify(bad));
  assert.equal(V.typeable("cd '/tmp/Área ✓' && claude"), "cd '/tmp/Área ✓' && claude");
});

test('config.json stays compatible with the Python ca CLI', { skip: !which('python3') && 'python3 missing' }, () => {
  const env = { ...process.env, CA_CONFIG: process.env.CA_CONFIG };
  const list = execFileSync('python3', [PY_CA, 'list'], { env, encoding: 'utf8' });
  assert.match(list, /work/); assert.match(list, /repo-personal/);
  const r3 = path.join(TMP, 'repo-py'); fs.mkdirSync(r3);
  execFileSync('python3', [PY_CA, 'add-account', 'from-python'], { env });
  execFileSync('python3', [PY_CA, 'bind', r3, 'from-python', '--mode', 'desktop'], { env });
  const cfg = ca.load();
  assert.equal(cfg.repos[real(r3)].mode, 'desktop');
  ca.unbind(cfg, r3); ca.removeAccount(cfg, 'from-python'); ca.save(cfg);
  assert.ok(!execFileSync('python3', [PY_CA, 'list'], { env, encoding: 'utf8' }).includes('from-python'));
});

test('account names: one rule for the app and the CLI', { skip: !which('python3') && 'python3 missing' }, () => {
  const { valid, invalid } = require('./fixtures/account-names.json');
  for (const n of valid) assert.ok(ca.validAccountName(n), `should accept ${JSON.stringify(n)}`);
  for (const n of invalid) assert.ok(!ca.validAccountName(n), `should refuse ${JSON.stringify(n)}`);
  assert.deepEqual(py('print(json.dumps([ca.valid_account_name(n) for n in inp]))', [...valid, ...invalid]),
    [...valid.map(() => true), ...invalid.map(() => false)]);
  // macOS and Windows folders ignore case, so "WORK" would share the "work" login
  assert.throws(() => ca.addAccount(ca.load(), 'WORK'), /"work" already exists/);
});

test('the app and the CLI print the same commands', { skip: !which('python3') && 'python3 missing' }, () => {
  const acc = ca.load().accounts.work;
  const repos = ['/tmp/plain', '/tmp/a b', "/tmp/it's", '/tmp/R&D (x) 100%', '/tmp/Área', 'C:\\Users\\me\\R&D repo'];
  const cases = [];
  for (const system of ['Darwin', 'Linux', 'Windows']) for (const repo of repos) for (const wt of [null, '', 'feat-x']) cases.push({ system, repo, wt });
  const js = cases.map(({ system, repo, wt }) => [
    ca.terminalCmd(repo, acc, wt, ['--model', 'opus'], system), ca.loginCmd(acc, system), ca.desktopCmd(acc, system),
    ...ca.dockerCmds(repo, acc, 'docker', wt, ['--version'], system).slice(1), ...ca.dockerCmds(repo, acc, 'container', wt, [], system).slice(1)]);
  const fromPy = py([
    'acc = ca.load()["accounts"]["work"]',
    'print(json.dumps([[ca.terminal_cmd(c["repo"], acc, c["wt"], ["--model", "opus"], c["system"]), ca.login_cmd(acc, c["system"]),',
    '  ca.desktop_cmd(acc, c["system"]), *ca.docker_cmds(c["repo"], acc, "docker", c["wt"], ["--version"], c["system"])[1:],',
    '  *ca.docker_cmds(c["repo"], acc, "container", c["wt"], [], c["system"])[1:]] for c in inp]))',
  ].join('\n'), cases);
  assert.deepEqual(fromPy, js);
  const paths = [r1, path.join(r1, 'src'), r2, TMP, path.parse(TMP).root];
  assert.deepEqual(py('print(json.dumps([ca.env_shell(ca.load(), p) for p in inp]))', paths), paths.map(p => ca.envShell(ca.load(), p)));
});

test('the app and the CLI keep the same PATH entries for Windows launches', { skip: !which('python3') && 'python3 missing' }, () => {
  const paths = ['C:\\a;.;\\usr\\local\\bin;bin;"C:\\Program Files\\x";\\\\srv\\share\\b;D:/y;C:rel;;\\\\?\\C:\\long', '', '.', 'C:\\'];
  assert.equal(ca.absoluteDirs(paths[0]), 'C:\\a;"C:\\Program Files\\x";\\\\srv\\share\\b;D:/y;\\\\?\\C:\\long');
  assert.deepEqual(py('print(json.dumps([ca.absolute_dirs(p) for p in inp]))', paths), paths.map(p => ca.absoluteDirs(p)));
});

test('the shell hook puts back a CLAUDE_CONFIG_DIR you set yourself', { skip: !which('bash') && 'bash missing' }, () => {
  const cfg = ca.load(), at = p => ca.envShell(cfg, p), dir = n => cfg.accounts[n].config_dir;
  const script = [
    'export CLAUDE_CONFIG_DIR=/outer',
    at(TMP), 'echo "0=$CLAUDE_CONFIG_DIR"',                          // never entered a bound repo: left alone
    at(r1), 'echo "1=$CLAUDE_CONFIG_DIR $CA_ACCOUNT"',
    at(r2), 'echo "2=$CLAUDE_CONFIG_DIR $CA_ACCOUNT"',
    at(TMP), 'echo "3=$CLAUDE_CONFIG_DIR ${CA_ACCOUNT-none} ${CA_OUTER_CLAUDE_CONFIG_DIR-none}"',
    'unset CLAUDE_CONFIG_DIR', at(r1), at(TMP), 'echo "4=${CLAUDE_CONFIG_DIR-unset}"',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['0=/outer', `1=${dir('work')} work`, `2=${dir('personal')} personal`, '3=/outer none none', '4=unset']);
});

test('a binding to a removed account gives a clear error', () => {
  const cfg = ca.load(), b = { account: 'gone', mode: 'terminal' };
  cfg.repos[real(r1)] = b;                                          // in memory only
  assert.throws(() => ca.accountOf(cfg, b), /"gone" is not configured/);
  assert.equal(ca.rows(cfg).find(r => r.account === 'gone').login, 'missing-account');
  assert.equal(ca.envShell(cfg, r1), ca.envShell(cfg, TMP));        // the hook treats it as unbound, never fails
  assert.throws(() => ca.accountOf(cfg, { account: 'constructor' }), ca.CaError);
});

test('config.json is written private, even over a leftover temp file', { skip: WIN && 'POSIX file modes' }, () => {
  const tmp = process.env.CA_CONFIG + '.tmp';
  fs.writeFileSync(tmp, 'stale'); fs.chmodSync(tmp, 0o644);
  ca.save(ca.load());
  assert.equal(fs.statSync(process.env.CA_CONFIG).mode & 0o777, 0o600);
});

test('Windows launches keep paths out of the text cmd parses', () => {
  const acc = ca.load().accounts.work, repo = 'C:\\Users\\me\\R&D & mkdir pwned (x) 100% ^!';
  // a key in lower case, PATH entries cmd reads against the current folder, and a machine that set
  // NoDefaultCurrentDirectoryInExePath for every program
  const base = { Path: 'C:\\bin;.;\\tools', SYSTEMROOT: 'D:\\Win', anthropic_api_key: 'sk-test', NoDefaultCurrentDirectoryInExePath: '1' };
  const noKey = env => Object.keys(env).every(k => k.toUpperCase() !== 'ANTHROPIC_API_KEY');
  const t = ca.windowsTerminal(repo, acc, 'feat-x', base);
  assert.equal(t.file, 'D:\\Win\\System32\\cmd.exe');
  assert.deepEqual(t.args, ['/d', '/s', '/c', '"start "Claude" cmd /d /v:off /k call open.cmd"']);
  assert.deepEqual([t.options.cwd, t.options.windowsVerbatimArguments], [path.join(ca.baseDir(), 'launch'), true]);
  assert.deepEqual([t.options.env.CLAUDE_CONFIG_DIR, t.options.env.CA_REPO, t.options.env.CA_CLAUDE_ARGS], [acc.config_dir, repo, '--worktree feat-x']);
  assert.ok(noKey(t.options.env) && !('NoDefaultCurrentDirectoryInExePath' in t.options.env)); // open.cmd sets it
  assert.equal(t.options.env.Path, 'C:\\bin');
  assert.equal(fs.readFileSync(path.join(ca.baseDir(), 'launch', 'open.cmd'), 'utf8'), ca.OPEN_CMD);
  const d = ca.windowsDocker(repo, acc, null, base);
  assert.equal(d.args[3], '"start "Claude" cmd /d /v:off /k call run.cmd"');
  assert.deepEqual([d.options.cwd, d.options.env.CA_REPO, d.options.env.CA_CLAUDE_ARGS], [path.join(ca.baseDir(), 'docker'), repo, '']);
  assert.ok(noKey(d.options.env) && !('NoDefaultCurrentDirectoryInExePath' in d.options.env));
  assert.equal(fs.readFileSync(path.join(ca.baseDir(), 'docker', 'run.cmd'), 'utf8'), ca.DOCKER_RUN_CMD);
  const login = ca.windowsLogin(acc, base);
  assert.match(login.args[3], /cmd \/d \/v:off \/k claude auth login"$/);
  assert.deepEqual([login.options.cwd, login.options.env.Path], [ca.launchDir(), 'C:\\bin']);
  assert.ok(noKey(login.options.env));
  // The lines people copy drop the key too. On Windows they also keep cmd from running a program from the
  // repository, and pushd takes a network path, which cd can't.
  assert.match(ca.loginCmd(acc, 'Darwin'), /^env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=/);
  assert.match(ca.terminalCmd('/r', acc, null, [], 'Linux'), /^cd \/r && env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR=/);
  for (const line of [ca.terminalCmd(repo, acc, null, [], 'Windows'), ca.loginCmd(acc, 'Windows')])
    assert.match(line, /set "NoDefaultCurrentDirectoryInExePath=1" && set "CLAUDE_CONFIG_DIR=[^"]+" && set "ANTHROPIC_API_KEY=" && claude/);
  assert.ok(ca.terminalCmd(repo, acc, null, [], 'Windows').startsWith(`@pushd "${repo}" && `));
  // @, which cmd ignores, keeps PowerShell from running any part of a pasted line
  for (const line of [ca.loginCmd(acc, 'Windows'), ca.desktopCmd(acc, 'Windows')]) assert.ok(line.startsWith('@set "'), line);
  assert.throws(() => ca.windowsTerminal(repo, acc, 'x&calc', base), /refusing/);
  for (const bad of ['a^b', 'x%PATH%', '"q"', 'a|b', 'C:\\x']) assert.throws(() => ca.cmdSafe(bad), ca.CaError);
  for (const [arg, want] of [['C:\\R&D', '"C:\\R&D"'], ['plain', 'plain'], ['100%', '"100%"'], ['', '""'], ['a b\\', '"a b\\\\"']])
    assert.equal(ca.winQuote(arg), want);
  assert.throws(() => ca.winQuote('say "hi" & calc'), /double quote/);
  const desk = ca.desktopLaunch(acc, 'Windows', { LOCALAPPDATA: 'C:\\L', anthropic_api_key: 'sk-test' });
  assert.ok(desk.env.CLAUDE_CONFIG_DIR === acc.config_dir && noKey(desk.env));
});

test('AppleScript gets the terminal command as an argument, unescaped', { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
  const cmd = `cd '/tmp/a "b" \\ c' && env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR='/x/Área' claude # ✓`;
  const out = execFileSync('osascript', ['-e', 'on run argv', '-e', 'return item 1 of argv', '-e', 'end run', cmd], { encoding: 'utf8' });
  assert.equal(out.replace(/\n$/, ''), cmd);
});
