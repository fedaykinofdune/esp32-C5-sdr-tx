// SPDX-License-Identifier: GPL-3.0-or-later
//
// The playground page: up to two boards (A, B) on Web Serial, a transmit bench that builds
// waveforms here and loops them on the board, a receiver view, spectrum painting, a shell
// console and the flasher.

import { Board, kv, sleep } from "./serial.js";
import * as dsp from "./dsp.js";
import { drawSpectrum, drawIQ, drawConst, Waterfall } from "./plots.js";
import { loadManifest, fetchImage, flash, eraseFlash } from "./flasher.js";

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const VID_ESPRESSIF = 0x303a;
const CHUNK_WORDS = 192;

const boards = { A: null, B: null };
const logs = { A: [], B: [] };
const uploaded = { A: null, B: null }; // crc and length of the buffer on each board

// ------------------------------------------------------------------------------ helpers

function setRes(el, text, kind = "") {
  el.textContent = text;
  el.className = `res ${kind}`;
}

function num(id) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : 0;
}

function board(sel) {
  const b = boards[$(sel).value];
  if (!b || !b.open) throw new Error(`board ${$(sel).value} is not connected`);
  return b;
}

const safe = () => $("safeAck").checked;

function guard(btn, fn) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; syncLocks(); }
  });
}

// ------------------------------------------------------------------------------ tabs

$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".tab").forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === "tx") renderPreview();
    if (b.dataset.tab === "paint") drawPaint();
    if (b.dataset.tab === "console") renderLog();
  }),
);

if (!("serial" in navigator)) $("nosupport").hidden = false;

// ------------------------------------------------------------------------------ devices

function slotEl(slot) {
  return document.querySelector(`.dev[data-slot="${slot}"]`);
}

function refreshDevices() {
  for (const slot of ["A", "B"]) {
    const el = slotEl(slot), b = boards[slot];
    el.classList.toggle("on", !!b?.open);
    const btn = el.querySelector("button");
    btn.textContent = b?.open ? "Disconnect" : "Connect";
    if (b?.open && b.info) {
      el.querySelector(".label").textContent = b.info.version
        ? `${b.info.app} ${b.info.version} · ${b.info.board?.split("/")[0]} · ${b.freq ?? b.info.freq} MHz`
        : b.info.app;
    } else if (!b?.open) el.querySelector(".label").textContent = "not connected";
  }
  for (const sel of $$(".devsel")) {
    const keep = sel.value;
    sel.innerHTML = "";
    for (const slot of ["A", "B"]) {
      const o = document.createElement("option");
      o.value = slot;
      o.textContent = `Board ${slot}${boards[slot]?.open ? "" : " (offline)"}`;
      sel.append(o);
    }
    sel.value = keep || (sel.id === "rxDev" && boards.B?.open ? "B" : "A");
  }
}

function logLine(slot, text, kind) {
  const l = logs[slot];
  l.push([text, kind]);
  if (l.length > 3000) l.splice(0, l.length - 3000);
  if ($("coDev").value === slot && !$("tab-console").hidden) appendLog(text, kind);
}

function appendLog(text, kind) {
  const el = $("coLog"), span = document.createElement("span");
  span.className = kind || "";
  span.textContent = text + "\n";
  el.append(span);
  if (el.childNodes.length > 3000) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

function renderLog() {
  $("coLog").textContent = "";
  for (const [t, k] of logs[$("coDev").value].slice(-1500)) appendLog(t, k);
}

async function connect(slot) {
  if (boards[slot]?.open) {
    await boards[slot].close();
    boards[slot] = null;
    refreshDevices();
    return;
  }
  const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID_ESPRESSIF }] });
  for (const s of ["A", "B"]) if (boards[s]?.port === port && boards[s].open) throw new Error(`that port is board ${s}`);
  const el = slotEl(slot);
  const b = new Board(port, {
    onLine: (t, k) => logLine(slot, t, k),
    onState: (s) => {
      el.classList.toggle("busy", s !== "ready" && s !== "closed");
      if (s === "closed") { boards[slot] = null; refreshDevices(); }
      else el.querySelector(".label").textContent = s;
    },
  });
  boards[slot] = b;
  uploaded[slot] = null;
  await b.connect();
  b.freq = b.info.freq;
  refreshDevices();
  if (!b.info.version) logLine(slot, "! no playground firmware answered: flash it from the Flash tab", "err");
}

