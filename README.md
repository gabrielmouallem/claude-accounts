# Claude Accounts

**Bind each git repository to its own Claude Code account.**

Claude Accounts is a small desktop app (macOS / Windows, built with Electron) plus a
dependency-free Python CLI, `ca`. You bind a folder to an account once. After that, every session
you start there uses that account's own login, settings and history. Each account is isolated by:

- **Terminal**: the official `claude` CLI with its own `CLAUDE_CONFIG_DIR`
- **Claude Desktop**: a separate instance with its own `--user-data-dir` (plus `CLAUDE_CONFIG_DIR`)
- **Docker / Apple `container`**: a container with the account's config dir mounted

<p align="center">
  <img src="docs/screenshots/1-repositories-dark.png" width="49%" alt="Repositories view (dark)">
  <img src="docs/screenshots/2-accounts-dark.png" width="49%" alt="Accounts view (dark)">
  <img src="docs/screenshots/3-command-palette-dark.png" width="49%" alt="Command palette">
  <img src="docs/screenshots/4-onboarding-dark.png" width="49%" alt="Onboarding">
  <img src="docs/screenshots/8-repositories-light.png" width="49%" alt="Repositories view (light)">
  <img src="docs/screenshots/9-accounts-light.png" width="49%" alt="Accounts view (light)">
</p>

## Why

