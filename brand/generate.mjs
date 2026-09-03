// intentum logo generator. Emits every brand SVG from a small set of proportions.
// Usage: node brand/generate.mjs brand        (add --preview for a contact sheet)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || "./out";


export const COLORS = {
  ink: '#131313',
  paper: '#F4F4F2',
  accent: '#E8302A',      // signal red, on light grounds
  accentDark: '#FF5148',  // signal red, lifted for dark grounds
};

const f = (n) => (Math.round(n * 100) / 100).toString();

// ---------------------------------------------------------------- mark
// Two arms converge on one point. Arms are one polygon with vertical end
// cuts; the point is a circle whose centre sits slightly ahead of the apex.
export const MARK = { L: 82, alpha: 30, w: 26, rho: 1.35, protrude: 3 };

export function markGeom(p = MARK) {
  const a = (p.alpha * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const hw = p.w / 2;
  const ex = -p.L * c;           // x of the vertical end cut
  const ey = p.L * s;            // |y| of centreline end
  const vh = hw / c;             // half height of the vertical cut
  const Ao = hw / s, Ai = -hw / s;
  const r = (p.rho * p.w) / 2;
  const cx = Ao + p.protrude - r;
  const pts = [[Ao, 0], [ex, -(ey + vh)], [ex, -(ey - vh)], [Ai, 0], [ex, ey - vh], [ex, ey + vh]];
  const bbox = { x: ex, y: -(ey + vh), w: cx + r - ex, h: 2 * (ey + vh) };
  return { pts, dot: { cx, cy: 0, r }, bbox };
}

// Returns a <g> holding the mark, with its bbox top-left at (x,y) and height h.
export function markGroup({ x = 0, y = 0, h, arms, dot, p = MARK, extra = '' } = {}) {
  const g = markGeom(p);
  const k = h / g.bbox.h;
  const poly = g.pts.map(([px, py]) => `${f(px - g.bbox.x)},${f(py - g.bbox.y)}`).join(' ');
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${f(k)})"${extra}>` +
    `<polygon points="${poly}" fill="${arms}"/>` +
    `<circle cx="${f(g.dot.cx - g.bbox.x)}" cy="${f(g.dot.cy - g.bbox.y)}" r="${f(g.dot.r)}" fill="${dot}"/>` +
    `</g>`;
}
export const markAspect = (p = MARK) => { const g = markGeom(p); return g.bbox.w / g.bbox.h; };

// ------------------------------------------------------------ wordmark
export const WM = {
  x: 100, w: 22, Rn: 36, Rm: 34, Re: 40.5, eBar: 47, tTop: -40, tL: 20, tR: 26,
  dotRho: 1.4, dotCy: -29, gapSS: 21, gapRS: 15, gapT: 12, os: 1.2,
};

export function wordmarkGeom(p = WM) {
  const hw = p.w / 2, X = p.x;
  const paths = [];
  let dot = null;
  let x = 0;

  const i = (x0) => { const cx = x0 + hw; paths.push(`M${f(cx)} ${X} V0`); dot = { cx, cy: p.dotCy, r: (p.dotRho * p.w) / 2 }; return x0 + p.w; };
  const n = (x0) => { const xL = x0 + hw, xR = xL + 2 * p.Rn, cy = hw + p.Rn - p.os;
    paths.push(`M${f(xL)} ${X} V0 M${f(xL)} ${f(cy)} A${p.Rn} ${p.Rn} 0 0 1 ${f(xR)} ${f(cy)} V${X}`); return xR + hw; };
  const t = (x0) => { const cx = x0 + p.tL;
    paths.push(`M${f(cx)} ${X} V${p.tTop} M${f(x0)} ${f(hw)} H${f(cx + p.tR)}`); return cx + p.tR; };
  const e = (x0) => { const cx = x0 + hw + p.Re, cy = X / 2, R = p.Re;
    const th0 = Math.asin((p.eBar - cy) / R);
    const sx = cx + R * Math.cos(th0);
    const ex = cx + R * Math.cos(Math.PI / 4), ey = cy + R * Math.sin(Math.PI / 4);
    paths.push(`M${f(cx - R * Math.cos(th0))} ${f(p.eBar)} H${f(sx)} A${R} ${R} 0 1 0 ${f(ex)} ${f(ey)}`); return cx + R + hw; };
  const u = (x0) => { const xL = x0 + hw, xR = xL + 2 * p.Rn, cy = X - hw - p.Rn + p.os;
    paths.push(`M${f(xL)} 0 V${f(cy)} A${p.Rn} ${p.Rn} 0 0 0 ${f(xR)} ${f(cy)} M${f(xR)} 0 V${X}`); return xR + hw; };
  const m = (x0) => { const xL = x0 + hw, x2 = xL + 2 * p.Rm, x3 = x2 + 2 * p.Rm, cy = hw + p.Rm - p.os;
    paths.push(`M${f(xL)} ${X} V0 M${f(xL)} ${f(cy)} A${p.Rm} ${p.Rm} 0 0 1 ${f(x2)} ${f(cy)} V${X} M${f(x2)} ${f(cy)} A${p.Rm} ${p.Rm} 0 0 1 ${f(x3)} ${f(cy)} V${X}`); return x3 + hw; };

  x = i(x);
  x = n(x + p.gapSS);
  x = t(x + p.gapT);
  x = e(x + p.gapT);
  x = n(x + p.gapRS);
  x = t(x + p.gapT);
  x = u(x + p.gapT);
  x = m(x + p.gapSS);

  const top = Math.min(dot.cy - dot.r, p.tTop);
  return { paths, dot, width: x, top, bottom: X, height: X - top, baseline: X };
}