$$(".dev button").forEach((btn) =>
  btn.addEventListener("click", async () => {
    const slot = btn.closest(".dev").dataset.slot;
    btn.disabled = true;
    try { await connect(slot); } catch (e) {
      if (e.name !== "NotFoundError") alert(`Board ${slot}: ${e.message}`);
      if (boards[slot] && !boards[slot].info) { await boards[slot].close(); boards[slot] = null; }
      refreshDevices();
    } finally { btn.disabled = false; }
  }),
);

navigator.serial?.addEventListener("disconnect", (ev) => {
  for (const s of ["A", "B"]) if (boards[s]?.port === ev.target) { boards[s].open = false; boards[s] = null; }
  refreshDevices();
});

async function stopTx(b) {
  await b.cmd("wave stop", { timeout: 6000 }).catch(() => {});
  await b.cmd("probe tx stop", { timeout: 6000 }).catch(() => {});
}

$("killAll").addEventListener("click", async () => {
  rxRunning = false;
  for (const s of ["A", "B"]) if (boards[s]?.open) await stopTx(boards[s]);
  setRes($("txRes"), "All transmitters off.", "ok");
});

// ------------------------------------------------------------------------------ safety lock

function syncLocks() {
  $("safety").classList.toggle("ok", safe());
  $("txGo").disabled = !safe();
  $("ptGo").disabled = !safe();
}
$("safeAck").addEventListener("change", () => {
  syncLocks();
  setRes($("txRes"), safe() ? "Ready. Pick a board, a waveform, then Transmit." : "Tick the conducted-setup box to unlock transmit.");
});

// ------------------------------------------------------------------------------ tuning

async function tune(b, mhz, out) {
  const r = await b.cmd(`probe f ${Math.round(mhz)}`);
  const m = r.match(/f (-?\d+) ret (-?\d+)/);
  if (!m) return setRes(out, r || "no reply", "err");
  const ret = +m[2];
  b.freq = +m[1];
  refreshDevices();
  setRes(out, ret === 0 ? `${m[1]} MHz` : ret === -34 ? `${m[1]} MHz, -ERANGE (VCO outside its window)` : `ret ${ret}`, ret === 0 ? "ok" : "err");
}

guard($("txTune"), async () => { try { await tune(board("txDev"), num("txFreq"), $("txTuneRes")); } catch (e) { setRes($("txTuneRes"), e.message, "err"); } });
guard($("rxTune"), async () => { try { await tune(board("rxDev"), num("rxFreq"), $("rxTuneRes")); } catch (e) { setRes($("rxTuneRes"), e.message, "err"); } });
guard($("txRaw"), async () => {
  try {
    const r = await board("txDev").cmd(`probe raw ${Math.round(num("txRawMhz"))} ${Math.round(num("txRawKhz"))}`);
    setRes($("txTuneRes"), r.trim(), "ok");
  } catch (e) { setRes($("txTuneRes"), e.message, "err"); }
});
guard($("txCbwSet"), async () => {
  try { setRes($("txTuneRes"), (await board("txDev").cmd(`probe cbw ${$("txCbw").value}`)).trim()); } catch (e) { setRes($("txTuneRes"), e.message, "err"); }
});
guard($("txLpfSet"), async () => {
  try {
    // The command sets the receive code too: keep the Receive tab's.
    const r = await board("txDev").cmd(`probe lpf ${Math.round(num("rxLpf"))} ${Math.round(num("txLpfA"))} ${Math.round(num("txLpfB"))}`);
    setRes($("txTuneRes"), r.trim());
  } catch (e) { setRes($("txTuneRes"), e.message, "err"); }
});

// ------------------------------------------------------------------------------ transmit: engine and generator

let engine = "r40";
const segInit = (id, cb) =>
  $$(`#${id} button`).forEach((b) =>
    b.addEventListener("click", () => {
      $$(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b));
      cb(b.dataset.v);
    }),
  );

