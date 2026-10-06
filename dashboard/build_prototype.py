#!/usr/bin/env python3
"""
產生 dashboard/prototype.html —— 單一儀表板的「可點原型」。

用途：讓 Cross 在接 Apps Script 後端之前確認版面與動線。
- 數字是真的：讀 repo 裡已經公開的聚合檔（voc-graph/out/latest.json、roadmap-bot/out/）。
- 原話、前後文、細分類是佔位：repo 裡沒有、也不准有原話（HANDOFF §5.1）。
- 不含 userID；頁面不載入任何外部腳本，所有文字都用 textContent 放進畫面。

時間段規則（HANDOFF §5.3 ＋ 第 3 輪審查補充，每個痛點各自計算）：
- 新興高熱：最近 2 週的每週平均 ≥ 10 位，且 ≥ 前 4 週每週平均 × 2（或前 4 週平均 < 2 位）
- 持續高熱：最近 6 週中至少 4 週 ≥ 20 位
- 消退：連續 3 週下降＝最近 3 週每週都比前一週低（需要 4 個週點）

    python3 dashboard/build_prototype.py
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "prototype.html"
TEMPLATE = ROOT / "dashboard" / "prototype.template.html"
BASELINE_FACTS = "2026-09-29"   # Roadmap「7 天內變差」的比較基準日

EMERGE_MIN = 10
PERSIST_MIN = 20
STATUS_RANK = {"On track": 0, "Warning": 1, "At Risk": 2, "Off track": 3}


def load(rel):
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))


def classify(s):
    """s＝由舊到新的週人數。回傳三條規則各自的判定與算式數字（畫面要秀出理由）。"""
    r2 = (s[-1] + s[-2]) / 2
    p4 = sum(s[-6:-2]) / 4
    emerging = r2 >= EMERGE_MIN and (r2 >= 2 * p4 or p4 < 2)
    hot_weeks = sum(1 for v in s[-6:] if v >= PERSIST_MIN)
    persistent = hot_weeks >= 4
    fading = len(s) >= 4 and s[-4] > s[-3] > s[-2] > s[-1]
    return {
        "emerging": emerging, "persistent": persistent, "fading": fading,
        "recent2": round(r2, 1), "prior4": round(p4, 1), "hotWeeks": hot_weeks,
    }


def main():
    g = load("voc-graph/out/latest.json")
    rm = load("roadmap-bot/out/latest.json")
    old = {c["key"]: c for c in load(f"roadmap-bot/out/facts-{BASELINE_FACTS}.json")["cards"]}
    mapping = load("voc-graph/mapping.json")

    weeks = list(g["windows"])   # 週起始日字串，由舊到新
    theme_names = {t["code"]: t["name"] for t in g["nodes"]["themes"]}
    themes_of = {}
    for e in g["edges"]:
        if e["type"] == "theme_pain":
            themes_of.setdefault(e["to"], []).append(
                {"code": e["from"], "name": theme_names.get(e["from"], ""), "n": e["weight"]})

    pains = []
    for p in g["nodes"]["pains"]:
        s = [x["streamers"] for x in p["stt"]["series"]]
        pains.append({
            "code": p["code"], "title": p["title"], "vocScore": p["voc_score"],
            "series": s, "latest": s[-1], "cards": p["cards"],
            "noOwner": p["status"] == "gap",
            "allZero": not any(s),
            "rule": classify(s),
            "themes": themes_of.get(p["code"], []),
        })

    cards = []
    for c in rm["cards"]:
        cards.append({k: c.get(k) for k in
                      ("key", "summary", "stage", "project_status", "domain", "release_date", "url")})

    worse = []
    for c in rm["cards"]:
        o = old.get(c["key"])
        if not o:
            continue
        if STATUS_RANK.get(c["project_status"], 0) > STATUS_RANK.get(o["project_status"], 0):
            worse.append({"key": c["key"], "summary": c["summary"], "url": c["url"],
                          "what": "狀態變差", "from": o["project_status"], "to": c["project_status"]})
        if o.get("release_date") and c.get("release_date") and c["release_date"] > o["release_date"]:
            worse.append({"key": c["key"], "summary": c["summary"], "url": c["url"],
                          "what": "上線日延後", "from": o["release_date"], "to": c["release_date"]})

    load_rows = []
    for d, v in rm["aggregate"]["domains_by_capacity"].items():
        load_rows.append({"domain": d, "cards": v["cards"], "points": v["points"],
                          "months": v["wip_months"], "verdict": v["wip_verdict"]})

    data = {
        "asOf": g["as_of_date"],
        "weeks": weeks,
        "latestWeek": g["sources"]["stt"]["latest_window"],
        "sttFetched": g["sources"]["stt"]["fetched_date"],
        "sttAgeDays": g["sources"]["stt"]["age_days"],
        "jiraAsOf": rm["as_of_date"],
        "pains": pains,
        "outside": g["views"]["outside_catalog"],
        "unbacked": g["views"]["unbacked_voc_cards"],
        "cards": cards,
        "stages": rm["aggregate"]["stages"],
        "worse": worse,
        "worseSince": BASELINE_FACTS,
        "load": load_rows,
        "baselineExpired": rm["baseline"]["expired"],
        "baselineExpiresAt": rm["baseline"]["expires_at"],
        "upcoming": rm["aggregate"]["upcoming_releases"][:8],
        "editorUrl": mapping.get("_editor_url", ""),
        "rules": {"emergeMin": EMERGE_MIN, "persistMin": PERSIST_MIN},
    }

    # 「<」轉義：JSON 字串裡就算出現 </script> 也不會提早結束 script 區塊
    blob = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
    html = TEMPLATE.read_text(encoding="utf-8").replace("__DATA__", blob)
    OUT.write_text(html, encoding="utf-8")
    n = sum(1 for p in pains if p["rule"]["emerging"])
    m = sum(1 for p in pains if p["rule"]["persistent"])
    print(f"wrote {OUT.relative_to(ROOT)}  新興 {n}／持續 {m}／變差 {len(worse)}")


if __name__ == "__main__":
    main()
