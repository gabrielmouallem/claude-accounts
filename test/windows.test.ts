// Windows only: runs the real cmd.exe on the app's launch specs, from a folder whose name is full of cmd syntax,
// with fake `claude` and `docker` that record what they receive. Proves no part of a path is read as a command.
// It runs what the new console would, without `start`, which would open a window and return at once.
// The fake claude is a batch file that runs node by name, like the shim npm installs when node.exe isn't next to
// it. The fake docker is an .exe, like the real one: a batch file run from run.cmd behaves differently (see
// DOCKER_RUN_CMD). The repository, and the home folder the CLI signs in from, hold a cmd.exe, claude.cmd, node.cmd
// and docker.cmd of their own, and none of them may ever run.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Account } from '../src/types.ts';
import type { WinLaunch } from '../src/core.ts';

const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-win-'));
process.env.CA_CONFIG = path.join(TMP, 'cfg', 'config.json');
// Loaded once CA_CONFIG is set, so nothing here can reach the real config
const ca = await import('../src/core.ts');

const BIN = path.join(TMP, 'bin'), HOME = path.join(TMP, 'home'), LOG = path.join(TMP, 'calls.jsonl');
const REPO = path.join(TMP, 'R&D & mkdir pwned (x) 100% ^!');
const RECORD = path.join(BIN, 'record.js');
const real = (p: string) => fs.realpathSync.native(p);
let acc: Account;

// record.js as a console program, for the .NET Framework compiler that ships with Windows (C# 5). It exits 1 when
// its first argument is CA_TEST_FAIL, so `docker image inspect` can report a missing image.
const RECORDER_CS = String.raw`
using System; using System.IO; using System.Text;
static class Recorder {
  static string Q(string s) { return s == null ? "null" : "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  static int Main(string[] args) {
    var sb = new StringBuilder("{\"argv\":[").Append(Q(Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0])));
    foreach (var a in args) sb.Append(",").Append(Q(a));
    sb.Append("],\"cwd\":").Append(Q(Environment.CurrentDirectory))
      .Append(",\"config\":").Append(Q(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR")))
      .Append(",\"key\":").Append(Q(Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY"))).Append("}\n");
    File.AppendAllText(Environment.GetEnvironmentVariable("CA_TEST_LOG"), sb.ToString());
    return args.Length > 0 && args[0] == Environment.GetEnvironmentVariable("CA_TEST_FAIL") ? 1 : 0;
  }
}`;

