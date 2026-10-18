#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Copy built images next to the web UI and list them in firmware/manifest.json.

    web/tools/stage.py [--out DIR] NAME=BUILD_DIR[:DESCRIPTION] ...

NAME is the file stem (NAME.bin) and the label; BUILD_DIR a west build directory. The
image is build/zephyr/zephyr.bin and its flash offset comes from the build's runners.yaml
(--esp-app-address, 0x2000 on the C5). Without arguments: ./build as "playground".
"""

import argparse
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys

WEB = pathlib.Path(__file__).resolve().parent.parent


def build_info(build):
    runners = (build / "zephyr" / "runners.yaml").read_text()
    m = re.search(r"--esp-app-address=(0x[0-9a-fA-F]+)", runners)
    address = m.group(1) if m else "0x2000"
    cfg = (build / "zephyr" / ".config").read_text()
    board = re.search(r'^CONFIG_BOARD_TARGET="([^"]+)"', cfg, re.M)
    cache = (build / "CMakeCache.txt").read_text()
    app = re.search(r"^APPLICATION_SOURCE_DIR:\w+=(.+)$", cache, re.M)
    return address, board.group(1) if board else "?", pathlib.Path(app.group(1)).name if app else "?"


def version():
    try:
        return subprocess.check_output(["git", "-C", str(WEB), "describe", "--tags", "--always", "--dirty"],
                                       text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=pathlib.Path, default=WEB / "firmware")
    ap.add_argument("images", nargs="*", default=["playground=build"])
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    builds, ver = [], version()
    for spec in args.images:
        name, _, rest = spec.partition("=")
        path, _, desc = rest.partition(":")
        build = pathlib.Path(path)
        image = build / "zephyr" / "zephyr.bin"
        if not image.is_file():
            sys.exit(f"{image}: not built")
        address, board, app = build_info(build)
        shutil.copyfile(image, args.out / f"{name}.bin")
        builds.append({
            "name": f"{app} · {board.split('/')[0]}",
            "description": desc or None,
            "file": f"{name}.bin",
            "address": address,
            "chip": "ESP32-C5" if "esp32c5" in board else board,
            "board": board,
            "version": ver,
            "date": datetime.date.today().isoformat(),
            "size": image.stat().st_size,
        })
        print(f"{name}.bin: {app} for {board}, {image.stat().st_size} bytes at {address}")
    (args.out / "manifest.json").write_text(json.dumps({"builds": builds}, indent=2) + "\n")


if __name__ == "__main__":
    main()