segInit("txEngine", (v) => {
  engine = v;
  $$(".eng").forEach((e) => (e.hidden = e.dataset.eng !== (v.startsWith("r") ? "replay" : v)));
  $("genCard").hidden = v === "carrier";
  renderPreview();
});

$("rpMode").addEventListener("change", () => {
  const card = $("rpMode").closest(".eng");
  card.classList.toggle("mode-burst", $("rpMode").value === "burst");
  card.classList.toggle("mode-pulse", $("rpMode").value === "pulse");
});

const genSel = $("genSel");
for (const [id, g] of Object.entries(dsp.GENERATORS)) {
  const o = document.createElement("option");
  o.value = id; o.textContent = g.label;
  genSel.append(o);
}
let genFile = null;
$("genFile").addEventListener("change", async () => {
  genFile = $("genFile").files[0] ? await $("genFile").files[0].arrayBuffer() : null;
  const ext = $("genFile").files[0]?.name.split(".").pop().toLowerCase();
  const fmt = $("gp-format");
  if (fmt && ["cf32", "cs16", "cs8", "cu8", "csv"].includes(ext)) fmt.value = ext;
  renderPreview();
});

function buildParams() {
  const g = dsp.GENERATORS[genSel.value], box = $("genParams");
  box.innerHTML = "";
  for (const p of g.params) {
    const l = document.createElement("label");
    l.textContent = p.label;
    let input;
    if (p.options) {
      input = document.createElement("select");
      for (const v of p.options) { const o = document.createElement("option"); o.value = v; o.textContent = v; input.append(o); }
      input.value = p.value;
    } else {
      input = document.createElement("input");
      input.type = "number"; input.value = p.value; input.step = "any";
    }
    input.id = `gp-${p.id}`;
    input.addEventListener("input", renderPreviewSoon);
    l.append(input);
    box.append(l);
  }
  $("genFileRow").hidden = !g.file;
  renderPreview();
}
genSel.addEventListener("change", buildParams);
for (const id of ["rpN", "rpAmp", "rpScale", "pcRate", "pcInterp", "pcN", "pcAmp", "txCbw"]) $(id).addEventListener("input", renderPreviewSoon);

function engineSpec() {
  if (engine === "paced") {
    const rate = num("pcRate");
    return { kind: "paced", fs: rate, nmax: Math.min(16383, Math.max(16, Math.round(num("pcN")))), amp: dsp.clamp(Math.round(num("pcAmp")), 1, 32767), full: 32767 };
  }
  const fs = engine === "r80" ? 80e6 : 40e6;
  return { kind: "replay", fs, rate: engine === "r80" ? 0 : 1, nmax: Math.min(16383, Math.max(16, Math.round(num("rpN")))), amp: dsp.clamp(Math.round(num("rpAmp")), 1, 511), full: 511 };
}

function makeWave() {
  const spec = engineSpec(), g = dsp.GENERATORS[genSel.value], p = {};
  for (const d of g.params) {
    const el = $(`gp-${d.id}`);
    p[d.id] = d.options && isNaN(+el.value) ? el.value : +el.value;
  }
  const w = g.make(spec.fs, spec.nmax, p, genFile);
  return { spec, w };
}

