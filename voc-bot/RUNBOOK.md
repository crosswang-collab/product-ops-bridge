# VoC Daily Bot — 部署手冊

每天早上 8:00（JST）自動去看 Slack `#UserFeedback` 跟 4 份表單，把用戶／實況主的需求彙整好，
寫進 **VIP Feedback Sharing Sheet** 的 4 個機器人專屬分頁。

> **重要前提：這支機器人不會動到那份試算表的任何既有分頁。** 它只會建立並寫入
> `VoC_Daily_Brief` / `VoC_Index` / `VoC_Raw_Log` / `VoC_Bot_Log` 這 4 個新分頁。

---

## 你會拿到什麼

| 分頁 | 內容 | 什麼時候看 |
|---|---|---|
| **VoC_Daily_Brief** | 今日摘要，最新的永遠在第 2 列。含「PM と話す候補」清單 | 每天早上掃一眼 |
| **VoC_Index** | 主索引，一個議題一列。含累計件數、直近30日熱度、優先分數（高→低排序） | 跟 PM 開會前打開這個 |
| **VoC_Raw_Log** | 每一則原始聲音，附 Slack 永久連結 | 要 drill down 舉證時 |
| **VoC_Bot_Log** | 執行紀錄與錯誤 | 覺得怪怪的時候 |

`VoC_Index` 最右邊兩欄 **PM共有日** 和 **クロスメモ** 是留給你手動填的，
機器人每天重算索引時**不會覆蓋**這兩欄。

---

## 部署（5 步，約 15 分鐘）

### 第 1 步 — 建立 Apps Script 專案

1. 開 https://script.google.com → **新增專案**
2. 左上專案名稱改成 `VoC Daily Bot`
3. 把左邊預設的 `Code.gs` 內容整份刪掉，貼上本資料夾的 `Code.gs` 全文
4. Ctrl/Cmd + S 存檔

> 為什麼是獨立專案而不是綁在試算表上？因為那份試算表的擁有者是 ryoyamamoto，
> 你不一定有權限在上面建立繫結指令碼。獨立專案用 ID 開啟即可，權限只需要「編輯者」。

### 第 2 步 — 取得 17media Slack token（唯一需要動到 Slack 的一步）

`#UserFeedback` (`C06PRMJ6HRD`) 在 **17media.slack.com**。
（順帶一提：Claude 這邊的 Slack 連線是 `mikai inc.` workspace，跨不過去，所以才需要這個 token。）

1. 用你的 **17media** 帳號登入 https://api.slack.com/apps → **Create New App** → **From scratch**
   - App Name：`VoC Bot`　Workspace：選 **17media**
2. 左側 **OAuth & Permissions** → 往下找 **Bot Token Scopes** → **Add an OAuth Scope**，加這 3 個：
   - `channels:history`（公開頻道歷史）
   - `groups:history`（私人頻道歷史，若該頻道是私人的必加）
   - `users:read`（把 user ID 轉成人名）
3. 拉到頁面最上方 → **Install to Workspace** → 允許
   - 若公司需要管理員核准，會顯示「Request to Install」，送出後請管理員按核准
4. 複製 **Bot User OAuth Token**（`xoxb-` 開頭）
5. **回到 Slack，進 `#UserFeedback` 頻道，輸入 `/invite @VoC Bot`**
   ← 這步很容易漏掉。沒做的話會出現 `not_in_channel` 錯誤。

### 第 3 步 — 填設定 + 設時區

在 `Code.gs` 最上面的 CONFIG 區塊：

```js
var SLACK_TOKEN = 'xoxb-你剛剛複製的token';   // ← 換掉
```

其他都已經填好了（4 份試算表 ID、頻道 ID、每天 8 點）。
`ANTHROPIC_API_KEY` 留空就好——留空是規則式摘要，功能完整。

然後設時區：左側 **⚙ 專案設定** → **時區** → 選 `(GMT+09:00) 日本標準時間`。
（沒設的話排程會用預設時區觸發，時間會跑掉。）

### 第 4 步 — 測連線

