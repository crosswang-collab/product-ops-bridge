#!/usr/bin/env python3
"""
產生 voc-bot/preview/index.html —— VoC Console 的離線預覽版。

用途：讓 Cross 在還沒部署 Apps Script 之前就能點開看介面長什麼樣、動線對不對。
畫面上的資料全部是這支腳本生出來的虛構資料，發話者叫「デモ配信者A」這種名字，
介面最上方也會有一條橘色警告條寫明「這是離線預覽版」。

介面本身只有一份（Dashboard.html）。這支腳本不改任何 UI，只是在前面塞一段
window.__VOC_DEMO__，讓 Dashboard.html 的 call() 走內嵌資料而不是 google.script.run。
所以 UI 改了就重跑一次：

    python3 voc-bot/build-preview.py
"""

import json
import pathlib
from datetime import date, timedelta

HERE = pathlib.Path(__file__).resolve().parent
TODAY = date(2026, 8, 12)          # 固定日期，讓輸出可重現
GENERATED_AT = "2026/08/12 08:10"


def ymd(d: date) -> str:
    return d.strftime("%Y/%m/%d")


# --- 可重現的偽亂數（不用 random，確保每次產出的檔案一模一樣）-----------------
class Rng:
    def __init__(self, seed: int):
        self.s = seed

    def next(self) -> int:
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s

    def pick(self, seq):
        return seq[self.next() % len(seq)]

    def below(self, n: int) -> int:
        return self.next() % n


R = Rng(20260812)

# --- 虛構的 roadmap（代碼沿用真實體系，標題與狀態都是編的）--------------------
ROADMAP = [
    ("S2.0", "Free ticker covers the livestream screen",        "S2 Broadcast / Ops",      "P0", "1",  "In development", False),
    ("S2.1", "App crashes when switching camera mid-stream",     "S2 Broadcast / Ops",      "P0", "2",  "In development", False),
    ("S2.6", "Cannot hide the gift board during a stream",       "S2 Broadcast / Ops",      "P1", "5",  "Backlog",        False),
    ("S2.7", "My-event settings are not remembered",             "S2 Broadcast / Ops",      "P1", "6",  "Discovery",      False),
    ("S5.0", "Blocked users can still view the profile",         "S5 Safety",               "P0", "3",  "Shipped",        True),
    ("U2.0", "System overlays clutter the viewing screen",       "U2 Watch / Return",       "P2", "11", "Backlog",        False),
    ("U2.2", "Hard to find the event entry point",               "U2 Watch / Return",       "P2", "12", "",               False),
    ("U4.0", "Overseas bots farm the red-envelope campaign",     "U4 Gifting / Spend",      "P0", "4",  "In development", False),
    ("U4.1", "No mid-tier price point between gifts",            "U4 Gifting / Spend",      "P2", "13", "Backlog",        False),
    ("U4.4", "Expensive gifts cannot be undone after misfire",   "U4 Gifting / Spend",      "P1", "7",  "Discovery",      False),
    ("U5.1", "Army rank does not create a sense of belonging",   "U5 Recognition / Status", "P2", "14", "",               False),
    ("U6.0", "VS mode does not switch match information",        "U6 Event / Compete",      "P1", "8",  "Shipped",        True),
    ("U6.2", "Blocked users still get matched in PK",            "U6 Event / Compete",      "P1", "9",  "Backlog",        False),
    ("Z1",   "PM roadmap is not shared back to the JP team",     "Z Strategy",              "P2", "15", "",               False),
]

CANDIDATES = [
    ("CAND-001", "配信中に固定コメントをピン留めしたい",      "Pin a comment during a live stream", "U2 Watch / Return",  "P2"),
    ("CAND-002", "月間ランキングの集計時刻を明示してほしい",  "Show monthly ranking cutoff time",   "U5 Recognition / Status", "P2"),
    ("CAND-003", "ギフト履歴をCSVで出したい",                 "Export gift history as CSV",         "U4 Gifting / Spend", "P1"),
    ("CAND-004", "iPadの横画面に対応してほしい",              "Support iPad landscape layout",      "U2 Watch / Return",  "P2"),
    ("CAND-005", "配信予約のリマインド通知がほしい",          "Reminder for scheduled streams",     "S2 Broadcast / Ops", "P1"),
    ("CAND-006", "サブアカウントの通報導線が分かりにくい",    "Sub-account reporting flow unclear",  "S5 Safety",          "P2"),
]

