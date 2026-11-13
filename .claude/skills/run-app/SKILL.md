---
name: run-app
description: Launch Claude Accounts in a sandbox (throwaway config and user data, fake demo accounts, launching disabled) and drive it with Playwright to see a change working in dark and light. Use after changing src/renderer, src/main.ts or src/preload.ts, or when asked to run, try or screenshot the app.
---

# Run the app in a sandbox

`scripts/sandbox.ts` builds the app, then starts it against a throwaway home: its own `config.json`, its own user
data, fake accounts and repositories, and launching disabled. Never check a change with `npm start`, which reads the
real config.

## For a person

```sh
npm run sandbox                  # demo data, follows the system theme
npm run sandbox -- --empty       # first run: the onboarding
npm run sandbox -- --light       # or --dark
```

## For you, with Playwright

Write the script in your scratchpad as an `.mts` file, not in the repo. Import the sandbox by absolute path, run it
with `node`, then read the screenshots.

```ts
import { launch } from '/abs/path/to/repo/scripts/sandbox.ts';

const { app, page } = await launch({ theme: 'dark' });     // { demo: false } for the onboarding
try {
  await page.keyboard.press('Meta+2');                       // Accounts; Control+2 on Windows and Linux
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/abs/path/to/scratchpad/accounts-dark.png' });
} finally { await app.close(); }
```

- Check both themes: `theme: 'light'` and `'dark'`.
- `preview: true` draws macOS window chrome into the page, because screenshots leave out the real traffic lights. On
  Linux it also renders the macOS layout; run under Xvfb (`xvfb-run node script.js`).
- `launch()` prints page errors as `[pageerror]`. `window.ca` is there for `page.evaluate()`, to call IPC directly. Add `page.on('console', …)` when you need more.
- A window opens on screen while the script runs. That's expected.

## What the demo holds

- **Accounts:** work, personal, client-x. The work CLI login and the personal container login show as signed in,
  using dummy files.
- **Repositories** under `~/code`:
  - acme-api: work, Terminal
  - acme-web: work, Docker
  - design-system: client-x, Desktop
  - side-project: personal, Terminal
  - weekend-ml: personal, Docker

## Good to know

- Launching is disabled. Open, Sign in and Desktop show a toast and **copy the command to the real system clipboard**.
- Keys: ⌘1, ⌘2 and ⌘3 switch views, ⌘K opens the palette, ⌘N binds a repository, and Escape closes overlays.
- Selectors (`#repo-list .row`, `.toast`, `.scrim`, `.onb`) change with the redesign. Check the current
  `src/renderer/app.ts` before you rely on one.
