#!/usr/bin/env python3
"""
build_dashboard.py — inject data/jpdash_payload.json into the dashboard template.

Usage:
    python3 scripts/build_dashboard.py

Reads:
    dashboard/jp-product-dashboard.template.html   (__PAYLOAD_JSON__ + __ROADMAP_JSON__ markers)
    data/jpdash_payload.json                       (plain-language summaries only)
    data/roadmap_jp_needs.json                     (JP Needs roadmap tab, tri-lingual)
Writes:
    dashboard/jp-product-dashboard.html            (self-contained, offline-capable)

The payload contains NO raw JIRA descriptions/comments — only the tri-lingual
plain-language summaries — so the built file is safe to deploy as a static page.
"""

import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, "dashboard", "jp-product-dashboard.template.html")
PAYLOAD = os.path.join(ROOT, "data", "jpdash_payload.json")
ROADMAP = os.path.join(ROOT, "data", "roadmap_jp_needs.json")
OUT = os.path.join(ROOT, "dashboard", "jp-product-dashboard.html")


def main():
    with open(PAYLOAD, encoding="utf-8") as fh:
        payload = json.load(fh)
    for req in ("generatedAt", "roadmap", "tickets", "parked"):
        if req not in payload:
            sys.exit(f"ERROR: payload missing required key '{req}'")
    if not payload["tickets"]:
        sys.exit("ERROR: payload has zero active tickets — refusing to build an empty dashboard")

    with open(ROADMAP, encoding="utf-8") as fh:
        roadmap = json.load(fh)
    for req in ("meta", "stats", "groups", "untracked", "notes"):
        if req not in roadmap:
            sys.exit(f"ERROR: roadmap payload missing required key '{req}'")
    for grp in roadmap["groups"]:
        for it in grp["items"]:
            for fld in ("title", "date", "status"):
                missing = [lg for lg in ("zh", "en", "ja") if not it.get(fld, {}).get(lg)]
                if missing:
                    sys.exit(f"ERROR: {it.get('key')} .{fld} missing language(s): {missing}")
    for it in roadmap["untracked"]:
        missing = [lg for lg in ("zh", "en", "ja") if not it.get(lg)]
        if missing:
            sys.exit(f"ERROR: untracked #{it.get('rank')} missing language(s): {missing}")

    with open(TPL, encoding="utf-8") as fh:
        tpl = fh.read()
    for marker in ("__PAYLOAD_JSON__", "__ROADMAP_JSON__"):
        if marker not in tpl:
            sys.exit(f"ERROR: template is missing the {marker} marker")

    def blobify(obj):
        # keep any </script> sequence inside the data from closing the tag early
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    html = tpl.replace("__PAYLOAD_JSON__", blobify(payload), 1)
    html = html.replace("__ROADMAP_JSON__", blobify(roadmap), 1)

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(html)
    rm_items = sum(len(g["items"]) for g in roadmap["groups"])
    print(f"OK: {os.path.relpath(OUT, ROOT)} "
          f"({len(html)//1024} KB, {len(payload['tickets'])} active, {len(payload['parked'])} parked, "
          f"snapshot {payload['generatedAt'][:16]})")
    print(f"    roadmap tab: {rm_items} ticketed + {len(roadmap['untracked'])} untracked "
          f"(data as of {roadmap['meta'].get('generated_at','?')})")


if __name__ == "__main__":
    main()
