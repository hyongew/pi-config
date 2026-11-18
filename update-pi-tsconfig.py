#!/usr/bin/env python3
"""Point tsconfig.json at the current pi-managed-install release.

Reads the pi version from install/current-version (the same file pi's
launcher uses) and rewrites the install/releases/<version> paths in
tsconfig.json. Run this after `pi update self`.

Usage:
    python -B update-pi-tsconfig.py
"""
import json
import re
import sys
from pathlib import Path

agent_dir = Path(__file__).resolve().parent
version_file = agent_dir / "install" / "current-version"
tsconfig_file = agent_dir / "tsconfig.json"

version = version_file.read_text(encoding="utf-8").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    sys.exit(f"unexpected version in {version_file}: {version!r}")

text = tsconfig_file.read_text(encoding="utf-8")
new_text, count = re.subn(r"install/releases/[^/\"]+", f"install/releases/{version}", text)
if count == 0:
    sys.exit(f"no install/releases/ paths found in {tsconfig_file}")

json.loads(new_text)  # sanity check: result is still valid JSON
tsconfig_file.write_text(new_text, encoding="utf-8")
print(f"updated {count} path(s) in {tsconfig_file.name} to pi {version}")
