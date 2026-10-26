// Draws the icon from scripts/icon-art.ts into build/icon.svg and the in-app mark (src/renderer/mark.svg),
// then renders PNG sizes, a macOS .icns and a Windows .ico (pure Node + sharp).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { icon, DARK } from './icon-art.ts';

const B = path.join(import.meta.dirname, '..', 'build');
fs.writeFileSync(path.join(B, 'icon.svg'), icon(DARK));
fs.writeFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'mark.svg'), icon({ ...DARK, shadow: false, crop: true }));
const svg = fs.readFileSync(path.join(B, 'icon.svg'));
const png = (s: number) => sharp(svg, { density: Math.max(72, 72 * s / 1024 * 4) }).resize(s, s).png().toBuffer();
fs.mkdirSync(path.join(B, 'icons'), { recursive: true });
const sizes = [16, 32, 48, 64, 128, 256, 512, 1024], bufs: Record<number, Buffer> = {};
for (const s of sizes) { bufs[s] = await png(s); fs.writeFileSync(path.join(B, 'icons', `${s}x${s}.png`), bufs[s]); }
fs.writeFileSync(path.join(B, 'icon.png'), bufs[1024]!);
// ICNS with PNG payloads: ic11 32 (16@2x), ic12 64 (32@2x), ic07 128, ic13 256 (128@2x), ic08 256, ic14 512 (256@2x),
// ic09 512, ic10 1024 (512@2x). iconutil stores 16 and 32 at 1x as raw ARGB (ic04, ic05); as PNGs (icp4, icp5) current
// macOS decodes them as noise, so they're left out and macOS scales the 2x ones down.
const ent: [string, number][] = [['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]];
const parts = ent.map(([t, s]) => { const h = Buffer.alloc(8), b = bufs[s]!; h.write(t, 0, 'ascii'); h.writeUInt32BE(b.length + 8, 4); return Buffer.concat([h, b]); });
const body = Buffer.concat(parts), head = Buffer.alloc(8); head.write('icns', 0, 'ascii'); head.writeUInt32BE(body.length + 8, 4);
fs.writeFileSync(path.join(B, 'icon.icns'), Buffer.concat([head, body]));
// ICO with PNG payloads
const icoSizes = [16, 24, 32, 48, 64, 128, 256]; const ib: Record<number, Buffer> = {};
for (const s of icoSizes) ib[s] = bufs[s] || await png(s);
const dir = Buffer.alloc(6 + 16 * icoSizes.length); dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(icoSizes.length, 4);
let off = dir.length;
icoSizes.forEach((s, i) => { const o = 6 + i * 16; dir.writeUInt8(s >= 256 ? 0 : s, o); dir.writeUInt8(s >= 256 ? 0 : s, o + 1); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(ib[s]!.length, o + 8); dir.writeUInt32LE(off, o + 12); off += ib[s]!.length; });
fs.writeFileSync(path.join(B, 'icon.ico'), Buffer.concat([dir, ...icoSizes.map(s => ib[s]!)]));
// menu-bar template icons (black + alpha) and a colored tray icon for Windows
const tray = fs.readFileSync(path.join(B, 'tray.svg'));
await sharp(tray, { density: 72 * 16 / 32 * 2 }).resize(16, 16).png().toFile(path.join(B, 'trayTemplate.png'));
await sharp(tray, { density: 144 }).resize(32, 32).png().toFile(path.join(B, 'trayTemplate@2x.png'));
await sharp(svg).resize(32, 32).png().toFile(path.join(B, 'tray.png'));
console.log('icons ok');
