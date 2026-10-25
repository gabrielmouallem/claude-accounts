# AGENTS.md

Claude Accounts opens each repository with the right Claude account. It is an Electron app plus a Python CLI (`ca`).
Both read and write one config, `~/.config/claude-accounts/config.json`. Each account gets its own folders: a
`CLAUDE_CONFIG_DIR` for Claude Code, a `--user-data-dir` for Claude Desktop, and a login folder for containers.
Sessions run on the account's subscription, never on an API key.

## Map

| Path | What it is |
| --- | --- |
| `src/main.js` | Electron main process: IPC handlers, launching (terminal, Docker, Desktop), tray, menus, config watcher |
| `src/core.js` | Config handling and command building. Mirrors `cli/ca` function for function |
| `src/validate.js` | Validation for every IPC payload |
| `src/preload.js` | The only API the renderer gets (`window.ca`) |
| `src/renderer/` | The UI: vanilla JS with a small `h()` DOM helper, `styles.css`, `icons.js`. `mark.svg` is generated |
| `cli/ca` | The CLI: one Python file, stdlib only, bundled with the app as is |
| `test/` | `node:test` suite. `core.test.js` also checks parity with the CLI; `windows.test.js` runs only on Windows |
| `cli/test_ca.py` | `unittest` suite for the CLI |
| `scripts/` | `icon-art.js` (the icon's source), `make-icons.js`, `sandbox.js`, `screenshots.js`, `demo-config.sh` |
| `build/` | Generated icons (`npm run icons`). Don't edit by hand |

## Commands

```sh
npm ci                                                 # install
npm test                                               # node:test suite
python3 -m unittest discover -s cli -p 'test_*.py'     # CLI suite
npm run sandbox                                        # the app on fake demo data, launching disabled
npm run icons                                          # redraw every icon from scripts/icon-art.js
npm run shots                                          # regenerate docs/screenshots (macOS, or Linux + Xvfb)
```

Run the app through `scripts/sandbox.js` (`npm run sandbox`, or its `launch()` under Playwright). It uses a throwaway
config and user-data folder, so it never touches the real ones. `npm start` uses your real config.

## Rules that never bend

1. **Never read credentials.** Don't open, print, log, copy or send the contents of `.credentials.json`,
   `.claude.json`, Keychain items or tokens. Sign-in state comes from existence checks (`stat`) or from the first line
   of `claude auth status`. The tests make those files unreadable to prove it; keep those tests.
2. **No network.** The app loads only its own files (CSP plus the `webRequest` filter in `main.js`). It makes no
   requests and has no telemetry, update checks, CDNs or remote fonts. The CLI opens no ports. A new dependency must
   not phone home.
3. **Subscription first.** Every launch drops `ANTHROPIC_API_KEY` (`claudeEnv` / `claude_env`). No new launch path may
   pass it through.
4. **No shell strings built from data.** Spawn with argv (`execFile` / `spawn`, never `shell: true` or
   `shell=True`). Paths and names go in argv, the working directory or the environment. Shell lines exist to be
   shown and copied, quoted with `shQuote` / `winQuote`. When a terminal must run one, it is passed as an argument
   (AppleScript `argv`, `bash -lc`). On Windows, cmd only ever sees fixed text (`cmdSafe`).
5. **Validate every IPC payload** in `main.js` with `validate.js`. `handle()` checks the sender. The renderer never
   gets Node, `fs` or `child_process`: keep `contextIsolation`, `sandbox` and no `nodeIntegration`.
6. **Build the DOM with `h()` and text nodes.** Never use `innerHTML` with data. Keep the CSP: no inline scripts or
   styles, nothing remote.
7. **Private files.** Account folders are `0700`. `config.json` is `0600`, written atomically (temp file plus rename).
   The app never deletes an account's folders.
8. **One config, two writers.** The app and the CLI share `config.json`: sorted keys, 2-space indent, UTF-8. A change to
   `src/core.js` usually needs the same change in `cli/ca`. The parity tests in `test/core.test.js` catch drift.
9. **The account follows the repository**, never the usage left on a plan. Don't build anything that switches
   accounts to get around usage limits.

## Conventions

- Match the code around you: CommonJS, `'use strict'`, `node:` imports, small functions, and comments that say why.
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

- Run both test suites.
- For a UI change, run the app in the sandbox and look at it in both themes.
- Check a change to launching, IPC, the renderer or the CLI against the rules above.

Area rules live in `.claude/rules/`: `main-process.md`, `renderer.md`, `cli.md` and `tests.md`. Read the one for the
area you change.