ORIGINS = [
    ("Slack #UserFeedback", "スレッド返信"),
    ("VIP Feedback", "回答フォーム"),
    ("JP feature requests Q3", "シート2行目以降"),
    ("JP feedback for Cross", "自由記述欄"),
    ("プロライバー定例会", "議事メモ"),
]

SPEAKERS = ["デモ配信者A", "デモ配信者B", "サンプルVIP-01", "サンプルVIP-02",
            "テスト運営C", "デモリスナーD", "サンプル代理店E"]

THEMES = {
    "S2.0": ("ティッカー・表示UI / Ticker & Overlay", "不満"),
    "S2.1": ("バグ・不具合 / Bugs", "バグ"),
    "S2.6": ("ギフトボード / Gift Board", "要望"),
    "S2.7": ("イベント・マイイベント / Events", "要望"),
    "S5.0": ("規約・不正対策 / Abuse & Policy", "通報"),
    "U2.0": ("アプリUI・導線 / App UI & Navigation", "不満"),
    "U2.2": ("アプリUI・導線 / App UI & Navigation", "質問"),
    "U4.0": ("規約・不正対策 / Abuse & Policy", "通報"),
    "U4.1": ("課金・報酬・BC / Payment & Revenue", "提案"),
    "U4.4": ("課金・報酬・BC / Payment & Revenue", "不満"),
    "U5.1": ("アーミー・ガーディアン・階級 / Community Rank", "提案"),
    "U6.0": ("VS・PK・マッチング / VS & Matching", "バグ"),
    "U6.2": ("VS・PK・マッチング / VS & Matching", "通報"),
    "Z1":   ("社内システム・PMプロセス / Internal & PM", "要望"),
    "CAND-001": ("アプリUI・導線 / App UI & Navigation", "要望"),
    "CAND-002": ("イベント・マイイベント / Events", "質問"),
    "CAND-003": ("課金・報酬・BC / Payment & Revenue", "要望"),
    "CAND-004": ("アプリUI・導線 / App UI & Navigation", "要望"),
    "CAND-005": ("VOD・配信機能 / VOD & Streaming", "要望"),
    "CAND-006": ("規約・不正対策 / Abuse & Policy", "提案"),
}

# 每個代碼的幾種說法（虛構，僅用來讓畫面看起來像真的在跑）
VOICES = {
    "S2.0": ["金テロが顔の位置に被ってしまい、表情が見えないと言われました。位置を変えられませんか。",
             "テロップが画面中央に出るので、コラボ中に相手の顔が隠れてしまいます。",
             "無料テロップの表示時間が長すぎて、配信画面がずっと塞がっています。"],
    "S2.1": ["配信中にインカメへ切り替えたらアプリが落ちました。今日で3回目です。",
             "カメラ切替のタイミングで強制終了します。iPhone 15 Proです。",
             "配信が突然切れて、再入場したら視聴者が半分になっていました。"],
    "S2.6": ["ギフトボードを一時的に非表示にしたいです。競争を煽りたくない日もあります。",
             "ギフター一覧を隠す設定がほしいという要望を複数人から受けています。"],
    "S2.7": ["マイイベントの設定が毎回リセットされます。前回の内容を覚えていてほしい。",
             "イベントを作るたびに同じ項目を入力しなおすのが負担です。",
             "子袋の設定だけ引き継がれないようで、毎回作り直しています。"],
    "S5.0": ["ブロックした相手にプロフィールを見られていました。仕様でしょうか。"],
    "U2.0": ["画面上の表示物が多すぎて、配信自体が見づらいという声があります。",
             "システム表示をまとめて隠すボタンがほしいです。"],
    "U2.2": ["イベントの入口がどこにあるのか分からないと視聴者から聞かれます。",
             "参加ページにたどり着けないという問い合わせが今週も来ています。"],
    "U4.0": ["海外からのボットらしきアカウントがお年玉を大量に取得しています。",
             "自投げと思われる動きが特定のルームで続いています。取り締まりをお願いします。",
             "紅包が数秒で消えます。明らかに人間の操作ではありません。",
             "不正取得の疑いがあるアカウントを3件まとめて報告します。"],
    "U4.1": ["ギフトの価格帯が上下に離れすぎていて、中間がありません。",
             "課金額の選択肢に中間帯を足してほしいという要望が出ています。"],
    "U4.4": ["高額ギフトを誤爆してしまい、取り消せませんでした。確認ダイアログがほしい。",
             "誤送信の相談が今月に入って増えています。"],
    "U5.1": ["アーミーの階級が上がっても実感がなく、所属感につながっていません。"],
    "U6.0": ["VSモードで対戦情報が切り替わらないままでした。",
             "マッチ情報が前の相手のまま表示されています。"],
    "U6.2": ["ブロックしたはずの相手とマッチングしました。",
             "身内マッチが続いていて、公平性に疑問の声が出ています。"],
    "Z1":   ["PM側のロードマップが日本チームに共有されておらず、認識合わせができていません。"],
    "CAND-001": ["配信中に固定したいコメントをピン留めできる機能がほしいです。",
                 "重要な連絡を上に固定できると助かります。"],
    "CAND-002": ["月間ランキングの集計が何時までなのか明示してほしいです。"],
    "CAND-003": ["ギフト履歴をCSVで書き出せると、事務所側の集計が楽になります。",
                 "履歴のエクスポートができないため手作業で転記しています。"],
    "CAND-004": ["iPadの横画面に対応してほしいという声が事務所から来ています。"],
    "CAND-005": ["配信予約をしてもリマインドが来ないので、視聴者が集まりません。",
                 "予約枠の通知がほしいです。"],
    "CAND-006": ["サブアカウントを通報したいのですが、導線が分かりにくいです。"],
}

