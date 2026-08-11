# VoC Daily Bot — 部署手冊

每天早上 8:00（JST）自動去看 Slack `#UserFeedback` 跟 4 份表單，把每一則聲音**比對你的 VoC Roadmap**，
然後告訴你：**哪些舊痛點又被抱怨了（而且還沒解決）、哪些是該加進 VoC 的新痛點。**

> **重要前提：這支機器人不會動到任何既有分頁。**
> 它只在 **VIP Feedback Sharing Sheet** 建立並寫入 5 個新分頁；
> 對 **Japan VoC roadmap workbook** 是**唯讀**的（只讀不寫，建議都寫進機器人自己的分頁）。

---

## 它怎麼判斷新舊痛點

```
Slack + 4 份表單的原始聲音
   ↓ 切分：一則講三件事 → 算三筆（並濾掉「お疲れ様です」這類寒暄）
   ↓ 比對 Japan VoC roadmap workbook 的「JP Needs — Product Roadmap」分頁
   │
   ├─ 命中既有 pain point  → 舊痛點：件數 +N，讀 Status/Shipped 判斷是否仍未解決
   ├─ 沒命中              → 新痛點：分群成候選，建議加入 VoC
   └─ 沒把握              → 未判定：留著下次自動重試，不靜默丟掉
```

---

## 你會拿到什麼

| 分頁 | 內容 | 什麼時候看 |
|---|---|---|
| **VoC_Daily_Brief** | 今日摘要，最新的永遠在第 2 列。先講「未解決又件數增加的舊痛點」，再講「建議加入 VoC 的新痛點」 | **每天只需要看這個** |
| **VoC_Pain_Points** | 既有 VoC 痛點 × 累計件數／今回新規／增減／是否未解決。未解決且增加多的排最前面 | 跟 PM 開會前打開 |
| **VoC_New_Candidates** | 不在 VoC 上的新痛點候選，附建議領域與優先度 | 決定要不要加進 VoC 時 |
| **VoC_Raw_Log** | 每一筆切分後的聲音，附連結、判定結果與判定根據 | 要 drill down 舉證、或想知道某筆為什麼被歸到某個痛點 |
| **VoC_Bot_Log** | 執行紀錄與錯誤 | 覺得怪怪的時候 |
| **Dashboard 網頁** | 三語互動網頁：本次變化、影響地圖、痛點排名、原始心聲佐證 | 要給團隊看、或開會投影的時候 |

`VoC_Pain_Points` 與 `VoC_New_Candidates` **最右邊兩欄是留給你手動填的**，機器人每天重算時**不會覆蓋**。

---

## 部署（5 步）

### 第 1 步 — 建立 Apps Script 專案

1. 開 https://script.google.com → **新增專案**
2. 專案名稱改成 `VoC Daily Bot`
3. 把預設的 `Code.gs` 內容整份刪掉，貼上本資料夾的 `Code.gs` 全文
4. Ctrl/Cmd + S 存檔

> 為什麼是獨立專案？因為 VIP Feedback Sharing Sheet 的擁有者是 ryoyamamoto，
> 你不一定有權限在上面建立繫結指令碼。獨立專案用 ID 開啟即可。

### 第 2 步 — 取得 17media Slack token

`#UserFeedback` (`C06PRMJ6HRD`) 在 **17media.slack.com**。有兩條路，**建議走 A**。

#### A. User Token（`xoxp-`）— 推薦，不需要把 app 加進頻道

User Token 是「**以你的身分**」讀取。你瀏覽器裡已經看得到 `#UserFeedback`，所以它就讀得到，
**不需要 `/invite`、不需要把 app 加進頻道**。

1. 用 **17media** 帳號登入 https://api.slack.com/apps → **Create New App** → **From scratch**
   - App Name：`VoC Bot`　Workspace：選 **17media**
2. 左側 **OAuth & Permissions** → 找 **User Token Scopes**（**不是** Bot Token Scopes），加這 3 個：
   - `channels:history`（公開頻道歷史）
   - `groups:history`（私人頻道歷史 — 私人頻道必加）
   - `users:read`（把 user ID 轉成人名）
