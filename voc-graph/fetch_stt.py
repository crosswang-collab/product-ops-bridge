#!/usr/bin/env python3
"""
fetch_stt.py — 從 BigQuery 把 STT-VoC 判定結果抓成「只有數字」的事實層 JSON。

來源：media17-1119.DataLab_Ayana.stt_voc_judgments      → F 主題（ayana 的 Gemini 判定）
      media17-1119.DataLab_Ayana.stt_voc_weekly_metrics  → 25 痛點（週報「定点」，正規表現檢知）

這支只做事實，不呼叫任何 LLM，也不碰原話：
  · 聚合全部在 BigQuery 裡做完，userID / stt / context 從來不離開 BigQuery。
  · 輸出只有 人數、件數、代碼、hit_id（hit_id 可回 BigQuery 查原文，社外不可，但本身不是個資）。
  · check.py 會掃輸出檔，出現 userID / stt / context 等欄位一律 FAIL。

定義（跟 ayana 週報對齊，但不保證數字完全一致 —— 週報的「定点」是從精讀池用正規表現數的，
這裡用的是判定表，母體不同）：
  · 看板列（board）  = priority='P1' ∧ exist='TRUE_PAIN' ∧ actionability ∈ {PRODUCT_ACTIONABLE, OPERATION_ACTIONABLE}
                       → F 主題的人數用這個母體（＝週報「Fテーマ推移」的定義）
  · 痛點（pain）      = weekly_metrics 的 metric_type='pain25'（＝週報「定点ルート」，不經 Gemini）
                       → VoC roadmap 25 痛點的人數用這個；判定表只收 P1+4 lane，大部分痛點進不去
  · 人數 = COUNT(DISTINCT userID)，是主指標；件數只當輔助（多話的人會灌件數）

跑法：
  # 需要 GOOGLE_APPLICATION_CREDENTIALS 指向有 BigQuery 讀取權的服務帳號
  python3 fetch_stt.py --out out/

Exit code（跟 roadmap-bot/extract.py 同一套約定）：
  0 = 正常跑完
  2 = 資料有結構性問題（欄位值出現沒見過的種類 → 定義可能變了，要人看）
  3 = 程式崩潰／連不上 BigQuery
  1 不使用（Python 未捕捉例外的預設值，不可以有「正常」的語意）
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import traceback

TABLE = "media17-1119.DataLab_Ayana.stt_voc_judgments"
METRICS_TABLE = "media17-1119.DataLab_Ayana.stt_voc_weekly_metrics"
BILLING_PROJECT = os.environ.get("GCP_BILLING_PROJECT", "media17-1119")
LOOKBACK_DAYS = 63  # 9 週：夠畫趨勢，又不會每天掃太多

BOARD_ACTIONABILITY = ("PRODUCT_ACTIONABLE", "OPERATION_ACTIONABLE")
# 已知的欄位值。出現清單外的值 = pipeline 的定義變了，必須停下來讓人看，不能默默算錯。
KNOWN_EXIST = {"TRUE_PAIN", "TOPIC", "NOISE", ""}
KNOWN_TIER = {"sTop", "Top", "Regular", "無印", ""}
PAIN_CODE_RE = r"[SUX][0-9]\.[0-9]"

EXIT_OK, EXIT_DATA, EXIT_CRASH = 0, 2, 3


# ═══════════════════════════════════════════════════════════════════
# SQL：全部在 BigQuery 裡聚合。這幾支查詢的輸出都不含 userID 與原話。
# ═══════════════════════════════════════════════════════════════════

SQL_BASE = f"""
WITH base AS (
  SELECT
    window_start, window_end, hit_id, userID,
    IFNULL(priority, '') AS priority,
    IFNULL(exist, '') AS exist,
    IFNULL(actionability, '') AS actionability,
    IFNULL(tier, '') AS tier,
    IFNULL(prompt_version, '') AS prompt_version,
    IFNULL(dict_version, '') AS dict_version,
    ARRAY(SELECT TRIM(c) FROM UNNEST(SPLIT(IFNULL(catalog, ''), '/')) c WHERE TRIM(c) != '') AS themes,
    ARRAY(SELECT DISTINCT p FROM UNNEST(REGEXP_EXTRACT_ALL(IFNULL(pain25_tags, ''), r'{PAIN_CODE_RE}')) p) AS pains
  FROM `{TABLE}`
  WHERE window_start >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL {LOOKBACK_DAYS} DAY)
),
board AS (
  SELECT * FROM base
  WHERE priority = 'P1' AND exist = 'TRUE_PAIN'
    AND actionability IN {BOARD_ACTIONABILITY}
)
"""

SQL_VALUES = SQL_BASE + """
SELECT
  ARRAY_AGG(DISTINCT exist) AS exist_values,
  ARRAY_AGG(DISTINCT tier) AS tier_values,
  ARRAY_AGG(DISTINCT priority) AS priority_values,
  COUNT(*) AS rows_total
