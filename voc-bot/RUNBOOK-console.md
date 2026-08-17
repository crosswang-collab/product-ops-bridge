# VoC Console — 部署手冊

把 VoC Daily Bot 每天寫進試算表的東西，變成一個你 90 秒讀得完的網頁。
**一個網址，加到書籤，每天早上打開就好。**

> 前提：你已經照 `RUNBOOK.md` 部署好 VoC Daily Bot，而且 `runDailyDigest` 至少成功跑過一次。
> 還沒跑過的話 Console 打開會是空的（它會直接告訴你「請先執行 runDailyDigest」）。

---

## 它回答什麼

| 你想知道的 | 在畫面哪裡 |
|---|---|
| 昨天、過去一週新增了哪些 VoC／痛點 | 最上面那句話 ＋「本期新增」分頁（期間可切昨日／7 日／30 日／全期） |
| 這些是不是已經在 VoC Roadmap 裡 | 每一列最左邊的藍／橘標籤：**已在 roadmap** ／ **不在 roadmap** |
| 已經在裡面的話層級多高 | 優先度（P0–P3）、Rank、Roadmap 狀態、未解決與否 —— 表上直接顯示；「Roadmap 覆蓋」分頁有分層彙總 |
| 在／不在 roadmap 的總 mention 次數 | 最上排前兩張大數字卡 |
| 過去所有痛點與 VoC 的總表 | 「痛點總表」分頁（roadmap 上的 ＋ 不在 roadmap 的候選，合成一張，可排序） |
| 原始大表（誰說的／何時／大小類別／來源連結） | 「Raw 大表」分頁（可搜尋、篩選、匯出 CSV） |
| 任何一個數字是怎麼來的 | **點下去**。每個數字、每一列、圖上每一根柱子都會開右側抽屜，列出構成它的每一則原話 ＋ 出處連結 |

---

## 部署（5 步，約 10 分鐘）

### 第 1 步 — 打開既有的 Apps Script 專案

https://script.google.com → 開啟你之前建的 **`VoC Daily Bot`**。
**不要開新專案**，Console 必須跟 bot 在同一個專案裡，才能共用設定與讀表邏輯。

### 第 2 步 — 更新 `Code.gs`

打開 GitHub 上的 `voc-bot/Code.gs`，**整份複製**，回到 Apps Script 把 `Code.gs` 內容**整份取代**，存檔。

> 這次只多了兩個欄位（roadmap 的 `Rank` 與 `Date of submission`），給 Console 顯示「層級多高」用。
> 比對邏輯、寫入邏輯、你填的 `SLACK_TOKEN` 跟 `ANTHROPIC_API_KEY` 都不受影響 ——
> **但貼上前先把你原本填的那兩把金鑰記下來，貼完要重新填回去。**

### 第 3 步 — 新增兩個檔案

在 Apps Script 左側檔案列表按 **＋**：

1. 選 **指令碼** → 命名 `Dashboard`（系統會自動變成 `Dashboard.gs`）
   → 把 GitHub 上 `voc-bot/Dashboard.gs` 的內容整份貼進去
2. 再按 **＋** → 選 **HTML** → 命名 `Dashboard`（會變成 `Dashboard.html`）
   → 把 GitHub 上 `voc-bot/Dashboard.html` 的內容整份貼進去

> 檔名一定要叫 `Dashboard`（大小寫相同）。`Dashboard.gs` 是用這個名字去找 HTML 的。

存檔。

### 第 4 步 — 測試

函式下拉選 **`testDashboard`** → **執行**。

跑完打開試算表的 **`VoC_Bot_Log`** 分頁，看最後幾列：

| 看到什麼 | 意思 |
|---|---|
| `apiCore：roadmap 42 件／候選 N 件／raw N 列` | 正常，資料讀得到 |
| `apiRaw：第一頁 N 列／總計 N 列／需要 N 次載入` | 正常 |
| `apiDetail：第 N 列取回成功` | 正常，drill-down 可用 |
| `第一頁判定分布：既存一致 N／…` | 正常，順便讓你知道有多少列還沒判定 |
| `WARN 讀不到 VoC Roadmap…` | 你對 Roadmap 表沒有檢視權，或 `VOC_ROADMAP_GID` 變了 |
| `FAIL 開不了資料試算表…` | 你對 VIP Feedback Sharing Sheet 沒有權限 |

