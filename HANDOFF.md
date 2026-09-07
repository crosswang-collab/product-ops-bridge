# HANDOFF — JP Product Dashboard (chat → Claude Code)

> Handoff FROM: Claude (chat, claude.ai) · 2026-07-06
> Handoff TO: Claude Code, repo `crosswang-collab/product-ops-bridge`
> Owner: Cross (COO, mikai / 17LIVE). Not an engineer. He does not debug — deliver complete, ≤5-step deploy.
> **Read `coding-rules` + `pre-delivery-checklist` conventions before shipping.** All user-facing UI copy: zero jargon, high-school reading level, tri-lingual (zh-Hant / en / ja).

---

## == 3-BLOCK HANDOFF ==

🎯 **Root goal**
Cross cannot read JIRA. He needs ONE interface that, for the whole JP/APPIDEAS product line, gives him: (a) a plain-language roadmap + per-ticket summary a non-product businessperson can understand, (b) tri-lingual zh/en/ja toggle, (c) timeline progress, (d) a heatmap showing each ticket on-track vs behind, and (e) a "needs Cross input" inbox. Search by keyword or ticket number must return that ticket's plain-language summary.

📍 **Current stage**
A working single-file HTML dashboard exists (design + i18n + heatmap + timeline + card layout + ON-AIR inbox + search-ready structure), seeded with ONE real ticket (APPIDEAS-1927, hand-verified 2026-07-03). The **live-refresh path built into the artifact is DEAD in this environment** (browser `fetch` to api.anthropic.com is sandbox-blocked → "Failed to fetch"). Data must therefore be fetched **outside the browser** (Claude Code can do this) and baked into the file — or turned into a real local tool.

⏭ **Next actions (in order)**
1. Fetch ALL open APPIDEAS tickets via Jira REST (pagination — the step that kept timing out in chat; script provided: `scripts/fetch_appideas.py`).
2. For each ticket, generate the tri-lingual plain-language summary object (schema below) using a high-tier model.
3. Render into the dashboard (reuse the shipped HTML/CSS/JS; data baked in, not live-fetched). Parking-lot section collapsed by default (decision B).
4. Ship one self-contained deliverable + a refresh command Cross can run without debugging.

Confirm root goal + stage are right before starting.

---

## Decisions already locked by Cross

| # | Decision | Detail |
|---|---|---|
| D1 | **Scope = whole APPIDEAS project** | `project = APPIDEAS AND statusCategory != Done`. NOT filtered to "JP Team" custom field — that under-covered the Kanban. |
| D2 | **Option B: include everything, but partition** | All 100+ open tickets included. **Parking lot** status → its own section, **collapsed by default**, and excluded from heatmap/timeline (nothing is moving on them). Active tickets (Develop In Progress / Design* / Discovery / Dev-QA Done) get full treatment. |
| D3 | **Parking-lot cards may be lightweight** | Cross said "抓整齊" (fetch everything cleanly). Parking-lot tickets often have only a title, no description/comments — do NOT fabricate progress/what/now/when for them (violates his data-honesty rule). Title translation + one-line "what problem it wants to solve" is acceptable for parking-lot; full what/now/when/health only where the ticket actually has content. |
| D4 | **Move to Claude Code + high-tier model** | This handoff exists because chat hit: pagination timeouts, sandboxed artifact fetch, and per-ticket summary cost. Claude Code solves all three (local HTTP with retry, no browser sandbox, scripted batch summarization, and can add Slack push later). |

