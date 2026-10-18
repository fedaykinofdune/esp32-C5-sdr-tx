// SPDX-License-Identifier: GPL-3.0-or-later
//
// Canvas plots: spectrum, I/Q traces, constellation and a waterfall. Colours come from the
// page's CSS custom properties so both themes read.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  // The CSS height stays the markup's height attribute: the backing store must not resize it.
  if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute("height") || "200";
  const square = canvas.classList.contains("square");
  if (!square) canvas.style.height = `${canvas.dataset.h}px`;
  const w = Math.max(50, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(50, Math.round((square ? canvas.clientWidth : +canvas.dataset.h) * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { ctx, w, h, dpr };
}

function frame(ctx, w, h, dpr) {
  ctx.fillStyle = css("--plot-bg");
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${11 * dpr}px ${css("--mono")}`;
  ctx.lineWidth = 1 * dpr;
}

function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// db: FFT-shifted power in dB over [-fs/2, fs/2); opts: ref, range, markers [{hz, label}], band [lo, hi].
export function drawSpectrum(canvas, db, fs, opts = {}) {
  const { ctx, w, h, dpr } = fit(canvas);
  frame(ctx, w, h, dpr);
  const ref = opts.ref ?? 0, range = opts.range ?? 100, padL = 44 * dpr, padB = 18 * dpr, pw = w - padL - 6 * dpr, ph = h - padB - 6 * dpr;
  const x = (hz) => padL + ((hz + fs / 2) / fs) * pw;
  const y = (d) => 6 * dpr + ((ref - d) / range) * ph;
  if (opts.band) {
    ctx.fillStyle = css("--grid");
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x(opts.band[0]), 6 * dpr, x(opts.band[1]) - x(opts.band[0]), ph);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = css("--grid");
  ctx.fillStyle = css("--muted");
  const ds = niceStep(range, 6);
  for (let d = Math.ceil((ref - range) / ds) * ds; d <= ref; d += ds) {
    ctx.beginPath(); ctx.moveTo(padL, y(d)); ctx.lineTo(w, y(d)); ctx.stroke();
    ctx.fillText(`${d}`, 4 * dpr, y(d) + 4 * dpr);
  }
  const fstep = niceStep(fs / 1e6, 8) * 1e6;
  for (let f = Math.ceil(-fs / 2 / fstep) * fstep; f <= fs / 2; f += fstep) {
    ctx.beginPath(); ctx.moveTo(x(f), 6 * dpr); ctx.lineTo(x(f), 6 * dpr + ph); ctx.stroke();
    const t = `${+(f / 1e6).toPrecision(4)}`;
    ctx.fillText(t, x(f) - ctx.measureText(t).width / 2, h - 4 * dpr);
  }
  if (!db || !db.length) return;
  const n = db.length;
  const trace = (arr, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    // One vertical span per pixel column, so peaks survive decimation.
    const cols = Math.floor(pw);
    for (let c = 0; c < cols; c++) {
      const a = Math.floor((c / cols) * n), b = Math.max(a + 1, Math.floor(((c + 1) / cols) * n));
      let mx = -1e9, mn = 1e9;
      for (let k = a; k < b; k++) { mx = Math.max(mx, arr[k]); mn = Math.min(mn, arr[k]); }
      const px = padL + c;
      ctx.moveTo(px, Math.max(6 * dpr, Math.min(6 * dpr + ph, y(mx))));
      ctx.lineTo(px, Math.max(6 * dpr, Math.min(6 * dpr + ph, y(mn))) + 0.5);
    }
    ctx.stroke();
  };
  if (opts.hold) trace(opts.hold, css("--muted"));
  trace(db, css("--trace"));
  for (const m of opts.markers || []) {
    ctx.fillStyle = css("--warn");
    const px = x(m.hz), py = y(m.db);
    ctx.beginPath(); ctx.moveTo(px, py - 2 * dpr); ctx.lineTo(px - 5 * dpr, py - 10 * dpr); ctx.lineTo(px + 5 * dpr, py - 10 * dpr); ctx.fill();
    ctx.fillText(m.label, Math.min(px + 6 * dpr, w - ctx.measureText(m.label).width - 4 * dpr), Math.max(py - 4 * dpr, 16 * dpr));
  }
}

export function drawIQ(canvas, i, q, count = 600, full = 1) {
  const { ctx, w, h, dpr } = fit(canvas);
  frame(ctx, w, h, dpr);
  ctx.strokeStyle = css("--grid");
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  if (!i || !i.length) return;
  const n = Math.min(count, i.length);
  let peak = full;
  if (!full) { peak = 1e-9; for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(i[k]), Math.abs(q[k])); }
  const sy = (v) => h / 2 - (v / peak) * (h / 2 - 6 * dpr);
  for (const [arr, col] of [[i, css("--trace-i")], [q, css("--trace-q")]]) {
    ctx.strokeStyle = col; ctx.lineWidth = 1.2 * dpr; ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const px = (k / (n - 1)) * w;
      k ? ctx.lineTo(px, sy(arr[k])) : ctx.moveTo(px, sy(arr[k]));
    }
    ctx.stroke();
  }
  ctx.fillStyle = css("--trace-i"); ctx.fillText("I", 6 * dpr, 14 * dpr);
  ctx.fillStyle = css("--trace-q"); ctx.fillText("Q", 18 * dpr, 14 * dpr);
}

export function drawConst(canvas, pts, { full = 0, alpha = 0.6 } = {}) {
  const { ctx, w, h, dpr } = fit(canvas);
  frame(ctx, w, h, dpr);
  ctx.strokeStyle = css("--grid");
  ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  if (!pts || !pts.length) return;
  let peak = full;
  if (!full) { peak = 1e-9; for (const [a, b] of pts) peak = Math.max(peak, Math.abs(a), Math.abs(b)); peak *= 1.15; }
  ctx.fillStyle = css("--trace");
  ctx.globalAlpha = alpha;
  const r = dpr * (pts.length > 2000 ? 1.5 : pts.length > 200 ? 2.5 : 5);
  for (const [a, b] of pts) ctx.fillRect(w / 2 + (a / peak) * (w / 2) - r / 2, h / 2 - (b / peak) * (h / 2) - r / 2, r, r);
  ctx.globalAlpha = 1;
}

// Waterfall: push one spectrum row (dB) at the top, older rows scroll down.
export class Waterfall {
  constructor(canvas) { this.canvas = canvas; }
  push(db, ref, range) {
    const { ctx, w, h } = fit(this.canvas);
    if (this.w !== w || this.h !== h) { this.w = w; this.h = h; ctx.fillStyle = css("--plot-bg"); ctx.fillRect(0, 0, w, h); }
    const row = Math.max(2, Math.round(h / 120));
    ctx.drawImage(this.canvas, 0, 0, w, h - row, 0, row, w, h - row);
    const img = ctx.createImageData(w, 1), n = db.length;
    for (let c = 0; c < w; c++) {
      const a = Math.floor((c / w) * n), b = Math.max(a + 1, Math.floor(((c + 1) / w) * n));
      let mx = -1e9;
      for (let k = a; k < b; k++) mx = Math.max(mx, db[k]);
      const [r, g, bl] = heat((mx - (ref - range)) / range);
      img.data.set([r, g, bl, 255], 4 * c);
    }
    for (let k = 0; k < row; k++) ctx.putImageData(img, 0, k);
  }
}

function heat(t) {
  t = Math.max(0, Math.min(1, t));
  // Dark blue, teal, green, yellow, white.
  const stops = [[8, 12, 30], [16, 70, 120], [20, 160, 130], [130, 220, 80], [250, 240, 120], [255, 255, 255]];
  const x = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
  return stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * f));
}
