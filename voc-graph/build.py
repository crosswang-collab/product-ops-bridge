#!/usr/bin/env python3
"""
build.py — 把三份事實接成一張圖：STT 聲音 → VoC 痛點 → Jira 卡。

不呼叫任何 LLM、不連網。只讀 repo 裡已經存在的檔：
  · catalog.json                      VoC roadmap 25 痛點 + STT F 主題（節點清單）
  · ../roadmap-bot/out/latest.json    Jira 每日事實層（roadmap-daily 產出）
  · out/stt-latest.json               STT 聚合（gas/SttExport.gs 以 Cross 身分讀 BigQuery 後推入）
  · mapping.json                      痛點 → Jira 卡（人工維護，唯一的人工輸入）

產出：
  · out/graph-YYYY-MM-DD.json   當日快照，append-only
  · out/latest.json             頁面固定讀這支
  · out/brief-YYYY-MM-DD.md     人看的每日摘要（也會貼進 GitHub job summary）

回答三個問題：
  1. 哪些痛點／主題的聲音在變多？對應的卡在哪個階段？      → views.rising
  2. 哪些痛點聲音不少，卻沒有任何卡接著？                  → views.gaps
  3. 哪些標了 [VoC] 的卡，對不到任何痛點？                  → views.unbacked_voc_cards

這支只負責「產出」，不負責判定產出合不合格 —— 那是 check.py 的工作（maker/checker 分離）。

Exit code：0 = 寫出檔案 / 3 = 崩潰（輸入檔壞掉或不存在）
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))

READ_FLOOR = 10        # 低於 10 人不讀動向（跟 ayana 週報同一條規則）
RISING_PCT = 0.20      # 前週比 +20% 以上算「在變多」
HISTORY_DAYS = 120     # 對應表候選：最近 120 天內離開 active 的卡
VOC_TAG_RE = re.compile(r"\[[^\]]*VoC[^\]]*\]", re.IGNORECASE)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def series_by_code(rows, window_starts):
    """[{window_start, code, streamers, ...}] → {code: {window_start: row}}"""
    out = {}
    for r in rows:
        if r["window_start"] in window_starts:
            out.setdefault(r["code"], {})[r["window_start"]] = r
    return out


def summarize(code_rows, window_starts):
    """一個代碼在各週的人數序列 + 最新週 + 前週比。"""
    pts = []
    for ws in window_starts:
        r = code_rows.get(ws) if code_rows else None
        pts.append({"window_start": ws, "streamers": r["streamers"] if r else 0})
    latest_row = code_rows.get(window_starts[-1]) if (code_rows and window_starts) else None
    latest = pts[-1]["streamers"] if pts else 0
    prev = pts[-2]["streamers"] if len(pts) >= 2 else None
    delta = round((latest - prev) / prev, 3) if prev else None
    return {
        "series": pts,
        "latest": latest,
        "prev": prev,
        "delta_pct": delta,
        "readable": latest >= READ_FLOOR,
        "stop_streamers": latest_row["stop_streamers"] if latest_row else 0,
        "top_streamers": latest_row["top_streamers"] if latest_row else 0,
        "sample_hit_ids": latest_row.get("sample_hit_ids", []) if latest_row else [],
    }


def load_left_cards(roadmap_dir, active_keys, today, days=HISTORY_DAYS):
    """最近 N 天的每日快照裡出現過、但現在已不在 active 的卡（多半是已發布）。
    給對應表編輯頁當候選，也讓「已離開 active」的卡能顯示卡名。"""
    floor = (dt.date.fromisoformat(today) - dt.timedelta(days=days)).isoformat()
    left = {}
    for f in sorted(glob.glob(os.path.join(roadmap_dir, "facts-*.json"))):
        d = os.path.basename(f)[6:16]
        if d < floor:
            continue
        try:
            snap = load(f)
        except Exception:
            continue
        for c in snap.get("cards", []):
            if c["key"] not in active_keys:
                left[c["key"]] = {"key": c["key"], "summary": c.get("summary"), "last_stage": c.get("stage"),
                                  "last_seen": d, "url": c.get("url")}
    return sorted(left.values(), key=lambda x: x["last_seen"], reverse=True)


def build(catalog, roadmap, stt, mapping, today, left_cards=()):
    dq = []  # data quality: {level: blocker|warn|info, msg}

    # ── Jira 卡 ─────────────────────────────────────────────
    cards = {c["key"]: c for c in roadmap.get("cards", [])}
    left_by_key = {c["key"]: c for c in left_cards}
    pain_codes = {p["code"] for p in catalog["pains"]}
    m = mapping.get("pain_to_cards", {}) or {}

    for code in m:
        if code not in pain_codes:
            dq.append({"level": "blocker",
                       "msg": f"mapping.json 有不存在的痛點代碼「{code}」（只能用 catalog.json 的 25 個）"})

    card_to_pains = {}
    for code, keys in m.items():
        for k in keys or []:
            card_to_pains.setdefault(k, []).append(code)

    # ── STT ─────────────────────────────────────────────────
    if stt:
        windows = sorted(stt.get("windows", []), key=lambda w: w["window_start"])
        window_starts = [w["window_start"] for w in windows]
        pain_rows = series_by_code(stt.get("pains", []), set(window_starts))
        theme_rows = series_by_code(stt.get("themes", []), set(window_starts))
        prompts = sorted({v for w in windows[-2:] for v in (w.get("prompt_versions") or []) if v})
        if len(prompts) > 1:
            dq.append({"level": "warn",
                       "msg": f"最近兩週的判定 prompt 版本不同（{', '.join(prompts)}），前週比可能不是同一把尺"})
    else:
        windows, window_starts, pain_rows, theme_rows = [], [], {}, {}
        dq.append({"level": "blocker", "msg": "沒有 STT 資料（out/stt-latest.json 不存在）"})

    # ── 痛點節點 ────────────────────────────────────────────
    pains = []
    for p in catalog["pains"]:
        code = p["code"]
        s = summarize(pain_rows.get(code), window_starts)
        mapped = m.get(code, []) or []
        linked = []
        for k in mapped:
            c = cards.get(k)
            linked.append({
                "key": k,
                "active": c is not None,
                "summary": c["summary"] if c else (left_by_key.get(k) or {}).get("summary"),
                "stage": c["stage"] if c else None,
                "last_seen": None if c else (left_by_key.get(k) or {}).get("last_seen"),
                "project_status": c.get("project_status") if c else None,
                "release_date": c.get("release_date") if c else None,
                "url": c["url"] if c else f"https://17media.atlassian.net/browse/{k}",
            })
        if any(x["active"] for x in linked):
            status = "covered"
        elif linked:
            status = "card_left"      # 有對應過卡，但卡已不在 active（做完／關掉／停車場）
        elif s["readable"]:
            status = "gap"            # 聲音 ≥ 10 人，卻沒有任何卡
        else:
            status = "quiet"
        pains.append({**p, "stt": s, "cards": linked, "status": status})

    # ── F 主題節點 ──────────────────────────────────────────
    themes = []
    for t in catalog["themes"]:
        themes.append({**t, "stt": summarize(theme_rows.get(t["code"]), window_starts)})

    # ── 卡片節點 ────────────────────────────────────────────
    card_nodes = []
    for k, c in cards.items():
        card_nodes.append({
            "key": k, "summary": c["summary"], "stage": c["stage"],
            "project_status": c.get("project_status"), "domain": c.get("domain"),
            "release_date": c.get("release_date"), "url": c["url"],
            "voc_tagged": bool(VOC_TAG_RE.search(c["summary"] or "")),
            "pains": sorted(card_to_pains.get(k, [])),
        })

    # ── 邊 ──────────────────────────────────────────────────
    edges = []
    latest_ws = window_starts[-1] if window_starts else None
    theme_codes = {t["code"] for t in catalog["themes"]}
    for r in (stt or {}).get("theme_pain", []):
        if r["window_start"] == latest_ws and r["pain"] in pain_codes and r["theme"] in theme_codes:
            edges.append({"from": r["theme"], "to": r["pain"], "type": "theme_pain",
                          "weight": r["streamers"]})
    for code, keys in m.items():
        if code not in pain_codes:
            continue
        for k in keys or []:
            edges.append({"from": code, "to": k, "type": "pain_card", "active": k in cards})

    # ── 三個問題 ────────────────────────────────────────────
    def rising_item(kind, n):
        return {"kind": kind, "code": n["code"],
                "name": n.get("title") or n.get("name"),
                "latest": n["stt"]["latest"], "prev": n["stt"]["prev"],
                "delta_pct": n["stt"]["delta_pct"], "stop_streamers": n["stt"]["stop_streamers"],
                "status": n.get("status")}

    rising = [rising_item("pain", p) for p in pains
              if p["stt"]["readable"] and (p["stt"]["delta_pct"] or 0) >= RISING_PCT]
    rising += [rising_item("theme", t) for t in themes
               if t["stt"]["readable"] and (t["stt"]["delta_pct"] or 0) >= RISING_PCT]
    rising.sort(key=lambda x: -(x["delta_pct"] or 0))

    gaps = sorted([{"code": p["code"], "title": p["title"], "latest": p["stt"]["latest"],
                    "delta_pct": p["stt"]["delta_pct"], "voc_score": p["voc_score"]}
                   for p in pains if p["status"] == "gap"], key=lambda x: -x["latest"])

    unbacked = [{"key": c["key"], "summary": c["summary"], "stage": c["stage"],
                 "project_status": c["project_status"], "url": c["url"]}
                for c in card_nodes if c["voc_tagged"] and not c["pains"]]

    outside = []
    if latest_ws:
        for code, rows in pain_rows.items():
            if code not in pain_codes and latest_ws in rows:
                outside.append({"code": code, "latest": rows[latest_ws]["streamers"]})
        outside.sort(key=lambda x: -x["latest"])

    for p in pains:
        for x in p["cards"]:
            if not x["active"]:
                dq.append({"level": "info",
                           "msg": f"{p['code']} 對應的 {x['key']} 已不在 active（做完／關掉／移到停車場？）"})

    latest_w = windows[-1] if windows else None
    stt_age = ((dt.date.fromisoformat(today) - dt.date.fromisoformat(latest_w["window_end"])).days
               if latest_w else None)

    return {
        "schema_version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "as_of_date": today,
        "sources": {
            "jira": {"as_of_date": roadmap.get("as_of_date"), "active_cards": len(cards)},
            "stt": {
                "latest_window": ({"start": latest_w["window_start"], "end": latest_w["window_end"]}
                                  if latest_w else None),
                "age_days": stt_age,
                "fetched_date": stt.get("fetched_date") if stt else None,
                "board_streamers": latest_w["board_streamers"] if latest_w else None,
                "definitions": stt.get("definitions") if stt else None,
            },
            "voc_roadmap": {"pains": len(catalog["pains"]), "source": catalog["_source"]["pains"]},
            "mapping": {"pains_mapped": sum(1 for c in m if m[c]), "cards_mapped": len(card_to_pains)},
        },
        "rules": {"read_floor": READ_FLOOR, "rising_pct": RISING_PCT},
        "windows": window_starts,
        "nodes": {"pains": pains, "themes": themes, "cards": card_nodes, "left_cards": list(left_cards)},
        "edges": edges,
        "views": {"rising": rising, "gaps": gaps, "unbacked_voc_cards": unbacked,
                  "outside_catalog": outside},
        "data_quality": dq,
    }


def pct(x):
    return "—" if x is None else f"{x:+.0%}"


def brief_md(g):
    s = g["sources"]
    v = g["views"]
    lw = s["stt"]["latest_window"]
    lines = [
        f"# VoC × Roadmap 每日圖 — {g['as_of_date']}",
        "",
        f"- Jira：{s['jira']['as_of_date']}（active {s['jira']['active_cards']} 張）",
        f"- STT：最新窗 {lw['start']}〜{lw['end']}（{s['stt']['age_days']} 天前）" if lw else "- STT：**沒有資料**",
        f"- 對應表：{s['mapping']['pains_mapped']}/25 個痛點有對應卡",
        "",
        f"## 1. 聲音在變多（≥{g['rules']['read_floor']} 人且前週比 ≥ +{g['rules']['rising_pct']:.0%}）",
    ]
    lines += [f"- {x['code']} {x['name']}：{x['prev']}→{x['latest']} 人（{pct(x['delta_pct'])}）"
              + (f"・sTop {x['stop_streamers']}" if x["stop_streamers"] else "")
              + (f"・**沒有卡**" if x.get("status") == "gap" else "")
              for x in v["rising"]] or ["- 無"]
    lines += ["", "## 2. 有聲音、沒有卡"]
    lines += [f"- {x['code']} {x['title']}：{x['latest']} 人（{pct(x['delta_pct'])}）" for x in v["gaps"]] or ["- 無"]
    lines += ["", "## 3. 標了 [VoC] 但對不到痛點的卡"]
    lines += [f"- {x['key']} {x['summary']}（{x['stage']}）" for x in v["unbacked_voc_cards"]] or ["- 無"]
    lines += ["", "## 4. STT 有、VoC 25 痛點沒有的代碼"]
    lines += [f"- {x['code']}：{x['latest']} 人" for x in v["outside_catalog"]] or ["- 無"]
    if g["data_quality"]:
        lines += ["", "## 資料品質"]
        lines += [f"- [{d['level']}] {d['msg']}" for d in g["data_quality"]]
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default=os.path.join(HERE, "catalog.json"))
    ap.add_argument("--roadmap", default=os.path.join(HERE, "..", "roadmap-bot", "out", "latest.json"))
    ap.add_argument("--stt", default=os.path.join(HERE, "out", "stt-latest.json"))
    ap.add_argument("--mapping", default=os.path.join(HERE, "mapping.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--today", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    args = ap.parse_args()

    try:
        catalog = load(args.catalog)
        roadmap = load(args.roadmap)
        mapping = load(args.mapping)
        stt = load(args.stt) if os.path.exists(args.stt) else None
        left = load_left_cards(os.path.dirname(os.path.abspath(args.roadmap)),
                               {c["key"] for c in roadmap.get("cards", [])}, args.today)
        g = build(catalog, roadmap, stt, mapping, args.today, left)
    except Exception:
        print("[CRASH] 讀不到輸入檔或格式壞掉：")
        traceback.print_exc()
        return 3

    os.makedirs(args.out, exist_ok=True)
    for name in (f"graph-{args.today}.json", "latest.json"):
        with open(os.path.join(args.out, name), "w", encoding="utf-8") as f:
            json.dump(g, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, f"brief-{args.today}.md"), "w", encoding="utf-8") as f:
        f.write(brief_md(g))

    v = g["views"]
    print(f"[OK] graph-{args.today}.json：變多 {len(v['rising'])}／沒卡 {len(v['gaps'])}／"
          f"VoC 卡沒對應 {len(v['unbacked_voc_cards'])}／資料品質 {len(g['data_quality'])} 條")
    return 0


if __name__ == "__main__":
    sys.exit(main())
