// Dock launchers (src/launchers.ts): their ids, labels and Info.plist. Building one and editing the Dock are
// checked by hand: they change the real Dock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-launchers-'));
process.env.CA_CONFIG = path.join(TMP, 'cfg', 'config.json');
process.env.CA_LAUNCHERS_DIR = path.join(TMP, 'Applications');
const L = await import('../src/launchers.ts');

test("the icon says the account's name, or the first word of a long one that no other account shares", () => {
  const mine = ['grade-account', 'personal-account'];
  assert.equal(L.launcherLabel('work', ['work']), 'WORK');
  assert.equal(L.launcherLabel('grade-account', mine), 'GRADE');
  assert.equal(L.launcherLabel('personal-account', mine), 'PERSONAL');
  assert.equal(L.launcherLabel('client-acme-co', ['client-acme-co', 'client-globex']), 'CLIENT-ACME-CO');
  assert.equal(L.launcherLabel('a-long-account', ['a-long-account']), 'A-LONG-ACCOUNT');
});

test('a launcher is known by its Desktop folder, however the path to it is written', () => {
  const d = path.join(TMP, 'acct', 'desktop');
  fs.mkdirSync(d, { recursive: true });
  fs.symlinkSync(path.join(TMP, 'acct'), path.join(TMP, 'link'));
  const id = L.launcherId(d);
  assert.match(id, /^dev\.gabriel\.claude-accounts\.launcher\.[0-9a-f]{12}$/);
  assert.equal(L.launcherId(path.join(TMP, 'link', 'desktop')), id);
  assert.equal(L.launcherId(path.join(TMP, 'acct', 'DESKTOP')), process.platform === 'linux' ? L.launcherId(path.join(TMP, 'acct', 'DESKTOP')) : id);
});

test('Info.plist holds what the launcher needs, escaped, and reads back; other apps are left alone', () => {
  const app = path.join(process.env.CA_LAUNCHERS_DIR!, `${L.appName('work')}.app`);
  const l = { id: L.launcherId(path.join(TMP, 'x')), account: 'work', desktopDir: path.join(TMP, 'a&b <d>'), configDir: path.join(TMP, 'c'),
              configPath: process.env.CA_CONFIG!, label: 'WORK', stub: '0123456789ab' };
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), L.infoPlist(l, '2.0.0'));
  assert.deepEqual(L.readLauncher(app), { ...l, app });
  if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', '-s', path.join(app, 'Contents', 'Info.plist')]);
  assert.throws(() => L.infoPlist({ ...l, desktopDir: `a${String.fromCharCode(1)}b` }, '2.0.0'), /control character/);

  const other = path.join(process.env.CA_LAUNCHERS_DIR!, 'Other.app', 'Contents');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>');
  assert.deepEqual(L.listLaunchers().map(x => x.account), ['work']);
});