FROM base
"""

SQL_WINDOWS = SQL_BASE + """
SELECT
  w.window_start, w.window_end, w.judged_rows, w.true_pain_rows,
  IFNULL(b.board_rows, 0) AS board_rows,
  IFNULL(b.board_streamers, 0) AS board_streamers,
  w.prompt_versions, w.dict_versions
FROM (
  SELECT window_start, window_end,
    COUNT(*) AS judged_rows,
    COUNTIF(exist = 'TRUE_PAIN') AS true_pain_rows,
    ARRAY_AGG(DISTINCT prompt_version) AS prompt_versions,
    ARRAY_AGG(DISTINCT dict_version) AS dict_versions
  FROM base GROUP BY window_start, window_end
) w
LEFT JOIN (
  SELECT window_start, COUNT(*) AS board_rows, COUNT(DISTINCT userID) AS board_streamers
  FROM board GROUP BY window_start
) b USING (window_start)
ORDER BY w.window_start
"""

SQL_THEMES = SQL_BASE + """
SELECT
  window_start, theme AS code,
  COUNT(DISTINCT userID) AS streamers,
  COUNT(*) AS rows_n,
  COUNT(DISTINCT IF(tier = 'sTop', userID, NULL)) AS stop_streamers,
  COUNT(DISTINCT IF(tier = 'Top', userID, NULL)) AS top_streamers,
  ARRAY_AGG(hit_id ORDER BY hit_id LIMIT 3) AS sample_hit_ids
FROM board, UNNEST(themes) AS theme
GROUP BY window_start, theme
ORDER BY window_start, streamers DESC
"""

# 25 痛點不能用判定表算：判定表只收 P1 + 4 條固定 lane，U4.1／U4.4 這類痛點根本進不去
# （2026-10-05 實測：09/21 窗判定表只出現 5 種代碼）。改讀 weekly_metrics 的 pain25，
# 這就是 ayana 週報「定点ルート」的來源 —— 09/14 窗 X1.0=277／S2.1=233／S2.0=154／
# U4.1=100／U4.4=76 與週報逐一相符。定点是正規表現檢知，不經 Gemini 判定，也沒有 tier。
# 同一窗被重建過（例：9/29 補日曜）會有多次 loaded_at，只取最新那次。
SQL_PAINS = f"""
SELECT
  window_start,
  REGEXP_EXTRACT(metric_key, r'^({PAIN_CODE_RE})') AS code,
  n_liver AS streamers,
  n_seg AS rows_n,
  CAST(NULL AS INT64) AS stop_streamers,
  CAST(NULL AS INT64) AS top_streamers,
  ARRAY<STRING>[] AS sample_hit_ids
FROM `{METRICS_TABLE}`
WHERE metric_type = 'pain25'
  AND REGEXP_CONTAINS(metric_key, r'^{PAIN_CODE_RE}')
  AND window_start >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL {LOOKBACK_DAYS} DAY)
QUALIFY ROW_NUMBER() OVER (PARTITION BY window_start, metric_key ORDER BY loaded_at DESC) = 1
ORDER BY window_start, streamers DESC
"""

SQL_THEME_PAIN = SQL_BASE + """
SELECT
  window_start, theme, pain,
  COUNT(DISTINCT userID) AS streamers
