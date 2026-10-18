# SPDX-License-Identifier: GPL-3.0-or-later

cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(esp_sdr_playground)

# rfprobe's shell (probe ...) is the radio side; src/wave.c adds the waveform buffer and the
# capability report the web UI (web/) drives.
target_sources(app PRIVATE ../rfprobe/src/main.c src/wave.c)