3. 拉到最上方 → **Install to Workspace** → 允許
4. 複製 **User OAuth Token**（`xoxp-` 開頭）
5. **跳過 `/invite`，直接進第 3 步。**

#### B. Bot Token（`xoxb-`）— 備選

同上，但在 **Bot Token Scopes** 加同樣 3 個 scope，複製 **Bot User OAuth Token**，
然後**必須**回 Slack 進 `#UserFeedback` 輸入 `/invite @VoC Bot`。漏掉會出現 `not_in_channel`。

#### 如果卡在「需要管理員核准」

17media 是企業版，可能限制非管理員安裝 app。兩種處理：

- 送出 **Request to Install**，請 Slack 管理員核准（用途：唯讀單一頻道、內部 VoC 彙整）
- 或**先不管 Slack**：`SLACK_TOKEN` 留著 placeholder 不動即可。程式會把 Slack 記為錯誤寫進
  `VoC_Bot_Log`，**其他 4 份表照跑照寫**，不會整支掛掉。等 token 拿到再填上去。

### 第 3 步 — 填設定 + 設時區

在 `Code.gs` 最上面的 CONFIG 區塊，有 **2 個**要填：

```js
var SLACK_TOKEN = 'xoxp-你剛剛複製的token';        // ← 換掉（xoxb- 也可以，同一個欄位）
var ANTHROPIC_API_KEY = 'sk-ant-你的key';          // ← 強烈建議填，理由見下
```

**為什麼 `ANTHROPIC_API_KEY` 這次變成強烈建議、不再是選填：**
痛點清單是**英文**（`Free ticker covers the livestream screen`），Slack 聲音是**日文**（`金テロが顔に被って…`）。
純關鍵字比對跨不過這個語言差。填了 key 走語意比對；留空會降級成規則式，判定欄會標
**「規則式(精度低)」**——那是降級模式，不是等效模式。

其他都已經填好了（4 份來源表 ID、Roadmap 表 ID 與 gid、頻道 ID、每天 8 點）。

然後設時區：左側 **⚙ 專案設定** → **時區** → 選 `(GMT+09:00) 日本標準時間`。

### 第 4 步 — 測連線

函式下拉選 **`testConnections`** → **執行**。

第一次會跳授權：**檢閱權限 → 選你的 Google 帳號 → 進階 → 前往「VoC Daily Bot」（不安全）→ 允許**。
（「不安全」是因為這支腳本沒經過 Google 驗證，是你自己寫的，正常。）

跑完打開 **VoC_Bot_Log**。**每一列都要是 OK 才往下走。** 常見錯誤：

| Log 訊息 | 意思 | 怎麼修 |
|---|---|---|
| `Slack token 還是 placeholder` | 第 3 步沒存到 | 重存 `Code.gs` |
| `not_in_channel` | 用了 bot token 但沒邀進頻道 | 打 `/invite @VoC Bot`，或改用 `xoxp-` user token |
| `channel_not_found` | token 不是 17media 的 | 第 2 步 workspace 選錯，重做 |
| `missing_scope` | 權限沒加齊 | 加 scope 後**必須重新 Install to Workspace** |
| `VoC Roadmap：開不了` | 你對 Roadmap 表沒有檢視權 | 那份表是你自己的，通常不會出現；確認帳號一致 |
| `找不到含「Request / Pain points」標題列` | Roadmap 的 gid 變了 | 執行 `inspectRoadmap` 看實際讀到什麼，必要時改 `VOC_ROADMAP_GID` |
| `目標試算表寫入失敗` | 你對 VIP 表只有檢視權 | 請 ryoyamamoto 給編輯者權限 |
| `Claude API key 未設定`（WARN） | 會降級成規則式 | 填 `ANTHROPIC_API_KEY` |

想確認痛點清單讀對了，可以再跑一次 **`inspectRoadmap`**，它會把讀到的 42 個痛點逐列 dump 到 `VoC_Bot_Log`。

### 第 5 步 — 首次執行 + 開排程

