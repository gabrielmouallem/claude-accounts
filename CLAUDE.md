@AGENTS.md

## Claude Code

- `/run-app` launches the app in a sandbox and drives it with Playwright, to see a change working in both themes.
- `/release` cuts a release. Run it only when asked.
- Before committing a change to launching, IPC, the renderer or `cli/ca`, have the `security-reviewer` agent check the
  diff.
- The rules in `.claude/rules/` load with the files they cover.
