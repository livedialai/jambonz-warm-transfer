#!/usr/bin/env python3
"""jambonz + mediajam: pass the hold-music URL through unchanged.

FreeSWITCH wants shout://<host>/<path>, and jambonz hard-codes that rewrite.
mediajam (the Go media engine used by newer jambonz installs) only knows
http/https and answers every shout:// play with

    {"cmd":"play.start","code":"bad_request","err":"unknown scheme \"shout\""}

which means: the play task runs, the caller hears silence. This patch keeps the
URL as configured (http/https) in the two places that build it.

Usage:
    sudo python3 patch_holdmusic.py [--root /opt/jambonz/feature-server] [--dry-run]

Every changed file gets a .bak-<HHMMSS> copy and is syntax-checked with
`node --check`. Re-running is safe (idempotent). Restart the feature server
afterwards:  systemctl restart jambonz-feature-server
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

JOBS = [
    (
        "lib/tasks/transfer/warm-parked.js",
        "  const fallbackUrl = cs.onHoldMusic\n"
        r"    ? `shout://${cs.onHoldMusic.replace(/^https?:\/\//, '')}`"
        "\n"
        "    : 'silence_stream://-1';",
        "  const fallbackUrl = cs.onHoldMusic\n"
        "    ? cs.onHoldMusic\n"
        "    : 'silence_stream://-1';",
    ),
    (
        "lib/utils/media-endpoint.js",
        r"    ...(onHoldMusic && {holdMusic: `shout://${onHoldMusic.replace(/^https?:\/\//, '')}`}),",
        "    ...(onHoldMusic && {holdMusic: onHoldMusic}),",
    ),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/opt/jambonz/feature-server")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    stamp = time.strftime("%H%M%S")
    rc = 0

    for rel, old, new in JOBS:
        path = os.path.join(args.root, rel)
        try:
            src = open(path, encoding="utf-8").read()
        except OSError as e:
            print(f"ERROR reading {path}: {e}")
            rc = 1
            continue

        if new in src and old not in src:
            print(f"already patched: {path}")
            continue
        if old not in src:
            print(f"ERROR pattern not found: {path} (different jambonz version?)")
            rc = 1
            continue
        if args.dry_run:
            print(f"would patch: {path}")
            continue

        shutil.copy2(path, f"{path}.bak-{stamp}")
        open(path, "w", encoding="utf-8").write(src.replace(old, new, 1))
        chk = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        ok = chk.returncode == 0
        print(f"patched: {path}  syntax={'ok' if ok else chk.stderr[:200]}")
        if not ok:
            rc = 1

    return rc


if __name__ == "__main__":
    sys.exit(main())
