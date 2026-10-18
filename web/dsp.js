// SPDX-License-Identifier: GPL-3.0-or-later
//
// Waveform generators and the bits of DSP the playground needs in the browser. Every
// generator returns one period of a complex baseband signal (Float32Array i, q, peak 1)
// that the DAC engine or the paced path loops seamlessly, so frequencies are snapped to
// whole cycles in the period (bins of fs / n) and modulations wrap circularly.

export const TAU = 2 * Math.PI;

// --- FFT (radix 2, in place) -------------------------------------------------------------

export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? TAU : -TAU) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let k = 0; k < n; k++) { re[k] /= n; im[k] /= n; }
}

export const pow2Floor = (n) => 2 ** Math.floor(Math.log2(Math.max(1, n)));

// Power spectrum in dB (FFT-shifted, DC in the middle) of the first pow2 samples, Hann
// windowed, normalized so a full-scale tone reads 0 dB.
export function spectrum(i, q, fullScale = 1, size = 0) {
  const n = size || Math.min(pow2Floor(i.length), 16384);
  const re = new Float64Array(n), im = new Float64Array(n);
  let wsum = 0;
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos((TAU * k) / n);
    re[k] = (i[k % i.length] / fullScale) * w;
    im[k] = (q[k % q.length] / fullScale) * w;
    wsum += w;
  }
  fft(re, im);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) / (wsum * wsum);
    out[(k + n / 2) % n] = 10 * Math.log10(p + 1e-20);
  }
  return out;
}

// --- Random numbers (seeded, so a waveform is reproducible) -------------------------------

export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// --- Constellations -----------------------------------------------------------------------

export function constellation(kind) {
  const pts = [];
  const psk = (m, rot = 0) => {
    for (let k = 0; k < m; k++) pts.push([Math.cos((TAU * k) / m + rot), Math.sin((TAU * k) / m + rot)]);
  };
  const qam = (m) => {
    const s = Math.round(Math.sqrt(m));
    for (let a = 0; a < s; a++) for (let b = 0; b < s; b++) pts.push([2 * a - s + 1, 2 * b - s + 1]);
  };
  switch (kind) {
    case "bpsk": psk(2); break;
    case "qpsk": psk(4, Math.PI / 4); break;
    case "8psk": psk(8); break;
    case "16qam": qam(16); break;
    case "64qam": qam(64); break;
    case "256qam": qam(256); break;
    default: psk(4, Math.PI / 4);
  }
  const rms = Math.sqrt(pts.reduce((s, [x, y]) => s + x * x + y * y, 0) / pts.length);
  return pts.map(([x, y]) => [x / rms, y / rms]);
}

// Root raised cosine taps, span symbols either side, sps samples per symbol.
function rrc(beta, sps, span) {
  const n = 2 * span * sps + 1, h = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const t = (k - span * sps) / sps;
    let v;
    if (Math.abs(t) < 1e-9) v = 1 - beta + (4 * beta) / Math.PI;
    else if (beta > 0 && Math.abs(Math.abs(t) - 1 / (4 * beta)) < 1e-9)
      v = (beta / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
    else
      v = (Math.sin(Math.PI * t * (1 - beta)) + 4 * beta * t * Math.cos(Math.PI * t * (1 + beta))) /
        (Math.PI * t * (1 - (4 * beta * t) ** 2));
    h[k] = v;
  }
  return h;
}

// --- Generators ---------------------------------------------------------------------------

const snap = (hz, fs, n) => Math.round((hz * n) / fs);

function finish(i, q, info) {
  let peak = 1e-12;
  for (let k = 0; k < i.length; k++) peak = Math.max(peak, Math.abs(i[k]), Math.abs(q[k]));
  for (let k = 0; k < i.length; k++) { i[k] /= peak; q[k] /= peak; }
  let p = 0;
  for (let k = 0; k < i.length; k++) p += i[k] * i[k] + q[k] * q[k];
  info.papr = 10 * Math.log10(2 / (p / i.length + 1e-20));
  return { i, q, n: i.length, ...info };
}

