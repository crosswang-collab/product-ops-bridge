#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
roadmap-bot / extract.py — 把 Jira roadmap 卡片正規化成一份事實層 JSON。

這支程式只做「事實」，不做「判讀」。它不呼叫任何 LLM。
判讀層（哪個紅燈是真的、哪個是帳面波動）由 Claude Routine 另外做，讀這支的產出。

═══════════════════════════════════════════════════════════════════
兩種執行模式
═══════════════════════════════════════════════════════════════════

  1) dry-run（今天用這個，不需要 token）
     python3 extract.py --from-file raw.json --out out/

  2) live（正式排程用，需要 Jira API token）
     export JIRA_EMAIL="crosswang@17.media"
     export JIRA_TOKEN="<你的 Atlassian API token>"
     python3 extract.py --live --out out/

產出三個檔（都寫進 --out 指定的目錄）：
     facts-YYYY-MM-DD.json   當日事實快照（給 dashboard 讀、給判讀層讀）
     latest.json             上面那份的複本，dashboard 固定讀這支
     changes-YYYY-MM-DD.md   每日變化報告（人看的：跟上一份快照比動了什麼）

═══════════════════════════════════════════════════════════════════
已知限制（部署前先讀）
═══════════════════════════════════════════════════════════════════

  · 需要「兩個」Jira filter，不是一個：
      filter 16245 → active 卡片（健康度 + 產能）。只含 issuetype = Idea。
      filter 15906 → 發布清單。含 issuetype = Tech 的卡（例：1888 Liquid glass，
                     它有 9/1 發布日但不在 16245 裡）。
    只撈 16245 會漏掉發布卡，「同日集中度」就會低估。dry-run 時第二個母體可省略，
    省略時發布清單會標記 partial=true。
  · Q2 baseline（每個 domain 每月交付幾點）是 PMT 每季手動鎖定的值，
    不存在於 Jira。本程式從 BASELINES 讀，不自己推算。過期會在變化報告警告。
  · 工作日（business day）計算只扣週末，不扣台灣/日本假日。
    PMT 報告的 bd 來自 Jira 自動化欄位，本程式直接讀那個欄位，
    只有在欄位為空時才自己算 —— 自己算的值會標記 estimated=true。
  · Jira 的 status 名稱若被改名，STAGE_MAP 會漏接。漏接不會靜默：
    未知 status 會進變化報告的「未分類」區並讓 exit code = 2。

═══════════════════════════════════════════════════════════════════
exit code（排程靠這個判斷成敗，改動前先看 roadmap-daily.yml）
═══════════════════════════════════════════════════════════════════

    0  正常跑完（有沒有變化都算正常）          → 綠燈，commit
    2  資料有結構性問題，沒寫出東西            → 紅燈
    3  程式崩潰                                → 紅燈

  1 已停用。它原本的意思是「對帳與週報有差異」，但 2026-09-02 起比較
  基準改成「上一份快照」，差異變成常態訊號而不是警告，這個 code 就沒有
  意義了。**不要拿 1 來表示別的東西** —— Python 未捕捉的例外預設就是
  exit 1，一旦 1 有了「正常」的語意，當機就會被當成成功放行。
  2026-08-31 真的發生過一次：程式炸了、workflow 綠燈、什麼都沒寫。
  所以任何走不下去的錯誤都要 raise HardStop（→ 2）。
