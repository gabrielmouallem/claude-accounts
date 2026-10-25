---
paths:
  - "test/**"
  - "cli/test_*.py"
---

# Tests

- **Throwaway config:** set `CA_CONFIG` to a temp folder before requiring `src/core.js` or loading `cli/ca`. Never
  touch `~/.config/claude-accounts`, `~/.claude` or the app's user data. Each test file runs in its own process.
- **No real sign-ins and no network.** Tests that need `claude` only run `--version` and `auth status` against empty
  folders, and skip when `claude` is missing.
- **Credential checks** use dummy files made unreadable (`chmod 0`), which proves the code only checks that they exist.
- **Platform cases** skip with a reason: `{ skip: WIN && 'POSIX file modes' }` or `@unittest.skipIf(WIN, "…")`.
  Windows launch behavior goes in `test/windows.test.js`, which runs the real cmd.exe in CI.
- **Shared behavior** gets one parity test. Use `py()` in `test/core.test.js` to run the CLI's functions on the same
  input, and keep shared cases in `test/fixtures/` (both suites read `account-names.json`).
- **UI checks** run the app through `scripts/sandbox.js` (see `/run-app`), never against your real config.
