'use strict';
// Windows only: runs the real cmd.exe on the app's launch specs, from a folder whose name is full of cmd syntax,
// with fake `claude` and `docker` that record what they receive. Proves no part of a path is read as a command.
// It runs the line the app hands to `start`, without `start`, which would open a window and return at once.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-win-'));
process.env.CA_CONFIG = path.join(TMP, 'cfg', 'config.json');
const ca = require('../src/core');

const BIN = path.join(TMP, 'bin'), LOG = path.join(TMP, 'calls.jsonl');
const REPO = path.join(TMP, 'R&D & mkdir pwned (x) 100% ^!');
const real = p => fs.realpathSync.native(p);
let acc;

// The text after `cmd /d /k` in a spec: what the new console window would run.
const inner = spec => /cmd \/d \/k (.*)"$/.exec(spec.args[3])[1];
const runInner = spec => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${inner(spec)}"`], { ...spec.options, encoding: 'utf8' });
const calls = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const env = () => ({ ...process.env, PATH: `${BIN};${process.env.PATH}`, CA_TEST_LOG: LOG, ANTHROPIC_API_KEY: 'sk-test' });

before(() => {
  if (!WIN) return;
  fs.mkdirSync(BIN); fs.mkdirSync(REPO);
  fs.writeFileSync(path.join(BIN, 'record.js'), `require('fs').appendFileSync(process.env.CA_TEST_LOG, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR ?? null, key: process.env.ANTHROPIC_API_KEY ?? null }) + '\\n');`);
  // %* hands on the arguments exactly as cmd received them, quotes included
  for (const name of ['claude', 'docker']) fs.writeFileSync(path.join(BIN, `${name}.cmd`), `@"${process.execPath}" "%~dp0record.js" ${name} %*\r\n`);
  const cfg = ca.load(); acc = ca.addAccount(cfg, 'work'); ca.save(cfg);
});

test('Terminal: claude starts in the folder, as the account, without the API key', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const r = runInner(ca.windowsTerminal(REPO, acc, 'feat-x', env()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [c] = calls();
  assert.deepEqual(c.argv, ['claude', '--worktree', 'feat-x']);
  assert.equal(real(c.cwd), real(REPO));
  assert.deepEqual([c.config, c.key], [acc.config_dir, null]);
  assert.ok(!fs.existsSync(path.join(REPO, 'pwned')));
});

test('Docker: run.cmd hands the folder to docker intact', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const spec = ca.windowsDocker(REPO, acc, 'feat-x', env());
  const r = runInner(spec);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [inspect, run] = calls();
  assert.deepEqual(inspect.argv, ['docker', 'image', 'inspect', ca.IMAGE]);   // found, so no build
  assert.deepEqual(run.argv, ca.dockerArgv(REPO, acc, 'docker', 'feat-x')[1]);
  assert.equal(real(run.cwd), real(REPO));
  assert.equal(run.key, null);
  for (const dir of [REPO, spec.options.cwd]) assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
});

test('Sign-in runs claude auth login as the account', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const r = runInner(ca.windowsLogin(acc, env()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [c] = calls();
  assert.deepEqual([c.argv, c.config, c.key], [['claude', 'auth', 'login'], acc.config_dir, null]);
});
