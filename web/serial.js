// SPDX-License-Identifier: GPL-3.0-or-later
//
// One board's shell over Web Serial. The C5's USB-Serial-JTAG resets the chip on the
// RTS line and selects the ROM bootloader with DTR, so a port opens with both low and
// gets a pulse on RTS alone (as tools/rfprobe.py does). Commands go one at a time; a
// reply ends with the prompt ("sdr> " for the playground, "uart:~$ " for other apps).

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PROMPT = /(?:sdr> |uart:~\$ )$/;

export class Board {
  constructor(port, { onLine, onState } = {}) {
    this.port = port;
    this.onLine = onLine || (() => {});
    this.onState = onState || (() => {});
    this.buf = "";
    this.waiters = [];
    this.queue = Promise.resolve();
    this.info = null;
    this.open = false;
  }

  async connect({ reset = true } = {}) {
    await this.port.open({ baudRate: 115200, bufferSize: 65536 });
    this.open = true;
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    this.readLoop();
    if (reset) await this.reset();
    await this.handshake();
  }

  async reset() {
    this.onState("resetting");
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    // The Wi-Fi driver takes a few seconds to bring the radio up.
    await this.waitFor(/ready|init failed/, 9000).catch(() => {});
  }

  async handshake() {
    this.onState("handshake");
    await this.write("\x03\r");
    await sleep(150);
    await this.cmd("shell echo off", { timeout: 2000 }).catch(() => {});
    const info = await this.cmd("wave info", { timeout: 2000 }).catch(() => "");
    const m = info.match(/info app (\S+) version (\S+) board (\S+) words (\d+) cpu (\d+) paced (\d+)-(\d+) f (\d+) rxgainmax (-?\d+)/);
    this.info = m
      ? { app: m[1], version: m[2], board: m[3], words: +m[4], cpu: +m[5], pacedMin: +m[6], pacedMax: +m[7], freq: +m[8], rxGainMax: +m[9] }
      : { app: "unknown (no wave command: flash the playground)", words: 0, freq: 0 };
    this.onState("ready");
    return this.info;
  }

  async readLoop() {
    const dec = new TextDecoder();
    while (this.open && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.feed(dec.decode(value, { stream: true }));
        }
      } catch (e) {
        this.onLine(`! read: ${e.message}`, "err");
      } finally {
        this.reader.releaseLock();
      }
      if (!this.open) break;
    }
    this.open = false;
    this.onState("closed");
  }

  feed(text) {
    this.buf += text.replace(ANSI, "").replace(/\r/g, "");
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.emit(line);
    }
    if (PROMPT.test(this.buf)) {
      this.buf = "";
      this.emit(null);
    }
  }

  emit(line) {
    if (line !== null && line.length) this.onLine(line, "rx");
    for (const w of [...this.waiters]) w(line);
  }

  waitFor(re, timeout) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== fn); reject(new Error("timeout")); }, timeout);
      const fn = (line) => {
        if (line !== null && re.test(line)) {
          clearTimeout(t);
          this.waiters = this.waiters.filter((x) => x !== fn);
          resolve(line);
        }
      };
      this.waiters.push(fn);
    });
  }

  async write(s) {
    const w = this.port.writable.getWriter();
    try {
      await w.write(new TextEncoder().encode(s));
    } finally {
      w.releaseLock();
    }
  }

  // Run one command; resolves with its output (all lines up to the prompt).
  cmd(line, { timeout = 5000, quiet = false } = {}) {
    const run = async () => {
      if (!this.open) throw new Error("not connected");
      const lines = [];
      const done = new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== fn); reject(new Error(`${line.split(" ").slice(0, 3).join(" ")}: timeout`)); }, timeout);
        const fn = (l) => {
          if (l === null) {
            clearTimeout(t);
            this.waiters = this.waiters.filter((x) => x !== fn);
            resolve(lines.join("\n"));
          } else lines.push(l);
        };
        this.waiters.push(fn);
      });
      if (!quiet) this.onLine(`> ${line.length > 120 ? line.slice(0, 117) + "..." : line}`, "tx");
      await this.write(line + "\r");
      return done;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async close() {
    this.open = false;
    try { await this.reader?.cancel(); } catch {}
    try { await this.port.close(); } catch {}
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "key value key value ..." after a leading word, as the firmware prints its results.
export function kv(line) {
  const out = {}, t = line.trim().split(/\s+/);
  for (let k = 1; k + 1 < t.length; k += 2) out[t[k]] = isNaN(+t[k + 1]) ? t[k + 1] : +t[k + 1];
  return out;
}
