.. _esp_sdr_playground:

playground
##########

the C5 transmitter, driven from a browser

Overview
********

One firmware for the ESP32-C5 (Seeed XIAO ESP32-C5, Waveshare ESP32-C5-Zero) and a web page
(``web/``) that flashes it and drives it over the same USB cable. The firmware is
:ref:`rfprobe <esp_sdr_rfprobe>`'s shell plus a waveform buffer (``src/wave.c``); the page builds
waveforms, uploads them, starts and stops the transmitter, and plots captures. The shell stays
usable by hand: ``screen /dev/ttyACM0``, or the page's Console tab.

- **DAC engine loop** (``wave play``): up to 16383 words looped by the modem's DAC engine at 80 or
  40 MS/s with no CPU, continuously or for 1 to 255 passes. Anything periodic: tones, multitone
  combs, AM and FM, chirps, band-limited noise, PSK and QAM with root raised cosine shaping, CPFSK,
  OFDM symbols, I/Q files.
- **Pulsed** (``wave pulse``): bursts of passes with the transmitter off in between, until
  ``wave stop``.
- **Paced** (``wave paced``): the buffer as int16 I/Q through the CPU-paced TX DC path at up to
  250 kS/s, 2400 to 5900 MHz, for a fixed time (the shell is busy meanwhile).
- **Carrier** and **spectrum painting**: rfprobe's ``probe tx carrier`` and ``probe tx paint``.
- **Receive**: rfprobe's burst captures (``probe rx``, 80 to 4 MS/s) and the gapless
  diagnostic-bus ring (``probe diag iq``).

The C5's transmit power steps have no effect: the level follows the samples times the DAC scale,
and the chain compresses above about 1000 (``doc/hardware-quirks.md``). Use a cable and 30 to
60 dB of attenuation between boards, never an antenna.

Building and flashing
*********************

.. code-block:: console

   west build -b xiao_esp32c5/esp32c5/hpcore esp-sdr-zephyr/apps/playground
   west flash

or from the page: stage the image next to it and open it on localhost (Web Serial needs https
or localhost, and Chrome, Edge or another Chromium browser):

.. code-block:: console

   esp-sdr-zephyr/web/tools/stage.py playground=build
   python3 -m http.server -d esp-sdr-zephyr/web 8000

The Flash tab writes ``zephyr.bin`` at 0x2000 (the C5's ROM keeps the first two sectors)
through esptool-js; the USB-Serial-JTAG enters the bootloader by itself. CI publishes the page
with the images at ``<pages>/playground/``.

The diagnostic-bus ring drives GPIO 0, 1, 3, 4, 5, 7, 10 and 23 while it runs: on the XIAO that
is D0, D1, D3, D4 and D10.

Shell
*****

On top of rfprobe's ``probe`` commands (see its README):

.. code-block:: none

   wave info                   one line: app, version, board, buffer words, CPU clock, paced
                               range, LO, largest receive gain index
   wave put <offset> <base64>  little-endian words into the buffer at a word offset
   wave crc <n>                CRC-32 (IEEE) of the first n words, to check an upload
   wave play <n> [rate 0|1] [passes] [scale]
                               loop n words through the DAC engine at 80 (0) or 40 (1) MS/s;
                               passes 0 until "wave stop", else waits for them
   wave pulse <n> <rate 0|1> <passes> <off ms> [scale]
                               bursts of passes, transmitter off for off ms between them
   wave paced <n> <rate Hz> [ms] [interp]
                               n int16 pairs through the paced TX DC path for ms
   wave state                  replay and pulse state
   wave stop                   pulses and replay off

Words: the DAC engine takes ``esp_sdr_replay_word()``, I in bits 9:0 and Q in bits 19:10
(-511 to 511); the paced path I in bits 15:0 and Q in bits 31:16 (-32767 to 32767).

The prompt is ``sdr> `` and colours are off, so a program can tell where a reply ends; the page
also turns the echo off (``shell echo off``) when it connects.
