'use strict';
// Windows only: runs the real cmd.exe on the app's launch specs, from a folder whose name is full of cmd syntax,
// with fake `claude` and `docker` that record what they receive. Proves no part of a path is read as a command.
// It runs the line the app hands to `start`, without `start`, which would open a window and return at once.
// The fake claude is a batch file, like the shim npm installs. The fake docker is an .exe, like the real one: a
// batch file run from run.cmd behaves differently (see DOCKER_RUN_CMD).
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

// record.js as a console program, for the .NET Framework compiler that ships with Windows (C# 5).
// It exits 1 when its first argument is CA_TEST_FAIL, so `docker image inspect` can report a missing image.
const RECORDER_CS = String.raw`
using System; using System.IO; using System.Text;
static class Recorder {
  static string Q(string s) { return s == null ? "null" : """ + s.Replace("\", "\\").Replace(""", "\"") + """; }
  static int Main(string[] args) {
    var sb = new StringBuilder("{"argv":[").Append(Q(Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0])));
    foreach (var a in args) sb.Append(",").Append(Q(a));
    sb.Append("],"cwd":").Append(Q(Environment.CurrentDirectory))
      .Append(","config":").Append(Q(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR")))
      .Append(","key":").Append(Q(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY"))).Append("}
");
    File.AppendAllText(Environment.GetEnvironmentVariable("CA_TEST_LOG"), sb.ToString());
    return args.Length > 0 && args[0] == Environment.GetEnvironmentVariable("CA_TEST_FAIL") ? 1 : 0;
  }
}`;

// The text after `cmd /d /k` in a spec: what the new console window would run.
const inner = spec => /cmd \/d \/k (.*)"$/.exec(spec.args[3])[1];
const runInner = (spec, flags = []) => spawnSync('cmd.exe', ['/d', ...flags, '/s', '/c', `"${inner(spec)}"`], { ...spec.options, encoding: 'utf8' });
const calls = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const env = () => ({ ...process.env, PATH: `${BIN};${process.env.PATH}`, CA_TEST_LOG: LOG, ANTHROPIC_API_KEY: 'sk-test' });

before(() => {
  if (!WIN) return;
  fs.mkdirSync(BIN); fs.mkdirSync(REPO);
  fs.writeFileSync(path.join(BIN, 'record.js'), `require('fs').appendFileSync(process.env.CA_TEST_LOG, JSON.stringify({
    argv: process.argv.slice(2), cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR ?? null, key: process.env.ANTHROPIC_API_KEY ?? null }) + '\\n');`);
  // %* hands on the arguments exactly as cmd received them, quotes included
  fs.writeFileSync(path.join(BIN, 'claude.cmd'), `@"${process.execPath}" "%~dp0record.js" claude %*\r\n`);
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition $env:CA_SOURCE -OutputAssembly $env:CA_EXE -OutputType ConsoleApplication'],
    { env: { ...process.env, CA_SOURCE: RECORDER_CS, CA_EXE: path.join(BIN, 'docker.exe') }, encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.stdout + ps.stderr);
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

test('Docker: a missing image is built from its own folder, then run from the repository', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const spec = ca.windowsDocker(REPO, acc, null, { ...env(), CA_TEST_FAIL: 'image' });
  const r = runInner(spec);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [, build, run] = calls();
  assert.deepEqual(build.argv, ['docker', 'build', '-t', ca.IMAGE, '.']);
  assert.equal(real(build.cwd), real(spec.options.cwd));
  assert.deepEqual([run.argv, real(run.cwd)], [ca.dockerArgv(REPO, acc, 'docker', null)[1], real(REPO)]);
});

test('Docker: the folder stays intact when delayed expansion is on for every cmd', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const r = runInner(ca.windowsDocker(REPO, acc, null, env()), ['/v:on']);   // what the DelayedExpansion registry value does
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(calls()[1].argv, ca.dockerArgv(REPO, acc, 'docker', null)[1]);
});

test('Sign-in runs claude auth login as the account', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const r = runInner(ca.windowsLogin(acc, env()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [c] = calls();
  assert.deepEqual([c.argv, c.config, c.key], [['claude', 'auth', 'login'], acc.config_dir, null]);
});