// Runs what the console a spec opens would run (`start "Claude" cmd <switches> /k <line>`), with its switches.
// `pre` goes ahead of them: cmd takes the last /v it is given, so a /v:on there stands in for the registry value
// that turns delayed expansion on for every cmd, which the console's own switches have to override.
function runConsole(spec: WinLaunch, pre: string[] = []) {
  const m = /^"start "Claude" cmd (.*?) \/k (.*)"$/.exec(spec.args[3] ?? '');
  assert.ok(m, `not a console launch: ${spec.args[3]}`);
  const [, switches = '', line = ''] = m;
  return spawnSync(spec.file, [...pre, ...switches.split(' '), '/s', '/c', `"${line}"`], { ...spec.options, encoding: 'utf8' });
}
interface Call { argv: string[]; cwd: string; marker?: boolean; config: string | null; key: string | null }
const calls = (): Call[] => fs.readFileSync(LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const nonePlanted = (list: Call[]) => assert.deepEqual(list.filter(c => ['planted', 'cmd'].includes(c.argv[0] ?? '')), []);
// The first `n` calls, which have to be there
function first(list: Call[], n: number): Call[] {
  assert.ok(list.length >= n, `expected ${n} calls, got ${JSON.stringify(list)}`);
  return list.slice(0, n);
}
// The key in lower case: Windows reads names without regard to case, so this spelling would reach claude too.
const env = () => ({ ...process.env, PATH: `${BIN};${process.env.PATH}`, CA_TEST_LOG: LOG, anthropic_api_key: 'sk-test' });
// The CLI, run from inside the repository the way a person would, by the full path of python.
const PY = WIN ? (spawnSync('where', ['python'], { encoding: 'utf8' }).stdout || '').split(/\r?\n/)[0]?.trim() ?? '' : '';
const cli = (...args: string[]) => spawnSync(PY, [path.join(import.meta.dirname, '..', 'cli', 'ca'), ...args],
  { cwd: REPO, env: { ...env(), USERPROFILE: HOME }, encoding: 'utf8' });

before(() => {
  if (!WIN) return;
  for (const dir of [BIN, HOME, REPO]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(REPO, 'ca-marker'), '');
  fs.writeFileSync(RECORD, `const fs = require('fs');
fs.appendFileSync(process.env.CA_TEST_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
  marker: fs.existsSync('ca-marker'), config: process.env.CLAUDE_CONFIG_DIR ?? null, key: process.env.ANTHROPIC_API_KEY ?? null }) + '\\n');`);
  // How npm's own shim ends when node.exe isn't next to it: node by name, after a goto that fails on purpose to leave
  // the batch file. %* hands on the arguments exactly as cmd received them, quotes included.
  fs.writeFileSync(path.join(BIN, 'claude.cmd'),
    ['@ECHO off', 'SETLOCAL', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node "${RECORD}" claude %*`, ''].join('\r\n'));
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition $env:CA_SOURCE -OutputAssembly $env:CA_EXE -OutputType ConsoleApplication'],
    { env: { ...process.env, CA_SOURCE: RECORDER_CS, CA_EXE: path.join(BIN, 'docker.exe') }, encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.stdout + ps.stderr);
  for (const dir of [REPO, HOME]) {
    for (const f of ['claude.cmd', 'node.cmd', 'docker.cmd']) fs.writeFileSync(path.join(dir, f), `@"${process.execPath}" "${RECORD}" planted %*\r\n`);
    fs.copyFileSync(path.join(BIN, 'docker.exe'), path.join(dir, 'cmd.exe'));   // would record itself as "cmd"
  }
  const cfg = ca.load(); acc = ca.addAccount(cfg, 'work'); ca.bind(cfg, REPO, 'work'); ca.save(cfg);
});

test('Terminal: claude starts in the repository, as the account, without the API key', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const spec = ca.windowsTerminal(REPO, acc, 'feat-x', env());
  assert.ok(path.isAbsolute(spec.file));                      // never a cmd.exe found in the working folder
  assert.notEqual(real(spec.options.cwd), real(REPO));
  const r = runConsole(spec);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = calls(); nonePlanted(all);
  const [c] = first(all, 1) as [Call];
  assert.deepEqual(c.argv, ['claude', '--worktree', 'feat-x']);
  assert.deepEqual([real(c.cwd), c.marker, c.config, c.key], [real(REPO), true, acc.config_dir, null]);
  assert.ok(!fs.existsSync(path.join(REPO, 'pwned')));
});

test('Terminal: a repository on a network path opens there, and its drive letter is given back', { skip: !WIN && 'Windows only' }, t => {
  const unc = `\\\\localhost\\${REPO[0]}$${REPO.slice(2)}`;   // the same folder, through the administrative share
  if (!fs.existsSync(unc)) return t.skip('no administrative share on this machine');
  fs.rmSync(LOG, { force: true });
  const r = runConsole(ca.windowsTerminal(unc, acc, null, env()));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = calls(); nonePlanted(all);
  const [c] = first(all, 1) as [Call], drive = /^([A-Za-z]):\\/.exec(c.cwd);
  assert.ok(drive && c.marker, `claude started in ${c.cwd}`);   // on the drive letter pushd mapped to the share
  // popd runs once the shim's failed goto hands control back to open.cmd
  assert.ok(!fs.existsSync(`${drive[1]}:\\`), `${drive[1]}: was still mapped after Claude Code exited`);
});

test('Docker: run.cmd hands the folder to docker intact', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const spec = ca.windowsDocker(REPO, acc, 'feat-x', env());
  const r = runConsole(spec);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = calls(); nonePlanted(all);
  const [inspect, run] = first(all, 2) as [Call, Call];
  assert.deepEqual(inspect.argv, ['docker', 'image', 'inspect', ca.IMAGE]);   // found, so no build
  assert.deepEqual(run.argv, ca.dockerArgv(REPO, acc, 'docker', 'feat-x')[1]);
  assert.deepEqual([real(run.cwd), run.key], [real(spec.options.cwd), null]);  // never from inside the repository
  for (const dir of [REPO, spec.options.cwd]) assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
});

test('Docker: a missing image is built from its own folder', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const spec = ca.windowsDocker(REPO, acc, null, { ...env(), CA_TEST_FAIL: 'image' });
  const r = runConsole(spec);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [, build, run] = first(calls(), 3) as [Call, Call, Call];
  assert.deepEqual([build.argv, real(build.cwd)], [['docker', 'build', '-t', ca.IMAGE, '.'], real(spec.options.cwd)]);
  assert.deepEqual(run.argv, ca.dockerArgv(REPO, acc, 'docker', null)[1]);
});

test('Launches work when a machine sets cmd up stricter for every program', { skip: !WIN && 'Windows only' }, () => {
  const probe = spawnSync(ca.cmdExe(), ['/v:on', '/v:off', '/d', '/c', 'echo !CA_PROBE!'], { env: { ...process.env, CA_PROBE: 'x' }, encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), '!CA_PROBE!', 'cmd took the first /v switch, so runConsole cannot stand in for the registry');
  fs.rmSync(LOG, { force: true });
  // Delayed expansion would read ! and ^ in the path. NoDefaultCurrentDirectoryInExePath would hide the launchers
  // in their own folder.
  const strict = { ...env(), NoDefaultCurrentDirectoryInExePath: '1' };
  for (const spec of [ca.windowsTerminal(REPO, acc, null, strict), ca.windowsDocker(REPO, acc, null, strict)]) {
    const r = runConsole(spec, ['/v:on']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  const all = calls(); nonePlanted(all);
  const [term, , run] = first(all, 3) as [Call, Call, Call];
  assert.deepEqual([real(term.cwd), run.argv], [real(REPO), ca.dockerArgv(REPO, acc, 'docker', null)[1]]);
});

test('Sign-in runs claude auth login as the account, from a folder of ours', { skip: !WIN && 'Windows only' }, () => {
  fs.rmSync(LOG, { force: true });
  const spec = ca.windowsLogin(acc, env());
  const r = runConsole(spec);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const all = calls(); nonePlanted(all);
  const [c] = first(all, 1) as [Call];
  assert.deepEqual([c.argv, real(c.cwd), c.config, c.key], [['claude', 'auth', 'login'], real(spec.options.cwd), acc.config_dir, null]);
});

test('Deep status asks claude as the account, whatever folder the app is in', { skip: !WIN && 'Windows only' }, async () => {
  fs.rmSync(LOG, { force: true });
  const here = process.cwd();
  process.chdir(REPO);
  try { assert.equal((await ca.authStatus(acc, { env: env() })).note, 'exit 0'); } finally { process.chdir(here); }
  const all = calls(); nonePlanted(all);
  const [c] = first(all, 1) as [Call];
  assert.deepEqual([c.argv, real(c.cwd), c.config, c.key], [['claude', 'auth', 'status'], real(ca.launchDir()), acc.config_dir, null]);
});

test('CLI: ca run starts claude in the repository and ca login signs in from home, as the account', { skip: (!WIN && 'Windows only') || (!PY && 'python missing') }, () => {
  fs.rmSync(LOG, { force: true });
  for (const args of [['run', REPO, '--', '--version'], ['login', 'work']]) {
    const r = cli(...args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  const all = calls(); nonePlanted(all);
  const [run, login] = first(all, 2) as [Call, Call];
  assert.deepEqual([run.argv, real(run.cwd), run.config, run.key], [['claude', '--version'], real(REPO), acc.config_dir, null]);
  assert.deepEqual([login.argv, real(login.cwd), login.config, login.key], [['claude', 'auth', 'login'], real(HOME), acc.config_dir, null]);
});
