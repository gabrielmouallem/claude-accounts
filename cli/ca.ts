// ca: opens each repository with the right Claude account, from the terminal. It is built on src/core.ts like the
// app, so both read and write one config.json and print the same commands. scripts/build-cli.ts compiles it with
// Bun into a single executable, which the app bundles. Its Install button puts it in ~/.local/lib/claude-accounts,
// behind a script at ~/.local/bin/ca (ca.cliWrapper). macOS and Linux only. Credential files are only checked for
// existence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as ca from '../src/core.ts';
import type { Account, Config, Engine, System } from '../src/types.ts';

// Set by scripts/build-cli.ts in the executable, and absent when Node or Bun runs this file
declare const CA_COMPILED: boolean | undefined;
declare const CA_VERSION: string | undefined;

// The installed ca is a script that starts this executable with DO_NOT_TRACK=1, for the Bun runtime inside it, and
// names itself in CA_WRAPPER (see cliWrapper in src/core.ts). The programs ca runs get the caller's own DO_NOT_TRACK
// back, and only the absolute entries of PATH, so a repository's own node or claude can't stand in for the real one.
const WRAPPER = process.env.CA_WRAPPER;
const ENV: ca.Env = (() => {
  const env = { ...process.env, PATH: ca.posixDirs(process.env.PATH) };
  if (WRAPPER !== undefined) {
    const caller = env.CA_CALLER_DO_NOT_TRACK ?? '';
    if (caller.startsWith('=')) env.DO_NOT_TRACK = caller.slice(1); else delete env.DO_NOT_TRACK;
  }
  delete env.CA_WRAPPER; delete env.CA_CALLER_DO_NOT_TRACK;
  return env;
})();
// For a Desktop window that has never opened: what the app's sign-in guide says (desktopGuide in src/renderer/app.ts)
const DESKTOP_FIRST = "[ca] This account's Claude Desktop window isn't signed in yet. Choose Continue with email there and type the code from the email. A Google sign-in, or the link in the email, goes to the Claude that was open first.";

const USAGE = `usage: ca <command> [options]

  add-account <name> [--config-dir DIR] [--desktop-dir DIR] [--docker-dir DIR]
  rename-account <name> <new-name>
  bind <repo> <account> [--mode terminal|docker|desktop]
  unbind <repo>
  list
  status [--deep]          --deep also asks \`claude auth status\` who each account is signed in as
  run [repo] [-w [NAME]] [--print]
  login <account> [--print]
  desktop <account> [--launch] [--os Darwin|Windows|Linux]
  shell-hook direnv|zsh|bash [repo] [--write]
  env [path] [--shell]
  docker-run [repo] [--engine docker|container] [--build] [--print] [-w [NAME]]

Arguments after -- go to claude. ca and the Claude Accounts app share one config.`;

class UsageError extends Error {}

