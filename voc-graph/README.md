# voc-graph

每天把三份事實接成一張圖，放在 Vercel 的 `/voc-graph/web/`：

```
STT 主播聲音（BigQuery，每週一批）
   │  Apps Script（gas/SttExport.gs，每天 08:30 JST，以 Cross 本人權限讀；公司禁 GCP 金鑰）
   ▼  F 主題 ← stt_voc_judgments／25 痛點 ← stt_voc_weekly_metrics
out/stt-latest.json ───────────────┐
VoC roadmap 25 痛點（catalog.json）─┼─▶ build.py ─▶ check.py ─▶ Vercel 頁面
Jira active 卡（roadmap-bot，每天）─┘   （組圖）    （驗收，沒過就不更新）
          ▲
   mapping.json（痛點 → Jira 卡，PM 維護，唯一的人工輸入）
```

頁面只回答三件事：**哪些聲音在變多、哪些痛點有聲音沒有卡、哪些 [VoC] 卡對不到痛點。**

## 契約

```
┌─ LOOP CONTRACT ────────────────────────────────
│ NAME   : voc-graph-daily
│ TRIGGER: roadmap-daily 成功跑完後（GitHub Actions workflow_run）；可手動觸發
│ GOAL   : voc-graph/out/latest.json 是今天的圖，25 痛點各自標好
│          STT 人數與對應的 Jira 卡，而且頁面讀的就是這份
│ STOP   : PASS = check.py 的 C1–C10 全部 PASS（條件寫死在 check.py 檔頭）
│          由 check.py 判定，build.py 不得自評
│ BUDGET : 每天 1 輪 ／ ≤ 10 分鐘（workflow timeout）／ ≤ 63 天的 STT 窗
│ FAIL   : Apps Script：暫時性錯誤重試 3 次；欄位值變了／權限錯／token 過期
│          → 不寫檔，寄信給 Cross
│          STT 超過 14 天沒更新（Apps Script 停了）→ check.py C4 紅燈
│          驗收沒過 → 不 commit，頁面維持前一天，GitHub 寄信
│          連續 3 天紅燈 → 代表不是偶發，要人看（找 Claude 帶 log 進來）
└────────────────────────────────────────────────
```

**為什麼沒有 state 檔**：這條 loop 對外只有「讀」（BigQuery、repo 內檔案），唯一的寫入是
commit 自己的 `out/`（Apps Script 推 `stt-latest.json` 前先比對 repo 現有版本，相同就不推），而且以日期為 key、重跑同一天結果相同（冪等）。沒有不可撤回的動作，
所以「上次做到哪」由 `out/graph-<日期>.json` 本身承擔，不另開 state。

**AI 判讀不在這條 loop 裡**：Gemini 判定是 ayana 的 pipeline 在上游做的；這裡只搬數字。
要加「Claude 讀圖寫判讀」時，它是一份另存的報告（你會親自讀），不進每日自動驗收。

## 部署

1. **Apps Script**：照 [`gas/README.md`](gas/README.md) 的 5 步（約 15 分鐘，不需要 GCP 管理員）
2. 跑完後 Actions → roadmap-daily → Run workflow，voc-graph-daily 會自動接著跑
3. 綠燈後打開 `https://<你的 vercel 網址>/voc-graph/web/`

## 紅燈對照

| 訊息 | 意思 | 誰處理 |
|---|---|---|
| 信件 `[STT Export] 今天沒有更新` + `欄位值跟預期不同` | 判定表的 tier / priority / exist 出現新值。**刻意停下**，寧可停不要算錯 | 把信貼給 Claude |
| 信件 + `GitHub ... 401` | GitHub token 過期或錯 | 你，重做 gas/README 第 3 步 |
| 信件 + `Access Denied` | 你的 BigQuery 權限被收回 | 資料團隊 |
| `C4 STT 夠新 FAIL` | STT 超過 14 天沒更新：Apps Script 停了，或 ayana 的判定沒跑 | 先看有沒有失敗信；沒有就問 ayana |
| `C6 ... mapping.json 有不存在的痛點代碼` | PM 填錯代碼 | PM |

## 檔案

| 檔案 | 用途 |
|---|---|
| `catalog.json` | 25 痛點（取自 `JP_Needs_Heatmap_ZH.html` 的 RANK）＋ F 主題（取自 ayana pipeline 的 CATALOG）。痛點改版時重抽 |
| `mapping.json` | 痛點 → Jira 卡。PM 維護 |
| `gas/SttExport.gs` | Apps Script：BigQuery → `out/stt-latest.json`。聚合在 BigQuery 內完成，userID 與原話不離開 BigQuery |
| `build.py` | 組圖 → `out/latest.json`、`out/graph-<日期>.json`、`out/brief-<日期>.md` |
| `check.py` | 驗收 C1–C10。只讀不改 |
| `web/index.html` | Vercel 頁面 |
| `fixtures/` | **虛構資料**，只給本機測試用 |

## 本機測試（不需要 BigQuery）

```bash
cd voc-graph
mkdir -p /tmp/vg && cp fixtures/stt-fixture.json /tmp/vg/stt-latest.json
python3 build.py --stt /tmp/vg/stt-latest.json --mapping fixtures/mapping-fixture.json --out /tmp/vg --today <roadmap latest.json 的日期>
python3 check.py --out /tmp/vg --today <同上>
```

## 隱私

頁面是公開網址（Cross 決定不設密碼，`noindex` 擋搜尋引擎）。所以：
- 只放人數、代碼、Jira 卡名、`hit_id`；**不放用戶原話、不放 userID**
- `check.py` C8 會掃輸出，出現 `userID` / `context` / 字串型 `stt` 等欄位一律 FAIL
- 要看原話：拿 `hit_id` 回 BigQuery `stt_voc_judgments` 查（社外不可）

## 已知限制

- **VoC Daily Bot（Slack ＋ 4 份表單）還沒接進來**。它的資料在 Google Sheet，下一階段加進同一支 Apps Script
- STT 讀取以 Cross 本人身分執行：權限被收回或交接時要重做 gas/README 的 5 步
- **25 痛點人數讀 `stt_voc_weekly_metrics`（pain25）**，就是 ayana 週報的「定点」：09/14 窗 X1.0=277／S2.1=233／S2.0=154／U4.1=100／U4.4=76 與週報逐一相符（2026-10-05 驗證）。不經 Gemini 判定、沒有 tier，所以痛點沒有 sTop 人數
  - 不用判定表的原因：判定表只收 P1＋4 條固定 lane，09/21 窗只出現 5 種痛點代碼，U4.1／U4.4 等會全部變 0
  - 不用精讀池的原因：精讀池是抽樣後的子集，S2.0 只剩 19 人（週報 154）
- 週次窗以判定表為準：weekly_metrics 若比判定表早一週出來，那一週的痛點人數要等判定表跟上才會顯示
- 欄位值（priority P1/P2/P3、tier sTop/Top/Regular/空、exist TRUE_PAIN/TOPIC/NOISE）2026-10-05 Cross 實查確認；日後出現新值會停下寄信