**有 FAIL 就先修，不要往下走。** 全是 OK／WARN 才進第 5 步。

### 第 5 步 — 部署成網頁

右上角 **部署 → 新增部署作業** →
齒輪選 **網頁應用程式** →

- **執行身分**：**我**（`crosswang@17.media`）
- **具有存取權的使用者**：**只有我自己**

→ **部署** → 第一次會要你授權（檢閱權限 → 選帳號 → 進階 → 前往「VoC Daily Bot」→ 允許）

拿到一個 `https://script.google.com/macros/s/…/exec` 的網址。**把它加進書籤。完成。**

> **存取權為什麼一定要選「只有我自己」**：Raw 大表裡有發話者姓名、Slack 原文與 permalink。
> 選「知道連結的任何人」等於把日本用戶的原話公開到網路上。要給別人看，用 Google 帳號逐一加人，
> 不要放寬成任何人。

---

## 改了 code 之後怎麼更新

改完 `Dashboard.html` 或 `Dashboard.gs` 存檔後 —— **要再部署一次才會生效**：
**部署 → 管理部署作業 → 鉛筆圖示 → 版本選「新版本」→ 部署**。網址不變。

（只改 `Code.gs` 給排程用的話不需要重新部署，排程吃的永遠是最新存檔。）

---

## 先講清楚的限制

1. **Console 是即時讀試算表的，但試算表本身是 bot 每天 08:00 才更新一次。**
   所以你早上 9 點看到的「昨日新增」，是 bot 今天早上抓到的東西。想要更即時 → 手動跑一次 `runDailyDigest`，再按 Console 右上角「重新整理」。

2. **「発生日」與「取込日」會不一樣，而且差很多。**
   発生日＝用戶實際說話那天；取込日＝bot 抓到那天。補抓舊訊息時，一則 3 週前的聲音會是「発生日很舊、取込日是昨天」。
   右上角可以切換基準。**問「用戶最近在抱怨什麼」用発生日；問「機器人昨天撈到什麼新東西」用取込日。**

3. **判定準不準，取決於 bot 有沒有填 `ANTHROPIC_API_KEY`。**
   沒填的話畫面上會有一條黃色警告，而且很多列會標成「歸類沒把握」。那不是 Console 的問題，是資料源的問題。

4. **「未判定」「歸類沒把握」「代碼已失效」永遠顯示在 KPI 下面那一排，不會被藏起來。**
   這是刻意的 —— 你跟 PM 講數字的時候，要先知道有多少是機器人沒把握的。

5. **資料量上限 30,000 列。** 超過的話 Console 只載入最新的 3 萬列，並且會在畫面上明說。
   以目前的量（每天數十列）大概三年後才會碰到。

6. **Console 完全不寫任何資料**，只有 `testDashboard` 會往 `VoC_Bot_Log` 寫驗證紀錄。
   你在 `VoC_Pain_Points` / `VoC_New_Candidates` 手填的那兩欄，Console 不碰也不顯示。

7. **手機上能開，但這是為桌機設計的。** 表格很寬，手機要橫向捲。

---

## 出事的時候

| 症狀 | 處理 |
|---|---|
| 打開一片黑，寫「介面載不起來」 | 照畫面指示跑 `testDashboard`，看 `VoC_Bot_Log` |
| 打開是空的、數字都 0 | bot 還沒跑過，先執行 `runDailyDigest` |
| 「是否已在 roadmap」全都顯示未知 | Roadmap 表讀不到，看 `VoC_Bot_Log` 的 WARN |
| 改了 code 但畫面沒變 | 忘了「管理部署作業 → 新版本」 |
| 載入很慢 | 看畫面上的載入進度：raw 列數多就會慢，這是一次性成本，載完之後切換期間／分頁都是瞬間的 |

---

## 離線預覽版（不用部署就能看介面）

`voc-bot/preview/index.html` 是同一份介面配上**虛構的示範資料**，直接用瀏覽器打開就能看動線。
畫面最上方有橘色警告條標明是預覽版。改過 `Dashboard.html` 之後重新產生：

```bash
python3 voc-bot/build-preview.py
```
