# VoC 作戰台（單一儀表板）

把直播原話（STT）、Slack＋表單的聲音、Jira Roadmap 放在同一個頁面。只有允許名單上的人打得開；頁面只讀資料，不寫任何東西。

## 部署（5 步，約 10 分鐘）

1. 打開 https://script.google.com → **新專案**，專案名稱改成「VoC 作戰台」。把 `dashboard/gas/Dashboard.gs` 的**全文**貼進去，取代預設的 `程式碼.gs` 內容，然後按儲存。
   這是新專案，**不要**貼進「STT Export」。
2. 左側「**服務**」按 ＋ → 選 **BigQuery API** → 新增。
3. 上方函數選單選 `testDashboard` → **執行** → 第一次會跳出授權視窗，全部允許（需要 BigQuery、試算表、外部網址的讀取權）。下方紀錄打勾的行都要是 ✅（「新興／持續／消退」那行是數字摘要，沒有勾）。**看到 ⚠️、❌ 或紅色錯誤框就先停，把整段紀錄（或錯誤框的字）貼給 Claude**，不用自己判斷。
4. 右上角「**部署 → 新增部署作業**」→ 類型選「網頁應用程式」：
   - 執行身分：**我**
   - 誰可以存取：**17.media 網域內的任何使用者**（實際能看的人另由程式裡的允許名單控制）

   按部署，複製網址，打開確認畫面正常。最上方出現黃色「注意」或「讀不到資料」時，截圖貼給 Claude。
5. 舊 VoC Console 改轉址：打開「VoC Daily Bot」專案的 `Dashboard.gs`，找到 `var NEW_DASHBOARD_URL = '';`，把第 4 步的網址貼進兩個引號中間 → 儲存 → **部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署**。

## 已上線（2026-10-06）

- 網址：`https://script.google.com/a/macros/17.media/s/AKfycbyvKDW_bRldvvYRaguBGJFsSg47uk3sqz83piXl-9GeX4eQq5jlW72JnMtrgd6CJ-aQxw/exec`
- 舊頁面轉址：Vercel 的 `/voc-graph/web`（對照頁）、`/roadmap-bot/web`（Roadmap 頁）一律轉到上面網址（`vercel.json` 的 `redirects`）。「誰在處理這個痛點」編輯頁與 JP Needs 熱力圖不轉。
- 舊 VoC Console：repo 的 `voc-bot/Dashboard.gs` 已填好 `NEW_DASHBOARD_URL`；貼進「VoC Daily Bot」專案並部署新版本後生效。

## 原話輸出＋翻譯＋摘要（2026-10-07 改版：不需要任何付費金鑰）

在痛點細節的「全部原話」按「讀取原話」：抓最近 4 週全部原話，可直接下載 CSV。
- **翻譯**：按「翻譯成中文（Google 翻譯）」，用 Apps Script 內建的 Google 翻譯逐則翻成繁中（免費、不需金鑰；每批 20 則，每 1,000 則約 5–10 分鐘，途中可先下載）。失敗的批次會跳過，最後可按「補翻」；當天次數用完或太忙會直接停下說原因。
- **摘要**：下載 CSV → 打開 claude.ai 上傳 → 按頁面上「複製摘要指令」貼過去。

**資料去向（2026-10-07 Cross 決定）**：翻譯時原話送到 Google 翻譯（公司已在用的 Google 服務，以 Cross 帳號執行）；摘要時由 Cross 自己把 CSV 上傳到 claude.ai。

**更新步驟（約 3 分鐘）**
1. 打開 https://raw.githubusercontent.com/crosswang-collab/product-ops-bridge/main/dashboard/gas/Dashboard.gs → Ctrl+A、Ctrl+C → 在 Apps Script 的程式檔（`程式碼.gs`）裡 Ctrl+A、Ctrl+V → 儲存。
2. 打開 `appsscript.json`（左側檔案清單裡；看不到的話：齒輪「專案設定」→ 勾「在編輯器中顯示 appsscript.json」），整份換成 https://raw.githubusercontent.com/crosswang-collab/product-ops-bridge/main/dashboard/gas/appsscript.json 的內容 → 儲存。
3. 函數選單選 `testTranslate` → 執行。看到「✅ Google 翻譯可以用」才繼續；看到 ❌ 就把那行貼給 Claude。
4. 部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署。