上方函式下拉選單選 **`testConnections`** → 按 **執行**。

第一次會跳授權：**檢閱權限 → 選你的 Google 帳號 → 進階 → 前往「VoC Daily Bot」（不安全）→ 允許**。
（「不安全」是因為這支腳本沒經過 Google 驗證，是你自己寫的，正常。）

跑完打開試算表的 **VoC_Bot_Log** 分頁，你會看到一串檢查結果。
**每一列都要是 OK 才往下走。** 常見錯誤：

| Log 訊息 | 意思 | 怎麼修 |
|---|---|---|
| `Slack token 還是 placeholder` | 第 3 步沒存到 | 重存 `Code.gs` |
| `not_in_channel` | bot 沒被邀進頻道 | 回 Slack 打 `/invite @VoC Bot` |
| `channel_not_found` | token 不是 17media 的 | 第 2 步 workspace 選錯了，重做 |
| `missing_scope` | 權限沒加齊 | 回 App 設定加 scope，**要重新 Install to Workspace** |
| `目標試算表寫入失敗` | 你對那份表只有檢視權 | 請 ryoyamamoto 給你編輯者權限 |

### 第 5 步 — 首次執行 + 開排程

1. 函式選 **`runDailyDigest`** → **執行**
   - 第一次會抓過去 30 天的 Slack + 4 份表全部內容，可能跑 1–3 分鐘
   - 跑完去看 `VoC_Daily_Brief` 和 `VoC_Index`
2. 確認結果 OK 後，函式選 **`setupAll`** → **執行**
   - 這會安裝每日 08:10 的排程

完成。之後每天早上自己會跑。

---

## 已知限制（先講清楚，不要部署完才發現）

1. **Slack 只讀 `C06PRMJ6HRD` 這一個頻道。** 要加頻道的話目前要改 code。
2. **單次執行上限 300 則 Slack 訊息、40 個討論串。** 超過的部分下次執行自動接續，
   不會遺漏（水位是從已寫入的最新訊息推算的）。第一次跑如果訊息很多，可能要連跑兩三次才追完。
3. **分類是規則式的**，用關鍵字字典比對，不是 AI。準確度大概八成，
   `その他 / Other` 那一類就是沒對到字典的。要提高準確度就填 `ANTHROPIC_API_KEY`。
4. **索引是「議題層級」聚類**（主題 × 種類 × 核心關鍵字），不是一則聲音一列。
   要看個別聲音去 `VoC_Raw_Log`，每筆都有連結。
5. **重複偵測靠文字比對。** 同一件事講法差很多時，可能會變成兩列。
   `CANON` 那個表就是在處理這件事（ギフボ→ギフトボード 之類），發現漏的可以自己加一行。
6. **Apps Script 單次執行上限 6 分鐘**，程式內建 4 分鐘軟上限會主動收手。
7. **這份試算表的擁有者是 ryoyamamoto@17.media。** 機器人會每天在他的表裡新增 4 個分頁並持續寫入。
   建議先知會他一聲。

---

## 日常操作

| 想做什麼 | 怎麼做 |
|---|---|
| 現在立刻跑一次 | 執行 `runDailyDigest` |
| 改時間 | 改 `DAILY_HOUR`，然後重跑 `installDailyTrigger` |
| 暫停 | 執行 `removeTriggers` |
| 加一份新表單 | 在 `SOURCE_SHEETS` 加一行 `{ id: '...', label: '...' }` |
| 某些欄位沒被抓到 | 執行 `inspectSources`，把 `VoC_Bot_Log` 的結果貼給 Claude |
| 分類不準 | 在 `THEMES` / `KIND_RULES` / `CANON` 加關鍵字 |
| 想要 AI 摘要 | 填 `ANTHROPIC_API_KEY`，跑 `testConnections` 確認通 |

## 出事的時候

看 `VoC_Bot_Log`，由下往上找 `ERROR` 或 `FAIL`。
排程執行失敗時 Google 也會寄信到你的 Gmail。
回報時請附上：`VoC_Bot_Log` 最後 10 列 + 你在哪一步。
