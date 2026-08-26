# VoC Console v2 — 開發計畫（帶去下一個 chat 用）

> **這份文件怎麼用**：開新 chat 後貼上「附錄 A 的開場 prompt」，並確保新 session 掛著
> `crosswang-collab/product-ops-bridge` 這個 repo。文件本身在 `voc-bot/PLAN-console-v2.md`，
> 新 chat 的 Claude 讀得到，不需要複製全文。
>
> **開工前 Cross 要先回答第 6 節的 5 個問題** —— 其中 2 個不回答就無法開工（有標 🔴）。

---

## 0. BLUF

v1 解決了「讀得到」；v2 要解決的是「30 秒看懂 → 在介面上分類 → 對 PM 輸出」這條完整 workflow。
五個階段：**補資料涵蓋 → 30 秒首屏（含消費行為）→ 介面上分類（寫入！）→ 解決狀態 cluster → JIRA 連動與 PM 輸出包**。
最大的架構轉變在 Phase 2：Console 從「純唯讀」變成「可寫入」，人工判定與機器判定必須分欄、人工永遠贏。
最大的未知數在 Phase 1：**消費行為資料在哪、用什麼 key 跟發話者對起來** —— 這題只有 Cross 能答。

---

## 1. 現況（已完成、已上 main）

| 元件 | 檔案 | 狀態 |
|---|---|---|
| VoC Daily Bot v2（抓取→切分→比對→寫表） | `voc-bot/Code.gs`（~2,200 行） | 每天 08:10 JST 排程；含失敗轉態 email 通知（`ALERT_EMAIL`＋`notifyRunState_`，一次故障最多 3 封） |
| VoC Console（讀取介面） | `voc-bot/Dashboard.gs` ＋ `voc-bot/DashboardUI.html` | BLUF＋健康列＋資料品質列＋3 行動卡＋3 累計 KPI＋4 分頁＋右側抽屜 drill-down＋CSV 匯出 |
| 離線預覽（虛構資料） | `voc-bot/build-preview.py` → `voc-bot/preview/index.html` | 改完 HTML 跑 `python3 voc-bot/build-preview.py` 重新產生 |
| 部署手冊 | `voc-bot/RUNBOOK-console.md` | 5 步；含「出事的時候」對照表 |
| Crit 紀錄 | `voc-bot/CRIT-console.md` | 12 點 checklist：8 PASS / 3 FAIL / 1 N/A；三條 FAIL 只有 Cross 能關 |

資料流：Slack 1 個 channel ＋ 4 份 Google Sheet → 切分成獨立訴求 → Claude 比對 VoC Roadmap →
寫進 `VoC_Raw_Log`（append-only，唯一真相）→ Console 純前端聚合。
**Console 目前完全不寫任何資料**（唯一例外：`testDashboard` 寫一列 log）。這是 v1 的刻意設計，Phase 2 要打破它。

部署狀態：Apps Script 專案「VoC Daily Bot」，Web App 執行身分＝Cross、存取權＝只有我自己。
HTML 檔在 Apps Script 裡叫 **`DashboardUI`**（不是 `Dashboard`，見 PITFALLS #1）。

---

## 2. 資料涵蓋盤點（問題 1 的答案）

### 2.1 現在吃什麼（`Code.gs` 實際行為，不是願望）

