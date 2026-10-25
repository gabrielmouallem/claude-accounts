// Drives the real app (demo HOME, launching disabled) under Xvfb and saves screenshots.
const { _electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), OUT = path.join(ROOT, 'docs', 'screenshots');
const only = process.argv[2];
async function launch(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, CA_CONFIG: path.join(home, '.config/claude-accounts/config.json'), CA_NO_LAUNCH: '1',
    CA_PREVIEW_PLATFORM: 'darwin', CA_THEME: 'dark', DISPLAY: process.env.DISPLAY || ':99', XDG_CONFIG_HOME: path.join(home, '.config'), ...extraEnv };
  delete env.ANTHROPIC_API_KEY;
  const app = await _electron.launch({ executablePath: require('electron'), args: [ROOT, '--no-sandbox', '--force-device-scale-factor=2', ...(extraEnv.LIGHT ? [] : ['--force-dark-mode'])], env });
  const page = await app.firstWindow();
  page.on('console', m => console.log('[console]', m.type(), m.text())); page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.waitForSelector('.sidebar .nav'); await page.waitForTimeout(500);
  return { app, page };
}
const shot = async (page, name) => { await page.waitForTimeout(450); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('saved', name); };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const demo = '/tmp/ca-demo';
  execFileSync(path.join(__dirname, 'demo-config.sh'), [demo]);
  const home = path.join(demo, 'home');
  if (!only || only === 'main') {
    const { app, page } = await launch(home);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await shot(page, '1-repositories-dark');
    await page.click('.row[data-i="1"] .row-actions .btn.ghost'); await shot(page, '5-row-menu-dark'); await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+2'); await page.click('.card .card-foot .btn.ghost'); await page.waitForTimeout(1200);
    await shot(page, '2-accounts-dark');
    await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+k'); await page.keyboard.type('acme');
    await shot(page, '3-command-palette-dark');
    await page.keyboard.press('Escape'); await page.keyboard.press('Meta+k');
    await shot(page, '3b-command-palette-all-dark');
    await page.keyboard.press('Escape'); await page.keyboard.press('Meta+n'); await shot(page, '6-bind-modal-dark'); await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+3'); await shot(page, '7-settings-dark');
    await app.close();
  }
  if (!only || only === 'light') {
    // Forced light color scheme (CA_THEME=light -> nativeTheme 'light', no --force-dark-mode).
    execFileSync(path.join(__dirname, 'demo-config.sh'), [demo]);
    const L = { CA_THEME: 'light', LIGHT: '1' };
    { const { app, page } = await launch(home, L);
      if (!(await page.evaluate(() => document.documentElement.classList.contains('light')))) throw new Error('light theme not applied');
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
      await shot(page, '8-repositories-light');
      await page.keyboard.press('Meta+2'); await page.click('.card .card-foot .btn.ghost'); await page.waitForTimeout(1200);
      await shot(page, '9-accounts-light');
      await page.keyboard.press('Meta+1'); await page.keyboard.press('Meta+k'); await page.waitForSelector('.pal-input input'); await page.waitForTimeout(250); await page.fill('.pal-input input', 'acme');
      await shot(page, '10-palette-light'); await page.keyboard.press('Escape');
      await page.keyboard.press('Meta+3'); await page.waitForTimeout(600); await page.focus('.seg button:nth-child(2)'); await page.keyboard.press('Tab'); await shot(page, '11-settings-light');
      await app.close(); }
    { const empty = '/tmp/ca-demo-empty-l/home'; fs.rmSync('/tmp/ca-demo-empty-l', { recursive: true, force: true }); fs.mkdirSync(empty, { recursive: true });
      const { app, page } = await launch(empty, L);
      await shot(page, '12-onboarding-light');
      await page.fill('.onb input', 'work'); await page.click('.onb .btn.primary'); await page.waitForTimeout(400);
      await shot(page, '12b-onboarding-signin-light');
      await app.close(); }
  }
  if (!only || only === 'onb') {
    const empty = '/tmp/ca-demo-empty/home'; fs.rmSync('/tmp/ca-demo-empty', { recursive: true, force: true }); fs.mkdirSync(empty, { recursive: true });
    const { app, page } = await launch(empty);
    await shot(page, '4-onboarding-dark');
    await page.fill('.onb input', 'work'); await page.click('.onb .btn.primary'); await page.waitForTimeout(400);
    await shot(page, '4b-onboarding-signin-dark');
    await page.click('.onb .btn.primary'); await shot(page, '4c-onboarding-bind-dark');
    await page.click('.onb .btn.ghost'); await shot(page, '4d-empty-repos-dark');
    await app.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
