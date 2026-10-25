'use strict';
// The app icon, drawn from one geometry: two rings (one per account) and the lens where they overlap,
// set apart from both rings by a gap so the light top of the lens never merges into the white rings.
// scripts/make-icons.js writes build/icon.svg and src/renderer/mark.svg from it; keep this file the source.

// Two rings (centers 188 apart, r 190, stroke 40) on the 824px macOS squircle of a 1024 canvas.
const A = 418, B = 606, CY = 512, R = 190, SW = 40;
// The sheen fades along a smoothstep curve; straight segments between a few stops show as bands on the dark ground.
const fade = peak => Array.from({ length: 9 }, (_, i) => { const t = i / 8; return [t, '#fff', +(peak * (1 - t * t * (3 - 2 * t))).toFixed(4)]; });
const stops = list => list.map(([at, c, op]) => `<stop offset="${at}" stop-color="${c}"${op === undefined ? '' : ` stop-opacity="${op}"`}/>`).join('');

// o.p prefixes every id, so several icons can share one document.
// o.shadow false drops the outer shadow, and o.crop trims the canvas to the squircle (the in-app mark).
// The shadow is a separate blurred shape: a filter on the gradient itself makes Chrome render the gradient in a few coarse bands.
function icon(o) {
  const p = o.p || '', id = n => p + n, url = n => `url(#${p}${n})`;
  const rl = R - SW / 2 - o.gap;                                   // lens: overlap of the two discs, inset by the gap
  const half = Math.sqrt(rl * rl - ((B - A) / 2) ** 2), w = rl * 2 - (B - A);
  const top = CY - half, bot = CY + half;
  const body = `<defs>
    <linearGradient id="${id('bg')}" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">${stops(o.bg)}</linearGradient>
    <radialGradient id="${id('sheen')}" cx="512" cy="100" r="640" gradientUnits="userSpaceOnUse">${stops(fade(o.sheen))}</radialGradient>
    <linearGradient id="${id('rim')}" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">${stops(o.rim)}</linearGradient>
    <linearGradient id="${id('ring')}" x1="0" y1="${CY - R - SW / 2}" x2="0" y2="${CY + R + SW / 2}" gradientUnits="userSpaceOnUse">${stops(o.ring)}</linearGradient>
    <linearGradient id="${id('lens')}" x1="0" y1="${top}" x2="0" y2="${bot}" gradientUnits="userSpaceOnUse">${stops(o.lens)}</linearGradient>
    <linearGradient id="${id('bevel')}" x1="0" y1="${top}" x2="0" y2="${CY}" gradientUnits="userSpaceOnUse">${stops([[0, '#fff', o.bevel], [1, '#fff', 0]])}</linearGradient>
    <clipPath id="${id('sq')}"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
    <clipPath id="${id('la')}"><circle cx="${A}" cy="${CY}" r="${rl}"/></clipPath>
    <clipPath id="${id('lb')}"><circle cx="${B}" cy="${CY}" r="${rl}"/></clipPath>
    <filter id="${id('glow')}" x="-150%" y="-80%" width="400%" height="260%"><feGaussianBlur stdDeviation="44"/></filter>${o.shadow === false ? '' : `
    <filter id="${id('sh')}" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="22"/></filter>`}
  </defs>${o.shadow === false ? '' : `
  <rect x="100" y="118" width="824" height="824" rx="186" fill="#000" opacity="${o.shadow}" filter="${url('sh')}"/>`}
  <rect x="100" y="100" width="824" height="824" rx="186" fill="${url('bg')}"/>
  <g clip-path="${url('sq')}">
    <rect x="100" y="100" width="824" height="824" fill="${url('sheen')}"/>
    <ellipse cx="512" cy="${CY}" rx="${w / 2 + 34}" ry="${half + 46}" fill="#a3e635" opacity="${o.glow}" filter="${url('glow')}"/>
  </g>
  <circle cx="${A}" cy="${CY}" r="${rl}" fill="${url('lens')}" clip-path="${url('lb')}"/>
  <circle cx="${A}" cy="${CY}" r="${rl}" fill="none" stroke="${url('bevel')}" stroke-width="7" clip-path="${url('lb')}"/>
  <circle cx="${B}" cy="${CY}" r="${rl}" fill="none" stroke="${url('bevel')}" stroke-width="7" clip-path="${url('la')}"/>
  <g fill="none" stroke="${url('ring')}" stroke-width="${SW}"><circle cx="${A}" cy="${CY}" r="${R}"/><circle cx="${B}" cy="${CY}" r="${R}"/></g>
  <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" fill="none" stroke="${url('rim')}" stroke-width="3"/>`;
  if (o.bodyOnly) return body;
  const frame = o.crop ? 'viewBox="100 100 824 824"' : 'width="1024" height="1024" viewBox="0 0 1024 1024"';
  return `<svg xmlns="http://www.w3.org/2000/svg" ${frame}>\n  ${body}\n</svg>\n`;
}

// The default appearance: graphite squircle, white rings, lime lens.
const DARK = {
  bg: [[0, '#2b2b30'], [1, '#09090b']], sheen: .1, shadow: .36, gap: 14, glow: .42, bevel: .5,
  rim: [[0, '#fff', .22], [.4, '#fff', .03], [1, '#fff', .06]],
  ring: [[0, '#ffffff'], [.55, '#ececef'], [1, '#b9b9c1']],
  lens: [[0, '#d9fa96'], [.35, '#b5ee4a'], [.75, '#84cc16'], [1, '#5d9612']],
};
// For light grounds such as a website or docs page.
const LIGHT = {
  bg: [[0, '#ffffff'], [1, '#e2e2e7']], sheen: .6, shadow: .2, gap: 14, glow: .5, bevel: .55,
  rim: [[0, '#fff', .9], [.5, '#000', .04], [1, '#000', .1]],
  ring: [[0, '#3a3a41'], [1, '#09090b']],
  lens: [[0, '#c8f46e'], [.4, '#a3e635'], [.8, '#78b814'], [1, '#5d9612']],
};

module.exports = { icon, DARK, LIGHT };