// ---------------------------------------------------------------- arguments
interface Spec { min?: number; max?: number; flags?: string[]; values?: string[]; worktree?: boolean }
interface Args { pos: string[]; flags: Set<string>; values: Map<string, string>; worktree: string | null; extra: string[] }
// Arguments after `--` go to claude. -w/--worktree takes the next argument only when it isn't an option, so `-w`
// alone lets Claude Code name the worktree.
function parse(args: string[], { min = 0, max = 0, flags = [], values = [], worktree = false }: Spec): Args {
  const dash = args.indexOf('--');
  const own = dash < 0 ? args : args.slice(0, dash);
  const out: Args = { pos: [], flags: new Set(), values: new Map(), worktree: null, extra: dash < 0 ? [] : args.slice(dash + 1) };
  for (let i = 0; i < own.length; i++) {
    const a = own[i]!;
    if (!a.startsWith('-') || a === '-') { out.pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = a === '-w' ? 'worktree' : a.startsWith('--') ? a.slice(2, eq < 0 ? undefined : eq) : '';
    const inline = a.startsWith('--') && eq >= 0 ? a.slice(eq + 1) : undefined;
    if (name === 'worktree' && worktree) {
      const next = own[i + 1];
      out.worktree = inline ?? (next !== undefined && !next.startsWith('-') ? own[++i]! : '');
    } else if (values.includes(name)) {
      const v = inline ?? own[++i];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      out.values.set(name, v);
    } else if (flags.includes(name) && inline === undefined) out.flags.add(name);
    else throw new UsageError(`unknown option ${a}`);
  }
  if (out.pos.length < min) throw new UsageError('missing arguments');
  if (out.pos.length > max) throw new UsageError(`unexpected argument ${out.pos[max]}`);
  if (out.worktree !== null && !ca.WORKTREE.test(out.worktree))
    throw new ca.CaError(`invalid worktree name ${JSON.stringify(out.worktree)}: use letters, numbers, dot, dash, underscore and slash, up to 100, not starting with a dash`);
  return out;
}
function oneOf<T extends string>(value: string | undefined, choices: readonly T[], what: string): T | undefined {
  if (value === undefined || (choices as readonly string[]).includes(value)) return value as T | undefined;
  throw new UsageError(`${what} must be one of ${choices.join(', ')}`);
}

// ---------------------------------------------------------------- processes
// A program from PATH by its full path, or a clear error
function need(name: string): string {
  const exe = ca.program(name);
  if (!exe) throw new ca.CaError(`${name} not found on PATH`);
  return exe;
}
// Runs a program in this terminal and ends the way it did. Node and Bun can't exec, so ca waits for it. Ctrl+C and
// Ctrl+\ reach the program directly, since both are in the foreground, so ca only ignores them; a TERM or HUP sent to
// ca is passed on.
// The signals that end a program without a crash or a core dump, which ca passes on to itself when the program ends on
// one. Any other, such as a crash's SIGSEGV, would look like Bun crashing, so ca exits with 128 plus its number, the
// status a shell gives it.
const ENDINGS = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE', 'SIGKILL']);
function foreground(file: string, args: string[], options: { cwd?: string; env: ca.Env }): Promise<number> {
  const child = spawn(file, args, { ...options, stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'] as const;
  const pass = (s: NodeJS.Signals) => { if (s === 'SIGTERM' || s === 'SIGHUP') child.kill(s); };
  for (const s of signals) process.on(s, pass);
  const done = () => { for (const s of signals) process.off(s, pass); };
  return new Promise((resolve, reject) => {
    child.on('error', e => { done(); reject(new ca.CaError(`couldn't start ${file}: ${e.message}`)); });
    child.on('exit', (code, signal) => {
      done();
      if (signal && ENDINGS.has(signal)) process.kill(process.pid, signal);   // so the shell reports it as ca's
      resolve(code ?? (signal ? 128 + os.constants.signals[signal] : 1));
    });
  });
}
async function deepStatus(acc: Account): Promise<string> {
  const exe = ca.program('claude');
  return exe ? (await ca.authStatus(acc, { claude: exe, env: ENV })).note : 'error: claude CLI not found';
}
function knownAccount(cfg: Config, name: string): Account {
  const acc = Object.hasOwn(cfg.accounts, name) ? cfg.accounts[name] : undefined;
  if (!acc) throw new ca.CaError(`unknown account ${JSON.stringify(name)}; run: ca add-account ${name}`);
  return acc;
}
// How the shell hook runs ca again: the installed script that started it. Otherwise this executable by its full path,
// or the runtime and this file from a checkout, with the DO_NOT_TRACK=1 that the script would set as Bun starts.
function selfCommand(): string {
  if (WRAPPER) return ca.shQuote(path.resolve(WRAPPER));
  const argv = typeof CA_COMPILED !== 'undefined' ? [process.execPath] : [process.execPath, process.argv[1] ?? ''];
  return `DO_NOT_TRACK=1 ${argv.map(ca.shQuote).join(' ')}`;
}
// Appends without following a symbolic link: a repository can ship .envrc as a link to a file of yours, such as
// ~/.zshrc. Returns whether the file is new.
function appendNoFollow(file: string, text: string): boolean {
  const { O_WRONLY, O_APPEND, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  let fd: number, created = true;
  try {
    try { fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL, 0o666); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      fd = fs.openSync(file, O_WRONLY | O_APPEND | O_NOFOLLOW); created = false;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ELOOP') throw e;
    throw new ca.CaError(`${file} is a symbolic link, so ca won't write to it. Remove the link, or add this line yourself:\n${text.trimEnd()}`);
  }
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
  return created;
}

// ---------------------------------------------------------------- commands
async function runRepo(repo: string, acc: Account, account: string, a: Args): Promise<number | void> {
  if (a.flags.has('print')) { console.log(ca.terminalCmd(repo, acc, a.worktree, a.extra)); return; }
  const exe = need('claude');
  console.error(`[ca] ${path.basename(repo)} -> account '${account}'`);
  return foreground(exe, ca.claudeArgv(a.worktree, a.extra).slice(1), { cwd: repo, env: ca.claudeEnv(acc, ENV) });
}
async function dockerRun(repo: string, acc: Account, engine: Engine, a: Args): Promise<number | void> {
  const ctx = ca.writeDockerfile();
  const other: Engine = engine === 'docker' ? 'container' : 'docker';
  const [, build, run] = ca.dockerCmds(repo, acc, engine, a.worktree, a.extra);
  const [, otherBuild, otherRun] = ca.dockerCmds(repo, acc, other, a.worktree, a.extra);
  console.log([
    `# Dockerfile: ${path.join(ctx, 'Dockerfile')}`, `# build: ${build}`, `# run:   ${run}`,
    `# alt (${other === 'container' ? 'Apple container' : 'docker'}):`, `#   ${otherBuild}`, `#   ${otherRun}`,
    `# first run: type /login inside the container (login stored in ${acc.docker_config_dir})`,
  ].join('\n'));
  if (a.flags.has('print')) return;
  const exe = ca.program(engine);
  if (!exe) throw new ca.CaError(`${engine} not found; the commands are printed above`);
  const [buildArgv, runArgv] = ca.dockerArgv(repo, acc, engine, a.worktree, a.extra);
  const env = ca.withoutVars(ENV, 'ANTHROPIC_API_KEY');
  if (a.flags.has('build') || spawnSync(exe, ['image', 'inspect', ca.IMAGE], { stdio: 'ignore', env }).status !== 0) {
    if (spawnSync(exe, buildArgv.slice(1), { stdio: 'inherit', env }).status !== 0) throw new ca.CaError(`${engine} build failed`);
  }
  return foreground(exe, runArgv.slice(1), { env });
}

async function main(args: string[]): Promise<number | void> {
  const [cmd = '', ...rest] = args;
  const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (cmd === '-h' || cmd === '--help' || own.includes('-h') || own.includes('--help')) { console.log(USAGE); return; }
  if (cmd === '--version') { console.log(typeof CA_VERSION === 'string' ? CA_VERSION : 'dev'); return; }
  switch (cmd) {
    case 'add-account': {
      const a = parse(rest, { min: 1, max: 1, values: ['config-dir', 'desktop-dir', 'docker-dir'] });
      const cfg = ca.load(), name = a.pos[0]!;
      const acc = ca.addAccount(cfg, name, a.values.get('config-dir'), a.values.get('desktop-dir'), a.values.get('docker-dir'));
      ca.save(cfg);
      console.log(JSON.stringify({ [name]: acc }, null, 2));
      console.log(`next: ca login ${name}`);
      return;
    }
    case 'rename-account': {
      const a = parse(rest, { min: 2, max: 2 });
      const cfg = ca.load(), [from = '', to = ''] = a.pos;
      ca.renameAccount(cfg, from, to);
      ca.save(cfg);
      console.log(`${from} -> ${to}`);
      return;
    }
    case 'bind': {
      const a = parse(rest, { min: 2, max: 2, values: ['mode'] });
      const mode = oneOf(a.values.get('mode'), ca.MODES, '--mode') ?? 'terminal';
      const cfg = ca.load(), [repo = '', account = ''] = a.pos;
      const p = ca.bind(cfg, repo, account, mode);
      ca.save(cfg);
      console.log(`${p} -> ${account} (${mode})`);
      return;
    }
    case 'unbind': {
      const a = parse(rest, { min: 1, max: 1 });
      const cfg = ca.load();
      ca.unbind(cfg, a.pos[0]!);
      ca.save(cfg);
      return;
    }
    case 'list': case 'status': {
      const status = cmd === 'status', a = parse(rest, { flags: status ? ['deep'] : [] });
      const cfg = ca.load();
      console.log('ACCOUNTS');
      for (const name of Object.keys(cfg.accounts).sort()) {
        const acc = cfg.accounts[name]!;
        const deep = a.flags.has('deep') ? `  [${await deepStatus(acc)}]` : '';
        console.log(`  ${name.padEnd(14)} cli=${ca.loginState(acc).padEnd(14)} container=${ca.dockerLoginState(acc).padEnd(14)} ${acc.config_dir}${deep}`);
      }
      console.log('REPOS');
      for (const r of ca.rows(cfg))
        console.log(`  ${r.repo.padEnd(50)} -> ${r.account.padEnd(14)} ${r.mode.padEnd(9)} ${status ? r.login : ''}${r.exists ? '' : '  (missing)'}`);
      if (status) {
        const [repo, b] = ca.findRepo(cfg);
        console.log(`CWD: ${b ? `bound to ${b.account} via ${repo}` : 'not bound'}`);
      }
      return;
    }
    case 'run': case 'docker-run': {
      const docker = cmd === 'docker-run';
      const a = parse(rest, { max: 1, flags: docker ? ['print', 'build'] : ['print'], values: docker ? ['engine'] : [], worktree: true });
      const cfg = ca.load(), [repo, b] = ca.findRepo(cfg, a.pos[0]);
      if (!repo || !b) throw new ca.CaError('repo not bound; run: ca bind <repo> <account>');
      const acc = ca.accountOf(cfg, b);
      if (docker) return dockerRun(repo, acc, oneOf(a.values.get('engine'), ['docker', 'container'] as const, '--engine') ?? 'docker', a);
      if (b.mode === 'docker') return dockerRun(repo, acc, 'docker', a);
      return runRepo(repo, acc, b.account, a);
    }
    case 'login': {
      const a = parse(rest, { min: 1, max: 1, flags: ['print'] });
      const name = a.pos[0]!, acc = knownAccount(ca.load(), name);
      if (a.flags.has('print')) { console.log(ca.loginCmd(acc)); return; }
      const exe = need('claude');
      console.error(`[ca] signing in account '${name}' (config dir ${acc.config_dir})`);
      return foreground(exe, ['auth', 'login'], { cwd: os.homedir(), env: ca.claudeEnv(acc, ENV) });
    }
    case 'desktop': {
      const a = parse(rest, { min: 1, max: 1, flags: ['launch'], values: ['os'] });
      const system: System = oneOf(a.values.get('os'), ['Darwin', 'Windows', 'Linux'] as const, '--os') ?? ca.SYSTEM;
      const acc = knownAccount(ca.load(), a.pos[0]!);
      console.log(ca.desktopCmd(acc, system));
      const l = a.flags.has('launch') && system === ca.SYSTEM ? ca.desktopLaunch(acc, system, ENV) : null;
      if (!l) return;
      if (ca.desktopNeverOpened(acc)) console.error(DESKTOP_FIRST);
      spawn(need(l.file), l.args, { env: l.env, cwd: os.homedir(), detached: true, stdio: 'ignore' }).unref();
      return;
    }
    case 'shell-hook': {
      const a = parse(rest, { min: 1, max: 2, flags: ['write'] });
      const kind = oneOf(a.pos[0], ['direnv', 'zsh', 'bash'] as const, 'the kind')!;
      const cfg = ca.load(), out = ca.shellHook(kind, { cfg, repo: a.pos[1], caCommand: selfCommand() });
      const [repo] = ca.findRepo(cfg, a.pos[1]);
      if (kind === 'direnv' && a.flags.has('write') && repo) {
        const file = path.join(repo, '.envrc'), allow = `direnv allow ${ca.shQuote(repo)}`;
        // direnv allow approves the whole file, and a file the repository ships has lines of its own
        console.log(appendNoFollow(file, out + '\n') ? `created ${file}; run: ${allow}`
          : `appended to ${file}, which was already there. direnv allow approves all of it, so read it first, then run: ${allow}`);
      } else console.log(out);
      return;
    }
    case 'env': {
      const a = parse(rest, { max: 1, flags: ['shell'] });
      const cfg = ca.load();
      if (a.flags.has('shell')) { console.log(ca.envShell(cfg, a.pos[0])); return; }
      const [, b] = ca.findRepo(cfg, a.pos[0]);
      console.log(b ? `CLAUDE_CONFIG_DIR=${ca.accountOf(cfg, b).config_dir}` : 'not bound');
      return;
    }
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : 'missing command');
  }
}

const argv = process.argv.slice(2);
if (ca.SYSTEM === 'Windows') {
  console.error("ca: Windows isn't supported yet; use the Claude Accounts app");
  process.exitCode = 1;
} else if (argv.length === 2 && argv[0] === 'env' && argv[1] === '--shell') {
  // The shell hook runs this before every prompt, so it is answered first and never fails: a config that can't be
  // read leaves the shell as it is outside a bound repository, and says why on stderr.
  let cfg: Config = { accounts: {}, repos: {} };
  try { cfg = ca.load(); } catch (e) { console.error(`ca: ${e instanceof Error ? e.message : String(e)}`); }
  console.log(ca.envShell(cfg));
} else {
  try { process.exitCode = (await main(argv)) ?? 0; }
  catch (e) {
    if (e instanceof UsageError) { console.error(`${USAGE}\n\nca: ${e.message}`); process.exitCode = 2; }
    else if (e instanceof ca.CaError || (e instanceof Error && 'code' in e)) { console.error(`ca: ${e.message}`); process.exitCode = 1; }
    else throw e;
  }
}
