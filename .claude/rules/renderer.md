---
paths:
  - "src/renderer/**"
---

# Renderer

- **DOM:**
  - Build it with `h(tag, attrs, ...kids)`. Data only ever becomes text nodes or attribute values, never markup.
  - `icon(name, size)` in `icons.ts` draws the app's own Lucide-style set. To add an icon, add a static path to `ICONS`;
    `IconName` picks it up.
  - `logoMark()` is an `<img>` of `mark.svg`, which `npm run icons` draws. Don't edit `mark.svg` by hand.
- **CSP:** `style-src 'self'` blocks `style="…"` attributes and `<style>` tags. Style with classes, or with
  `el.style.x = …` (CSSOM), which the CSP allows. Nothing loads from outside the app.
- **Build:** esbuild bundles `app.ts` and what it imports into one `out/renderer/app.js`, and copies the files in
  `STATIC` (`scripts/build.ts`) next to it. The renderer has its own tsconfig, with the DOM and without Node, and shares
  only types with the rest (`../types.ts`).
- **State** lives in `S`. Code that runs once the state has loaded reads it with `data()`. `render()` redraws the main view on window focus and whenever `config.json` changes, so keep
  anything typed in state as it is typed (`oninput`). The onboarding's `o.name` is the example.
- **API calls:** every `window.ca.*` call can reject. Go through `act()` / `launch()`, or catch and `toast('bad', …)`.
- **Platform:**
  - `IS_MAC` comes from `?platform=`. Show keys with `MOD` and `SHIFT`: ⌘ ⇧ on macOS, Ctrl Shift elsewhere.
  - Hide what only works on one platform: Apple container and the Terminal/iTerm choice are macOS only.
- **Keyboard and access:**
  - Every action has a keyboard path. ⌘K opens the palette, and Escape closes menus, dialogs and the palette.
  - Icon-only buttons need a `title` or `aria-label`. A status carries a word, never only a color.
- **Copy** follows AGENTS.md (sentence case, no em dashes, product vocabulary). Fix older strings you touch.
- **Design:** the new design system (tokens, components, voice) replaces `styles.css` in the coming redesign. Until
  then, use the CSS variables in `styles.css`, not raw colors.