| 來源 | 涵蓋方式 | 已知的洞 |
|---|---|---|
| Slack `C06PRMJ6HRD`（設定檔註解寫 #UserFeedback） | `conversations.history` 分頁抓＋討論串回覆（每串最多 50 則）；濾掉 bot 貼文與系統訊息 | ① 首次執行只回抓 30 天（`FIRST_RUN_LOOKBACK_DAYS=30`），更舊的歷史**從來沒進過系統**；② 單次上限 `SLACK_MAX_MESSAGES`，超過會下次接續（誠實截斷，不漏但會晚）；③ 每串第 51 則之後的回覆漏掉 |
| 4 份 Sheet（VIP Feedback／JP feature requests Q3／JP feedback for Cross／プロライバー定例会） | 每份掃**所有可見分頁**，自動找表頭列、同義字對欄位 | ① **隱藏分頁直接跳過**；② 表頭認不出來的分頁整張跳過；③ 內容欄對不到同義字表的欄位漏掉；④ 內容 <6 字元的列濾掉。以上四種**全部是靜默跳過，不會告訴你** |
| **Slack #jp-user-feedback** | **完全沒有涵蓋** | 程式只有單一 `SLACK_CHANNEL_ID` 變數，結構上就不支援第二個 channel |

### 2.2 Phase 0 要做的事

1. **多 channel 改造**：`SLACK_CHANNEL_ID` → `SLACK_CHANNELS = [{id, label}, …]`，permalink 產生、
   時間水位（`lastSlackTs_`）都要按 channel 分開算——水位混在一起會漏訊息。
2. **涵蓋稽核函式 `testCoverage()`**：對每個來源印出「看到幾列／吃進幾列／跳過幾列＋跳過原因分佈」
   寫進 `VoC_Bot_Log`。把 2.1 的四種靜默跳過變成看得見的數字。
3. **Console 加「來源涵蓋」區塊**：每個來源最後一次成功讀取時間＋吃進筆數，跟健康列同一層。
   「有沒有吃到全部資料」從此是畫面上的事實，不是猜測。

⚠️ 本 session 的 Slack 連接器搜不到 17media workspace（掛的是別的 workspace），
**jp-user-feedback 的 channel ID 我拿不到**，也無法確認 `C06PRMJ6HRD` 到底是不是就是它。
Cross 取得方式：Slack 打開該 channel → 頻道名稱點下去 → 最下面「頻道 ID」。→ 見第 6 節問題 1。

---

## 3. 踩過的坑（PITFALLS — 下一個 chat 不要重踩）

格式照 coding-rules Rule 5：`[平台] 出了什麼錯 — 正確做法`

1. **[Apps Script] 同一專案不能有兩個同名檔案，指令碼跟 HTML 也不行** — `Dashboard.gs` 佔了名字，HTML 必須叫 `DashboardUI`。`doGet` 的 `createHtmlOutputFromFile('DashboardUI')` 與檔名大小寫要完全一致。
2. **[Apps Script] 改完 code 畫面不會變** — 一定要「部署 → 管理部署作業 → 新版本」。只改 `Code.gs` 給排程用的不用。
3. **[Apps Script] 整份重貼 `Code.gs` 會把金鑰洗掉** — 貼之前先記下 `SLACK_TOKEN`、`ANTHROPIC_API_KEY`，貼完填回去。repo 裡永遠是 placeholder，**絕不 commit 真值**。
4. **[語意] `generatedAt = nowStr_()` 是「打開網頁的時間」不是「資料的時間」** — 資料時間唯一來源是 `dashLastRun_()` 從 `VoC_Bot_Log` 倒讀的最後成功時刻。介面上這兩個字樣絕不能混。v2 所有新元件沿用這條。
5. **[設計] 首屏數字超過 ~30 個、同一數字出現兩次以上＝checker 會判 FAIL** — v1 靠「期間數字刻在按鈕上、KPI 只放累計」壓到 32 個。v2 加新元件時要先減後加。
6. **[前端] sticky 表頭會吃掉底下列的點擊** — Playwright 抓到 `intercepts pointer events`。解法：`tbody tr { scroll-margin-top: <表頭高度> }`。
7. **[資料] roadmap 上被刪掉／改名的代碼（orphan）不能算進「在／不在 roadmap」任一邊** — 否則 KPI 跟自己的小字對不起來。`buildItems()` 的 `orphan` 旗標處理這件事，v2 的 cluster 也要延用。
8. **[GAS] 效能三件套** — ① `apiRaw` 回陣列的陣列（省 40% JSON）；② 1,200 列一頁分批；③ TextFinder 定位單筆而不是整張掃。v2 寫入 API 沿用同樣思路。
9. **[環境] 本容器 curl 不到 Vercel preview／script.google.com** — 代理擋 CONNECT。驗證一律走本地 Playwright 對 `preview/index.html`，不要宣稱線上版驗過。
10. **[流程] bot 每天自己醒，掛掉沒人知道** — 已用健康列＋轉態 email 補上。v2 任何新的無人化環節（例如 JIRA 同步）都要先過 loop-contract 四格，缺 STOP 不開工。
11. **[資料] `VoC_New_Candidates` 每天整張重建** — 在上面手填的東西會被洗掉。這正是 Phase 2 必須把人工判定寫在 `VoC_Raw_Log` 專屬欄位（append-only）而不是彙總表的原因。
12. **[Claude API] 比對一次 15 筆（`MATCH_BATCH_SIZE`），量大會「達單次上限」** — 未判定積壓時跑 `catchUpMatching` 接續，不是 bug。

