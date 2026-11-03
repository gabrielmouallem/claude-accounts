---
paths:
  - "cli/**"
---

# The `ca` CLI

- **Two versions.** `cli/ca.ts` is the one the app bundles: TypeScript on `src/core.ts`, compiled with Bun by
  `scripts/build-cli.ts`, which turns off loading `.env`, `bunfig.toml`, `package.json` and `tsconfig.json` from the
  folder it runs in. Settings installs it in `~/.local/lib/claude-accounts` behind the `cliWrapper` script in
  `~/.local/bin/ca`. `cli/ca` is the older Python version, one stdlib-only Python 3.8+ file, which `cli/ca.ts`
  replaces. The rest of this file is about `cli/ca`.
- In `cli/ca.ts`, find programs with `ca.program()` and run them with `ENV`, which keeps only absolute PATH entries
  and gives back the caller's own `DO_NOT_TRACK`.
- **The Python `cli/ca` mirrors `src/core.ts`** with the same functions in snake_case and identical output.
  `test/core.test.ts` loads it as a module and compares the commands, the account-name rule and the shell-hook text
  with the app's. Change both sides together.
- **Errors:** a user error is `raise SystemExit("what went wrong; how to fix it")`, never a traceback. A binding whose
  account is gone goes through `account_of()`.
- **Processes:**
  - Always argv lists, never `shell=True`.
  - Find programs with `program()`, never `shutil.which()`. Windows looks in the current folder first, and a
    repository could hold its own `claude.cmd`; `program()` reads only absolute PATH entries.
  - npm installs `claude` as a `.cmd` shim on Windows, and cmd reads `& | < > ^ % ! ( ) "` in a shim's arguments
    even inside quotes. Pass the arguments of anything `program()` found through `check_cmd_args()` first.
  - Run every program with `env=child_env(...)`. On Windows the shim runs `node` by name, and `child_env` keeps cmd
    from finding it in the current folder.
  - Docker runs from `docker_argv()`, not from splitting a printed line.
- **Printed commands** use `q(s, system)`: `shlex.quote`, or `win_quote` for cmd. Hook output (`env --shell`,
  `shell-hook`) is always for a POSIX shell, so it uses `shlex.quote`.
- **`ca env --shell`** runs on every bash prompt. Keep it fast, and make it print the "unbound" text rather than fail.
- **Config:** use only `load()` and `save()`. `save()` writes atomically, `0600`, UTF-8, with `ensure_ascii=False` so
  the app and the CLI write the same bytes.