function tones(fs, n, list) {
  // list: [{hz, amp, phase}]
  const i = new Float32Array(n), q = new Float32Array(n);
  const actual = [];
  for (const t of list) {
    const k = snap(t.hz, fs, n);
    actual.push((k * fs) / n);
    for (let s = 0; s < n; s++) {
      const ph = (TAU * ((k * s) % n)) / n + (t.phase || 0);
      i[s] += t.amp * Math.cos(ph);
      q[s] += t.amp * Math.sin(ph);
    }
  }
  return { i, q, actual };
}

export const GENERATORS = {
  tone: {
    label: "CW tone",
    params: [{ id: "hz", label: "Offset (Hz)", value: 1e6 }],
    make(fs, nmax, p) {
      const n = nmax;
      const t = tones(fs, n, [{ hz: p.hz, amp: 1 }]);
      return finish(t.i, t.q, { note: `tone at ${fmtHz(t.actual[0])}` });
    },
  },
  twotone: {
    label: "Two-tone (IMD)",
    params: [
      { id: "hz", label: "Centre (Hz)", value: 2e6 },
      { id: "sep", label: "Spacing (Hz)", value: 200e3 },
    ],
    make(fs, nmax, p) {
      const t = tones(fs, nmax, [
        { hz: p.hz - p.sep / 2, amp: 1 },
        { hz: p.hz + p.sep / 2, amp: 1 },
      ]);
      return finish(t.i, t.q, { note: `tones at ${t.actual.map(fmtHz).join(", ")}; IM3 lands at centre ± 1.5 × spacing` });
    },
  },
  comb: {
    label: "Multitone comb",
    params: [
      { id: "count", label: "Tones", value: 16 },
      { id: "sep", label: "Spacing (Hz)", value: 500e3 },
      { id: "hz", label: "Centre (Hz)", value: 0 },
    ],
    make(fs, nmax, p) {
      const m = Math.max(1, Math.round(p.count)), list = [];
      for (let k = 0; k < m; k++) {
        // Newman phases keep the crest factor down.
        list.push({ hz: p.hz + (k - (m - 1) / 2) * p.sep, amp: 1, phase: (Math.PI * k * k) / m });
      }
      const t = tones(fs, nmax, list);
      return finish(t.i, t.q, { note: `${m} tones, ${fmtHz(t.actual[1] - t.actual[0] || 0)} apart` });
    },
  },
  am: {
    label: "AM (tone)",
    params: [
      { id: "hz", label: "Carrier offset (Hz)", value: 1e6 },
      { id: "fm", label: "Mod frequency (Hz)", value: 10e3 },
      { id: "depth", label: "Depth (0..1)", value: 0.8 },
    ],
    make(fs, n, p) {
      const kc = snap(p.hz, fs, n), km = Math.max(1, snap(p.fm, fs, n));
      const i = new Float32Array(n), q = new Float32Array(n);
      for (let s = 0; s < n; s++) {
        const a = 1 + p.depth * Math.cos((TAU * ((km * s) % n)) / n);
        const ph = (TAU * ((kc * s) % n)) / n;
        i[s] = a * Math.cos(ph); q[s] = a * Math.sin(ph);
      }
      return finish(i, q, { note: `carrier ${fmtHz((kc * fs) / n)}, mod ${fmtHz((km * fs) / n)}` });
    },
  },
  fm: {
    label: "FM (tone)",
    params: [
      { id: "hz", label: "Carrier offset (Hz)", value: 1e6 },
      { id: "fm", label: "Mod frequency (Hz)", value: 10e3 },
      { id: "dev", label: "Deviation (Hz)", value: 75e3 },
    ],
    make(fs, n, p) {
      const kc = snap(p.hz, fs, n), km = Math.max(1, snap(p.fm, fs, n));
      const fmA = (km * fs) / n, beta = p.dev / fmA;
      const i = new Float32Array(n), q = new Float32Array(n);
      for (let s = 0; s < n; s++) {
        const ph = (TAU * ((kc * s) % n)) / n + beta * Math.sin((TAU * ((km * s) % n)) / n);
        i[s] = Math.cos(ph); q[s] = Math.sin(ph);
      }
      return finish(i, q, { note: `β = ${beta.toFixed(2)}, Carson BW ≈ ${fmtHz(2 * (p.dev + fmA))}` });
    },
  },
  chirp: {
    label: "Linear chirp",
    params: [
      { id: "f0", label: "Start (Hz)", value: -5e6 },
      { id: "f1", label: "Stop (Hz)", value: 5e6 },
      { id: "updown", label: "Up-down (0/1)", value: 0 },
    ],
    make(fs, n, p) {
      const i = new Float32Array(n), q = new Float32Array(n);
      let ph = 0;
      for (let s = 0; s < n; s++) {
        let x = s / n;
        if (p.updown >= 0.5) x = x < 0.5 ? 2 * x : 2 - 2 * x;
        const f = p.f0 + (p.f1 - p.f0) * x;
        i[s] = Math.cos(ph); q[s] = Math.sin(ph);
        ph += (TAU * f) / fs;
      }
      return finish(i, q, { note: `sweep ${fmtHz(p.f0)} → ${fmtHz(p.f1)} every ${fmtTime(n / fs)}` });
    },
  },
  noise: {
    label: "Band-limited noise",
    params: [
      { id: "bw", label: "Bandwidth (Hz)", value: 10e6 },
      { id: "hz", label: "Centre (Hz)", value: 0 },
      { id: "seed", label: "Seed", value: 1 },
    ],
    pow2: true,
    make(fs, nmax, p) {
      const n = pow2Floor(nmax), re = new Float64Array(n), im = new Float64Array(n), r = rng(p.seed);
      const kc = snap(p.hz, fs, n), half = Math.max(0, Math.round((p.bw / fs) * n / 2));
      for (let k = -half; k <= half; k++) {
        const b = (((kc + k) % n) + n) % n, ph = TAU * r();
        re[b] = Math.cos(ph); im[b] = Math.sin(ph);
      }
      fft(re, im, true);
      return finish(Float32Array.from(re), Float32Array.from(im), { note: `${2 * half + 1} random-phase bins, flat in band` });
    },
  },
  qam: {
    label: "PSK / QAM (RRC)",
    params: [
      { id: "mod", label: "Modulation", value: "qpsk", options: ["bpsk", "qpsk", "8psk", "16qam", "64qam", "256qam"] },
      { id: "rs", label: "Symbol rate (Bd)", value: 1e6 },
      { id: "beta", label: "RRC roll-off", value: 0.35 },
      { id: "hz", label: "Centre (Hz)", value: 0 },
      { id: "seed", label: "Seed", value: 1 },
    ],
    make(fs, nmax, p) {
      const sps = Math.max(2, Math.round(fs / p.rs)), nsym = Math.max(8, Math.floor(nmax / sps));
      const n = nsym * sps, pts = constellation(p.mod), r = rng(p.seed);
      const sym = Array.from({ length: nsym }, () => pts[Math.floor(r() * pts.length)]);
      const h = rrc(p.beta, sps, 6), half = (h.length - 1) / 2;
      const i = new Float32Array(n), q = new Float32Array(n);
      // Circular pulse shaping: the period wraps without a seam.
      for (let s = 0; s < nsym; s++) {
        const [a, b] = sym[s];
        for (let t = 0; t < h.length; t++) {
          const idx = (((s * sps + t - half) % n) + n) % n;
          i[idx] += a * h[t]; q[idx] += b * h[t];
        }
      }
      const kc = snap(p.hz, fs, n);
      if (kc) mix(i, q, kc, n);
      return finish(i, q, {
        note: `${nsym} symbols at ${fmtHz(fs / sps).replace("Hz", "Bd")}, ${sps} samples each, occupied ≈ ${fmtHz((fs / sps) * (1 + p.beta))}`,
        symbols: sym,
      });
    },
  },
  fsk: {
    label: "FSK (CPFSK)",
    params: [
      { id: "levels", label: "Levels (2/4)", value: 2 },
      { id: "rs", label: "Symbol rate (Bd)", value: 100e3 },
      { id: "dev", label: "Deviation (Hz)", value: 50e3 },
      { id: "hz", label: "Centre (Hz)", value: 0 },
      { id: "seed", label: "Seed", value: 1 },
    ],
    make(fs, nmax, p) {
      const m = p.levels >= 3 ? 4 : 2;
      const sps = Math.max(2, Math.round(fs / p.rs)), nsym = Math.max(8, Math.floor(nmax / sps)), n = nsym * sps;
      const r = rng(p.seed), freq = new Float64Array(n);
      for (let s = 0; s < nsym; s++) {
        const lvl = Math.floor(r() * m), f = p.dev * (m === 2 ? 2 * lvl - 1 : (2 * lvl - 3) / 3);
        for (let t = 0; t < sps; t++) freq[s * sps + t] = f;
      }
      // Pull the mean so the phase closes on a whole turn: no step at the wrap.
      let total = 0;
      for (let s = 0; s < n; s++) total += freq[s];
      const kc = snap(p.hz + total / n, fs, n), corr = (kc * fs) / n - total / n;
      const i = new Float32Array(n), q = new Float32Array(n);
      let ph = 0;
      for (let s = 0; s < n; s++) {
        i[s] = Math.cos(ph); q[s] = Math.sin(ph);
        ph += (TAU * (freq[s] + corr)) / fs;
      }
      return finish(i, q, { note: `${m}-FSK, ${nsym} symbols, h = ${((2 * p.dev) / (fs / sps)).toFixed(2)}` });
    },
  },
  ofdm: {
    label: "OFDM symbols",
    params: [
      { id: "fft", label: "FFT size", value: 256, options: [64, 128, 256, 512, 1024] },
      { id: "used", label: "Used subcarriers", value: 100 },
      { id: "cp", label: "Cyclic prefix", value: 32 },
      { id: "mod", label: "Subcarrier mod", value: "qpsk", options: ["bpsk", "qpsk", "16qam", "64qam"] },
      { id: "seed", label: "Seed", value: 1 },
    ],
    make(fs, nmax, p) {
      const nfft = Math.round(p.fft), cp = Math.min(Math.round(p.cp), nfft), used = Math.min(Math.round(p.used), nfft - 2);
      const nsym = Math.max(1, Math.floor(nmax / (nfft + cp))), n = nsym * (nfft + cp);
      const pts = constellation(p.mod), r = rng(p.seed);
      const i = new Float32Array(n), q = new Float32Array(n), syms = [];
      for (let s = 0; s < nsym; s++) {
        const re = new Float64Array(nfft), im = new Float64Array(nfft);
        for (let k = 1; k <= used; k++) {
          // Carriers either side of DC, DC itself left empty (LO leakage sits there).
          const bin = k <= used / 2 ? k : nfft - (k - Math.floor(used / 2));
          const [a, b] = pts[Math.floor(r() * pts.length)];
          re[bin] = a; im[bin] = b;
          if (syms.length < 2000) syms.push([a, b]);
        }
        fft(re, im, true);
        const base = s * (nfft + cp);
        for (let t = 0; t < nfft + cp; t++) {
          const src = (t - cp + nfft) % nfft;
          i[base + t] = re[src]; q[base + t] = im[src];
        }
      }
      return finish(i, q, {
        note: `${nsym} symbols, ${used} carriers ${fmtHz(fs / nfft)} apart, ${fmtHz((used + 1) * fs / nfft)} wide`,
        symbols: syms,
      });
    },
  },
  file: {
    label: "Custom file (I/Q)",
    params: [{ id: "format", label: "Format", value: "cf32", options: ["cf32", "cs16", "cs8", "cu8", "csv"] }],
    file: true,
    make(fs, nmax, p, file) {
      if (!file) throw new Error("pick a file first");
      const { i, q } = parseIq(file, p.format, nmax);
      return finish(i, q, { note: `${i.length} samples from file, played at ${fmtHz(fs).replace("Hz", "S/s")}` });
    },
  },
};

