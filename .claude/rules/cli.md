---
paths:
  - "cli/**"
---

# The `ca` CLI

- One file, stdlib only, Python 3.8+, `#!/usr/bin/env python3`. The app bundles it as is and its Install button
  copies it to `~/.local/bin`, so it can't import anything from this repo.
- **It mirrors `src/core.js`** with the same functions in snake_case and identical output. `test/core.test.js` loads it
  as a module and compares the commands, the account-name rule and the shell-hook text with the app's. Change both
  sides together.
- **Errors:** a user error is `raise SystemExit("what went wrong; how to fix it")`, never a traceback. A binding whose
  account is gone goes through `account_of()`.
- **Processes:**
  - Always argv lists, never `shell=True`.
  - Resolve `claude` with `shutil.which()`, because npm installs it as a `.cmd` shim on Windows.
  - Docker runs from `docker_argv()`, not from splitting a printed line.
- **Printed commands** use `q(s, system)`: `shlex.quote`, or `win_quote` for cmd. Hook output (`env --shell`,
  `shell-hook`) is always for a POSIX shell, so it uses `shlex.quote`.
- **`ca env --shell`** runs on every bash prompt. Keep it fast, and make it print the "unbound" text rather than fail.
- **Config:** use only `load()` and `save()`. `save()` writes atomically, `0600`, UTF-8, with `ensure_ascii=False` so
  the app and the CLI write the same bytes.
