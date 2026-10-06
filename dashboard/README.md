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

## 原話輸出＋中文摘要＋翻譯（2026-10-06 新增）

在痛點細節的「全部原話」按「開始整理」：抓最近 4 週全部原話 → Gemini 做中文摘要 → 每 20 則一批翻成繁中（上千則約 10–20 分鐘，途中可先下載；失敗的批次會跳過，最後可按「補翻」）→ 可下載 CSV 與摘要。Gemini 走公司 GCP（media17-1119）的 Vertex AI，以 Cross 身分呼叫，原話不出公司的 Google 雲。

**更新步驟（第一次，約 3 分鐘）**
1. 打開 https://raw.githubusercontent.com/crosswang-collab/product-ops-bridge/main/dashboard/gas/Dashboard.gs → Ctrl+A、Ctrl+C → 在 Apps Script 的 `Code.gs` 裡 Ctrl+A、Ctrl+V → 儲存。
2. 左側齒輪「專案設定」→ 勾選「在編輯器中顯示『appsscript.json』資訊清單檔案」→ 回到編輯器打開 `appsscript.json` → 用 https://raw.githubusercontent.com/crosswang-collab/product-ops-bridge/main/dashboard/gas/appsscript.json 的內容整份取代 → 儲存。（這一步是讓程式可以呼叫 Gemini。）
3. 函數選單選 `testGemini` → 執行 → 會再跳一次授權，全部允許。看到「✅ Gemini 可以用」才繼續；看到 ❌ 就把那行貼給 Claude（多半是要請 GCP 管理員開權限）。
4. 部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署。

下載沒反應時，按「下載沒反應？顯示全文自己複製」，全選複製後貼到 Google 試算表的 A1，會自動分成欄。

## 之後怎麼改

| 想做的事 | 怎麼做 |
|---|---|
| 加一位 PM 看得到 | `Dashboard.gs` 最上面 `ALLOWED_EMAILS` 加一行 email → 儲存 → 部署 → 管理部署作業 → 新版本 |
| 想馬上看到最新數字 | 資料每 6 小時自動重抓；急的話在編輯器執行 `refreshNow` |
| 介面改版 | Claude 改 `dashboard/app/` → 跑 `python3 dashboard/build_gas.py` → Cross 重新貼上全文並部署新版本 |

## 安全設計（第 3 輪審查要求）

- **存取**：每個瀏覽器呼叫得到的函數（`getDashboard`、`getPainDetail`、`refreshNow`、`testDashboard`）第一行都檢查允許名單；`doGet` 對名單外的人只給「沒有權限」頁。
- **原話顯示**：頁面一律用 `textContent` 放文字，不把字串當 HTML；不載入任何外部腳本或樣式。`build_gas.py` 打包時會掃描並拒絕違規寫法。
- **BigQuery**：SQL 寫死，只吃具名參數 `@code`（必須是 25 痛點清單內的代碼）與 `@since`（伺服器算的日期）。
- **不顯示 userID**：查詢結果不選 userID；Slack＋表單不帶發話者姓名；連結只保留 `https://`。
- **不寫任何東西**：專案內不需要任何 GitHub 金鑰（repo 是公開的，直接讀統計檔）、沒有寫入函數、不建試算表。原話只存在伺服器端 6 小時快取。
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
| `gas/appsscript.json` | Apps Script 權限設定（含呼叫 Gemini 需要的權限） |
| `app/Code.template.gs` | 伺服器端原始碼 |
| `app/Page.html` | 頁面原始碼 |
| `build_gas.py` | 打包＋安全掃描 |
| `test/harness.js` | 本機模擬 Apps Script 跑全部檢查：`node dashboard/test/harness.js` |
| `prototype.html` / `build_prototype.py` | 10/06 給 Cross 確認版面的原型（假原話） |

## 已知坑

- [Apps Script] 改了程式畫面不會變 — 一定要「部署 → 管理部署作業 → 新版本」。
- [Apps Script] 名單外的人「直接呼叫函數」也擋得住，是因為每個公開函數都呼叫 `assertAllowed_()`；新增公開函數時第一行一定要加。
- [BigQuery] 週人數讀不到時，畫面會改用 repo 的 7 週備援資料，並在最上方與「資料來源狀態」寫明原因。