function mix(i, q, k, n) {
  for (let s = 0; s < n; s++) {
    const ph = (TAU * ((k * s) % n)) / n, c = Math.cos(ph), d = Math.sin(ph);
    const a = i[s], b = q[s];
    i[s] = a * c - b * d; q[s] = a * d + b * c;
  }
}

export function parseIq(buf, format, nmax) {
  let vals;
  if (format === "csv") {
    const txt = new TextDecoder().decode(buf);
    vals = txt.split(/[\s,;]+/).filter(Boolean).map(Number);
  } else if (format === "cf32") vals = Array.from(new Float32Array(buf.slice(0, buf.byteLength - (buf.byteLength % 8))));
  else if (format === "cs16") vals = Array.from(new Int16Array(buf.slice(0, buf.byteLength - (buf.byteLength % 4))));
  else if (format === "cs8") vals = Array.from(new Int8Array(buf));
  else vals = Array.from(new Uint8Array(buf), (v) => v - 127.5);
  const n = Math.min(nmax, Math.floor(vals.length / 2));
  if (n < 1) throw new Error("no samples in file");
  const i = new Float32Array(n), q = new Float32Array(n);
  for (let k = 0; k < n; k++) { i[k] = vals[2 * k]; q[k] = vals[2 * k + 1]; }
  return { i, q };
}