---

## 4. V2 開發計畫（五個 Phase，每個都有可驗收的 STOP）

> 順序有依賴關係：Phase 0 不做完，30 秒首屏顯示的是不完整的資料 —— 快而錯比慢更糟。
> Phase 2 是信任基礎（人工分類），Phase 3/4 都建立在它之上。

### Phase 0 — 資料涵蓋補齊（先讓數字可信）

**做什麼**：第 2.2 節的三件事。
**改哪裡**：`Code.gs`（多 channel＋`testCoverage()`）、`Dashboard.gs`／`DashboardUI.html`（來源涵蓋區塊）。
**STOP（checker 可驗）**：
- `SLACK_CHANNELS` 含 jp-user-feedback，`testConnections` 對每個 channel 各回 OK
- `testCoverage()` 在 `VoC_Bot_Log` 印出每來源「看到／吃進／跳過＋原因」
- Console 顯示每來源最後成功讀取時間；任一來源連續 2 天沒資料時變黃
**前置**：問題 1（channel ID）。
**規模**：小。半天內含驗證。

### Phase 1 — 30 秒首屏重設計 ＋ 發話者消費行為

**做什麼**：
- 首屏砍半（CRIT-console.md I WISH 第 1 條，Cross 這次的話等於拍板）：
  **BLUF 一句 → 健康列 → 「本期新增」清單（每條帶 AI 一句 summary）→ 待分類佇列入口**。
  累計 KPI、趨勢圖、查詢型分頁全部移出首屏（分頁還在，只是不佔第一屏）。
- 每則聲音／每個發話者旁邊掛**消費行為標籤**（例：月消費級距、SVIP 等級、最近活躍）。
  抽屜裡顯示發話者的 spending 摘要——「誰在抱怨」跟「這個人值多少」同框。
**風險（最大的一個）**：發話者是 Slack 顯示名或表單自由填寫的名字，消費資料的 key 很可能是
openID／user ID —— **名字對 ID 的 mapping 髒是常態**。第一版策略：對得上的顯示、對不上的誠實標
「無消費資料」，寧缺勿錯，絕不模糊比對之後假裝精確。
**STOP**：
- Playwright 量測：首屏（1440×900 與 1280×720）數字 ≤ 15 個，「本期新增」前 5 列完整可見
- 新增聲音清單每列有：summary、發話者、消費標籤（或「無資料」）、來源連結
- 消費標籤抽查 10 筆與來源表一致；對不上的顯示「無消費資料」而不是空白或錯值
**前置**：🔴 問題 2（消費資料在哪、join key 是什麼）。
**規模**：中。介面重排一天；消費資料接入取決於資料乾淨度，髒的話另計。

### Phase 2 — 介面上分類（Console 第一次寫入，架構轉變）

