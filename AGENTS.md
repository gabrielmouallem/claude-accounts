# AGENTS.md

Claude Accounts opens each repository with the right Claude account. It is an Electron app plus a CLI (`ca`) that
the app bundles. Both read and write one config, `~/.config/claude-accounts/config.json`. Each account gets its own
folders: a `CLAUDE_CONFIG_DIR` for Claude Code, a `--user-data-dir` for Claude Desktop, and a login folder for
containers. Sessions run on the account's subscription, never on an API key.

## Map

| Path | What it is |
| --- | --- |
| `src/main.ts` | Electron main process: IPC handlers, launching (terminal, Docker, Desktop), tray, menus, config watcher |
| `src/core.ts` | Config handling and command building. Mirrors `cli/ca` function for function |
| `src/validate.ts` | A zod schema for every IPC payload, and the lookups that check a payload against the config |
| `src/types.ts` | Types shared by the main process, the preload and the UI: the config, the state, each IPC channel's result |
| `src/preload.ts` | The only API the renderer gets (`window.ca`) |
| `src/renderer/` | The UI: TypeScript with a small `h()` DOM helper, `styles.css`, `icons.ts`. `mark.svg` is generated |
| `cli/ca.ts` | The CLI the app bundles and installs: TypeScript on `src/core.ts`, compiled with Bun by `scripts/build-cli.ts` |
| `cli/ca` | The older CLI as one Python file, stdlib only, for use without the app. `cli/ca.ts` replaces it |
| `src/launchers.ts` | Dock launchers (macOS): one small app per account in `~/Applications/Claude Accounts`, built, renamed and removed with the account |
| `launcher/launcher.swift` | The program inside every launcher. It also draws their icons and edits the Dock (`--render-icon`, `--dock-*`) |
| `test/` | `node:test` suite. `core.test.ts` also checks parity with the Python CLI; `cli.test.ts` runs the compiled one; `windows.test.ts` runs only on Windows |
| `cli/test_ca.py` | `unittest` suite for the Python CLI |
| `scripts/` | `build.ts` (esbuild), `build-cli.ts` (the bundled `ca`), `build-launcher.ts` (the launchers' program, needs Xcode's tools), `icon-art.ts` (the icon's source), `make-icons.ts`, `sandbox.ts`, `screenshots.ts`, `demo-config.sh` |
| `build/` | Generated icons (`npm run icons`). Don't edit by hand |
| `out/` | The build Electron runs and packages (`npm run build`). Git ignores it |

## Commands

```sh
npm ci                                                 # install
npm run typecheck                                      # tsc, for the app, the renderer, the tests and the scripts
npm test                                               # node:test suite
python3 -m unittest discover -s cli -p 'test_*.py'     # CLI suite
npm run build                                          # src/ into out/ (start, sandbox, shots and dist run it)
node scripts/build-cli.ts darwin-arm64                 # the bundled ca, in out/cli/<platform>-<arch> (dist runs it)
node scripts/build-launcher.ts                         # the Dock launchers' program, in out/launcher (build runs it)
npm run sandbox                                        # the app on fake demo data, launching disabled
npm run icons                                          # redraw every icon from scripts/icon-art.ts
npm run shots                                          # regenerate docs/screenshots (macOS, or Linux + Xvfb)
```

Run the app through `scripts/sandbox.ts` (`npm run sandbox`, or its `launch()` under Playwright). It uses a throwaway
config and user-data folder, so it never touches the real ones. `npm start` uses your real config.

## Rules that never bend

1. **Never read credentials.** Don't open, print, log, copy or send the contents of `.credentials.json`,
   `.claude.json`, Keychain items or tokens. Sign-in state comes from existence checks (`stat`) or from
   `claude auth status`, of which only `loggedIn`, `email`, `subscriptionType` and `orgName` are kept
   (`parseAuthStatus`). The tests make those files unreadable to prove it; keep those tests.
2. **No network.** The app loads only its own files (CSP plus the `webRequest` filter in `main.ts`). It makes no
   requests and has no telemetry, update checks, CDNs or remote fonts. The CLI opens no ports. A new dependency must
   not phone home.
   - A `claude` the app runs on its own (`claude auth status`) gets `QUIET` (`core.ts`), and runs only at start-up,
     when an account's folder first gets files, on Refresh and while a sign-in it opened is pending. So does
     `claude auth logout` (`signOut`), which runs only when you remove an account and its folders.
   - The installed `ca` is the `cliWrapper` script, which starts the Bun executable with `DO_NOT_TRACK=1`; without
     it, Bun uploads a report when it crashes. `selfCommand()` prints the script, so the shell hook uses it too.
3. **Subscription first.** Every launch drops `ANTHROPIC_API_KEY` in any letter case, since Windows ignores case in
   names (`claudeEnv` / `claude_env`). No new launch path may pass it through.
4. **No shell strings built from data.** Spawn with argv (`execFile` / `spawn`, never `shell: true` or
   `shell=True`). Paths and names go in argv, the working directory or the environment. Shell lines exist to be
   shown and copied, quoted with `shQuote` / `winQuote`. When a terminal must run one, it is passed as an argument
   (AppleScript `argv`, `bash -lc`), and a line with a control character is never typed or copied
   (`V.typeable`). On Windows, cmd only ever sees fixed text (`cmdSafe`); paths reach it in environment variables
   that a launcher (`open.cmd`, `run.cmd`) expands inside quotes.
   - **Programs come from PATH, never from the repository.** Windows looks in the current folder first, and npm's
     `claude.cmd` runs `node` by name, so a repository could plant `cmd.exe`, `claude.cmd` or `node.cmd`. Start cmd
     by its full path (`cmdExe`) in a folder of ours (`launchDir`), set `NoDefaultCurrentDirectoryInExePath` before
     entering the repository, and keep only absolute PATH entries (`absoluteDirs`). The CLI finds programs with
     `program()`, never `shutil.which()`, and runs them with `child_env()`.
5. **Validate every IPC payload.** `handle()` in `main.ts` checks the sender, then parses the payload with its
   channel's schema in `validate.ts`, which refuses unknown fields. The renderer never gets Node, `fs` or
   `child_process`: keep `contextIsolation`, `sandbox` and no `nodeIntegration`.
6. **Build the DOM with `h()` and text nodes.** Never use `innerHTML` with data. Keep the CSP: no inline scripts or
   styles, nothing remote.
7. **Private files.** Account folders are `0700`. `config.json` is `0600`, written atomically (temp file plus rename).
   The app takes an account's folders away only when you remove it with **Sign out and move its folders to the Trash**
   on (the default). It signs the account out first (`signOut`; on Windows the sign-in is a file in the folder),
   since the Keychain files the sign-in under the folder's path, and stops if that fails. Demo mode refuses. Then it moves to the Trash only folders inside `accounts/` that no other
   account uses (`ownFolders`, `trashList`), never deleting them outright.
8. **One config, two writers.** The app and the CLI share `config.json`: sorted keys, 2-space indent, UTF-8. A change to
   `src/core.ts` usually needs the same change in `cli/ca`. The parity tests in `test/core.test.ts` catch drift.
9. **The account follows the repository**, never the usage left on a plan. Don't build anything that switches
   accounts to get around usage limits.

## Conventions

- Match the code around you: TypeScript, ES modules, `node:` imports, small functions, and comments that say why.
  - Node runs the tests and scripts as they are, stripping the types. So use only syntax it can erase (no `enum`,
    `namespace` or parameter properties), and import a `.ts` file by its full name.
  - esbuild only strips types too. `npm run typecheck` is what checks them, with `strict` and
    `noUncheckedIndexedAccess`.
- Python: stdlib only, runs on 3.8+. Report a user error with `raise SystemExit("…")`, never a traceback.
- Copy: English, sentence case, second person. No em dashes and no exclamation marks; buttons are verbs.
  - Use these words: account, rule, repository, *opens with* (Claude Desktop, Terminal, Docker), *sign in* (verb) and
    *sign-in* (noun), plan, settings.
  - Errors say what went wrong, then how to fix it.
- Tests:
  - Use a throwaway `CA_CONFIG` in a temp folder, and never sign in for real.
  - Skip platform-specific cases with a reason.
  - Behavior shared by the app and the CLI gets a parity test, not two copies.

## Before you finish

- Run `npm run typecheck` and both test suites.
- For a UI change, run the app in the sandbox and look at it in both themes.
- Check a change to launching, IPC, the renderer or the CLI against the rules above.

Area rules live in `.claude/rules/`: `main-process.md`, `renderer.md`, `cli.md` and `tests.md`. Read the one for the
area you change.
