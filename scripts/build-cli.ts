// Compiles cli/ca.ts with Bun into a single executable that carries its own runtime, so ca needs nothing installed.
// Each lands in out/cli/<platform>-<arch>/ca, the folder electron-builder's ${platform}-${arch} expands to.
// `node scripts/build-cli.ts` builds for this machine; name targets to cross-compile, which downloads Bun's runtime
// for them from npm.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');
// Bun's target for each. Intel gets the baseline build, which also runs on CPUs without AVX2 and under Rosetta.
export const TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64', 'darwin-x64': 'bun-darwin-x64-baseline',
  'linux-arm64': 'bun-linux-arm64', 'linux-x64': 'bun-linux-x64-baseline',
} as const;
export type Target = keyof typeof TARGETS;
export const BUN = path.join(path.dirname(createRequire(import.meta.url).resolve('bun/package.json')), 'bin', 'bun.exe');

export function cliPath(target = `${process.platform}-${process.arch}`): string {
  return path.join(ROOT, 'out', 'cli', target, 'ca');
}
// Builds one executable, for `target` or with no target for this machine (its own Bun runtime, no download), and
// returns its path. `entry` is for tests, which build other programs the way ca is built.
export function buildCli({ target, outfile = cliPath(target), quiet = false, entry = 'cli/ca.ts' }: { target?: Target; outfile?: string; quiet?: boolean; entry?: string } = {}): string {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  execFileSync(BUN, [
    'build', entry, '--compile', `--outfile=${outfile}`, ...(target ? [`--target=${TARGETS[target]}`] : []),
    // A compiled program reads .env and bunfig.toml from the folder it runs in, unless told not to. ca runs in every
    // repository you open, and one could carry a bunfig.toml that preloads its own code, or a .env that sets
    // CA_CONFIG. test/cli.test.ts checks that neither does anything.
    '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json',
    '--define', 'CA_COMPILED=true', '--define', `CA_VERSION=${JSON.stringify(version)}`,
  ], { cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit' });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2);
  for (const t of targets) if (!Object.hasOwn(TARGETS, t)) throw new Error(`unknown target ${t}; use one of ${Object.keys(TARGETS).join(', ')}`);
  if (targets.length) for (const t of targets as Target[]) buildCli({ target: t });
  else buildCli();
}