// <g> with the wordmark's bbox top-left at (x,y) and height h.
export function wordmarkGroup({ x = 0, y = 0, h, ink, dot, p = WM } = {}) {
  const g = wordmarkGeom(p);
  const k = h / g.height;
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${f(k)}) translate(0 ${f(-g.top)})">` +
    `<path d="${g.paths.join(' ')}" fill="none" stroke="${ink}" stroke-width="${p.w}" stroke-linecap="butt"/>` +
    `<circle cx="${f(g.dot.cx)}" cy="${f(g.dot.cy)}" r="${f(g.dot.r)}" fill="${dot}"/>` +
    `</g>`;
}
export const wordmarkAspect = (p = WM) => { const g = wordmarkGeom(p); return g.width / g.height; };

// ------------------------------------------------------------- lockups
export const LOCK = { gap: 0.38, stackGap: 0.34 };

// Horizontal lockup. The mark is as tall as the wordmark box, so its bottom sits
// on the baseline and its top meets the i-dot; a mark centred on the x-height
// would overshoot the baseline and read as sagging.
export function lockupGroup({ x = 0, y = 0, H, ink, arms, dot, wmDot, lk = LOCK } = {}) {
  const mh = H;
  const mw = mh * markAspect();
  const ww = H * wordmarkAspect();
  const gap = mw * lk.gap;
  return {
    svg: markGroup({ x, y, h: mh, arms, dot }) +
      wordmarkGroup({ x: x + mw + gap, y, h: H, ink, dot: wmDot }),
    width: mw + gap + ww, height: H, top: y,
  };
}

export function stackedGroup({ x = 0, y = 0, H, ink, arms, dot, wmDot, lk = LOCK } = {}) {
  // H is the wordmark height; mark is 1.9x the wordmark height, centred above.
  const mh = H * 1.9;
  const mw = mh * markAspect();
  const ww = H * wordmarkAspect();
  const width = Math.max(mw, ww);
  const gap = H * lk.stackGap * 2.2;
  return {
    svg: markGroup({ x: x + (width - mw) / 2, y, h: mh, arms, dot }) +
      wordmarkGroup({ x: x + (width - ww) / 2, y: y + mh + gap, h: H, ink, dot: wmDot }),
    width, height: mh + gap + H,
  };
}