let previewTimer = 0;
function renderPreviewSoon() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function renderPreview() {
  if ($("tab-tx").hidden) return;
  if (engine === "carrier") {
    drawSpectrum($("pvSpec"), null, 40e6);
    drawIQ($("pvTime"), null, null);
    $("pvConstCard").hidden = true;
    $("pvInfo").textContent = "";
    $("pvNote").textContent = "Carrier: one constant DAC value, the LO itself.";
    return;
  }
  let made;
  try { made = makeWave(); } catch (e) { $("pvNote").textContent = e.message; return; }
  const { spec, w } = made;
  const ia = new Float32Array(w.n), qa = new Float32Array(w.n);
  for (let k = 0; k < w.n; k++) { ia[k] = w.i[k] * spec.amp; qa[k] = w.q[k] * spec.amp; }
  const db = dsp.spectrum(ia, qa, spec.full);
  const bw = $("txCbw").value === "2" ? 18e6 : 10e6;
  drawSpectrum($("pvSpec"), db, spec.fs, { ref: 0, range: 100, band: spec.kind === "replay" ? [-bw, bw] : null });
  drawIQ($("pvTime"), ia, qa, Math.min(w.n, 800), spec.full);
  $("pvConstCard").hidden = !w.symbols;
  if (w.symbols) drawConst($("pvConst"), w.symbols);
  $("pvInfo").textContent = `${w.n} samples · ${dsp.fmtTime(w.n / spec.fs)} period · ${dsp.fmtHz(spec.fs / w.n)} bins · PAPR ${w.papr.toFixed(1)} dB`;
  $("pvNote").textContent = w.note || "";
  if (spec.kind === "replay") {
    const drive = spec.amp * num("rpScale");
    $("rpDrive").textContent = `Drive ${spec.amp} × ${num("rpScale")} = ${drive}${drive > 1000 ? " (above ~1000: the chain compresses)" : ""}. Shaded band: the analog filter's rough passband.`;
  }
}

// ------------------------------------------------------------------------------ transmit: upload and play

async function upload(slot, b, words, bar) {
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.length * 4);
  const crc = dsp.crc32(bytes);
  if (uploaded[slot] && uploaded[slot].crc === crc && uploaded[slot].n === words.length) return crc;
  for (let off = 0; off < words.length; off += CHUNK_WORDS) {
    const n = Math.min(CHUNK_WORDS, words.length - off);
    const r = await b.cmd(`wave put ${off} ${dsp.b64(bytes.subarray(off * 4, (off + n) * 4))}`, { quiet: true });
    if (!new RegExp(`^put ${off} ${n}$`, "m").test(r)) throw new Error(`upload at ${off}: ${r.trim() || "no reply"}`);
    bar.style.width = `${(100 * (off + n)) / words.length}%`;
  }
  const r = await b.cmd(`wave crc ${words.length}`);
  const m = r.match(/crc \d+ ([0-9a-f]{8})/);
  if (!m || parseInt(m[1], 16) !== crc) throw new Error(`CRC mismatch: board ${m?.[1]}, page ${crc.toString(16).padStart(8, "0")}`);
  uploaded[slot] = { crc, n: words.length };
  return crc;
}

guard($("txGo"), async () => {
  const res = $("txRes"), bar = $("txBar");
  bar.style.width = "0";
  try {
    if (!safe()) throw new Error("tick the conducted-setup box first");
    const slot = $("txDev").value, b = board("txDev");
    if (!b.info?.version) throw new Error("this board runs no playground firmware");
    await stopTx(b);
    if (engine === "carrier") {
      const r = await b.cmd(`probe tx carrier ${Math.round(num("crI"))} ${Math.round(num("crQ"))}`);
      return setRes(res, r.trim() || "carrier on", /txdc/.test(r) ? "ok" : "err");
    }
    const { spec, w } = makeWave();
    const words = spec.kind === "paced" ? dsp.pacedWords(w, spec.amp) : dsp.replayWords(w, spec.amp);
    setRes(res, `Uploading ${words.length} words...`);
    await upload(slot, b, words, bar);
    bar.style.width = "100%";
    let r;
    if (spec.kind === "paced") {
      const ms = dsp.clamp(Math.round(num("pcMs")), 1, 60000);
      setRes(res, `Paced TX for ${ms} ms (the board's shell is busy meanwhile)...`);
      r = await b.cmd(`wave paced ${words.length} ${spec.fs} ${ms} ${$("pcInterp").value}`, { timeout: ms + 8000 });
    } else {
      const scale = dsp.clamp(Math.round(num("rpScale")), 1, 255), mode = $("rpMode").value;
      const passes = dsp.clamp(Math.round(num("rpPasses")), 1, 255);
      if (mode === "loop") r = await b.cmd(`wave play ${words.length} ${spec.rate} 0 ${scale}`);
      else if (mode === "burst") r = await b.cmd(`wave play ${words.length} ${spec.rate} ${passes} ${scale}`, { timeout: 8000 });
      else r = await b.cmd(`wave pulse ${words.length} ${spec.rate} ${passes} ${Math.round(num("rpOff"))} ${scale}`);
    }
    const m = r.match(/ret (-?\d+)/);
    const ok = m && +m[1] === 0;
    setRes(res, ok ? `On air: ${r.trim()}` : `Board said: ${r.trim()}${m && +m[1] === -34 ? " (-ERANGE: frequency outside this path's range)" : ""}`, ok ? "ok" : "err");
  } catch (e) {
    setRes(res, e.message, "err");
  }
});

