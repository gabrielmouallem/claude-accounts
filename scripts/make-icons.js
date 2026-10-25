// Renders build/icon.svg into PNG sizes, a macOS .icns and a Windows .ico (pure Node + sharp).
const sharp = require('sharp'); const fs = require('fs'); const path = require('path');
const B = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(B, 'icon.svg'));
const png = s => sharp(svg, { density: Math.max(72, 72 * s / 1024 * 4) }).resize(s, s).png().toBuffer();
(async () => {
  fs.mkdirSync(path.join(B, 'icons'), { recursive: true });
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024], bufs = {};
  for (const s of sizes) { bufs[s] = await png(s); fs.writeFileSync(path.join(B, 'icons', `${s}x${s}.png`), bufs[s]); }
  fs.writeFileSync(path.join(B, 'icon.png'), bufs[1024]);
  // ICNS with PNG payloads: icp4 16, icp5 32, icp6 64, ic07 128, ic08 256, ic09 512, ic10 1024 (512@2x), ic11 32(16@2x), ic12 64, ic13 256, ic14 512
  const ent = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const parts = ent.map(([t, s]) => { const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(bufs[s].length + 8, 4); return Buffer.concat([h, bufs[s]]); });
  const body = Buffer.concat(parts), head = Buffer.alloc(8); head.write('icns', 0, 'ascii'); head.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(path.join(B, 'icon.icns'), Buffer.concat([head, body]));
  // ICO with PNG payloads
  const icoSizes = [16, 24, 32, 48, 64, 128, 256]; const ib = {};
  for (const s of icoSizes) ib[s] = bufs[s] || await png(s);
  const dir = Buffer.alloc(6 + 16 * icoSizes.length); dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(icoSizes.length, 4);
  let off = dir.length;
  icoSizes.forEach((s, i) => { const o = 6 + i * 16; dir.writeUInt8(s >= 256 ? 0 : s, o); dir.writeUInt8(s >= 256 ? 0 : s, o + 1); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(ib[s].length, o + 8); dir.writeUInt32LE(off, o + 12); off += ib[s].length; });
  fs.writeFileSync(path.join(B, 'icon.ico'), Buffer.concat([dir, ...icoSizes.map(s => ib[s])]));
  // menu-bar template icons (black + alpha) and a colored tray icon for Windows
  const tray = fs.readFileSync(path.join(B, 'tray.svg'));
  await sharp(tray, { density: 72 * 16 / 32 * 2 }).resize(16, 16).png().toFile(path.join(B, 'trayTemplate.png'));
  await sharp(tray, { density: 144 }).resize(32, 32).png().toFile(path.join(B, 'trayTemplate@2x.png'));
  await sharp(svg).resize(32, 32).png().toFile(path.join(B, 'tray.png'));
  console.log('icons ok');
})();