FROM base, UNNEST(themes) AS theme, UNNEST(pains) AS pain
WHERE exist = 'TRUE_PAIN'
GROUP BY window_start, theme, pain
HAVING streamers >= 2
ORDER BY window_start, streamers DESC
"""


# ═══════════════════════════════════════════════════════════════════

def run_query(client, sql, label):
    """暫時性錯誤（429/5xx/逾時）重試 3 次；其他錯誤直接往上丟。"""
    from google.api_core import exceptions as gexc
    transient = (gexc.TooManyRequests, gexc.InternalServerError, gexc.BadGateway,
                 gexc.ServiceUnavailable, gexc.GatewayTimeout)
    for attempt in range(1, 4):
        try:
            rows = list(client.query(sql, job_config=None).result(timeout=300))
            print(f"[OK] {label}: {len(rows)} 列")
            return [dict(r) for r in rows]
        except transient as e:
            if attempt == 3:
                raise
            wait = 2 ** attempt
            print(f"[RETRY] {label} 暫時性錯誤（第 {attempt} 次）：{e}；{wait} 秒後重試")
            time.sleep(wait)


def _jsonable(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


def _clean(rows):
    return [{k: _jsonable(v) for k, v in r.items()} for r in rows]


def validate_values(vals):
    """出現沒見過的欄位值 → 回傳問題清單（非空 = blocker）。"""
    problems = []
    exist_vals = set(vals.get("exist_values") or [])
    tier_vals = set(vals.get("tier_values") or [])
    prio_vals = set(vals.get("priority_values") or [])
    if not vals.get("rows_total"):
        problems.append(f"{TABLE} 最近 {LOOKBACK_DAYS} 天沒有任何列（pipeline 停了？還是表換了？）")
    if exist_vals - KNOWN_EXIST:
        problems.append(f"exist 出現沒見過的值：{sorted(exist_vals - KNOWN_EXIST)}")
    if tier_vals - KNOWN_TIER:
        problems.append(f"tier 出現沒見過的值：{sorted(tier_vals - KNOWN_TIER)}")
    if "P1" not in prio_vals:
        problems.append(f"priority 裡沒有 'P1'（實際值：{sorted(prio_vals)}）→ 看板定義對不上")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out/")
    args = ap.parse_args()

    try:
        from google.cloud import bigquery
    except ImportError:
        print("[CRASH] 沒有安裝 google-cloud-bigquery（pip install google-cloud-bigquery）")
        return EXIT_CRASH

    try:
        client = bigquery.Client(project=BILLING_PROJECT)
        vals = run_query(client, SQL_VALUES, "欄位值檢查")[0]
        problems = validate_values(vals)
        if problems:
            print("[BLOCKER] STT 判定表的欄位值跟預期不一樣，不寫檔：")
            for p in problems:
                print("    " + p)
            return EXIT_DATA

        windows = _clean(run_query(client, SQL_WINDOWS, "週次摘要"))
        themes = _clean(run_query(client, SQL_THEMES, "F 主題"))
        pains = _clean(run_query(client, SQL_PAINS, "25 痛點"))
        theme_pain = _clean(run_query(client, SQL_THEME_PAIN, "主題×痛點共現"))
    except Exception:
        print("[CRASH] 讀 BigQuery 失敗：")
        traceback.print_exc()
        return EXIT_CRASH

    if not pains:
        print(f"[BLOCKER] {METRICS_TABLE} 最近 {LOOKBACK_DAYS} 天沒有 metric_type='pain25' 的列，"
              "25 痛點會全部變 0 —— 不寫檔。")
        return EXIT_DATA

    for r in themes + pains:
        r["rows"] = r.pop("rows_n")

    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    doc = {
        "schema_version": 1,
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "fetched_date": today,
        "source_table": TABLE,
        "lookback_days": LOOKBACK_DAYS,
        "definitions": {
            "board": "priority='P1' ∧ exist='TRUE_PAIN' ∧ actionability ∈ PRODUCT/OPERATION_ACTIONABLE（F 主題母體）",
            "pain": "stt_voc_weekly_metrics 的 pain25（＝週報定点：正規表現檢知，不經 Gemini 判定，無 tier）",
            "streamers": "COUNT(DISTINCT userID)，主指標",
            "precision_note": "Gemini 判定適合率 77–86%、再現率 96–100%（ayana n=90 盲檢）→ 人數約多算 1–2 成",
        },
        "windows": windows,
        "themes": themes,
        "pains": pains,
        "theme_pain": theme_pain,
    }

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "stt-latest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    latest = windows[-1] if windows else None
    print(f"[OK] → {path}（{len(windows)} 週；最新窗 "
          f"{latest['window_start'] + '〜' + latest['window_end'] if latest else '無'}）")
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(EXIT_CRASH)