**做什麼**：待分類佇列（未判定＋歸類沒把握＋代碼失效）逐筆呈現：原話全文＋機器人的猜測與理由
＋一排按鈕（歸入既有痛點 S2.x／歸入候選 CAND-x／建新痛點／標雜訊）。點了直接寫回 sheet。
**安全規則（不可妥協，v1 血淚換的）**：
1. **人工判定寫專屬新欄**（`人工判定`／`判定者`／`判定時刻`，加在 `RAW_HEADERS` 尾端），
   **絕不覆蓋**機器的 `判定` 欄——稽核時要看得出「機器說什麼、人改成什麼」。
2. **人工永遠贏**：`matchPending_` 重試未判定時必須跳過有人工判定的列（現在不會跳，要改）。
3. `LockService` 包每次寫入——你開兩個 tab 同時點就會撞。
4. 寫入 API 拿 hash 用 TextFinder 定位（同 `apiDetail`），寫完回讀驗證才回 OK。
5. Web App 存取權維持「只有我自己」；如果要多人分類→先回答問題 3，那是另一個規模的題目。
**STOP**：
- 在介面分類 1 筆 → sheet 該列 3 個人工欄位正確寫入，機器判定欄原封不動
- 分類後跑 `runDailyDigest` → 該筆不被重判（人工贏）
- 兩個瀏覽器 tab 同時分類不同列 → 兩筆都成功、無錯位（LockService 驗證）
- 分類完成的筆即時從佇列消失、進入所屬 cluster
**規模**：大。這是 v2 最重的一塊，建議在新 chat 裡單獨一輪做完＋checker 驗收。

### Phase 3 — 解決狀態 Cluster 總覽

**做什麼**：首屏下方（或第二屏頂部）四欄看板：**已解決／解決中／未解決／待分類**。
每欄放痛點卡（標題、累計、近 7 日、優先度、Rank、消費加權聲量），點卡開既有抽屜。
**現成基礎**：`resolved`／`status` 欄位、`bucketOf()`／`itemBucket()` 已有，主要是聚合與呈現，
不需要新資料。「解決中」的判定規則要跟 Roadmap 的 Status 欄實際值對一次（哪些值算 in progress）。
**STOP**：
- 四欄件數相加 ＝ 有效痛點總數（orphan 排除規則沿用 PITFALLS #7）
- 每張卡可 drill-down 到原話
- 與「痛點總表」分頁的數字交叉驗算一致
**規模**：小-中。

### Phase 4 — JIRA 連動 ＋ PM 輸出包

**JIRA（先便宜後貴，兩步走）**：
- **4a（先做）**：Roadmap 或 `VoC_Pain_Points` 加一欄 `JIRA Key`（如 `APPIDEAS-123`），
  Console 顯示成連結 `https://17media.atlassian.net/browse/<KEY>`。零 API、零憑證，當天完成。
- **4b（4a 用順了再做）**：GAS 用 Jira REST API（email＋API token，Basic auth）批次拉 ticket 狀態，
  每天跟 bot 一起刷。多一把要管理的憑證＋一個新失敗模式（納入健康列與 email 通知）。
  參考：Jira site `17media.atlassian.net`，cloudId `69564616-1122-4f22-9fa5-00ccbcda1149`，
  已知專案 `APPIDEAS`（VoC 對應哪個專案→問題 4）。
**PM 輸出包**：任一 cluster／痛點一鍵產出可貼給 PM 的包：
痛點標題＋累計與近 7 日聲量＋消費加權＋3 則代表性原話（含連結）＋JIRA key。
第一版做「複製到剪貼簿」（v1 已有雛形，抽屜裡有「複製全部原話」），格式適合貼 Slack。
**STOP**：
- 填了 JIRA Key 的痛點在 Console 點得開對應 ticket
- （4b）ticket 狀態欄每日更新，Jira 讀取失敗走「未知」降級不炸頁（同 roadmap 降級模式）
- 輸出包貼進 Slack 後格式完整、連結可點、可直接 @PM 開討論
**規模**：4a＋輸出包＝小；4b＝中。

