---
paths:
  - "src/main.ts"
  - "src/preload.ts"
  - "src/validate.ts"
  - "src/core.ts"
  - "src/types.ts"
---

# Main process, IPC and launching

- **A new IPC call** needs four things, and `tsc` fails until they agree:
  - its result in `Results` and its method in `Api` (`types.ts`);
  - its payload schema in `PAYLOADS` (`validate.ts`): a `z.strictObject` built from the field helpers there, whose
    messages say what is wrong ("invalid repo");
  - `handle('area:verb', p => …)` in `registerIpc()`, where `p` is the parsed payload;
  - one method in `preload.ts`.

  `handle()` checks the sender and shows the message of a `CaError` or `ValidationError` as it is. Anything else
  shows as "Unexpected error: …", so throw one of those two for a failure you expect.
- **Build:** Electron runs `out/main.cjs` and `out/preload.cjs`, which `scripts/build.ts` bundles. `__dirname` is
  `out/`, so `build/` and `cli/` are one level up. The preload may import only types, since the sandbox gives it
  nothing but `electron`.
- **Config changes** go through `mutate(cfg => …)`: it loads, applies, saves and refreshes the tray. Prefs (theme,
  terminal, tray, onboarded) live in `prefs.json` in the app's user data. They are app-only and never go in
  `config.json`.
- **Accounts:** look up a binding's account with `ca.accountOf()`, which reports a removed account clearly, and a
  name or repository from a payload with `V.knownAccount()` / `V.boundRepo()`. Never use `cfg.accounts[name]` on a
  name from config, since `__proto__` and `constructor` exist on every object.
- **Launching** returns `{ ok, message, command }` through `withCopy()`, which copies the command when a launch fails.
  - `openTerminal(command, windows)`: `command` is the POSIX line for macOS and Linux (and what gets copied). Terminal
    and iTerm type it, so it and every copied command go through `V.typeable()`, which refuses control characters.
  - `windows()` builds the `ca.windows*` spec. On Windows, paths reach cmd only in environment variables that a launcher
    batch file expands inside quotes; the line itself passes `cmdSafe()`. Every cmd starts by its full path in
    `launchDir()` with PATH cut to absolute entries (`windowsEnv()`), and `open.cmd` sets
    `NoDefaultCurrentDirectoryInExePath` before it enters the repository. So a `cmd.exe`, `claude.cmd` or `node.cmd`
    checked into a repository can't run. Build a new Windows launch like `windowsTerminal()`.
  - Claude Desktop starts from `desktopLaunch()` argv, never a shell string.
  - Respect `LAUNCH_DISABLED` (`CA_NO_LAUNCH=1`) before spawning anything.
  - Spawn with `baseEnv()`: apps started from Finder get a minimal `PATH`, and this one comes from the login shell.
- **Window hardening stays:**
  - `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webviewTag`;
  - navigation, new windows and permission requests are denied;
  - the `webRequest` filter cancels anything that isn't `file:` or `devtools:`.
- **`core.ts` mirrors `cli/ca`** with the same functions in snake_case. Change a command builder in one, and change
  the other, then run the parity tests.
