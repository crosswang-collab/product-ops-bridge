#!/usr/bin/env python3
"""
assemble_payload.py — merge per-ticket summaries + parked entries into
data/jpdash_payload.json, which build_dashboard.py then bakes into the HTML.

Reads (from the scratch work directory used by the summarizer agents):
    tickets/*.json        raw fetched ticket detail (for dates + rawSummary)
    summaries/*.json      tri-lingual active-ticket summaries
    parked_in/*.json      raw parked-ticket index slices (for `updated`)
    parked_out/*.json     tri-lingual parked title/intent
    roadmap.json          {zh,en,ja} overview paragraph
    drop_keys.json        junk/test ticket keys that were filtered out

Writes:
    data/jpdash_payload.json
"""
import json, glob, os, sys, datetime

WORK = os.environ.get(
    "JPDASH_WORK",
    "/tmp/claude-0/-home-user-product-ops-bridge/ac87f106-b8c8-590f-baad-aa76dcb6f90e/scratchpad",
)
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEW = "https://17media.atlassian.net/jira/polaris/projects/APPIDEAS/ideas/view/3570203"


def url(k):
    return f"{VIEW}?selectedIssue={k}"


def main():
    # ---- active tickets: summary + url + dates (mapped from raw ticket file) ----
    tickets = []
    for f in sorted(glob.glob(WORK + "/summaries/*.json")):
        d = json.load(open(f))
        k = d["key"]
        raw = json.load(open(f"{WORK}/tickets/{k}.json"))
        rd = raw.get("dates", {})
        d["url"] = url(k)
        d["rawSummary"] = raw.get("summary", "")
        d["updated"] = (raw.get("updated") or "")[:10]
        d["dates"] = {
            "start": rd.get("discoveryStart") or rd.get("discoveryTarget"),
            "t0": rd.get("discoveryTarget"),
            "t1": rd.get("designTarget"),
            "t2": rd.get("techTarget"),
            "t3": rd.get("devTarget"),
            "t4": rd.get("outcomeTarget"),
        }
        tickets.append(d)

    # ---- parked entries: title + intent + url + updated (for recency sort) ----
    updated_by_key = {t["key"]: (t.get("updated") or "")[:10] for t in json.load(open(WORK + "/index_all.json"))}
    parked = []
    seen = set()
    for f in sorted(glob.glob(WORK + "/parked_out/batch_*.json")):
        for p in json.load(open(f)):
            k = p["key"]
            if k in seen:
                continue
            seen.add(k)
            p["url"] = url(k)
            p["updated"] = updated_by_key.get(k, "")
            parked.append(p)
    # most-recently-touched idea first — more useful to browse than raw ticket number
    parked.sort(key=lambda p: p.get("updated") or "", reverse=True)

    roadmap = json.load(open(WORK + "/roadmap.json"))
    drop = json.load(open(WORK + "/drop_keys.json"))

    payload = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc)
        .astimezone(datetime.timezone(datetime.timedelta(hours=9)))
        .isoformat(timespec="seconds"),
        "source": "claude-code",
        "junkDropped": len(drop),
        "roadmap": roadmap,
        "tickets": tickets,
        "parked": parked,
    }
    os.makedirs(REPO + "/data", exist_ok=True)
    out = REPO + "/data/jpdash_payload.json"
    json.dump(payload, open(out, "w"), ensure_ascii=False, indent=1)
    print(f"wrote {out}: {len(tickets)} active, {len(parked)} parked, junkDropped {len(drop)}")

    bad = [t["key"] for t in tickets
           if not all(t.get(x, {}).get(l) for x in ("title", "what", "now", "when") for l in ("zh", "en", "ja"))]
    print("active with missing lang fields:", bad or "none")
    pbad = [p["key"] for p in parked if not all(p.get("title", {}).get(l) for l in ("zh", "en", "ja"))]
    print("parked with missing title langs:", pbad or "none")
    if bad or pbad:
        sys.exit(1)


if __name__ == "__main__":
    main()