### 建議節奏

| 輪次（chat） | 內容 | 理由 |
|---|---|---|
| 下一個 chat | Phase 0 ＋ Phase 1 | 資料先可信，首屏才有意義；兩個都偏介面與抓取，改動面重疊 |
| 再下一輪 | Phase 2 單獨做 | 寫入路徑要單獨驗收，不跟別的混 |
| 之後 | Phase 3 → 4a＋輸出包 → 4b | 依賴 Phase 2 的人工分類結果 |

每輪交付前照慣例跑 checker（Review mode，rubric：Cross 需求＋ideo 12 點＋coding-rules Pre-Ship），
🔴 存在即 FAIL 不降級。

---

## 5. v2 不改的東西（防 scope creep）

- 切分／比對／寫入 `VoC_Raw_Log` 的核心邏輯（v1 驗過，動它要有明確理由）
- 一個 Apps Script 專案、`var`、hardcode config、錯誤寫 Sheet（coding-rules GAS 規則）
- Web App 存取權「只有我自己」（Raw 含發話者姓名與 Slack 原文，放寬＝公開日本用戶原話）
- 健康列／資料品質列永遠在數字之前
- `VoC_Raw_Log` append-only＝唯一真相；人工判定也是往它加欄，不是另建真相

---

## 6. Cross 要先回答的問題（開工前）

| # | 問題 | 擋住哪個 Phase |
|---|---|---|
| 1 | **jp-user-feedback 的 channel ID**（頻道名稱點下去最底下）。順便確認 `C06PRMJ6HRD` 是哪個 channel、除了這兩個還有沒有第三個來源 channel？ | Phase 0 |
| 2 | 🔴 **消費行為資料在哪份表／哪個系統？欄位有哪些（月消費、SVIP 等級…）？用什麼 key 跟發話者對起來**（openID？名字？）？ | Phase 1 消費標籤 |
| 3 | 分類介面**只有你用，還是之後要給別人**（PM／CS）？答案決定 Phase 2 是維持「只有我自己」還是要做多人＋權限，後者規模大很多 | Phase 2 |
| 4 | 🔴（4b 前再答即可）VoC 對應的 **JIRA 專案**是哪個（APPIDEAS？別的？）？願不願意在 GAS 裡放一把 Jira API token？ | Phase 4b |
| 5 | PM 輸出包的形式偏好：貼 Slack 的文字？PDF？還是共享 Sheet？（預設做 Slack 文字，最快能用） | Phase 4 |

---

## 附錄 A — 下一個 chat 的開場 prompt（複製貼上）

```
讀 voc-bot/PLAN-console-v2.md，照計畫做 Phase 0 + Phase 1。

我的回答：
1. jp-user-feedback channel ID：C________；C06PRMJ6HRD 是 #________
2. 消費行為資料在：________（sheet 連結／欄位／join key：________）
3. 分類介面使用者：________
（4、5 之後再答）

規則照舊：coding-rules（GAS 一個專案、完整交付）、交付前跑 checker Review mode、
金鑰只用 placeholder。踩坑清單在 PLAN 第 3 節，不要重踩。
```

## 附錄 B — 檔案地圖

```
voc-bot/
├─ Code.gs               bot 本體（抓取→切分→比對→寫表→email 通知）
├─ Dashboard.gs          Console 後端（apiCore / apiRaw / apiDetail / testDashboard）
├─ DashboardUI.html      Console 前端（Apps Script 裡檔名必須是 DashboardUI）
├─ build-preview.py      產生離線預覽（改完 HTML 要重跑）
├─ preview/index.html    離線預覽（虛構資料）
├─ RUNBOOK.md            bot 部署手冊
├─ RUNBOOK-console.md    Console 部署手冊（5 步＋出事對照表）
├─ CRIT-console.md       crit 紀錄（12 點判定＋三條未關的 FAIL）
└─ PLAN-console-v2.md    本文件
```