// --------------------------------------------------------- construction
// Annotated drawing of the mark's geometry, for the brand sheet.
export function constructionSvg({ ink = '#131313', muted = '#8A8A86', brand = '#E8302A', p = MARK } = {}) {
  const g = markGeom(p);
  const a = (p.alpha * Math.PI) / 180;
  const pad = 46;
  const ox = -g.bbox.x + pad, oy = -g.bbox.y + pad;
  const W = g.bbox.w + pad * 2 + 150, H = g.bbox.h + pad * 2;
  const P = (x, y) => `${f(x + ox)} ${f(y + oy)}`;
  const poly = g.pts.map(([x, y]) => `${f(x + ox)},${f(y + oy)}`).join(' ');
  const ex = g.pts[1][0], ey = -p.L * Math.sin(a);
  let b = '';
  b += `<polygon points="${poly}" fill="${ink}" fill-opacity="0.12"/>`;
  b += `<circle cx="${f(g.dot.cx + ox)}" cy="${f(oy)}" r="${f(g.dot.r)}" fill="${brand}" fill-opacity="0.18"/>`;
  b += `<circle cx="${f(g.dot.cx + ox)}" cy="${f(oy)}" r="${f(g.dot.r)}" fill="none" stroke="${brand}" stroke-width="1.2"/>`;
  b += `<polygon points="${poly}" fill="none" stroke="${ink}" stroke-width="1.2"/>`;
  // centrelines of the arms
  b += `<path d="M${P(ex, ey)} L${P(0, 0)} L${P(ex, -ey)}" fill="none" stroke="${muted}" stroke-width="1" stroke-dasharray="4 4"/>`;
  // axis through the point
  b += `<path d="M${P(ex - 30, 0)} H${f(g.dot.cx + g.dot.r + 22 + ox)}" fill="none" stroke="${muted}" stroke-width="1" stroke-dasharray="4 4"/>`;
  // vertical end-cut line
  b += `<path d="M${P(ex, g.bbox.y - 18)} V${f(g.bbox.y + g.bbox.h + 18 + oy)}" fill="none" stroke="${muted}" stroke-width="1" stroke-dasharray="4 4"/>`;
  // angle arc at the junction
  const ar = 34;
  b += `<path d="M${P(-ar * Math.cos(a), -ar * Math.sin(a))} A${ar} ${ar} 0 0 0 ${P(-ar * Math.cos(a), ar * Math.sin(a))}" fill="none" stroke="${brand}" stroke-width="1"/>`;
  b += `<text x="${f(-ar - 8 + ox)}" y="${f(oy + 4)}" text-anchor="end" font-family="JetBrains Mono, Menlo, monospace" font-size="11" fill="${brand}">${2 * p.alpha}°</text>`;
  // labels
  const lab = (x, y, t, anchor = 'start') => `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-family="JetBrains Mono, Menlo, monospace" font-size="11" fill="${muted}">${t}</text>`;
  b += lab(ex + ox, g.bbox.y + oy - 24, 'vertical cut');
  b += lab(g.dot.cx + ox, g.bbox.y + oy - 6, `point ø ${p.rho} w`, 'middle');
  b += lab(ex + ox + 8, g.bbox.y + g.bbox.h + oy + 16, `arm w`);
  b += lab(g.dot.cx + g.dot.r + ox + 8, oy + g.dot.r + 18, 'sits ahead of the apex');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(W)} ${f(H)}" width="100%" role="img" aria-label="Construction of the intentum mark">${b}</svg>`;
}

// ---------------------------------------------------------------- files
const svg = (w, h, body, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(w)} ${f(h)}" width="${f(w)}" height="${f(h)}"${attrs}>${body}</svg>\n`;

