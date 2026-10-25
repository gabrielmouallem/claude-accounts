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
const PY_CA = path.join(__dirname, '..', 'resources', 'ca');
const which = b => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0;
const r1 = path.join(TMP, 'repo-work'), r2 = path.join(TMP, 'repo-personal');

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
    assert.equal(fs.statSync(a.config_dir).mode & 0o777, 0o700);
  }
  assert.deepEqual(cfg.repos[fs.realpathSync(r1)], { account: 'work', mode: 'terminal' });
  assert.equal(cfg.repos[fs.realpathSync(r2)].mode, 'docker');
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
  assert.equal(r, fs.realpathSync(r1)); assert.equal(b.account, 'work');
  assert.deepEqual(ca.findRepo(ca.load(), TMP), [null, null]);
});

test('env construction strips ANTHROPIC_API_KEY', () => {
  const acc = ca.load().accounts.work;
  const env = ca.claudeEnv(acc, { ANTHROPIC_API_KEY: 'x', PATH: '/bin' });
  assert.equal(env.CLAUDE_CONFIG_DIR, acc.config_dir); assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.ok(ca.envShell(ca.load(), path.join(r1, 'src')).includes(`export CLAUDE_CONFIG_DIR=${acc.config_dir}`));
  assert.ok(ca.envShell(ca.load(), TMP).includes('unset'));
});

test('run command + worktree', () => {
  const cfg = ca.load(), acc = cfg.accounts.work;
  const out = ca.terminalCmd(fs.realpathSync(r1), acc, 'feat-x', [], 'Linux');
  assert.ok(out.includes('CLAUDE_CONFIG_DIR=')); assert.ok(out.includes('claude --worktree feat-x'));
  assert.ok(out.includes('env -u ANTHROPIC_API_KEY'));
  assert.ok(ca.terminalCmd(r1, acc, '', [], 'Linux').endsWith('claude --worktree'));
  const win = ca.terminalCmd('C:\\My Repo', acc, null, [], 'Windows');
  assert.ok(win.startsWith('cd /d "C:\\My Repo"')); assert.ok(win.includes('set "ANTHROPIC_API_KEY="'));
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

test('login state uses existence only (unreadable file)', () => {
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
  const cfg = ca.load(), acc = cfg.accounts.personal, repo = fs.realpathSync(r2);
  const [ctx, build, run] = ca.dockerCmds(repo, acc);
  assert.ok(build.includes('docker build -t claude-code-ca:latest'));
  assert.ok(run.includes(`${acc.docker_config_dir}:/home/node/.claude`)); assert.ok(run.includes(`${repo}:/workspace`));
  assert.ok(ca.dockerCmds(repo, acc, 'container')[2].startsWith('container run --rm -it'));
  ca.writeDockerfile();
  assert.ok(fs.readFileSync(path.join(ctx, 'Dockerfile'), 'utf8').includes('npm i -g @anthropic-ai/claude-code'));
  assert.ok(ca.rows(cfg).find(r => r.repo === repo).command.startsWith('docker run')); // honours mode=docker
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
  assert.equal(V.boundRepo(cfg, fs.realpathSync(r1)), fs.realpathSync(r1));
  assert.throws(() => V.mode('shell'), V.ValidationError);
  assert.throws(() => V.worktree('--dangerous'), V.ValidationError);
  assert.throws(() => V.worktree('a;rm -rf /'), V.ValidationError);
  assert.equal(V.worktree(''), ''); assert.equal(V.worktree(undefined), null);
  assert.throws(() => V.str({ toString: () => 'x' }, 'x'), V.ValidationError);
});

test('config.json stays compatible with the Python ca CLI', { skip: !which('python3') && 'python3 missing' }, () => {
  const env = { ...process.env, CA_CONFIG: process.env.CA_CONFIG };
  const list = execFileSync('python3', [PY_CA, 'list'], { env, encoding: 'utf8' });
  assert.match(list, /work/); assert.match(list, /repo-personal/);
  const r3 = path.join(TMP, 'repo-py'); fs.mkdirSync(r3);
  execFileSync('python3', [PY_CA, 'add-account', 'from-python'], { env });
  execFileSync('python3', [PY_CA, 'bind', r3, 'from-python', '--mode', 'desktop'], { env });
  const cfg = ca.load();
  assert.equal(cfg.repos[fs.realpathSync(r3)].mode, 'desktop');
  ca.unbind(cfg, r3); ca.removeAccount(cfg, 'from-python'); ca.save(cfg);
  assert.ok(!execFileSync('python3', [PY_CA, 'list'], { env, encoding: 'utf8' }).includes('from-python'));
});