guard($("txStop"), async () => {
  try { await stopTx(board("txDev")); setRes($("txRes"), "Transmitter off.", "ok"); } catch (e) { setRes($("txRes"), e.message, "err"); }
});

// ------------------------------------------------------------------------------ receive

let rxSrc = "burst", rxRunning = false, rxLast = null, rxHold = null, rxAvgBuf = [];
const wf = new Waterfall($("rxWf"));
segInit("rxSrc", (v) => { rxSrc = v; $$(".src").forEach((e) => (e.hidden = e.dataset.src !== v)); });
$("rxGain").addEventListener("input", () => ($("rxGainV").textContent = $("rxGain").value));
$("rxAvg").addEventListener("change", () => { rxHold = null; rxAvgBuf = []; });

guard($("rxApply"), async () => {
  try {
    const b = board("rxDev");
    const g = await b.cmd(`probe gain ${$("rxAgc").checked ? -1 : $("rxGain").value}`);
    const l = await b.cmd(`probe lpf ${Math.round(num("rxLpf"))}`);
    const mx = g.match(/max (\d+)/);
    if (mx) $("rxGain").max = mx[1];
    setRes($("rxRes"), `${g.trim()} · ${l.trim()}`, "ok");
  } catch (e) { setRes($("rxRes"), e.message, "err"); }
});

function collectB64(out) {
  const parts = out.split("\n").filter((l) => l.startsWith("d ")).map((l) => dsp.unb64(l.slice(2).trim()));
  const total = parts.reduce((s, p) => s + p.length, 0), all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}