export function emitAll(out = OUT) {
  mkdirSync(out, { recursive: true });
  const C = COLORS;
  const files = {};

  // mark (height 100 units)
  const mg = markGeom();
  const mw = 100 * markAspect();
  files['intentum-mark.svg'] = svg(mw, 100, markGroup({ h: 100, arms: C.ink, dot: C.accent }));
  files['intentum-mark-dark.svg'] = svg(mw, 100, markGroup({ h: 100, arms: C.paper, dot: C.accentDark }));
  files['intentum-mark-mono.svg'] = svg(mw, 100, markGroup({ h: 100, arms: 'currentColor', dot: 'currentColor' }), ' fill="currentColor"');

  // tile / app icon / avatar: 1024 canvas
  const T = 1024, R = T * 0.2237;
  const th = T * 0.52, tw = th * markAspect();
  const tx = (T - tw) / 2 + T * 0.012, ty = (T - th) / 2;  // nudge right: chevron's mass sits left
  files['intentum-tile.svg'] = svg(T, T,
    `<rect width="${T}" height="${T}" rx="${f(R)}" fill="${C.ink}"/>` +
    markGroup({ x: tx, y: ty, h: th, arms: C.paper, dot: C.accentDark }));
  files['intentum-tile-paper.svg'] = svg(T, T,
    `<rect width="${T}" height="${T}" rx="${f(R)}" fill="${C.paper}"/>` +
    markGroup({ x: tx, y: ty, h: th, arms: C.ink, dot: C.accent }));
  files['intentum-tile-square.svg'] = svg(T, T,
    `<rect width="${T}" height="${T}" fill="${C.ink}"/>` +
    markGroup({ x: tx, y: ty, h: th, arms: C.paper, dot: C.accentDark }));
  // favicon: same tile, mark a little larger for 16px legibility
  const fh = T * 0.6, fw = fh * markAspect();
  files['favicon.svg'] = svg(T, T,
    `<rect width="${T}" height="${T}" rx="${f(T * 0.2)}" fill="${C.ink}"/>` +
    markGroup({ x: (T - fw) / 2 + T * 0.012, y: (T - fh) / 2, h: fh, arms: C.paper, dot: C.accentDark }));

  // wordmark (height 100)
  const ww = 100 * wordmarkAspect();
  files['intentum-wordmark.svg'] = svg(ww, 100, wordmarkGroup({ h: 100, ink: C.ink, dot: C.accent }));
  files['intentum-wordmark-dark.svg'] = svg(ww, 100, wordmarkGroup({ h: 100, ink: C.paper, dot: C.accentDark }));
  files['intentum-wordmark-mono.svg'] = svg(ww, 100, wordmarkGroup({ h: 100, ink: 'currentColor', dot: 'currentColor' }), ' fill="currentColor"');

  // horizontal lockups (height 100)
  const box = (L) => `<g transform="translate(0 ${f(-L.top)})">${L.svg}</g>`;
  const L1 = lockupGroup({ H: 100, ink: C.ink, arms: C.ink, dot: C.accent, wmDot: C.ink });
  files['intentum-logo.svg'] = svg(L1.width, L1.height, box(L1));
  const L2 = lockupGroup({ H: 100, ink: C.paper, arms: C.paper, dot: C.accentDark, wmDot: C.paper });
  files['intentum-logo-dark.svg'] = svg(L2.width, L2.height, box(L2));
  const L3 = lockupGroup({ H: 100, ink: 'currentColor', arms: 'currentColor', dot: 'currentColor', wmDot: 'currentColor' });
  files['intentum-logo-mono.svg'] = svg(L3.width, L3.height, box(L3), ' fill="currentColor"');

  // stacked lockups
  const S1 = stackedGroup({ H: 100, ink: C.ink, arms: C.ink, dot: C.accent, wmDot: C.ink });
  files['intentum-logo-stacked.svg'] = svg(S1.width, S1.height, S1.svg);
  const S2 = stackedGroup({ H: 100, ink: C.paper, arms: C.paper, dot: C.accentDark, wmDot: C.paper });
  files['intentum-logo-stacked-dark.svg'] = svg(S2.width, S2.height, S2.svg);

  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body);
  return files;
}

// ------------------------------------------------------------ preview
export function previewSheet() {
  const C = COLORS;
  const W = 1600, H = 1500;
  let b = `<rect width="${W}" height="${H}" fill="${C.paper}"/>`;
  // row 1: mark + lockup on paper
  b += markGroup({ x: 80, y: 60, h: 260, arms: C.ink, dot: C.accent });
  const l1 = lockupGroup({ x: 420, y: 130, H: 120, ink: C.ink, arms: C.ink, dot: C.accent, wmDot: C.ink });
  b += l1.svg;
  // row 2: on ink
  b += `<rect x="0" y="380" width="${W}" height="420" fill="${C.ink}"/>`;
  b += markGroup({ x: 80, y: 440, h: 260, arms: C.paper, dot: C.accentDark });
  const l2 = lockupGroup({ x: 420, y: 510, H: 120, ink: C.paper, arms: C.paper, dot: C.accentDark, wmDot: C.paper });
  b += l2.svg;
  // row 3: tiles at decreasing sizes + mono
  const R = 0.2237;
  let x = 80;
  for (const s of [256, 128, 64, 48, 32, 24, 16]) {
    const th = s * 0.52, tw = th * markAspect();
    b += `<rect x="${x}" y="${860}" width="${s}" height="${s}" rx="${f(s * R)}" fill="${C.ink}"/>`;
    b += markGroup({ x: x + (s - tw) / 2 + s * 0.012, y: 860 + (s - th) / 2, h: th, arms: C.paper, dot: C.accentDark });
    x += s + 40;
  }
  // wordmark alone, big
  b += wordmarkGroup({ x: 80, y: 1180, h: 150, ink: C.ink, dot: C.accent });
  // stacked
  const s1 = stackedGroup({ x: 1150, y: 860, H: 80, ink: C.ink, arms: C.ink, dot: C.accent, wmDot: C.ink });
  b += s1.svg;
  return svg(W, H, b);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = emitAll(OUT);
  if (process.argv.includes('--preview')) {
    writeFileSync(join(OUT, 'sheet.svg'), previewSheet());
    writeFileSync(join(OUT, 'construction.svg'), constructionSvg());
  }
  console.log('wrote', Object.keys(files).length, 'files to', OUT);
  const g = markGeom(); console.log('mark bbox', g.bbox, 'dot', g.dot);
  const w = wordmarkGeom(); console.log('wordmark', { width: w.width, top: w.top, height: w.height });
}