// --- Words for the device -----------------------------------------------------------------

// DAC engine words: I in bits 9:0, Q in bits 19:10, ±511.
export function replayWords(w, amp) {
  const out = new Uint32Array(w.n);
  for (let k = 0; k < w.n; k++) {
    const a = clamp(Math.round(w.i[k] * amp), -511, 511), b = clamp(Math.round(w.q[k] * amp), -511, 511);
    out[k] = ((a & 0x3ff) | ((b & 0x3ff) << 10)) >>> 0;
  }
  return out;
}

// Paced words: I in bits 15:0, Q in bits 31:16, ±32767.
export function pacedWords(w, amp) {
  const out = new Uint32Array(w.n);
  for (let k = 0; k < w.n; k++) {
    const a = clamp(Math.round(w.i[k] * amp), -32767, 32767), b = clamp(Math.round(w.q[k] * amp), -32767, 32767);
    out[k] = ((a & 0xffff) | ((b & 0xffff) << 16)) >>> 0;
  }
  return out;
}

// Receive words (probe rx): Q in bits 9:0, I in bits 19:10, signed.
export function decodeRxWords(bytes) {
  const n = Math.floor(bytes.length / 4), dv = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
  const i = new Float32Array(n), q = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const w = dv.getUint32(4 * k, true);
    let a = (w >> 10) & 0x3ff, b = w & 0x3ff;
    if (a >= 512) a -= 1024;
    if (b >= 512) b -= 1024;
    i[k] = a; q[k] = b;
  }
  return { i, q };
}