async function captureOnce() {
  const b = board("rxDev");
  let i, q, fs, full;
  if (rxSrc === "burst") {
    const n = dsp.clamp(Math.round(num("rxN")), 256, 16380);
    const out = await b.cmd(`probe rx ${n} ${$("rxRate").value}`, { timeout: 30000, quiet: true });
    const m = out.match(/rx n (\d+) f (\d+) fs (\d+) lpf (-?\d+) gain (-?\d+)/);
    if (!m) throw new Error(out.trim().split("\n").pop() || "no capture");
    ({ i, q } = dsp.decodeRxWords(collectB64(out)));
    fs = +m[3]; full = 512;
    b.freq = +m[2];
  } else {
    const out = await b.cmd(`probe diag iq ${Math.round(num("dgR"))} ${Math.round(num("dgPairs"))}`, { timeout: 15000, quiet: true });
    const m = out.match(/iq n (\d+) rate (\d+) lsb (\d+) f (\d+)/);
    if (!m || +m[1] === 0) throw new Error(out.trim().split("\n").slice(-2).join(" ") || "no samples");
    ({ i, q } = dsp.decodeInt16Pairs(collectB64(out)));
    fs = +m[2];
    full = 0;
    for (let k = 0; k < i.length; k++) full = Math.max(full, Math.abs(i[k]), Math.abs(q[k]));
    full = Math.max(full, 1);
  }
  rxLast = { i, q, fs, freq: b.freq };
  let db = dsp.spectrum(i, q, full);
  const mode = $("rxAvg").value;
  if (mode === "peak") {
    rxHold = rxHold && rxHold.length === db.length ? rxHold.map((v, k) => Math.max(v, db[k])) : Float32Array.from(db);
  } else if (+mode > 0) {
    rxAvgBuf.push(db);
    if (rxAvgBuf.length > +mode) rxAvgBuf.shift();
    if (rxAvgBuf.every((x) => x.length === db.length)) {
      const acc = new Float32Array(db.length);
      for (const r of rxAvgBuf) for (let k = 0; k < acc.length; k++) acc[k] += 10 ** (r[k] / 10);
      db = acc.map((v) => 10 * Math.log10(v / rxAvgBuf.length));
    }
  }
  // Strongest bin away from DC (the LO leakage sits there).
  let pk = -1, pv = -1e9;
  const nb = db.length, guardBins = Math.max(2, Math.round(nb / 400));
  for (let k = 0; k < nb; k++) if (Math.abs(k - nb / 2) > guardBins && db[k] > pv) { pv = db[k]; pk = k; }
  const pkHz = ((pk - nb / 2) / nb) * fs;
  const ref = num("rxRef"), range = Math.max(10, num("rxRange"));
  drawSpectrum($("rxSpec"), db, fs, { ref, range, hold: mode === "peak" ? rxHold : null, markers: pk >= 0 ? [{ hz: pkHz, db: pv, label: `${dsp.fmtHz(pkHz)} ${pv.toFixed(1)} dB` }] : [] });
  wf.push(db, ref, range);
  drawIQ($("rxTime"), i, q, 600, 0);
  const pts = [];
  for (let k = 0; k < Math.min(i.length, 4000); k++) pts.push([i[k], q[k]]);
  drawConst($("rxConst"), pts, { alpha: 0.35 });
  let p = 0;
  for (let k = 0; k < i.length; k++) p += i[k] * i[k] + q[k] * q[k];
  const rms = Math.sqrt(p / i.length);
  $("rxPeak").textContent = `${(b.freq || 0)} MHz LO · ${dsp.fmtHz(fs).replace("Hz", "S/s")} · peak ${dsp.fmtHz(pkHz)} (${dsp.fmtHz(b.freq * 1e6 + pkHz)})`;
  setRes($("rxRes"), `${i.length} samples, rms ${rms.toFixed(1)}${rxSrc === "burst" && rms > 300 ? " (near clipping: lower the gain)" : ""}`, "ok");
}

guard($("rxOnce"), async () => { try { await captureOnce(); } catch (e) { setRes($("rxRes"), e.message, "err"); } });

$("rxRun").addEventListener("click", async () => {
  if (rxRunning) { rxRunning = false; return; }
  rxRunning = true;
  $("rxRun").textContent = "Stop";
  $("rxRun").classList.add("primary");
  try {
    while (rxRunning) { await captureOnce(); await sleep(10); }
  } catch (e) { setRes($("rxRes"), e.message, "err"); }
  rxRunning = false;
  $("rxRun").textContent = "Run";
  $("rxRun").classList.remove("primary");
});

