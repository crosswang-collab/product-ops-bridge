#!/usr/bin/env python3
"""
check.py — voc-graph 的驗收員（checker）。

build.py 是 maker，這支是 checker：只讀產出檔，不修改任何東西，每條判定都附證據。
任何一條 FAIL → 整份 FAIL → workflow 不 commit，Vercel 頁面維持前一天的版本。

判定的是 voc-graph/README.md 契約卡裡的 STOP 條件，條件寫死在這裡，不接受 maker 傳入：
  C1 latest.json 能解析，schema_version = 1，必要欄位都在
  C2 latest.json 的 as_of_date = 今天
  C3 Jira 來源日期 = 今天（roadmap-daily 今天有跑成功）
  C4 STT 最新一週的結束日 ≤ 14 天前（ayana 的判定是每週一批，最慢約晚 10 天）
  C5 痛點節點恰好是 catalog.json 的 25 個代碼
  C6 data_quality 沒有 blocker（例：mapping.json 寫了不存在的代碼）
  C7 每一條邊的兩端都存在於節點裡
  C8 輸出檔不含個資或原話欄位（userID / liveStreamID / context / reason / voc_summary_* / 字串型的 stt）
  C9 graph-<今天>.json 存在且與 latest.json 內容相同
  C10 抽驗：每個痛點的最新人數，與 stt-latest.json 原始列逐一相符（驗證 build 沒有接錯）

Exit code：0 = PASS / 2 = FAIL / 3 = 崩潰（連檔案都讀不了，視同 FAIL）
"""

import argparse
import datetime as dt
import json
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
STT_MAX_AGE_DAYS = 14
FORBIDDEN_KEYS = {"userID", "liveStreamID", "context", "reason", "reason_primary",
                  "voc_summary_primary", "voc_summary_secondary", "utt_key"}
REQUIRED_KEYS = {"schema_version", "as_of_date", "sources", "nodes", "edges", "views", "data_quality"}


def find_forbidden(obj, path="$"):
    hits = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            p = f"{path}.{k}"
            if k in FORBIDDEN_KEYS or (k == "stt" and isinstance(v, str)):
                hits.append(p)
            hits += find_forbidden(v, p)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            hits += find_forbidden(v, f"{path}[{i}]")
    return hits


def run(out_dir, catalog_path, today):
    results = []  # (條件, PASS/FAIL, 證據)

    def rec(name, ok, evidence):
        results.append((name, "PASS" if ok else "FAIL", evidence))

    latest_path = os.path.join(out_dir, "latest.json")
    stt_path = os.path.join(out_dir, "stt-latest.json")

    try:
        g = json.load(open(latest_path, encoding="utf-8"))
    except Exception as e:
        rec("C1 格式", False, f"{latest_path} 無法解析：{e}")
        return results
    missing = REQUIRED_KEYS - set(g)
    rec("C1 格式", g.get("schema_version") == 1 and not missing,
        f"schema_version={g.get('schema_version')}，缺欄位={sorted(missing) or '無'}")

    rec("C2 今天的圖", g.get("as_of_date") == today, f"as_of_date={g.get('as_of_date')}，今天={today}")

    jira_date = (g.get("sources", {}).get("jira") or {}).get("as_of_date")
    rec("C3 Jira 是今天", jira_date == today, f"sources.jira.as_of_date={jira_date}")

    lw = (g.get("sources", {}).get("stt") or {}).get("latest_window")
    if lw:
        age = (dt.date.fromisoformat(today) - dt.date.fromisoformat(lw["end"])).days
        rec("C4 STT 夠新", age <= STT_MAX_AGE_DAYS,
            f"最新窗結束於 {lw['end']}，{age} 天前（上限 {STT_MAX_AGE_DAYS}）")
    else:
        rec("C4 STT 夠新", False, "sources.stt.latest_window = null（沒有 STT 資料）")

    catalog = json.load(open(catalog_path, encoding="utf-8"))
    want = {p["code"] for p in catalog["pains"]}
    got = [p.get("code") for p in g.get("nodes", {}).get("pains", [])]
    rec("C5 25 痛點齊全", len(got) == len(want) == 25 and set(got) == want,
        f"節點 {len(got)} 個；少了 {sorted(want - set(got)) or '無'}；多了 {sorted(set(got) - want) or '無'}")

    blockers = [d["msg"] for d in g.get("data_quality", []) if d.get("level") == "blocker"]
    rec("C6 沒有 blocker", not blockers, "；".join(blockers) or "data_quality 無 blocker")

    nodes = g.get("nodes", {})
    pain_ids = {p["code"] for p in nodes.get("pains", [])}
    theme_ids = {t["code"] for t in nodes.get("themes", [])}
    bad_edges = []
    for e in g.get("edges", []):
        if e.get("type") == "theme_pain" and not (e["from"] in theme_ids and e["to"] in pain_ids):
            bad_edges.append(f"{e['from']}→{e['to']}")
        elif e.get("type") == "pain_card" and e["from"] not in pain_ids:
            bad_edges.append(f"{e['from']}→{e['to']}")
        elif e.get("type") not in ("theme_pain", "pain_card"):
            bad_edges.append(f"未知邊型 {e.get('type')}")
    rec("C7 邊的兩端都存在", not bad_edges,
        f"{len(g.get('edges', []))} 條邊；斷掉的：{bad_edges[:5] or '無'}")

    leaks = find_forbidden(g)
    if os.path.exists(stt_path):
        leaks += [f"stt-latest.json:{p}" for p in find_forbidden(json.load(open(stt_path, encoding="utf-8")))]
    rec("C8 不含個資／原話", not leaks, f"違規欄位：{leaks[:5] or '無'}")

    snap = os.path.join(out_dir, f"graph-{today}.json")
    same = os.path.exists(snap) and json.load(open(snap, encoding="utf-8")) == g
    rec("C9 當日快照", same, f"{snap} {'存在且與 latest.json 相同' if same else '不存在或內容不同'}")

    if lw and os.path.exists(stt_path):
        stt = json.load(open(stt_path, encoding="utf-8"))
        raw = {r["code"]: r["streamers"] for r in stt.get("pains", []) if r["window_start"] == lw["start"]}
        diffs = [f"{p['code']}: 圖={p['stt']['latest']} 原始={raw.get(p['code'], 0)}"
                 for p in nodes.get("pains", []) if p["stt"]["latest"] != raw.get(p["code"], 0)]
        rec("C10 人數抽驗", not diffs, f"25 個痛點逐一比對；不符：{diffs[:5] or '無'}")
    else:
        rec("C10 人數抽驗", False, "沒有 STT 原始檔可比對")

    return results


def render(results, today):
    verdict = "PASS" if all(r[1] == "PASS" for r in results) else "FAIL"
    lines = [f"## voc-graph 驗收 — VERDICT: {verdict}（{today}）", "",
             "| 條件 | 判定 | 證據 |", "|---|---|---|"]
    lines += [f"| {n} | {'✅ PASS' if s == 'PASS' else '❌ FAIL'} | {e} |" for n, s, e in results]
    return verdict, "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--catalog", default=os.path.join(HERE, "catalog.json"))
    ap.add_argument("--today", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    args = ap.parse_args()

    try:
        results = run(args.out, args.catalog, args.today)
    except Exception:
        print("[CRASH] 驗收途中崩潰，視同 FAIL：")
        traceback.print_exc()
        return 3

    verdict, md = render(results, args.today)
    print(md)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(md + "\n")
    return 0 if verdict == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
