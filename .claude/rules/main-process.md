---
paths:
  - "src/main.js"
  - "src/preload.js"
  - "src/validate.js"
  - "src/core.js"
---

# Main process, IPC and launching

- **A new IPC call** needs three things:
  - `handle('area:verb', p => …)` in `registerIpc()`;
  - each payload field checked with `validate.js` (add a validator there rather than checking inline);
  - one function in `preload.js`.

  `handle()` checks the sender and shows the message of a `CaError` or `ValidationError` as it is. Anything else
  shows as "Unexpected error: …", so throw one of those two for a failure you expect.
- **Config changes** go through `mutate(cfg => …)`: it loads, applies, saves and refreshes the tray. Prefs (theme,
  terminal, tray, onboarded) live in `prefs.json` in the app's user data. They are app-only and never go in
  `config.json`.
- **Accounts:** look up a binding's account with `ca.accountOf()`, which reports a removed account clearly. Never use
  `cfg.accounts[name]` on a name from config, since `__proto__` and `constructor` exist on every object.
- **Launching** returns `{ ok, message, command }` through `withCopy()`, which copies the command when a launch fails.
  - `openTerminal(command, win)`: `command` is the POSIX line for macOS and Linux (and what gets copied). `win()`
    builds the `ca.windows*` spec. On Windows, paths reach cmd only through cwd and env; the line itself passes
    `cmdSafe()`.
  - Claude Desktop starts from `desktopLaunch()` argv, never a shell string.
  - Respect `LAUNCH_DISABLED` (`CA_NO_LAUNCH=1`) before spawning anything.
  - Spawn with `baseEnv()`: apps started from Finder get a minimal `PATH`, and this one comes from the login shell.
- **Window hardening stays:**
  - `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webviewTag`;
  - navigation, new windows and permission requests are denied;
  - the `webRequest` filter cancels anything that isn't `file:` or `devtools:`.
- **`core.js` mirrors `cli/ca`** with the same functions in snake_case. Change a command builder in one, and change
  the other, then run the parity tests.