$("rxSave").addEventListener("click", () => {
  if (!rxLast) return setRes($("rxRes"), "capture something first", "err");
  const f = new Float32Array(2 * rxLast.i.length);
  for (let k = 0; k < rxLast.i.length; k++) { f[2 * k] = rxLast.i[k] / 512; f[2 * k + 1] = rxLast.q[k] / 512; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([f.buffer], { type: "application/octet-stream" }));
  a.download = `esp-sdr_${rxLast.freq}MHz_${rxLast.fs}sps.cf32`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// ------------------------------------------------------------------------------ paint

let paint = { w: 96, h: 20, px: new Uint8Array(96 * 20) };

function renderText() {
  const w = dsp.clamp(Math.round(num("ptW")), 8, 256), h = dsp.clamp(Math.round(num("ptH")), 4, 128);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle"; ctx.textAlign = "center";
  let size = h;
  ctx.font = `bold ${size}px ${getComputedStyle(document.body).fontFamily}`;
  const text = $("ptText").value || " ";
  while (size > 4 && ctx.measureText(text).width > w - 2) { size--; ctx.font = `bold ${size}px sans-serif`; }
  ctx.fillText(text, w / 2, h / 2 + 1);
  fromCanvas(c);
}

function fromCanvas(c) {
  const w = c.width, h = c.height, d = c.getContext("2d").getImageData(0, 0, w, h).data;
  const px = new Uint8Array(w * h), inv = $("ptInv").checked;
  for (let k = 0; k < w * h; k++) px[k] = (d[4 * k] + d[4 * k + 1] + d[4 * k + 2] > 384) !== inv ? 1 : 0;
  paint = { w, h, px };
  drawPaint();
}

$("ptImg").addEventListener("change", async () => {
  const f = $("ptImg").files[0];
  if (!f) return;
  const img = await createImageBitmap(f);
  const w = dsp.clamp(Math.round(num("ptW")), 8, 256);
  const h = dsp.clamp(Math.round((img.height / img.width) * w), 4, 128);
  $("ptH").value = h;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  fromCanvas(c);
});

$("ptRender").addEventListener("click", renderText);
for (const id of ["ptText", "ptW", "ptH", "ptInv"]) $(id).addEventListener("change", renderText);
for (const id of ["ptN", "ptRate", "ptRow"]) $(id).addEventListener("input", drawPaint);

function drawPaint() {
  const c = $("ptCanvas"), dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  const cell = c.width / paint.w;
  c.height = Math.round(Math.min(cell * paint.h, 520 * dpr));
  c.style.height = `${c.height / dpr}px`;
  const cellY = c.height / paint.h, ctx = c.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue("--plot-bg");
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = css.getPropertyValue("--trace");
  for (let y = 0; y < paint.h; y++)
    for (let x = 0; x < paint.w; x++) if (paint.px[y * paint.w + x]) ctx.fillRect(x * cell, y * cellY, Math.ceil(cell), Math.ceil(cellY));
  const fs = $("ptRate").value === "0" ? 80e6 : 40e6, n = Math.max(1, num("ptN"));
  $("ptInfo").textContent = `${paint.w} × ${paint.h}: columns ${dsp.fmtHz(fs / n)} apart, ${dsp.fmtHz((paint.w * fs) / n)} wide; ${((paint.h * num("ptRow")) / 1000).toFixed(2)} s a pass. Set the receiver's waterfall to about that span.`;
}

$("ptCanvas").addEventListener("click", (ev) => {
  const r = ev.target.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - r.left) / r.width) * paint.w), y = Math.floor(((ev.clientY - r.top) / r.height) * paint.h);
  if (x >= 0 && y >= 0 && x < paint.w && y < paint.h) { paint.px[y * paint.w + x] ^= 1; drawPaint(); }
});

guard($("ptGo"), async () => {
  const res = $("ptRes"), bar = $("ptBar");
  try {
    if (!safe()) throw new Error("tick the conducted-setup box first");
    const b = board("ptDev");
    await stopTx(b);
    let r = await b.cmd(`probe tx paint size ${paint.w} ${paint.h}`);
    if (!/paint size/.test(r)) throw new Error(r.trim());
    for (let y = 0; y < paint.h; y++) {
      let hex = "";
      for (let x = 0; x < paint.w; x += 4) {
        let v = 0;
        for (let k = 0; k < 4; k++) v = (v << 1) | (x + k < paint.w ? paint.px[y * paint.w + x + k] : 0);
        hex += v.toString(16);
      }
      // Rows with nothing set stay as the size command left them: blank.
      if (/[^0]/.test(hex)) await b.cmd(`probe tx paint row ${y} ${hex}`, { quiet: true });
      bar.style.width = `${(100 * (y + 1)) / paint.h}%`;
    }
    const n = dsp.clamp(Math.round(num("ptN")), Math.max(256, paint.w + 1), 15103);
    r = await b.cmd(`probe tx paint run ${Math.round(num("ptRow"))} ${Math.round(num("ptAmp"))} ${$("ptRate").value} ${n} ${Math.round(num("ptScale"))} ${Math.round(num("ptGap"))}`);
    setRes(res, r.trim(), /^paint \d/.test(r.trim()) ? "ok" : "err");
  } catch (e) { setRes(res, e.message, "err"); }
});
guard($("ptStop"), async () => { try { await stopTx(board("ptDev")); setRes($("ptRes"), "Painting stopped.", "ok"); } catch (e) { setRes($("ptRes"), e.message, "err"); } });
guard($("ptState"), async () => { try { setRes($("ptRes"), (await board("ptDev").cmd("probe tx paint state")).trim()); } catch (e) { setRes($("ptRes"), e.message, "err"); } });

