#!/usr/bin/env python3
"""冒烟：vault 单测 +（可选）本机 API health。"""
from __future__ import annotations

import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    print("== unit tests ==")
    r = subprocess.run([sys.executable, str(ROOT / "tests" / "test_vault.py"), "-v"], cwd=str(ROOT))
    if r.returncode != 0:
        return r.returncode

    print("\n== optional live health ==")
    try:
        with urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=2) as resp:
            body = resp.read().decode()
            print("health:", body[:200])
    except Exception as e:
        print("(server not running, skip)", e)

    print("\nSMOKE OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
