#!/usr/bin/env python3
"""Inventory advertised camera/encoder controls over ADB without starting capture.

These GObject properties describe the plugin ABI, not a guarantee that every
mode works on AC204. Device behavior must still be tested for each feature.
"""
import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def properties(text):
    section = text.split("Element Properties:", 1)[1]
    section = section.split("Element Signals:", 1)[0].split("Element Actions:", 1)[0]
    parts = re.split(r"^  ([a-z][\w-]*)\s*:", section, flags=re.M)
    result = []
    for i in range(1, len(parts), 2):
        lines = parts[i + 1].splitlines()
        result.append({
            "name": parts[i],
            "description": lines[0].strip(),
            "metadata": [line.strip() for line in lines[1:] if line.strip()],
            "evidence": "advertised_by_installed_plugin",
        })
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    adb = ["adb"] + (["-s", args.serial] if args.serial else [])
    plugins = []
    for name in ("djiqmmfsrc", "djicamc2venc"):
        text = subprocess.check_output(
            adb + ["shell", f"LC_ALL=C gst-inspect-1.0 {name} 2>/dev/null"],
            text=True, timeout=20,
        )
        plugins.append({"name": name, "properties": properties(text)})
    args.output.write_text(json.dumps({
        "inspected_at": datetime.now(timezone.utc).isoformat(),
        "model": "DJI Osmo Action 5 Pro / AC204",
        "read_only": True,
        "caveat": "Advertised controls are integration candidates, not verified hardware features. Some vendor tags are absent on this firmware.",
        "plugins": plugins,
    }, indent=2) + "\n")
    print("; ".join(f"{p['name']}: {len(p['properties'])} properties" for p in plugins))


if __name__ == "__main__":
    main()