// ------------------------------------------------------------------------------ console

$("coDev").addEventListener("change", renderLog);
$("coClear").addEventListener("click", () => { logs[$("coDev").value].length = 0; renderLog(); });
$("coForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const line = $("coIn").value.trim();
  if (!line) return;
  $("coIn").value = "";
  try { await board("coDev").cmd(line, { timeout: 65000 }); } catch (e) { appendLog(`! ${e.message}`, "err"); }
});
$$("[data-q]").forEach((b) => b.addEventListener("click", async () => {
  try { await board("coDev").cmd(b.dataset.q); } catch (e) { appendLog(`! ${e.message}`, "err"); }
}));
$("coReset").addEventListener("click", async () => {
  try {
    const b = board("coDev");
    uploaded[$("coDev").value] = null;
    await b.reset();
    await b.handshake();
    refreshDevices();
  } catch (e) { appendLog(`! ${e.message}`, "err"); }
});

// ------------------------------------------------------------------------------ flash

let builds = [];
async function initBuilds() {
  builds = await loadManifest();
  const box = $("builds");
  box.innerHTML = "";
  if (!builds.length) {
    box.innerHTML = `<p class="muted">No images next to this page (firmware/manifest.json). Pick a local file below, or build one: see Help.</p>`;
    $("fwFile").closest("details").open = true;
    return;
  }
  builds.forEach((b, k) => {
    const l = document.createElement("label");
    l.className = "build";
    l.innerHTML = `<input type="radio" name="build" value="${k}" ${k ? "" : "checked"}><span><b></b><br><span class="meta"></span></span>`;
    l.querySelector("b").textContent = b.name;
    l.querySelector(".meta").textContent = [b.description, b.version, b.date].filter(Boolean).join(" · ");
    box.append(l);
  });
}

function fwLog(s) {
  const el = $("fwLog");
  el.textContent += s.endsWith("\n") ? s : s + "\n";
  el.scrollTop = el.scrollHeight;
}

async function releaseAll() {
  for (const s of ["A", "B"]) if (boards[s]) { await boards[s].close(); boards[s] = null; }
  refreshDevices();
}

guard($("fwFlash"), async () => {
  $("fwLog").textContent = "";
  $("fwBar").style.width = "0";
  try {
    let image, address;
    const file = $("fwFile").files[0];
    const pick = document.querySelector('input[name="build"]:checked');
    if (file && (!pick || $("fwFile").closest("details").open)) {
      image = new Uint8Array(await file.arrayBuffer());
      address = parseInt($("fwAddr").value, 16);
      fwLog(`Local image ${file.name}, ${image.length} bytes at 0x${address.toString(16)}`);
    } else if (pick) {
      const b = builds[+pick.value];
      fwLog(`Fetching ${b.file}...`);
      image = await fetchImage(b);
      address = parseInt(b.address || "0x2000", 16);
      fwLog(`${b.name}: ${image.length} bytes at 0x${address.toString(16)}`);
    } else throw new Error("pick an image");
    if (!Number.isFinite(address)) throw new Error("bad address");
    await releaseAll();
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID_ESPRESSIF }] });
    await flash(port, image, { address, eraseAll: $("fwErase").checked, log: fwLog, progress: (f) => ($("fwBar").style.width = `${(f * 100).toFixed(1)}%`) });
    fwLog("Done. Connect it as board A or B; the radio takes a few seconds to come up.");
  } catch (e) {
    fwLog(`! ${e.message}`);
  }
});

guard($("fwEraseOnly"), async () => {
  $("fwLog").textContent = "";
  try {
    await releaseAll();
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID_ESPRESSIF }] });
    await eraseFlash(port, { log: fwLog });
  } catch (e) { fwLog(`! ${e.message}`); }
});

// ------------------------------------------------------------------------------ start

refreshDevices();
buildParams();
renderText();
syncLocks();
initBuilds();
window.addEventListener("resize", () => { renderPreviewSoon(); drawPaint(); });