下載沒反應時，按「下載沒反應？顯示全文自己複製」，全選複製後貼到 Google 試算表的 A1，會自動分成欄。

## 之後怎麼改

| 想做的事 | 怎麼做 |
|---|---|
| 改 PM 名字／固定某個痛點找的團隊 | `Dashboard.gs` 最上面 `TEAM_PM`（團隊 → PM）、`PAIN_TEAM`（痛點 → 團隊；預設空白＝Cross 自己對照，畫面列出 5 個團隊的 PM）→ 儲存 → 部署新版本。痛點已有負責的卡時，改用卡的團隊 |
| 開卡試算表 | `Dashboard.gs` 最上面 `CARD_SHEET_URL` 填網址 → 儲存 → 部署新版本；痛點細節的「下一步」就會出現「開卡試算表」按鈕。改完想馬上看到，在編輯器執行 `refreshNow`（否則最多 6 小時後生效） |
| 加一位 PM 看得到 | `Dashboard.gs` 最上面 `ALLOWED_EMAILS` 加一行 email → 儲存 → 部署 → 管理部署作業 → 新版本 |
| 想馬上看到最新數字 | 資料每 6 小時自動重抓；急的話在編輯器執行 `refreshNow` |
| 介面改版 | Claude 改 `dashboard/app/` → 跑 `python3 dashboard/build_gas.py` → Cross 重新貼上全文並部署新版本 |

## 安全設計（第 3 輪審查要求）

- **存取**：每個瀏覽器呼叫得到的函數（`getDashboard`、`getPainDetail`、`getPainExport`、`translateQuotes`、`refreshNow`、`testDashboard`、`testTranslate`）第一行都檢查允許名單；`doGet` 對名單外的人只給「沒有權限」頁。
- **原話顯示**：頁面一律用 `textContent` 放文字，不把字串當 HTML；不載入任何外部腳本或樣式。`build_gas.py` 打包時會掃描並拒絕違規寫法。
- **BigQuery**：SQL 寫死，只吃具名參數 `@code`（必須是 25 痛點清單內的代碼）與 `@since`（伺服器算的日期）。
- **不顯示 userID**：查詢結果不選 userID；Slack＋表單不帶發話者姓名；連結只保留 `https://`。
- **不寫任何東西**：專案內不需要任何 GitHub 金鑰（repo 是公開的，直接讀統計檔）、沒有寫入函數、不建試算表。原話只存在伺服器端 6 小時快取。不需要任何金鑰。
- **例外（2026-10-07 Cross 決定）**：按「翻譯成中文」時原話送到 Google 翻譯；摘要由 Cross 自己把 CSV 上傳到 claude.ai。
- **頁面打包在專案內**：不從 repo 動態讀頁面，改版必須 Cross 重新部署。

## 時間段規則（每個痛點各自計算，最近 12 週）

| 類型 | 規則 |
|---|---|
| 🔥 新興高熱 | 最近 2 週**每週平均** ≥ 10 位，且 ≥ 前 4 週每週平均 × 2（前 4 週平均 < 2 位時不看倍數） |
| 🔁 持續高熱 | 最近 6 週中至少 4 週 ≥ 20 位 |
| 📉 消退 | 最近 3 週**每週都比前一週低**（需要 4 個週點） |

## 檔案

| 檔案 | 用途 |
|---|---|
| `gas/Dashboard.gs` | **貼進 Apps Script 的唯一檔案**（由 `build_gas.py` 產生，不要手改） |
| `gas/appsscript.json` | Apps Script 權限設定 |
| `app/Code.template.gs` | 伺服器端原始碼 |
| `app/Page.html` | 頁面原始碼 |
| `build_gas.py` | 打包＋安全掃描 |
| `test/harness.js` | 本機模擬 Apps Script 跑全部檢查：`node dashboard/test/harness.js` |
| `prototype.html` / `build_prototype.py` | 10/06 給 Cross 確認版面的原型（假原話） |

## 已知坑

- [Apps Script] 改了程式畫面不會變 — 一定要「部署 → 管理部署作業 → 新版本」。
- [Apps Script] 名單外的人「直接呼叫函數」也擋得住，是因為每個公開函數都呼叫 `assertAllowed_()`；新增公開函數時第一行一定要加。
- [BigQuery] 週人數讀不到時，畫面會改用 repo 的 7 週備援資料，並在最上方與「資料來源狀態」寫明原因。
