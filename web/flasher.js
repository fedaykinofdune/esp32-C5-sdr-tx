// SPDX-License-Identifier: GPL-3.0-or-later
//
// Browser flashing through esptool-js (vendored, Apache-2.0). The C5's USB-Serial-JTAG
// enters the ROM bootloader on its own when esptool-js opens it (the usb_reset sequence),
// so no BOOT button is needed. Zephyr's images for the C5 start at 0x2000: the ROM keeps
// the first two sectors.

import { ESPLoader, Transport } from "./vendor/esptool-js-0.6.1.mjs";

export async function loadManifest() {
  try {
    const r = await fetch("firmware/manifest.json", { cache: "no-store" });
    if (!r.ok) return [];
    const m = await r.json();
    return m.builds || [];
  } catch {
    return [];
  }
}

export async function fetchImage(build) {
  const r = await fetch(`firmware/${build.file}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`firmware/${build.file}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function flash(port, image, { address = 0x2000, eraseAll = false, log, progress }) {
  const term = {
    clean() {},
    writeLine: (s) => log(s),
    write: (s) => log(s),
  };
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: 921600, terminal: term, debugLogging: false });
  try {
    const chip = await loader.main();
    log(`Chip: ${chip}`);
    if (!/ESP32-C5/i.test(chip)) log(`! this image is for the ESP32-C5, the port reports ${chip}`);
    await loader.writeFlash({
      fileArray: [{ data: image, address }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll,
      compress: true,
      reportProgress: (_i, written, total) => progress(written / total),
    });
    log("Flashed. Resetting into the new firmware...");
    await loader.after("hard_reset");
  } finally {
    try { await transport.disconnect(); } catch {}
  }
}

export async function eraseFlash(port, { log }) {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: 921600,
    terminal: { clean() {}, writeLine: log, write: log },
  });
  try {
    log(`Chip: ${await loader.main()}`);
    log("Erasing the whole flash (takes a while)...");
    await loader.eraseFlash();
    log("Erased.");
    await loader.after("hard_reset");
  } finally {
    try { await transport.disconnect(); } catch {}
  }
}
