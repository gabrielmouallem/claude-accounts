// Drives the real app in a sandbox (scripts/sandbox.ts: demo data, launching disabled) and saves docs/screenshots.
// Runs on macOS, or on Linux under Xvfb.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import * as sandbox from './sandbox.ts';

const ROOT = path.join(import.meta.dirname, '..'), OUT = path.join(ROOT, 'docs', 'screenshots');
const only = process.argv[2];
async function launch({ demo = true, theme = 'dark' }: { demo?: boolean; theme?: 'dark' | 'light' } = {}) {
  const r = await sandbox.launch({ demo, theme, preview: true, args: ['--force-device-scale-factor=2'] });
  r.page.on('console', m => console.log('[console]', m.type(), m.text()));
  await r.page.waitForTimeout(500);
  return r;
}
const shot = async (page: Page, name: string) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('saved', name); };

fs.mkdirSync(OUT, { recursive: true });
if (!only || only === 'main') {
  const { app, page } = await launch();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await shot(page, '1-repositories-dark');
  await page.click('.row[data-i="1"] .row-actions .btn.ghost'); await shot(page, '5-row-menu-dark'); await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+2'); await page.waitForSelector('.card'); await page.waitForTimeout(1200);
  await shot(page, '2-accounts-dark');
  await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+k'); await page.waitForSelector('.pal-input input'); await page.waitForTimeout(250); await page.keyboard.type('acme');
  await shot(page, '3-command-palette-dark');
  await page.keyboard.press('Escape'); await page.keyboard.press('Meta+k');
  await shot(page, '3b-command-palette-all-dark');
  await page.keyboard.press('Escape'); await page.keyboard.press('Meta+n'); await shot(page, '6-bind-modal-dark'); await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+3'); await shot(page, '7-settings-dark');
  await app.close();
}
if (!only || only === 'light') {
  // Forced light color scheme (CA_THEME=light -> nativeTheme 'light', no --force-dark-mode).
  { const { app, page } = await launch({ theme: 'light' });
    if (!(await page.locator('html.light').count())) throw new Error('light theme not applied');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await shot(page, '8-repositories-light');
    await page.keyboard.press('Meta+2'); await page.waitForSelector('.card'); await page.waitForTimeout(1200);
    await shot(page, '9-accounts-light');
    await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+k'); await page.waitForSelector('.pal-input input'); await page.waitForTimeout(250); await page.fill('.pal-input input', 'acme');
    await shot(page, '10-palette-light'); await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+3'); await page.waitForTimeout(600); await page.focus('.seg button:nth-child(2)'); await page.keyboard.press('Tab'); await shot(page, '11-settings-light');
    await app.close(); }
  { const { app, page } = await launch({ demo: false, theme: 'light' });
    await shot(page, '12-onboarding-light');
    await page.fill('.onb input', 'work'); await page.click('.onb .btn.primary'); await page.waitForTimeout(400);
    await shot(page, '12b-onboarding-signin-light');
    await app.close(); }
}
if (!only || only === 'onb') {
  const { app, page } = await launch({ demo: false });
  await shot(page, '4-onboarding-dark');
  await page.fill('.onb input', 'work'); await page.click('.onb .btn.primary'); await page.waitForTimeout(400);
  await shot(page, '4b-onboarding-signin-dark');
  await page.click('.onb .btn.primary'); await shot(page, '4c-onboarding-bind-dark');
  await page.click('.onb .btn.ghost'); await shot(page, '4d-empty-repos-dark');
  await app.close();
}