Claude Code and Claude Desktop keep one login per user profile. There's no built-in way to say
"this repo uses my work account, that one uses my personal account"
([anthropics/claude-code#18435](https://github.com/anthropics/claude-code/issues/18435)).
Logging out and back in whenever you switch projects is tedious and easy to get wrong.
Claude Accounts gives each account its own isolated config directory and launches sessions with
the right one for the repository you're in.

## Install (macOS)

1. Download `ClaudeAccounts-<version>-mac-arm64` (Apple Silicon) or `-mac-x64` (Intel), as `.dmg`
   or `.zip`, from [Releases](https://github.com/gabrielmouallem/claude-accounts/releases), and
   drag **Claude Accounts.app** to `/Applications`.
2. The app is **not signed or notarized**, so macOS blocks the first launch. Either right-click the
   app, choose **Open**, then **Open** again, or run:
   ```sh
   xattr -dr com.apple.quarantine "/Applications/Claude Accounts.app"
   ```
3. The first time you open a session, macOS asks permission for the app to control Terminal/iTerm.

**Windows:** use `ClaudeAccounts-<version>-win-x64-portable.exe` or the `.zip` (also unsigned, so
SmartScreen may warn you).

**Requirements:** the `claude` CLI on your login-shell `PATH`. Docker or Apple `container` is needed
only for container mode, and Claude Desktop only for desktop mode. Settings → *Install `ca`* copies
the bundled CLI (requires `python3`) to `~/.local/bin`.

## Using the app

- **Onboarding**: add an account → sign in (`claude auth login` with that account's config dir) → bind a repo.
- **Repositories**: change an account or mode inline, then press **Open** (↵). The row menu has worktree, copy command, reveal and unbind.
- **Accounts**: login badges per account (CLI / container). **Check status** runs `claude auth status` for a deep check.
- **Shortcuts**: ⌘K palette, ⌘N bind repo, ⇧⌘N add account, ⌘1–3 switch views, ↑↓/↵ in lists.
- A menu-bar item for quick launch (toggle it in Settings).

The app and the CLI share one config file (`~/.config/claude-accounts/config.json`, or `$CA_CONFIG`),
so you can use them interchangeably.

## Build from source

Requires Node.js 22+ (and `python3` for the CLI tests).

```sh
git clone https://github.com/gabrielmouallem/claude-accounts.git
cd claude-accounts
npm install
npm start            # run the app
npm test             # node:test suite (core logic + CLI config compatibility)
npm run dist:mac     # electron-builder --mac --arm64 --x64 → dist/ (dmg needs macOS; zip works anywhere)
npm run dist:win     # electron-builder --win --x64 → portable .exe + .zip
npm run dist         # electron-builder --mac --win
npm run icons        # regenerate build/icon.{png,icns,ico} from build/icon.svg
npm run shots        # regenerate docs/screenshots with fake demo data (needs a display, e.g. Xvfb)
```

The app bundles a copy of the CLI at `resources/ca`. `cli/ca` is the source of truth; after editing
it, run `npm run sync-ca`. CI checks that the two files match.

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs the tests and builds unsigned
macOS (arm64 + x64, dmg + zip) and Windows (portable + zip) artifacts. When you push a `v*` tag,
it attaches them to a GitHub Release using only the built-in `GITHUB_TOKEN`.

**Signing & notarization (optional):** remove `"identity": null` from `build.mac`, add
`"hardenedRuntime": true` and `"notarize": true`, and provide `CSC_LINK` / `CSC_KEY_PASSWORD`
(Developer ID certificate) and `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.

## CLI (`cli/ca`)

`ca` is a single stdlib-only Python 3 script. It has a CLI and a small local web UI.

```sh
mkdir -p ~/.local/bin && cp cli/ca ~/.local/bin/ca && chmod +x ~/.local/bin/ca   # needs python3 + claude on PATH
```

```sh
ca add-account work            # creates ~/.config/claude-accounts/accounts/work/{claude,desktop,docker-claude}
ca add-account personal
ca login work                  # CLAUDE_CONFIG_DIR=<work dir> claude auth login (browser sign-in)
ca bind ~/code/acme work
ca bind ~/code/side personal --mode docker
ca list; ca status [--deep]    # --deep asks `claude auth status` (prints status only, no secrets)
ca run [repo] [-w name] [-- extra claude args]   # works from any subdir; -w = --worktree passthrough
ca run --print                 # show the command instead of running it
ca desktop work [--launch] [--os Darwin|Windows|Linux]
ca docker-run [repo] [--engine docker|container] [--build] [--print]
ca ui                          # http://127.0.0.1:<port>/?token=<random>
```

Config format (`~/.config/claude-accounts/config.json`, override with `CA_CONFIG=...`):

```json
{"accounts": {"work": {"config_dir": "...", "desktop_user_data_dir": "...", "docker_config_dir": "..."}},
 "repos": {"/abs/path/repo": {"account": "work", "mode": "terminal|docker|desktop"}}}
```

**To make plain `claude` pick the right account automatically:**

- zsh: add `eval "$(ca shell-hook zsh)"` to `~/.zshrc` (chpwd hook)
- bash: add `eval "$(ca shell-hook bash)"` to `~/.bashrc` (PROMPT_COMMAND)
- direnv: `ca shell-hook direnv ~/code/acme --write && direnv allow ~/code/acme`

**Modes**

- `terminal`: the native CLI with `CLAUDE_CONFIG_DIR`. `ANTHROPIC_API_KEY` is removed so the subscription login is used.
- `docker`: `node:20-slim` + `npm i -g @anthropic-ai/claude-code`. The repo is mounted at `/workspace` and the account's `docker_config_dir` at `/home/node/.claude`. Run `/login` once inside the container. The container has its own login because on macOS the host token lives in the Keychain, which containers can't access. The Apple `container` equivalent is supported too.
- `desktop`: on macOS, `open -n -a "Claude" --env CLAUDE_CONFIG_DIR=... --args --user-data-dir=...`. On Windows it prints a `claude.exe --user-data-dir=` command. There's no official Linux Desktop build.

CLI tests: `python3 -m unittest discover -s cli -p 'test_*.py' -v`. They use a throwaway config, with no network and no login.

## What's verified and what isn't

Everything was developed and tested on **Linux**:

- **Verified:** the app's 13 `node:test` tests and the CLI's 12 `unittest` tests pass. They cover config handling and validation, subdirectory lookup, env construction, a real `claude --version` running under a per-account `CLAUDE_CONFIG_DIR`, `claude auth status` isolation, the existence-only credential check, docker/container/desktop command generation, the bash hook, the web UI token and Host checks, and IPC input validation. The UI was exercised and screenshotted under Xvfb in a macOS preview mode. The macOS bundle structure was inspected (Info.plist, icon, arm64/x64 Mach-O).
- **Not tested:** real macOS or Windows. That leaves the Keychain badge, vibrancy, tray, AppleScript terminal launch, Claude Desktop multi-instance (`--user-data-dir`, `open --env`) and Windows launching untested. Real sign-ins weren't tested either. **Docker and Apple `container` modes are also untested:** the commands are generated and unit-tested, but no image was built or run.

Bug reports from real macOS/Windows setups are very welcome.

## Security

- **Credential contents are never read.** Login state comes from checking whether
  `<config_dir>/.credentials.json` exists, or from the official `claude auth status`. On macOS, CLI
  logins live in the Keychain, so the badge shows `keychain?` until you run *Check status*.
- **No network, no telemetry.** The app makes no network requests (non-local requests are
  cancelled), loads no remote content, and bundles its fonts and icons. The CLI's optional web UI
  listens on `127.0.0.1` only, requires a random per-run token, checks the `Host` header (against DNS
  rebinding), and doesn't log requests.
- `ANTHROPIC_API_KEY` is stripped from the environment of every session it launches.
- Account dirs are created `0700`. The config is written `0600`, atomically.
- Electron hardening: `contextIsolation`, no `nodeIntegration`, a sandboxed renderer, a minimal preload,
  a strict CSP, and validation of all IPC input. Navigation, new windows and permission requests are denied.

## Terms of use

You are responsible for using this tool in line with Anthropic's terms: use it only with accounts
that are yours, not to share credentials or subscriptions.

## Disclaimer

This is an independent project. It is **not affiliated with, endorsed by, or sponsored by Anthropic**.
"Claude" and "Claude Code" are trademarks of Anthropic, PBC.

## Contributing

Issues and pull requests are welcome. Please open an
[issue](https://github.com/gabrielmouallem/claude-accounts/issues) for bugs (include OS, app/CLI
version and `claude --version`) or to discuss larger changes first. Run `npm test` and the CLI tests
before you submit a PR, and never include real config files, credentials or email addresses in an issue or PR.

## License

[MIT](LICENSE) © 2026 Gabriel Mouallem