// int16 pairs (probe diag iq).
export function decodeInt16Pairs(bytes) {
  const n = Math.floor(bytes.length / 4), dv = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
  const i = new Float32Array(n), q = new Float32Array(n);
  for (let k = 0; k < n; k++) { i[k] = dv.getInt16(4 * k, true); q[k] = dv.getInt16(4 * k + 2, true); }
  return { i, q };
}

export function crc32(u8) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < u8.length; n++) {
    c = (crc ^ u8[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function b64(u8) {
  let s = "";
  for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
  return btoa(s);
}

export function unb64(str) {
  const s = atob(str), out = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) out[k] = s.charCodeAt(k);
  return out;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function fmtHz(hz) {
  const a = Math.abs(hz);
  if (a >= 1e9) return `${(hz / 1e9).toFixed(4).replace(/\.?0+$/, "")} GHz`;
  if (a >= 1e6) return `${(hz / 1e6).toFixed(4).replace(/\.?0+$/, "")} MHz`;
  if (a >= 1e3) return `${(hz / 1e3).toFixed(3).replace(/\.?0+$/, "")} kHz`;
  return `${hz.toFixed(1).replace(/\.0$/, "")} Hz`;
}

export function fmtTime(s) {
  if (s >= 1) return `${s.toFixed(3)} s`;
  if (s >= 1e-3) return `${(s * 1e3).toFixed(3)} ms`;
  return `${(s * 1e6).toFixed(2)} µs`;
}
