// Builds the app into out/: the main process and the preload as CommonJS bundles for Electron, the renderer as one
// script for its page, and the page's static files. esbuild only strips the types; npm run typecheck checks them.
//
//   node scripts/build.ts            or   import { build } from './build.ts'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'out');
const STATIC = ['index.html', 'styles.css', 'mark.svg', 'fonts'];

export async function build(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });
  const common = { absWorkingDir: ROOT, bundle: true, logLevel: 'warning', legalComments: 'none' } as const;
  await Promise.all([
    // Electron 45 runs Node 24 and Chrome 156
    esbuild.build({ ...common, entryPoints: ['src/main.ts', 'src/preload.ts'], outdir: 'out', outExtension: { '.js': '.cjs' },
                    platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] }),
    esbuild.build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'out/renderer/app.js',
                    platform: 'browser', format: 'iife', target: 'chrome156' }),
  ]);
  for (const f of STATIC) fs.cpSync(path.join(ROOT, 'src', 'renderer', f), path.join(OUT, 'renderer', f), { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