**如果你之前跑過舊版（v1，有 `VoC_Index` 分頁）**，先跑一次
**`resetRawLogAndRebuild`** —— 它會清空 `VoC_Raw_Log` 並用新的切分規則重建。
不跑也能運作（有相容處理），但舊資料會維持舊的粗切分，件數會偏低。
**這個函式會刪 `VoC_Raw_Log` 的資料**，你手動填的兩欄不受影響。

1. 全新部署 → 函式選 **`runDailyDigest`** → **執行**
   （升級自 v1 → 改選 **`resetRawLogAndRebuild`**）
   - 第一次會抓過去 30 天 Slack + 4 份表全部內容，並逐批送去比對，可能跑 2–5 分鐘
   - 跑完看 `VoC_Daily_Brief`、`VoC_Pain_Points`、`VoC_New_Candidates`
2. 確認結果 OK 後，函式選 **`setupAll`** → **執行**（安裝每日 08:10 排程）

完成。試算表已經會每天自己更新。想要一個「大家都打得開的網頁版」再往下做。

---

## Dashboard 網頁（選配，4 步）

一個給全團隊看的網頁：日／英／繁中三語切換，每一個數字都能點開背後的原始用戶心聲，
還附上出處連結。跟試算表讀同一份資料，不會有第二個真相。

### 第 1 步 — 新增 HTML 檔

Apps Script 編輯器左邊「檔案」旁邊的 **＋** → **HTML** →
檔名輸入 **`Dashboard`**（不要加 `.html`，Apps Script 會自己加）→
把預設內容整份刪掉，貼上本資料夾的 `Dashboard.html` 全文 → 存檔。

> 檔名一定要正好是 `Dashboard`。`Code.gs` 是用這個名字去找它的，打錯會出現
> 「找不到 HTML 檔案」。

### 第 2 步 — 部署成網頁

右上 **部署 → 新增部署作業 → 齒輪選「網頁應用程式」**：

| 欄位 | 選什麼 |
|---|---|
| 說明 | `VoC Dashboard v1` |
| 執行身分 | **我（你自己）** |
| 誰可以存取 | **17media 的任何人**（或「只有我」先自己看） |

按 **部署** → 第一次會要你授權 → 拿到一組 `https://script.google.com/…/exec` 網址。

### 第 3 步 — 自己先開一次

用那組網址開網頁。應該會看到最上面「距上次執行的變化」兩欄：
左邊是路線圖上沒有的新痛點，右邊是尚未解決又被再次提到的痛點。
點任何一列 → 展開該痛點背後的每一則原始心聲、出處、日期、比對信心與連結。

沒看到資料 → 表示 `runDailyDigest` 還沒跑成功，回去第 5 步。

### 第 4 步 — 把網址丟給團隊

網址固定不變，資料每天自己更新，不需要重新部署。

**改了 `Code.gs` 或 `Dashboard.html` 之後要讓大家看到新版**：
右上 **部署 → 管理部署作業 → 鉛筆圖示 → 版本選「新版本」→ 部署**。
只存檔不做這一步，網頁還是舊的。（同樣的地方也可以選回舊版本，退版很安全。）

---

## 已知限制（先講清楚，不要部署完才發現）

1. **比對精度取決於有沒有填 `ANTHROPIC_API_KEY`。** 沒填 → 跨語言比對命中率低，
   判定欄會誠實標成「規則式(精度低)」。這不是等效替代品。
2. **信心不足的判定會標「要確認」而不是靜默歸類。** `VoC_Raw_Log` 的
   `信頼度` 與 `判定根拠` 兩欄就是給你複核用的。發現判錯，改
   `VoC_Pain_Points` 的克羅斯備註欄，或回報給我調 prompt。
3. **Roadmap 上沒填 Source 代碼的列**，機器人用「標題雜湊」當 key。
   之後如果**改了那些列的標題**，累計件數會斷掉重新從 0 算。
   建議每列都給一個代碼（S2.x / U4.x / Z…），追蹤才穩定。
   `testConnections` 會告訴你有幾列沒代碼。
