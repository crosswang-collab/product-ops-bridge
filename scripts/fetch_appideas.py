#!/usr/bin/env python3
"""
fetch_appideas.py — pull ALL open APPIDEAS tickets from Jira, cleanly, with pagination.

Why this exists: the MCP/chat path returned 100 tickets then timed out (300s) on the
next page. This hits the REST enhanced-search endpoint directly, pages via nextPageToken
until isLast, retries transient errors, and writes one clean JSON file for the
dashboard pipeline to enrich.

Run:
    export JIRA_EMAIL="cross@17.media"          # your Atlassian login email
    export JIRA_API_TOKEN="xxxxxxxx"            # id.atlassian.com/manage-profile/security/api-tokens
    python3 scripts/fetch_appideas.py

Output:
    data/appideas_open.json   ->  {"generatedAt": ISO, "count": N, "tickets": [ {key,status,summary,updated,description,comments:[...] }, ... ]}

No secrets are stored in this file. Auth comes from environment variables only.
"""

import os, sys, json, time, base64, datetime, urllib.request, urllib.error

CLOUD_ID = "69564616-1122-4f22-9fa5-00ccbcda1149"   # 17media.atlassian.net (verified)
BASE     = f"https://api.atlassian.com/ex/jira/{CLOUD_ID}/rest/api/3"
JQL      = "project = APPIDEAS AND statusCategory != Done ORDER BY updated DESC"
FIELDS   = ["summary", "status", "issuetype", "updated", "description", "comment"]
PAGE     = 50
OUT      = os.path.join(os.path.dirname(__file__), "..", "data", "appideas_open.json")

# Test / junk / template tickets to drop (full-project sweep 2026-07-06). Extend as needed.
DROP = {
    "APPIDEAS-7",     # Something we are not going to do
    "APPIDEAS-287",   # Idea test & Epic is empty
    "APPIDEAS-368", "APPIDEAS-369",              # ru666y test1/2
    "APPIDEAS-880",   # [Tech] {project name}(template)
    "APPIDEAS-1475",  # Test idea
    "APPIDEAS-1574", "APPIDEAS-1581",            # test experiment / test solution
    "APPIDEAS-1929", "APPIDEAS-1942",            # [POC template] Test by Angela
    "APPIDEAS-1931",  # Test_0203_2
    "APPIDEAS-1968",  # This is my 3rd test
    "APPIDEAS-1975", "APPIDEAS-1979", "APPIDEAS-1984", "APPIDEAS-1993",  # test yoyo / jen jen
    "APPIDEAS-1996",  # A test tech ticket
    "APPIDEAS-2028",  # divider ticket: "2026 H2 Roadmap Candidates"
    "APPIDEAS-2070", "APPIDEAS-2071", "APPIDEAS-2072", "APPIDEAS-2073",
    "APPIDEAS-2074", "APPIDEAS-2075", "APPIDEAS-2076", "APPIDEAS-2077", "APPIDEAS-2078",
    "APPIDEAS-2085", "APPIDEAS-2087", "APPIDEAS-2088", "APPIDEAS-2089", "APPIDEAS-2090",
    "APPIDEAS-2091", "APPIDEAS-2092", "APPIDEAS-2095", "APPIDEAS-2096", "APPIDEAS-2097",
    "APPIDEAS-2098", "APPIDEAS-2099", "APPIDEAS-2100",   # workflow-automation test series
    "APPIDEAS-2109", "APPIDEAS-2110", "APPIDEAS-2111",   # Tanya/5-12 tests
    "APPIDEAS-2117",  # Test create epic ticket | Data
    "APPIDEAS-2119",  # test yoyo
    "APPIDEAS-2130",  # jenn test
    "APPIDEAS-2158",  # Test Ticket - auto update Epic Ticket Due Date
}


def _auth_header():
    email = os.environ.get("JIRA_EMAIL")
    token = os.environ.get("JIRA_API_TOKEN")
    if not email or not token:
        sys.exit("ERROR: set JIRA_EMAIL and JIRA_API_TOKEN environment variables first. "
                 "Create a token at id.atlassian.com/manage-profile/security/api-tokens")
    raw = f"{email}:{token}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def _post(path, payload, attempt=1):
    url = BASE + path
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", _auth_header())
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:300]
        except Exception:
            pass
        transient = e.code == 429 or e.code >= 500
        if transient and attempt <= 4:
            wait = 2 ** attempt
            print(f"  HTTP {e.code} (transient) — retry in {wait}s [{attempt}/4]", file=sys.stderr)
            time.sleep(wait)
            return _post(path, payload, attempt + 1)
        sys.exit(f"ERROR HTTP {e.code} on {path}: {body}")
    except (urllib.error.URLError, TimeoutError) as e:
        if attempt <= 4:
            wait = 2 ** attempt
            print(f"  network error ({e}) — retry in {wait}s [{attempt}/4]", file=sys.stderr)
            time.sleep(wait)
            return _post(path, payload, attempt + 1)
        sys.exit(f"ERROR network on {path}: {e}")


def _adf_to_text(node):
    """Flatten Atlassian Document Format to plain text (best-effort)."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    out = []
    if isinstance(node, dict):
        if node.get("type") == "text":
            out.append(node.get("text", ""))
        for child in node.get("content", []) or []:
            out.append(_adf_to_text(child))
        if node.get("type") in ("paragraph", "heading", "listItem", "tableRow"):
            out.append("\n")
    elif isinstance(node, list):
        for child in node:
            out.append(_adf_to_text(child))
    return "".join(out)


def main():
    print(f"Fetching: {JQL}")
    tickets, token, page = [], None, 0
    while True:
        page += 1
        payload = {"jql": JQL, "maxResults": PAGE, "fields": FIELDS}
        if token:
            payload["nextPageToken"] = token
        res = _post("/search/jql", payload)
        batch = res.get("issues", [])
        for it in batch:
            key = it.get("key")
            if key in DROP:
                continue
            f = it.get("fields", {})
            st = f.get("status") or {}
            comments = []
            for c in (f.get("comment", {}) or {}).get("comments", []) or []:
                comments.append({
                    "author": (c.get("author") or {}).get("displayName", ""),
                    "created": c.get("created", ""),
                    "text": _adf_to_text(c.get("body")).strip(),
                })
            tickets.append({
                "key": key,
                "status": st.get("name") if isinstance(st, dict) else st,
                "issuetype": (f.get("issuetype") or {}).get("name", ""),
                "summary": f.get("summary", ""),
                "updated": f.get("updated", ""),
                "description": _adf_to_text(f.get("description")).strip(),
                "comments": comments,
            })
        print(f"  page {page}: +{len(batch)} (total kept {len(tickets)})  isLast={res.get('isLast')}")
        if res.get("isLast") or not res.get("nextPageToken"):
            break
        token = res["nextPageToken"]
        time.sleep(0.5)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "count": len(tickets),
        "tickets": tickets,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"Done. {len(tickets)} tickets -> {os.path.normpath(OUT)}")


if __name__ == "__main__":
    main()