NOISE = ["お疲れ様です。本日もよろしくお願いいたします。",
         "ありがとうございました！", "承知しました。"]

# 各代碼在這 32 天內大約出現幾次（刻意讓 U4.0 最吵、CAND-003 竄升）
WEIGHT = {"S2.0": 14, "S2.1": 11, "S2.6": 5, "S2.7": 9, "S5.0": 2, "U2.0": 6,
          "U2.2": 4, "U4.0": 22, "U4.1": 7, "U4.4": 8, "U5.1": 3, "U6.0": 4,
          "U6.2": 6, "Z1": 2, "CAND-001": 5, "CAND-002": 3, "CAND-003": 11,
          "CAND-004": 4, "CAND-005": 7, "CAND-006": 2}

V_MATCH, V_REVIEW, V_RULE = "既存一致", "既存一致(要確認)", "規則式(精度低)"
V_NEW, V_PENDING, V_NOISE = "新規候補", "未判定", "ノイズ"

RM_CODES = {c[0] for c in ROADMAP}
RM_TITLE = {c[0]: c[1] for c in ROADMAP}
CAND_TITLE = {c[0]: c[1] for c in CANDIDATES}


def build_rows():
    rows = []
    n = 0
    for code, count in WEIGHT.items():
        for _ in range(count):
            # 近期權重高一點，讓「近 7 日」看起來有東西
            span = R.below(32)
            if R.below(3) == 0:
                span = R.below(8)
            occ = TODAY - timedelta(days=span)
            # 取込日 ≥ 発生日：模擬 bot 隔天才抓到、或補抓舊訊息
            ing = occ + timedelta(days=min(R.below(3), (TODAY - occ).days))
            origin, odet = R.pick(ORIGINS)
            theme, kind = THEMES[code]
            body = R.pick(VOICES[code])
            n += 1
            rid = "demo%04d-01" % n

            if code in RM_CODES:
                roll = R.below(10)
                verdict = V_MATCH if roll < 7 else (V_REVIEW if roll < 9 else V_RULE)
                topic = RM_TITLE[code]
                conf = "0.9" if verdict == V_MATCH else ("0.5" if verdict == V_REVIEW else "0.45")
                why = "既存痛点の記述と一致（デモデータ）"
            else:
                verdict, topic, conf = V_NEW, CAND_TITLE[code], "0.8"
                why = "ロードマップ上に該当なし。新規候補として登録（デモデータ）"

            # 示範用的假連結，指向 example.com，讓「開啟原始出處」的動線在預覽時看得到
            link = "https://example.com/demo-source/%s" % rid if origin.startswith("Slack") else ""
            rows.append([rid, ymd(ing), ymd(occ), origin, odet, kind, theme,
                         body[:40] + ("…" if len(body) > 40 else ""), body,
                         R.pick(SPEAKERS), link, verdict, code, topic, conf, why, "1/1"])

    # 未判定與雜訊：介面必須誠實顯示這兩類，所以預覽也要有
    for i in range(6):
        occ = TODAY - timedelta(days=R.below(9))
        origin, odet = R.pick(ORIGINS)
        rows.append(["demo9%03d-01" % i, ymd(occ), ymd(occ), origin, odet, "", "",
                     "判定できなかったサンプル", "配信の件、先日の話の続きですが対応いかがでしょうか。",
                     R.pick(SPEAKERS), "", V_PENDING, "", "", "",
                     "規則式では判定できず（デモデータ）", "1/1"])
    for i in range(4):
        occ = TODAY - timedelta(days=R.below(9))
        origin, odet = R.pick(ORIGINS)
        rows.append(["demo8%03d-01" % i, ymd(occ), ymd(occ), origin, odet, "", "",
                     "挨拶", R.pick(NOISE), R.pick(SPEAKERS), "", V_NOISE, "", "", "0.95",
                     "実質的な訴求なしと判定（デモデータ）", "1/1"])

    rows.sort(key=lambda r: r[2])
    return rows


