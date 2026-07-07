#!/usr/bin/env python3
"""
build_dashboard.py — inject data/jpdash_payload.json into the dashboard template.

Usage:
    python3 scripts/build_dashboard.py

Reads:
    dashboard/jp-product-dashboard.template.html   (contains __PAYLOAD_JSON__ marker)
    data/jpdash_payload.json                       (plain-language summaries only)
Writes:
    dashboard/jp-product-dashboard.html            (self-contained, offline-capable)

The payload contains NO raw JIRA descriptions/comments — only the tri-lingual
plain-language summaries — so the built file is safe to deploy as a static page.
"""

import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, "dashboard", "jp-product-dashboard.template.html")
PAYLOAD = os.path.join(ROOT, "data", "jpdash_payload.json")
OUT = os.path.join(ROOT, "dashboard", "jp-product-dashboard.html")


def main():
    with open(PAYLOAD, encoding="utf-8") as fh:
        payload = json.load(fh)
    for req in ("generatedAt", "roadmap", "tickets", "parked"):
        if req not in payload:
            sys.exit(f"ERROR: payload missing required key '{req}'")
    if not payload["tickets"]:
        sys.exit("ERROR: payload has zero active tickets — refusing to build an empty dashboard")

    with open(TPL, encoding="utf-8") as fh:
        tpl = fh.read()
    if "__PAYLOAD_JSON__" not in tpl:
        sys.exit("ERROR: template is missing the __PAYLOAD_JSON__ marker")

    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    blob = blob.replace("</", "<\\/")  # keep </script> sequences from breaking the page
    html = tpl.replace("__PAYLOAD_JSON__", blob, 1)

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"OK: {os.path.relpath(OUT, ROOT)} "
          f"({len(html)//1024} KB, {len(payload['tickets'])} active, {len(payload['parked'])} parked, "
          f"snapshot {payload['generatedAt'][:16]})")


if __name__ == "__main__":
    main()