"""

import argparse
import base64
import datetime as dt
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request


class HardStop(Exception):
    """走不下去、這一輪不會寫出任何檔案的錯誤。

    一律以 exit code 2 結束，讓排程紅燈。
    不要改用 Python 內建的 SystemExit(字串) —— 那會 exit 1，而 exit 1 是
    Python 未捕捉例外的預設值，等於把走不下去偽裝成正常結束。
    """


# ═══════════════════════════════════════════════════════════════════
# CONFIG — 只有這一區要改
# ═══════════════════════════════════════════════════════════════════

CLOUD_HOST = "17media.atlassian.net"

# PMT 週報用的母體。status != Parking lot 是報告自己的規則，
# 但 filter 本身「不含」這個條件 —— 2026-08-24 實測 filter 回 40 張，
# 扣掉 9 張 Parking lot 才是報告口中的 31 張 active。
JQL = "filter = 16245 ORDER BY key ASC"

# 發布清單的母體。與上面是「不同的集合」，不是子集：
# 16245 只含 issuetype = Idea；15906 另含 Tech 卡（實測 1888 [iOS] Liquid glass
# 有 9/1 發布日、status = Delivery-Develop In Progress，但不在 16245 內）。
# 少撈這個母體 → 發布集中度會低估 → 「9/1 有幾張」這個最可行動的訊號會失真。
RELEASE_JQL = "filter = 15906 ORDER BY key ASC"

# 從 active 集合中排除的 status。
EXCLUDED_STATUSES = {"Parking lot"}

# Jira 自訂欄位對應。
# 「已查證」= 2026-08-24 用 APPIDEAS-1938 逐欄比對 PMT 8/21 報告的數字確認過。
# 「推定」  = 值的形狀合理但沒有欄位名可證，第一次跑請人工核對對帳報告。
FIELDS = {
    "effort_points":   "customfield_10425",  # 已查證：1938=2，報告記 S=2
    "size_letter":     "customfield_10645",  # 已查證：1938="S"
    "stage_duration":  "customfield_12515",  # 已查證：1938=32bd，8/24 留言記 32 days
    "project_status":  "customfield_10636",  # 已查證：1938="At Risk"
    "domain":          "customfield_10658",  # 已查證：1938="Internal Tool"
    "horizon":         "customfield_10657",  # 已查證：1938="Now"（Now/Next/Candidate）
    "discovery_start": "customfield_10561",  # 已查證：報告明寫 10561 = Discovery Start
    "design_start":    "customfield_11120",  # 已查證：報告明寫 11120 = Design Start
    "tech_design_end": "customfield_12212",  # 已查證：報告明寫 12212 = Tech Design End
    "release_date":    "customfield_10436",  # 已查證：1927/1910/2212 皆 2026-09-01 = 報告§4 的 9/1
    "config_on":       "customfield_10610",  # 已查證：1927=9/7（卡片內文寫「9/7 Config on」），非發布日
    "teams":           "customfield_10430",  # 已查證：1758 讀到 ["Feature team","Data"]，
                                             # 與 8/21 報告註解「1758 的 Teams 含 Data」完全吻合
}

# Jira 的 domain 選項大小寫不一致（實測有 "Live commerce" 小寫 c）。
# 一律過這張表正規化，否則 baseline 查不到會靜默變成「無基準」。
DOMAIN_CANON = {
    "17app": "17App",
    "internal tool": "Internal Tool",
    "ist": "IST",
    "live commerce": "Live Commerce",
    "platform": "Platform",
}

# ★關鍵★ Teams → domain 產能池。
# PMT 的產能表是用「參與團隊」歸戶，不是用卡片的 owner domain
#（報告原文：「供給以 Teams（實際參與團隊）計算」「跨團隊卡片對每個參與團隊都計入完整 effort」）。
# 2026-08-24 用 8/21 報告逐 domain 反推驗證，四個 domain 的卡數與點數全部精確吻合：
#   Feature team        → 17App          9 張 24 pts ✓
#   Billing + Webapp    → Internal Tool  7 張 16 pts ✓
#   IST                 → IST            9 張 24 pts ✓（含當時還在的 2155）
#   Live Commerce       → Live Commerce  5 張 11 pts ✓
#   Platform + Eventory → Platform       6 張 18 pts ✓
TEAM_TO_DOMAIN = {
    "Feature team":  "17App",
    "Billing":       "Internal Tool",
    "Webapp":        "Internal Tool",
    "IST":           "IST",
    "Live Commerce": "Live Commerce",
    "Platform":      "Platform",
    "Eventory":      "Platform",
    # "Data" 刻意不對應 —— 8/21 報告明講它「不在 domain 對應表中，投入沒有被任何 domain 代表」。
    # 保持不對應，讓它出現在對帳報告的孤兒清單裡，而不是被偷偷塞進某個池子。
}

# status → 四個 stage 桶。PMT 報告的 Discovery/Design/Develop/Impact 就是這樣分的。
STAGE_MAP = {
    "Discovery":                      "Discovery",
    "Design - Story map":             "Design",
    "DESIGN - UX/UI":                 "Design",
    "Design - Refinement":            "Design",
    "Delivery - Develop In Progress": "Develop",
    "Dev/QA Done":                    "Develop",
    "Release":                        "Impact",
    "Impact - Data Collecting":       "Impact",
}

# T-shirt size → effort points。用來交叉檢查 effort_points 欄位。
SIZE_POINTS = {"XS": 1, "S": 2, "M": 3, "L": 4, "XL": 5}

# Q2 baseline：每個 domain 每月交付幾個 effort point。
# 來源：PMT「📈 Roadmap Capacity — 2026/8/21」§2，Q2 凍結值。
# n = 該 domain 在 Q2 已交付的卡數（樣本數，越小越不可信）。
# 下次重算：2026-10-01 季度切換（含 Platform 首個 baseline）。
BASELINES = {
    "17App":         {"pts_per_month": 10.3, "n": None, "cards_per_month": 4.7},
    "Internal Tool": {"pts_per_month": 8.3,  "n": None, "cards_per_month": 3.0},
    "IST":           {"pts_per_month": 4.3,  "n": 5,    "cards_per_month": 1.7},
    "Live Commerce": {"pts_per_month": 2.7,  "n": 3,    "cards_per_month": 1.0},
    "Platform":      {"pts_per_month": None, "n": None, "cards_per_month": None},
}
BASELINE_LOCKED_AT = "2026-08-21"
BASELINE_EXPIRES_AT = "2026-10-01"

# 在途存量判定帶（PMT §2）：<1.5 低於基準 / 1.5-2.5 健康 / 2.5-3.5 過載傾向 / >3.5 過載
WIP_BANDS = [(1.5, "below"), (2.5, "healthy"), (3.5, "warning"), (float("inf"), "overload")]
# 上游存量判定帶（PMT §1）：<0.5 斷炊風險 / 0.5-1.5 中等 / >1.5 充足
UPSTREAM_BANDS = [(0.5, "starving"), (1.5, "medium"), (float("inf"), "ample")]

# ── 比較基準：昨天的自己，不是任何人工報告 ─────────────────────
#
# 2026-09-02 決策（Cross）：Jira 是唯一真實來源，每天直接撈最準；
# 比較對象改成「上一份快照」。
#
# 為什麼不再拿 PMT 週報當基準：
#   · 週報是從 Jira 整理出來的「衍生品」，比 Jira 晚、且經過人工歸納。
#     拿衍生品去驗上游，方向是反的。
#   · 基準固定在某個星期四，之後每天的差異只會越來越大，最後每天都在
#     喊「與週報有差異」—— 讀者會被訓練成無視它。這跟先前拿掉 PASS/FAIL
#     措辭是同一個病。
#   · 「跟昨天比」的差異天生可行動：哪張卡動了、誰的狀態變差了。
#
# 歷史紀錄（不要刪，這是 TEAM_TO_DOMAIN 正確性的唯一證據）：
#   2026-08-24 曾用 PMT 2026-08-21 週報的產能數字反推驗證 TEAM_TO_DOMAIN，
#   四個 domain 的卡數與點數全部精確吻合：
#     17App 9 張 24 pts／Internal Tool 7 張 16 pts／IST 9 張 24 pts／
#     Live Commerce 5 張 11 pts／Platform 6 張 18 pts，Teams 參與計數 36。
#   若日後要重新驗證歸戶邏輯，拿當週的 PMT 報告重跑一次同樣的反推即可。

# project_status 的嚴重度排序，用來判斷「變好」還是「變差」。
STATUS_RANK = {"On track": 0, "Warning": 1, "At Risk": 2}

HTTP_RETRIES = 4
HTTP_BACKOFF_SEC = [2, 4, 8, 16]
TRANSIENT_CODES = {429, 500, 502, 503, 504}


# ═══════════════════════════════════════════════════════════════════
# 小工具
# ═══════════════════════════════════════════════════════════════════

def _date_from_jira(raw):
    """Jira 的日期欄位長成 '{"start":"2026-05-15","end":"2026-05-15"}'（字串包 JSON）。
    也可能已經是 dict，或是 None。三種都吃。回傳 'YYYY-MM-DD' 或 None。"""
    if not raw:
        return None
    obj = raw
    if isinstance(raw, str):
        s = raw.strip()
        if not s.startswith("{"):
            return s[:10] or None
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            return None
    if isinstance(obj, dict):
        return obj.get("start") or obj.get("end") or None
    return None


def _option_value(raw):
    """Jira 單選欄位 = {"value": "..."}；多選 = [{"value": "..."}, ...]。取第一個值。"""
    if raw is None:
        return None
    if isinstance(raw, dict):
        return raw.get("value")
    if isinstance(raw, list) and raw:
        first = raw[0]
        return first.get("value") if isinstance(first, dict) else str(first)
    if isinstance(raw, str):
        return raw
    return None


def _option_values(raw):
    """多選欄位取全部值，回傳 list（可能為空）。"""
    if raw is None:
        return []
    if isinstance(raw, dict):
        v = raw.get("value")
        return [v] if v else []
    if isinstance(raw, list):
        out = []
        for item in raw:
            v = item.get("value") if isinstance(item, dict) else str(item)
            if v:
                out.append(v)
        return out
    if isinstance(raw, str):
        return [raw]
    return []


def _business_days(start_ymd, end_date):
    """只扣週末，不扣假日。僅在 Jira 的 stage_duration 欄位為空時當備援。"""
    if not start_ymd:
        return None
    try:
        cur = dt.date.fromisoformat(start_ymd)
    except ValueError:
        return None
    if cur > end_date:
        return 0
    days = 0
    while cur < end_date:
        cur += dt.timedelta(days=1)
        if cur.weekday() < 5:
            days += 1
    return days


def _canon_domain(raw):
    """把 Jira 的 domain 值正規化。認不出來的原樣回傳（會出現在對帳報告，不會被吞掉）。"""
    if not raw:
        return None
    return DOMAIN_CANON.get(raw.strip().lower(), raw.strip())


def _band(value, bands):
    if value is None:
        return None
    for edge, label in bands:
        if value < edge:
            return label
    return bands[-1][1]


def _num(value, sign=False):
    """把數字印成人看的樣子。

    Jira 的數字欄位（effort points）回來的是 float —— 24 會變成 24.0。
    整數就印整數，真的有小數才印小數，報告裡不要出現 24.0 這種東西。
    sign=True 會強制加正負號（對帳的差值用）。
    """
    if value is None:
        return "—"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, int):
        return f"{value:+d}" if sign else f"{value}"
    return f"{value:+g}" if sign else f"{value:g}"


# ═══════════════════════════════════════════════════════════════════
# 抓資料
# ═══════════════════════════════════════════════════════════════════

def fetch_live(email, token, jql=None):
    """打 Jira REST 取卡片。分頁抓完為止。

    錯誤分流（對齊 coding-rules API 規則）：
      暫時性（429/5xx/逾時）→ retry + backoff，四次都失敗才放棄，不寫出部分結果
      永久性（400/403/404）→ 立刻放棄並說明原因，不 retry
    """
    field_ids = ["summary", "status"] + sorted(set(FIELDS.values()))
    url_base = f"https://{CLOUD_HOST}/rest/api/3/search/jql"
    cred = base64.b64encode(f"{email}:{token}".encode()).decode()

    issues, token_page, page = [], None, 0
    while True:
        page += 1
        body = {"jql": jql or JQL, "fields": field_ids, "maxResults": 100}
        if token_page:
            body["nextPageToken"] = token_page
        data = _post_json(url_base, body, cred)
        issues.extend(data.get("issues", []))
        token_page = data.get("nextPageToken")
        if not token_page or data.get("isLast") or page >= 20:
            break
    return issues


def _post_json(url, body, cred):
    payload = json.dumps(body).encode()
    last_err = None
    for attempt in range(HTTP_RETRIES):
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("Authorization", f"Basic {cred}")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            if e.code in TRANSIENT_CODES:
                last_err = f"暫時性錯誤 HTTP {e.code}: {detail}"
                if attempt < HTTP_RETRIES - 1:
                    time.sleep(HTTP_BACKOFF_SEC[attempt])
                    continue
            else:
                raise HardStop(
                    f"[永久性錯誤] Jira 回 HTTP {e.code}，不重試。\n"
                    f"  400 → JQL 或欄位 ID 有問題（filter 16245 還在嗎？）\n"
                    f"  401/403 → token 過期或沒有這個 filter 的檢視權\n"
                    f"  404 → endpoint 或 filter 不存在\n"
                    f"  Jira 回覆：{detail}"
                )
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last_err = f"連線失敗：{e}"
            if attempt < HTTP_RETRIES - 1:
                time.sleep(HTTP_BACKOFF_SEC[attempt])
                continue
    raise HardStop(f"[暫時性錯誤] 重試 {HTTP_RETRIES} 次仍失敗，這次不寫出任何檔案。\n  {last_err}")


def fetch_from_file(path):
    """吃 MCP / 手動匯出的 JSON。容忍三種外層形狀。"""
    try:
        with open(path, encoding="utf-8") as f:
            blob = json.load(f)
    except OSError as e:
        raise HardStop(f"[永久性錯誤] 讀不到 {path}：{e}") from e
    except json.JSONDecodeError as e:
        raise HardStop(f"[永久性錯誤] {path} 不是合法的 JSON："
                       f"第 {e.lineno} 行 —— {e.msg}") from e
    if isinstance(blob, dict):
        if "issues" in blob and isinstance(blob["issues"], dict):
            return blob["issues"].get("nodes", [])      # MCP 包法
        if isinstance(blob.get("issues"), list):
            return blob["issues"]                        # Jira REST 原生
    if isinstance(blob, list):
        return blob                                      # 已經是卡片陣列
    raise HardStop(f"[永久性錯誤] 認不出 {path} 的結構，沒有找到卡片陣列。")


# ═══════════════════════════════════════════════════════════════════
# 正規化
# ═══════════════════════════════════════════════════════════════════

def normalize(raw_issues, today):
    cards, excluded, unmapped = [], [], []

    for iss in raw_issues:
        f = iss.get("fields", {}) or {}
        key = iss.get("key", "?")
        status = ((f.get("status") or {}).get("name")) or "?"

        if status in EXCLUDED_STATUSES:
            excluded.append({"key": key, "status": status})
            continue

        stage = STAGE_MAP.get(status)
        if stage is None:
            unmapped.append({"key": key, "status": status})

        size = _option_value(f.get(FIELDS["size_letter"]))
        pts_field = f.get(FIELDS["effort_points"])
        pts = pts_field if isinstance(pts_field, (int, float)) else None
        pts_from_size = SIZE_POINTS.get(size) if size else None

        dur = f.get(FIELDS["stage_duration"])
        dur = dur if isinstance(dur, (int, float)) else None
        dur_estimated = False
        if dur is None:
            anchor = (_date_from_jira(f.get(FIELDS["design_start"]))
                      or _date_from_jira(f.get(FIELDS["discovery_start"])))
            dur = _business_days(anchor, today)
            dur_estimated = dur is not None

        cards.append({
            "key": key,
            "id": key.rsplit("-", 1)[-1],
            "summary": f.get("summary") or "",
            "status": status,
            "stage": stage,
            "domain": _canon_domain(_option_value(f.get(FIELDS["domain"]))),
            "domain_raw": _option_value(f.get(FIELDS["domain"])),
            "horizon": _option_value(f.get(FIELDS["horizon"])),
            "size": size,
            "effort_points": pts,
            "effort_points_from_size": pts_from_size,
            # size 欄位（10645）是 PM 自由輸入的文字，實測有「XL＋M＋M」這種值，
            # 所以不一致只是「值得看一眼」，不是資料錯誤。權威來源是 10425。
            "effort_mismatch": (pts is not None and pts_from_size is not None
                                and pts != pts_from_size),
            "project_status": _option_value(f.get(FIELDS["project_status"])),
            "stage_duration_bd": dur,
            "stage_duration_estimated": dur_estimated,
            "teams": _option_values(f.get(FIELDS["teams"])),
            "discovery_start": _date_from_jira(f.get(FIELDS["discovery_start"])),
            "design_start": _date_from_jira(f.get(FIELDS["design_start"])),
            "tech_design_end": _date_from_jira(f.get(FIELDS["tech_design_end"])),
            "release_date": _date_from_jira(f.get(FIELDS["release_date"])),
            "config_on": _date_from_jira(f.get(FIELDS["config_on"])),
            "capacity_domains": sorted({
                TEAM_TO_DOMAIN[t] for t in _option_values(f.get(FIELDS["teams"]))
                if t in TEAM_TO_DOMAIN
            }),
            "unmapped_teams": sorted([
                t for t in _option_values(f.get(FIELDS["teams"])) if t not in TEAM_TO_DOMAIN
            ]),
            "url": f"https://{CLOUD_HOST}/browse/{key}",
        })

    return cards, excluded, unmapped


def aggregate(cards, today, release_cards=None):
    """算出 dashboard 要的彙總。只做算術，不做判讀。

    ★兩套歸戶方式刻意並存，不可混用★
      owner  = 卡片自己的 domain 欄位 → 對應 PMT「🩺 Health」的健康度總表
      capacity = 卡片的 Teams 展開 → 對應 PMT「📈 Capacity」的產能表
    同一張卡在 capacity 側可能同時計入多個 domain（跨團隊卡計入每個參與團隊的完整 effort），
    所以 capacity 的卡數加總會大於 active 總數。這不是 bug，是報告的定義。
    """
    stages, owner, capacity = {}, {}, {}

    def _slot(bucket, name):
        return bucket.setdefault(name, {
            "cards": 0, "points": 0, "upstream_cards": 0, "by_stage": {}, "rag": {},
            "keys": [],
        })

    for c in cards:
        st = c["stage"] or "未分類"
        stages[st] = stages.get(st, 0) + 1
        pts = c["effort_points"] or 0

        o = _slot(owner, c["domain"] or "未指定")
        o["cards"] += 1
        o["points"] += pts
        o["keys"].append(c["key"])
        o["by_stage"][st] = o["by_stage"].get(st, 0) + 1
        o["rag"][c["project_status"] or "未填"] = o["rag"].get(c["project_status"] or "未填", 0) + 1
        if c["stage"] in ("Discovery", "Design"):
            o["upstream_cards"] += 1

        # Teams 全空 → 回退到 owner domain（報告也是這樣做，並且會把回退的卡列出來）
        targets = c["capacity_domains"] or ([c["domain"]] if c["domain"] else [])
        for d in targets:
            a = _slot(capacity, d)
            a["cards"] += 1
            a["points"] += pts
            a["keys"].append(c["key"])
            a["by_stage"][st] = a["by_stage"].get(st, 0) + 1
            if c["stage"] in ("Discovery", "Design"):
                a["upstream_cards"] += 1

    for d, a in capacity.items():
        base = BASELINES.get(d, {})
        ppm, cpm = base.get("pts_per_month"), base.get("cards_per_month")
        a["baseline_pts_per_month"] = ppm
        a["baseline_n"] = base.get("n")
        a["wip_months"] = round(a["points"] / ppm, 2) if ppm else None
        a["wip_verdict"] = _band(a["wip_months"], WIP_BANDS)
        a["upstream_months"] = round(a["upstream_cards"] / cpm, 2) if cpm else None
        a["upstream_verdict"] = _band(a["upstream_months"], UPSTREAM_BANDS)
        # n<5 時月數的絕對值不可信，只能看方向。判讀層必須讀這個旗標。
        a["baseline_thin"] = bool(base.get("n") and base["n"] < 5)

    # 發布清單用「16245 ∪ 15906」去重後的聯集。少了 15906 會漏掉 Tech 卡。
    pool, seen = [], set()
    for c in list(cards) + list(release_cards or []):
        if c["key"] in seen:
            continue
        seen.add(c["key"])
        pool.append(c)
    upcoming = sorted(
        [c for c in pool if c["release_date"] and c["release_date"] >= today.isoformat()],
        key=lambda c: c["release_date"],
    )
    by_day = {}
    for c in upcoming:
        by_day.setdefault(c["release_date"], []).append(c["key"])

    return {
        "stages": stages,
        "domains_by_owner": owner,
        "domains_by_capacity": capacity,
        "team_participation_count": sum(a["cards"] for a in capacity.values()),
        "cards_with_no_teams": [c["key"] for c in cards if not c["capacity_domains"]],
        "unmapped_teams": sorted({t for c in cards for t in c["unmapped_teams"]}),
        "upcoming_releases": [
            {"date": c["release_date"], "key": c["key"], "summary": c["summary"],
             "domain": c["domain"], "project_status": c["project_status"],
             "config_on": c["config_on"]}
            for c in upcoming
        ],
        "release_pool_partial": release_cards is None,
        "release_concentration": sorted(
            [{"date": d, "count": len(k), "keys": k} for d, k in by_day.items() if len(k) >= 2],
            key=lambda x: (-x["count"], x["date"]),
        ),
    }


def data_quality(cards):
    """資料品質問題。PMT 報告每週都在講這些 —— 欄位空白等於在報告裡隱形。"""
    issues = []
    for c in cards:
        if c["stage"] is None:
            issues.append({"key": c["key"], "issue": "status 沒有對應的 stage（STAGE_MAP 漏接）",
                           "detail": c["status"], "severity": "blocker"})
        if not c["teams"]:
            issues.append({"key": c["key"], "issue": "Teams 空白 → 產能報告會低估跨團隊負載",
                           "detail": "", "severity": "warn"})
        if not c["domain"]:
            issues.append({"key": c["key"], "issue": "Domain 空白 → 無法歸戶",
                           "detail": "", "severity": "warn"})
        if c["stage_duration_bd"] is None:
            issues.append({"key": c["key"], "issue": "Current Stage Duration 空白且無法推算 → 健康度無法判定",
                           "detail": "", "severity": "warn"})
        elif c["stage_duration_estimated"]:
            issues.append({"key": c["key"], "issue": "Current Stage Duration 空白，天數是本程式推算的",
                           "detail": f"{c['stage_duration_bd']}bd（僅扣週末）", "severity": "info"})
        if c["effort_mismatch"]:
            issues.append({"key": c["key"],
                           "issue": "Estimate Effort 與 size 文字不一致（權威值是 Estimate Effort）",
                           "detail": f"size={c['size']}(應為{c['effort_points_from_size']}) "
                                     f"但 effort={c['effort_points']}", "severity": "info"})
        if not c["discovery_start"]:
            issues.append({"key": c["key"], "issue": "Discovery Start 空白 → lifecycle 無法評分",
                           "detail": "", "severity": "warn"})
    return issues


def load_previous(out_dir):
    """讀上一份快照（latest.json），在覆寫它之前。

    用 latest.json 而不是 facts-<昨天>.json：排程可能週末沒跑、可能失敗過，
    「上一次成功跑出來的」才是正確的比較對象，不是日曆上的昨天。
    讀不到就回 None —— 第一次跑本來就沒有昨天，不是錯誤。
    """
    path = os.path.join(out_dir, "latest.json")
    try:
        with open(path, encoding="utf-8") as f:
            prev = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    # 沒有 cards 的檔案比不了，當成沒有前一份
    return prev if isinstance(prev, dict) and prev.get("cards") else None


def diff_snapshots(prev, cards, agg, today):
    """跟上一份快照逐卡比對，產出「這次跟上次差在哪」。

    這是整個系統唯一的比較基準 —— Jira 是真實來源，昨天的自己是基準。
    差異在這裡不是「錯誤」，是「訊號」：卡片本來就會動，重點是動了什麼。
    """
    empty = {"has_previous": False, "since": None, "days_ago": None,
             "added": [], "removed": [], "stage_moved": [], "status_changed": [],
             "release_moved": [], "load_changed": [],
             "active_from": None, "active_to": len(cards), "total": 0}
    if not prev:
        return empty

    since = prev.get("as_of_date")
    try:
        days_ago = (today - dt.date.fromisoformat(since)).days
    except (TypeError, ValueError):
        days_ago = None

    p_cards = {c["key"]: c for c in prev.get("cards", [])}
    c_cards = {c["key"]: c for c in cards}
    brief = lambda c: {"key": c["key"], "summary": c.get("summary", ""),
                       "domain": c.get("domain")}

    added = [{**brief(c), "stage": c.get("stage")}
             for k, c in c_cards.items() if k not in p_cards]
    removed = [{**brief(c), "last_stage": c.get("stage"),
                "last_status": c.get("project_status")}
               for k, c in p_cards.items() if k not in c_cards]

    stage_moved, status_changed, release_moved = [], [], []
    for k, c in c_cards.items():
        p = p_cards.get(k)
        if not p:
            continue
        if p.get("stage") != c.get("stage"):
            stage_moved.append({**brief(c), "from": p.get("stage"), "to": c.get("stage")})
        if p.get("project_status") != c.get("project_status"):
            a = STATUS_RANK.get(p.get("project_status"))
            b = STATUS_RANK.get(c.get("project_status"))
            status_changed.append({
                **brief(c), "from": p.get("project_status"), "to": c.get("project_status"),
                # None（未標）不參與好壞判斷 —— 沒標不等於變好或變差
                "worsened": (a is not None and b is not None and b > a),
            })
        if p.get("release_date") != c.get("release_date"):
            shift = None
            try:
                shift = (dt.date.fromisoformat(c["release_date"])
                         - dt.date.fromisoformat(p["release_date"])).days
            except (TypeError, ValueError, KeyError):
                pass
            release_moved.append({**brief(c), "from": p.get("release_date"),
                                  "to": c.get("release_date"), "days": shift})

    # 團隊負荷變化。只在判定改變、或月數變動 ≥0.1 時才報 —— 小數點後的抖動不是訊號。
    load_changed = []
    p_cap = (prev.get("aggregate") or {}).get("domains_by_capacity") or {}
    for dom, now in (agg.get("domains_by_capacity") or {}).items():
        was = p_cap.get(dom)
        if not was:
            continue
        m0, m1 = was.get("wip_months"), now.get("wip_months")
        v0, v1 = was.get("wip_verdict"), now.get("wip_verdict")
        moved = (m0 is not None and m1 is not None and abs(m1 - m0) >= 0.1)
        if moved or v0 != v1:
            load_changed.append({"domain": dom, "from": m0, "to": m1,
                                 "delta": round(m1 - m0, 2) if (m0 is not None and m1 is not None) else None,
                                 "verdict_from": v0, "verdict_to": v1})

    out = {"has_previous": True, "since": since, "days_ago": days_ago,
           "added": added, "removed": removed, "stage_moved": stage_moved,
           "status_changed": status_changed, "release_moved": release_moved,
           "load_changed": load_changed,
           "active_from": len(p_cards), "active_to": len(cards)}
    out["total"] = sum(len(out[k]) for k in
                       ("added", "removed", "stage_moved", "status_changed",
                        "release_moved", "load_changed"))
    return out


def changelog_md(ch):
    """把 diff 寫成人看的段落。沒有變化時就明講沒有，不要留空白。"""
    if not ch["has_previous"]:
        return ["這是第一份快照，沒有可以比較的上一次。明天起這一段會列出每天的變化。"]

    d = ch["days_ago"]
    when = ("今天稍早" if d == 0 else "昨天" if d == 1
            else f"{d} 天前" if isinstance(d, int) else str(ch["since"]))
    head = [f"跟{when}（{ch['since']}）那份比，active 從 "
            f"**{ch['active_from']}** 張變成 **{ch['active_to']}** 張。", ""]
    if not ch["total"]:
        return head + ["逐卡比對後**沒有任何變化** —— 沒有卡片新增、消失、換階段、"
                       "改狀態或改發布日，團隊負荷也沒動。"]

    L, nm = [], lambda x: f"**{x['key'].replace('APPIDEAS-', '')}** {x['summary']}"
    if ch["added"]:
        L += [f"### 新進來的卡（{len(ch['added'])}）", ""]
        L += [f"- {nm(x)} — {x['domain'] or '未分'}／{x['stage'] or '—'}" for x in ch["added"]] + [""]
    if ch["removed"]:
        L += [f"### 離開 active 的卡（{len(ch['removed'])}）", "",
              "> 可能是做完了、被關掉，或被移到 Parking lot。", ""]
        L += [f"- {nm(x)} — 最後停在 {x['last_stage'] or '—'}／{x['last_status'] or '未標'}"
              for x in ch["removed"]] + [""]
    if ch["status_changed"]:
        worse = [x for x in ch["status_changed"] if x["worsened"]]
        L += [f"### PM 改了狀態（{len(ch['status_changed'])}"
              + (f"，其中 {len(worse)} 個變差" if worse else "") + "）", ""]
        L += [f"- {'⚠ ' if x['worsened'] else ''}{nm(x)} — "
              f"{x['from'] or '未標'} → {x['to'] or '未標'}" for x in ch["status_changed"]] + [""]
    if ch["stage_moved"]:
        L += [f"### 換了階段（{len(ch['stage_moved'])}）", ""]
        L += [f"- {nm(x)} — {x['from'] or '—'} → {x['to'] or '—'}" for x in ch["stage_moved"]] + [""]
    if ch["release_moved"]:
        L += [f"### 改了發布日（{len(ch['release_moved'])}）", ""]
        for x in ch["release_moved"]:
            move = (f"延後 {x['days']} 天" if isinstance(x["days"], int) and x["days"] > 0
                    else f"提前 {-x['days']} 天" if isinstance(x["days"], int) and x["days"] < 0
                    else "改了")
            L += [f"- {nm(x)} — {x['from'] or '未定'} → {x['to'] or '未定'}（{move}）"]
        L += [""]
    if ch["load_changed"]:
        L += [f"### 團隊負荷變化（{len(ch['load_changed'])}）", ""]
        for x in ch["load_changed"]:
            tail = (f"，判定 {x['verdict_from'] or '無'} → {x['verdict_to'] or '無'}"
                    if x["verdict_from"] != x["verdict_to"] else "")
            L += [f"- **{x['domain']}** — {_num(x['from'])} → {_num(x['to'])} 個月"
                  f"（{_num(x['delta'], sign=True)}）{tail}"]
        L += [""]
    return head + L


# ═══════════════════════════════════════════════════════════════════
# 主流程
# ═══════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser(description="把 Jira roadmap 卡片正規化成事實層 JSON")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-file", metavar="PATH", help="讀已匯出的 JSON（dry-run，不需 token）")
    src.add_argument("--live", action="store_true", help="打 Jira REST（需 JIRA_EMAIL / JIRA_TOKEN）")
    ap.add_argument("--release-file", metavar="PATH",
                    help="dry-run 用：filter 15906 的匯出檔（發布清單母體）。"
                         "省略時發布清單只含 active 卡，會標記 partial=true")
    ap.add_argument("--out", default="out", help="輸出目錄（預設 out/）")
    ap.add_argument("--today", help="覆寫基準日 YYYY-MM-DD（測試用）")
    args = ap.parse_args()

    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()

    if args.live:
        email, token = os.environ.get("JIRA_EMAIL"), os.environ.get("JIRA_TOKEN")
        if not email or not token:
            raise HardStop("[永久性錯誤] --live 需要環境變數 JIRA_EMAIL 與 JIRA_TOKEN，"
                           "兩者缺一就不跑（不會寫出半份檔案）。")
        raw = fetch_live(email, token)
        raw_release = fetch_live(email, token, RELEASE_JQL)
        source = f"Jira REST live pull（{JQL} ＋ {RELEASE_JQL}）"
    else:
        raw = fetch_from_file(args.from_file)
        raw_release = fetch_from_file(args.release_file) if args.release_file else None
        source = f"檔案 {args.from_file}" + (
            f" ＋ {args.release_file}" if args.release_file else "（未提供發布母體）")

    if not raw:
        raise HardStop("[永久性錯誤] 一張卡都沒抓到。不寫出空檔案 —— "
                       "空檔案會讓 dashboard 顯示成「roadmap 清空了」，比壞掉更危險。")

    cards, excluded, unmapped = normalize(raw, today)
    release_cards = None
    if raw_release:
        release_cards, _, _ = normalize(raw_release, today)
    agg = aggregate(cards, today, release_cards)
    dq = data_quality(cards)
    # 一定要在覆寫 latest.json「之前」讀舊的那份
    changes = diff_snapshots(load_previous(args.out), cards, agg, today)

    facts = {
        "schema_version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "as_of_date": today.isoformat(),
        "source": source,
        "jql": JQL,
        "excluded_statuses": sorted(EXCLUDED_STATUSES),
        "baseline": {"locked_at": BASELINE_LOCKED_AT, "expires_at": BASELINE_EXPIRES_AT,
                     "expired": today.isoformat() >= BASELINE_EXPIRES_AT,
                     "values": BASELINES},
        "counts": {"raw_from_source": len(raw), "active": len(cards),
                   "excluded": len(excluded), "unmapped_status": len(unmapped)},
        "aggregate": agg,
        "cards": cards,
        "data_quality": dq,
        "changes": changes,
    }

    os.makedirs(args.out, exist_ok=True)
    stamp = today.isoformat()
    facts_path = os.path.join(args.out, f"facts-{stamp}.json")
    for path in (facts_path, os.path.join(args.out, "latest.json")):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(facts, fh, ensure_ascii=False, indent=2)

    blockers = [d for d in dq if d["severity"] == "blocker"]
    warns = [d for d in dq if d["severity"] == "warn"]

    md = [f"# Roadmap 每日變化報告 — {stamp}", "",
          "> 資料直接來自 Jira，比較基準是**上一份快照**（昨天的自己），"
          "不是任何人工整理過的報告。",
          "> 這一份回答的是：「跟上次比，動了什麼？」",
          "> 卡片每天都在動，有變化是常態；真的壞掉會出現在下面的「資料品質」段。", "",
          f"- 來源：{source}", f"- 原始 {len(raw)} 張 → active **{len(cards)}** 張"
          f"（排除 {len(excluded)}、未分類 {len(unmapped)}）",
          f"- 產能基準鎖定於 {BASELINE_LOCKED_AT}，"
          f"{'**已過期，數字不可用**' if facts['baseline']['expired'] else f'{BASELINE_EXPIRES_AT} 重算'}",
          "", "## 跟上一份快照的差異", ""]
    md += changelog_md(changes)
    md += ["", "## Stage 分布", "", "| Stage | 張數 |", "| --- | --- |"]
    md += [f"| {k} | {v} |" for k, v in sorted(agg["stages"].items())]
    md += ["", "## 產能（Teams 歸戶 — 對應 PMT 📈 Capacity）", "",
           f"Teams 參與計數 {agg['team_participation_count']}（>{len(cards)} 是正常的："
           "跨團隊卡對每個參與團隊都計入完整 effort）", "",
           "| Domain | 卡 | pts | 在途(月) | 判定 | 上游卡 | 上游(月) | 判定 | 基準薄弱 |",
           "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for d, a in sorted(agg["domains_by_capacity"].items()):
        md.append(f"| {d} | {a['cards']} | {_num(a['points'])} | {a['wip_months'] or '—'} | "
                  f"{a['wip_verdict'] or '無基準'} | {a['upstream_cards']} | "
                  f"{a['upstream_months'] or '—'} | {a['upstream_verdict'] or '無基準'} | "
                  f"{'是' if a['baseline_thin'] else ''} |")
    md += ["", "## 健康度歸戶（owner domain — 對應 PMT 🩺 Health）", "",
           "| Domain | 卡 | Project Status 分布 |", "| --- | --- | --- |"]
    for d, a in sorted(agg["domains_by_owner"].items()):
        rag = ", ".join(f"{k} {v}" for k, v in sorted(a["rag"].items()))
        md.append(f"| {d} | {a['cards']} | {rag} |")
    if agg["unmapped_teams"]:
        md += ["", f"> ⚠ Teams 有值但沒有對應到任何產能池：**{', '.join(agg['unmapped_teams'])}** "
               "—— 這些團隊的投入在產能報告裡完全看不見（8/21 報告也點出過 Data 這一條）。"]
    if agg["cards_with_no_teams"]:
        md += ["", f"> ⚠ Teams 全空、回退用 owner domain 計數的卡："
               f"**{', '.join(agg['cards_with_no_teams'])}**"]
    md += ["", "## 發布集中度（同日 ≥2 張）", ""]
    if agg["release_pool_partial"]:
        md += ["> ⚠ **未提供 filter 15906 母體，這份發布清單不完整**"
               "（會漏掉 issuetype=Tech 的卡，例如 1888）。集中度是低估值。", ""]
    md += ([f"- **{r['date']}**：{r['count']} 張 — {', '.join(r['keys'])}"
            for r in agg["release_concentration"]] or ["- 無"])
    md += ["", f"## 資料品質（blocker {len(blockers)} / warn {len(warns)}）", ""]
    md += ([f"- `{d['severity']}` **{d['key']}** — {d['issue']}"
            + (f"（{d['detail']}）" if d["detail"] else "")
            for d in dq] or ["- 無問題"])
    md += ["", "## Teams 逐卡明細（已查證欄位）", "",
           f"讀的是 `{FIELDS['teams']}`。此欄位已於 2026-08-24 用 8/21 報告的產能數字反推驗證。", "",
           "| 卡 | Domain | Teams 讀到 |", "| --- | --- | --- |"]
    md += [f"| {c['key']} | {c['domain'] or '—'} | {', '.join(c['teams']) or '（空白）'} |"
           for c in cards]

    rec_path = os.path.join(args.out, f"changes-{stamp}.md")
    with open(rec_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")

    print(f"[OK] active {len(cards)} 張 → {facts_path}")
    print(f"[OK] 每日變化報告 → {rec_path}")
    if changes["has_previous"]:
        print(f"[OK] 跟 {changes['since']} 那份比：{changes['total']} 項變化"
              f"（新增 {len(changes['added'])}／離開 {len(changes['removed'])}／"
              f"換階段 {len(changes['stage_moved'])}／改狀態 {len(changes['status_changed'])}／"
              f"改發布日 {len(changes['release_moved'])}／負荷 {len(changes['load_changed'])}）")
    else:
        print("[OK] 第一份快照，沒有可比較的上一次。")
    print(f"[OK] 資料品質：blocker {len(blockers)}／warn {len(warns)}")

    if unmapped:
        print("[BLOCKER] 有 status 沒對應到 stage，STAGE_MAP 要補：")
        for u in unmapped:
            print(f"    {u['key']}  status={u['status']!r}")
        return 2
    return 0


if __name__ == "__main__":
    # exit code 約定（workflow 依賴這個）：
    #   0 = 正常跑完（有沒有變化都算正常）
    #   2 = 資料有結構性問題（例如 status 沒對應到 stage）→ workflow 紅燈
    #   3 = 程式自己炸了 → workflow 紅燈
    #
    # 1 已停用，而且不要拿去表示別的東西：Python 未捕捉的例外預設就是
    # exit 1，一旦 1 有「正常」的語意，當機就會被當成成功。2026-08-31
    # 真的發生過 —— 程式炸掉，workflow 卻是綠燈、什麼都沒寫。
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except HardStop as e:
        print(f"\n{e}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        print("\n[中斷] 使用者中止，沒有寫出資料。", file=sys.stderr)
        sys.exit(3)
    except Exception:
        traceback.print_exc()
        print("\n[CRASH] extract.py 未預期地中斷，沒有產出可信的資料。"
              "\n        以 exit code 3 結束，讓排程紅燈 —— 不要把崩潰當成「沒有變化」。",
              file=sys.stderr)
        sys.exit(3)
