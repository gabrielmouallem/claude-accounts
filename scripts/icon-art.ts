// The app icon: two accounts, the one a repository opens with in front (a lime disc) and another behind it (a white
// ring), cut back where it passes behind the disc.
// scripts/make-icons.ts writes build/icon.svg and src/renderer/mark.svg from it; keep this file the source.
// build/tray.svg draws the same shapes for the menu bar.

// On the 824px macOS squircle of a 1024 canvas: the disc (r 192) low on the left, the ring (r 170, stroke 40) high on
// the right, and a gap of CUT between the disc and the part of the ring behind it.
const DISC = { x: 436, y: 580, r: 192 }, RING = { x: 600, y: 446, r: 170 }, SW = 40, CUT = 24;
// The sheen fades along a smoothstep curve; straight segments between a few stops show as bands on the dark ground.
type Stop = [at: number, color: string, opacity?: number];
const fade = (peak: number): Stop[] => Array.from({ length: 9 }, (_, i) => { const t = i / 8; return [t, '#fff', +(peak * (1 - t * t * (3 - 2 * t))).toFixed(4)]; });
const stops = (list: Stop[]) => list.map(([at, c, op]) => `<stop offset="${at}" stop-color="${c}"${op === undefined ? '' : ` stop-opacity="${op}"`}/>`).join('');

// The look of one icon. Ground (bg, sheen, rim), ring and disc (accent) are gradients; sheen and shadow are opacities.
export interface Look { bg: Stop[]; sheen: number; shadow: number; rim: Stop[]; ring: Stop[]; accent: Stop[] }
interface Options extends Omit<Look, 'shadow'> { shadow: number | false; p?: string; crop?: boolean; bodyOnly?: boolean }

// o.p prefixes every id, so several icons can share one document.
// o.shadow false drops the outer shadow, and o.crop trims the canvas to the squircle (the in-app mark).
// The shadow is a separate blurred shape: a filter on the gradient itself makes Chrome render the gradient in a few coarse bands.
export function icon(o: Options): string {
  const p = o.p || '', id = (n: string) => p + n, url = (n: string) => `url(#${p}${n})`;
  const body = `<defs>
    <linearGradient id="${id('bg')}" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">${stops(o.bg)}</linearGradient>
    <radialGradient id="${id('sheen')}" cx="512" cy="100" r="640" gradientUnits="userSpaceOnUse">${stops(fade(o.sheen))}</radialGradient>
    <linearGradient id="${id('rim')}" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">${stops(o.rim)}</linearGradient>
    <linearGradient id="${id('ring')}" x1="0" y1="${RING.y - RING.r - SW}" x2="0" y2="${RING.y + RING.r + SW}" gradientUnits="userSpaceOnUse">${stops(o.ring)}</linearGradient>
    <linearGradient id="${id('accent')}" x1="0" y1="${DISC.y - DISC.r}" x2="0" y2="${DISC.y + DISC.r}" gradientUnits="userSpaceOnUse">${stops(o.accent)}</linearGradient>
    <clipPath id="${id('sq')}"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
    <mask id="${id('behind')}" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <rect width="1024" height="1024" fill="#fff"/><circle cx="${DISC.x}" cy="${DISC.y}" r="${DISC.r + CUT}" fill="#000"/></mask>${o.shadow === false ? '' : `
    <filter id="${id('sh')}" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="22"/></filter>`}
  </defs>${o.shadow === false ? '' : `
  <rect x="100" y="118" width="824" height="824" rx="186" fill="#000" opacity="${o.shadow}" filter="${url('sh')}"/>`}
  <rect x="100" y="100" width="824" height="824" rx="186" fill="${url('bg')}"/>
  <g clip-path="${url('sq')}"><rect x="100" y="100" width="824" height="824" fill="${url('sheen')}"/></g>
  <circle cx="${RING.x}" cy="${RING.y}" r="${RING.r}" fill="none" stroke="${url('ring')}" stroke-width="${SW}" mask="${url('behind')}"/>
  <circle cx="${DISC.x}" cy="${DISC.y}" r="${DISC.r}" fill="${url('accent')}"/>
  <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="${url('rim')}" stroke-width="3"/>`;
  if (o.bodyOnly) return body;
  const frame = o.crop ? 'viewBox="100 100 824 824"' : 'width="1024" height="1024" viewBox="0 0 1024 1024"';
  return `<svg xmlns="http://www.w3.org/2000/svg" ${frame}>\n  ${body}\n</svg>\n`;
}

// The default appearance: graphite squircle, a white ring and a lime disc.
export const DARK: Look = {
  bg: [[0, '#2b2b30'], [1, '#09090b']], sheen: .1, shadow: .36,
  rim: [[0, '#fff', .22], [.4, '#fff', .03], [1, '#fff', .06]],
  ring: [[0, '#ffffff'], [.55, '#ececef'], [1, '#b9b9c1']],
  accent: [[0, '#d9fa96'], [.35, '#b5ee4a'], [.75, '#84cc16'], [1, '#5d9612']],
};
// For light grounds such as a website or docs page.
export const LIGHT: Look = {
  bg: [[0, '#ffffff'], [1, '#e2e2e7']], sheen: .6, shadow: .2,
  rim: [[0, '#fff', .9], [.5, '#000', .04], [1, '#000', .1]],
  ring: [[0, '#3a3a41'], [1, '#09090b']],
  accent: [[0, '#c8f46e'], [.4, '#a3e635'], [.8, '#78b814'], [1, '#5d9612']],
};