ROWS = build_rows()
PAGE = 1200

core = {
    "ok": True, "generatedAt": GENERATED_AT, "recentDays": 30, "degraded": False,
    "roadmapTab": "JP Needs — Product Roadmap (DEMO)",
    "roadmap": [{"code": c, "title": t, "area": a, "priority": p, "rank": rk,
                 "status": st, "resolved": rs, "requests": "", "note": "",
                 "sourceType": "VoC", "submitDate": "", "codeAuto": False, "row": i + 2}
                for i, (c, t, a, p, rk, st, rs) in enumerate(ROADMAP)],
    "candidates": [{"code": c, "title": jp, "titleEn": en, "area": a, "priority": p}
                   for (c, jp, en, a, p) in CANDIDATES],
    "rawCount": len(ROWS), "pageSize": PAGE, "hardMax": 30000,
    # 預覽版最上方已經有一條橘色警告條，這裡不再重複同一句話
    "problems": [],
    "verdicts": {"match": V_MATCH, "review": V_REVIEW, "rule": V_RULE,
                 "cand": V_NEW, "pending": V_PENDING, "noise": V_NOISE},
}

demo_js = """
<script>
/* === 離線預覽用的虛構資料。正式部署時不會有這一段 —— Dashboard.html 會改走
   google.script.run 讀真正的 VoC_Raw_Log。此檔由 voc-bot/build-preview.py 產生。 === */
window.__VOC_DEMO__ = (function(){
  var CORE = %s;
  var ROWS = %s;
  return {
    apiCore: function(){ return CORE; },
    apiRaw: function(off){
      off = off || 0;
      var page = ROWS.slice(off, off + %d);
      return { ok:true, offset:off, rows:page, total:ROWS.length,
               done:(off + page.length) >= ROWS.length, capped:false };
    },
    apiDetail: function(id){
      for (var i = 0; i < ROWS.length; i++){
        if (ROWS[i][0] === id) return { ok:true, id:id, body:ROWS[i][8],
          original:'【示範資料】' + ROWS[i][8] + '\\n\\n（正式版這裡會顯示切分前的整則訊息原文）',
          origin:ROWS[i][3], owner:ROWS[i][9], link:'', why:ROWS[i][15], split:'1/1', sheetRow:i+2 };
      }
      return { ok:false, error:'示範資料中找不到這一筆' };
    }
  };
})();
</script>
""" % (json.dumps(core, ensure_ascii=False),
       json.dumps(ROWS, ensure_ascii=False),
       PAGE)

html = (HERE / "Dashboard.html").read_text(encoding="utf-8")
marker = '<script>\n"use strict";'
if marker not in html:
    raise SystemExit("找不到主 script 起點，Dashboard.html 結構變了，請更新 build-preview.py")
out = html.replace(marker, demo_js.strip() + "\n\n" + marker, 1)
out = out.replace("<title>", "<title>", 1)

dst = HERE / "preview" / "index.html"
dst.parent.mkdir(exist_ok=True)
dst.write_text(out, encoding="utf-8")
print("已產生 %s（%d 列示範資料，%.0f KB）" % (dst, len(ROWS), dst.stat().st_size / 1024))