4. **Slack 只讀 `C06PRMJ6HRD` 這一個頻道。** 要加頻道目前要改 code。
5. **單次執行上限**：300 則 Slack 訊息、40 個討論串、10 批比對（每批 15 筆）。
   超過的下次自動接續，不會遺漏（水位從已寫入的最新訊息推算）。
   第一次跑訊息很多時，可能要連跑兩三次才追完 —— `VoC_Bot_Log` 會寫「達單次上限」。
6. **去重是「訊息層級」的**：同一則訊息只會被切分一次，之後永遠跳過。
   所以日後調整切分規則，不會把舊訊息重切一遍造成重複計數 ——
   但也代表**要讓舊資料享受新切分規則，必須跑 `resetRawLogAndRebuild`**。
7. **Apps Script 單次執行上限 6 分鐘**（Workspace 帳號通常 30 分鐘），
   程式內建 4.5 分鐘軟上限會主動收手；沒做完的下次接續。
8. **VIP Feedback Sharing Sheet 的擁有者是 ryoyamamoto@17.media。**
   機器人會每天在他的表裡新增 5 個分頁並持續寫入。建議先知會他。
9. **v1 的 `VoC_Index` 分頁不再更新。** 確認新分頁沒問題後可以自行刪除。
10. **Dashboard 的資料會快取 10 分鐘。** 不然每個人開一次網頁就要重讀 4 個分頁 +
    Roadmap，人一多會很慢。每天排程跑完會自動清快取；想立刻看到最新的，
    按頁面右上角的「更新到最新」。
11. **「17media 的任何人」代表全公司都讀得到原始用戶心聲**，包含 Slack 發言者名字，
    即使那個人沒有這幾份試算表的權限。覺得太寬就在第 2 步改成「只有我」，
    或改用「特定的人」。
12. **每天新長出來的痛點候選沒有中文標題。** Claude 在判定當下只寫日文與英文兩個標題，
    所以切到繁中時，新候選會顯示日文原題。既有的 42 個 VoC 痛點三語都有。

---

## 日常操作

| 想做什麼 | 怎麼做 |
|---|---|
| 現在立刻跑一次 | 執行 `runDailyDigest` |
| 看它到底讀到哪些痛點 | 執行 `inspectRoadmap`，結果在 `VoC_Bot_Log` |
| 某些來源欄位沒被抓到 | 執行 `inspectSources`，把 `VoC_Bot_Log` 結果貼給我 |
| 用新切分規則重建全部資料 | 執行 `resetRawLogAndRebuild`（**會清空 Raw_Log**） |
| 改時間 | 改 `DAILY_HOUR`，重跑 `installDailyTrigger` |
| 暫停 | 執行 `removeTriggers` |
| 加一份新來源表 | 在 `SOURCE_SHEETS` 加一行 `{ id: '...', label: '...' }` |
| Roadmap 換分頁了 | 改 `VOC_ROADMAP_GID`（網址 `#gid=` 後那串數字） |
| 降級模式命中率太低 | 在 `PAIN_POINT_ALIASES` 對應代碼下加日文說法 |
| 寒暄沒被濾掉 | 在 `NOISE_PHRASES` 加一行 |
| 切分太碎 / 太粗 | 調 `SEG_MAX_LEN`（預設 180）與 `SEG_MAX_PER_MESSAGE`（預設 8） |
| 判定太寬鬆 / 太嚴格 | 調 `MATCH_ACCEPT_CONF`（預設 0.6）與 `MATCH_REVIEW_CONF`（預設 0.4） |
| Dashboard 顯示舊資料 | 按網頁右上「更新到最新」，或執行 `clearDashboardCache` |
| 改完 code 網頁沒變 | 部署 → 管理部署作業 → 鉛筆 → 版本選「新版本」→ 部署 |

## 出事的時候

看 `VoC_Bot_Log`，由下往上找 `ERROR` 或 `FAIL`。排程執行失敗時 Google 也會寄信到你的 Gmail。
回報時請附上：`VoC_Bot_Log` 最後 10 列 + 你在哪一步。
