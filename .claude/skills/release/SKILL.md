---
name: release
description: Cut a Claude Accounts release. Bump the version, tag it, let CI build the macOS and Windows artifacts, and check the GitHub release. Only when the user asks for a release.
disable-model-invocation: true
argument-hint: "[patch|minor|major|x.y.z]"
---

# Release

CI (`.github/workflows/build.yml`) does the building. A `v*` tag runs the tests on Linux, macOS and Windows, then
builds the unsigned artifacts: macOS arm64 and x64 as dmg and zip, Windows as a portable exe and a zip. It then creates
the GitHub release with generated notes.

1. **Check the ground.**
   - You're on `main`, the tree is clean, and you're in sync with `origin/main` (`git fetch && git status -sb`).
   - Run `npm test` and `python3 -m unittest discover -s cli -p 'test_*.py'`. Stop on any failure.
2. **Pick the version** from `$ARGUMENTS`: patch, minor, major or an exact x.y.z. If it's empty, ask. Apply it with
   `npm version <it> --no-git-tag-version`, which updates `package.json` and `package-lock.json`.
3. **Update the README** where it names the version (Project status) and wherever this release changes what it says.
   Commit as `Release vX.Y.Z`.
4. **Ask before pushing.** Show the commit and the version. Pushing the tag publishes a release.
5. **Push:** `git push origin main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. **Watch CI:** `gh run list --workflow build.yml --limit 3`, then `gh run watch <id> --exit-status`.
   - On failure, read `gh run view <id> --log-failed` and fix it on `main`.
   - Move the tag only with the user's OK, since deleting a pushed tag is visible to everyone.
7. **Check the release.** `gh release view vX.Y.Z --json assets --jq '.assets[].name'` should list six files: dmg and
   zip for each macOS arch, and the Windows portable exe and zip.
8. **Report** the release URL and what's in it.