Still OPEN (ask Cross, don't guess):
- **O1 — final delivery form**: (a) static baked HTML (simplest, snapshot; refresh = re-run script + regenerate), or (b) a real local tool / small service in the repo that refreshes on demand. Chat recommended starting with (a); Cross may want (b) now that it's in Claude Code.
- **O2 — Slack push** ("需要我 input 時及時提醒"): deferred in chat v1 (artifact can't push). In Claude Code this becomes viable (cron + Slack webhook, @Cross-mention detection). Cross said "v1 先純 dashboard，用一週再說" — revisit after one week of use, unless he asks sooner.
- **O3 — "needs Cross" detection rule**: currently = a comment in last 21 days that @-mentions Cross OR explicitly asks stakeholders including him for a decision. Tune precision after real data (bias to over-report; each item links to the source comment for fast dismissal).

---

## PITFALLS (already hit — do not repeat)

| Where | What went wrong | Correct approach |
|---|---|---|
| Artifact runtime | Browser `fetch('https://api.anthropic.com/...')` inside a claude.ai artifact → **"Failed to fetch"** (sandbox blocks the egress). | Never rely on in-artifact network calls in this environment. Fetch server-side / in Claude Code; bake data in, or run as a real local tool. |
| Jira scope | `cf[10421] = "JP Team"` (Teams custom field) does NOT equal what's on the Kanban board. Under-covered. | Use `project = APPIDEAS AND statusCategory != Done`. Board membership ≠ Teams-field value. |
| Polaris view URL | `.../ideas/view/3570203` is a **Polaris view**, not a board. Its ticket set / ordering is **NOT readable via REST or the Rovo MCP**. Do not try to resolve the view definition through the API. | Approximate with a JQL scope (D1). If exact view parity is ever required, Cross must read the view's filter chips manually and dictate them. |
| Jira pagination | `searchJiraIssuesUsingJql` returned 100 then **timed out (300s) / rejected a hand-made nextPageToken** on subsequent pages via the MCP. | Use the REST endpoint directly with the returned `nextPageToken`, short page size, retry+backoff. See script. Loop until `isLast: true`. |
| Tool result size | A 100-issue fetch with `*all` fields is ~750 KB — too big for a single context window. | Request only the fields you need (below). Stream/persist to disk; process in batches. |

---

## Jira REST — verified specifics

- **Site**: `17media.atlassian.net`
- **cloudId (UUID)**: `69564616-1122-4f22-9fa5-00ccbcda1149`
- **Endpoint (v3 enhanced search, token-paginated)**:
  `POST https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/search/jql`
  body: `{"jql": "...", "maxResults": 50, "fields": [...], "nextPageToken": "..."}`
  Response: `{ "issues": [...], "nextPageToken": "...", "isLast": bool }`. Loop on `nextPageToken` until `isLast: true`.
- **Auth**: Jira API token (email + token → Basic auth), or OAuth. Cross's Atlassian account has access (org: 17.media). Store token as env var / secret — never hardcode in a committed file.
- **Fields to request** (keep small):
  `summary, status, issuetype, updated, description, comment` — plus the Polaris date fields if you want machine-readable stage targets. On APPIDEAS the process/target dates live in the description's process table and in "Stage Health Check" comments; parsing those (as the seed ticket does) is the reliable source.
- **Total open count observed**: 100 on page 1 (`isLast: false`), so **100+**. Status distribution on page 1:

| Status | Count (page 1) |
|---|---|
| Parking lot | 62 |
| Delivery - Develop In Progress | 17 |
| Discovery | 8 |
| Design - Refinement | 5 |
| DESIGN - UX/UI | 3 |
| Design - Story map | 2 |
| Dev/QA Done | 2 |
| Design - UX READY | 1 |

- **Test/junk tickets to drop** (seen on page 1): `APPIDEAS-2073 test yoyo`, `APPIDEAS-2130 jenn test`, `APPIDEAS-2158 Test Ticket…`, `APPIDEAS-1475 Test idea`, `APPIDEAS-7 Something we are not going to do`. Filter these out.
- **Stage mapping** (status → stage index 0–4 used by heatmap/timeline): 0 Discovery/planning · 1 Design* (Refinement/Story map/UX-UI/UX Ready) · 2 tech-prep · 3 Delivery-Develop In Progress · 4 Dev/QA Done / released. Parking lot = not staged (own section).

Two reference files ship alongside this handoff:
- `scripts/fetch_appideas.py` — standalone paginated fetcher (solves the timeout). Fills the gap chat couldn't.
- `data/appideas_page1_index.json` — the 100 page-1 tickets (key/status/summary) already pulled, so Claude Code can start from real data and only needs to fetch the remainder + enrich.

---

## Per-ticket summary schema (reuse verbatim — the shipped HTML expects this shape)

```json
{
  "key": "APPIDEAS-1927",
  "url": "https://17media.atlassian.net/jira/polaris/projects/APPIDEAS/ideas/view/3570203?selectedIssue=APPIDEAS-1927",
  "title":     {"zh": "...", "en": "...", "ja": "..."},
  "what":      {"zh": "...", "en": "...", "ja": "..."},
  "now":       {"zh": "...", "en": "...", "ja": "..."},
  "when":      {"zh": "...", "en": "...", "ja": "..."},
  "health":    "green | amber | red",
  "healthWhy": {"zh": "...", "en": "...", "ja": "..."},
  "stage": 0,
  "dates": {"start": "YYYY-MM-DD", "t0": "...", "t1": "...", "t2": "...", "t3": "...", "t4": "..."},
  "needsCross": {"flag": false, "date": null, "why": {"zh": "", "en": "", "ja": ""}}
}
```

Top-level payload: `{ "generatedAt": ISO, "roadmap": {zh,en,ja}, "tickets": [ ... ] }`.
Writing rules for summaries: zh = Traditional Chinese (Taiwan); ja = natural Japanese; en = plain English. No product/eng jargon (no "refinement / PRD / backlog / sprint"). `health`: use latest "Stage Health Check" comment if present (red circle=red, yellow=amber, green=green); else compare today vs current-stage target date (past=red, ≤5 days=amber, else green). `needsCross.flag=true` only per O3.

The gold-standard hand-verified example is APPIDEAS-1927 inside the shipped HTML (`SEED` object) — match that quality and voice for active tickets.

---

## Definition of done (verify before telling Cross it's shipped)

- [ ] Every open APPIDEAS ticket fetched (loop reached `isLast: true`); test/junk tickets dropped.
- [ ] Active tickets have full tri-lingual what/now/when/health; parking-lot tickets at least title + one-line intent, collapsed section.
- [ ] Heatmap + timeline cover active tickets only; parking-lot excluded.
- [ ] ON-AIR "needs Cross" inbox populated per O3, each item deep-links to the source ticket.
- [ ] Search box returns a ticket by key or keyword and shows its plain-language summary.
- [ ] zh/en/ja toggle switches ALL content including summaries.
- [ ] Refresh is ONE command Cross runs; no debugging, ≤5 steps, errors surface with a clear message (no silent failure).
- [ ] Run the `pre-delivery-checklist` 5 checks; report ①–⑤ in the delivery message.

---

## Vault note to write (per §5, after Cross confirms)

`[JIRA/Polaris] Polaris view URLs (/ideas/view/{id}) are NOT resolvable via REST or Rovo MCP — cannot read a view's ticket set/order. Approximate with JQL project scope. Board membership ≠ Teams custom field (cf[10421]). Enhanced search is token-paginated at /rest/api/3/search/jql — loop nextPageToken until isLast; MCP path times out on large pulls, use REST with retry.`

`[Artifacts] claude.ai HTML artifacts cannot fetch() external APIs (api.anthropic.com egress blocked → "Failed to fetch"). AI-powered artifacts that call the API do not run in this environment. Fetch server-side / in Claude Code and bake data in, or build a real local tool.`
