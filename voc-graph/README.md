# voc-graph

每天把三份事實接成一張圖，放在 Vercel 的 `/voc-graph/web/`：

```
STT 主播聲音（BigQuery，每週一批）─┐
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
│ FAIL   : BigQuery 暫時性錯誤（429/5xx）→ 重試 3 次，不寫半份檔
│          欄位值變了／權限錯 → exit 2/3，紅燈，不寫檔
│          驗收沒過 → 不 commit，頁面維持前一天，GitHub 寄信
│          連續 3 天紅燈 → 代表不是偶發，要人看（找 Claude 帶 log 進來）
└────────────────────────────────────────────────
```

**為什麼沒有 state 檔**：這條 loop 對外只有「讀」（BigQuery、repo 內檔案），唯一的寫入是
commit 自己的 `out/`，而且以日期為 key、重跑同一天結果相同（冪等）。沒有不可撤回的動作，
所以「上次做到哪」由 `out/graph-<日期>.json` 本身承擔，不另開 state。

**AI 判讀不在這條 loop 裡**：Gemini 判定是 ayana 的 pipeline 在上游做的；這裡只搬數字。
要加「Claude 讀圖寫判讀」時，它是一份另存的報告（你會親自讀），不進每日自動驗收。

## 部署（3 步）

1. **服務帳號**：請資料團隊開一個服務帳號，權限 =
   `media17-1119.DataLab_Ayana` 的 **BigQuery Data Viewer** ＋ `media17-1119` 的 **BigQuery Job User**，
   產出 JSON 金鑰。
2. **放進 GitHub**：repo Settings → Secrets and variables → Actions → New secret，
   名稱 `GCP_SA_KEY`，值貼整份 JSON。
3. **手動跑一次**：Actions → voc-graph-daily → Run workflow。綠燈後打開
   `https://<你的 vercel 網址>/voc-graph/web/`。之後每天自動跟在 roadmap-daily 後面跑。

## 第一次跑可能遇到的事

| 紅燈訊息 | 意思 | 誰處理 |
|---|---|---|
| `缺少 GCP_SA_KEY` | 第 2 步沒做 | 你 |
| `fetch_stt.py 崩潰或連不上 BigQuery` + `403` | 服務帳號權限不夠 | 資料團隊 |
| `[BLOCKER] ... 出現沒見過的值` | 判定表的欄位值（tier / priority / exist）跟 ayana notebook 的定義不同。**這是刻意的**：寧可停，不要算錯 | 帶 log 找 Claude 改 `fetch_stt.py` 的 `KNOWN_*` |
| `C4 STT 夠新 FAIL` | ayana 的判定超過 14 天沒跑 | 問 ayana |
| `C6 ... mapping.json 有不存在的痛點代碼` | PM 填錯代碼 | PM |

## 檔案

| 檔案 | 用途 |
|---|---|
| `catalog.json` | 25 痛點（取自 `JP_Needs_Heatmap_ZH.html` 的 RANK）＋ F 主題（取自 ayana pipeline 的 CATALOG）。痛點改版時重抽 |
| `mapping.json` | 痛點 → Jira 卡。PM 維護 |
| `fetch_stt.py` | BigQuery → `out/stt-latest.json`。聚合在 BigQuery 內完成，userID 與原話不離開 BigQuery |
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

- **VoC Daily Bot（Slack ＋ 4 份表單）還沒接進來**。它的資料在 Google Sheet，下一階段用同一個服務帳號讀
- STT 的痛點人數是用**判定表**的 `pain25_tags` 算的；ayana 週報的「定点」是從精讀池用正規表現數的，母體不同，數字不會一樣
- 欄位值（tier 等）是照 ayana notebook 推定的，第一次實跑才會知道是否完全吻合 —— 不吻合會紅燈停下，不會算錯
