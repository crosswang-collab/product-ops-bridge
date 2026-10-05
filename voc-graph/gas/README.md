# STT Export（Apps Script）— 部署 5 步

這支 Apps Script 每天 08:30 JST，用**你本人的 BigQuery 權限**讀 STT 統計數字，推進 repo 的
`voc-graph/out/stt-latest.json`。不產生任何 GCP 金鑰（公司禁止），只抓聚合後的數字，不抓原話。

約 15 分鐘。

---

## 第 1 步：建 Apps Script 專案（3 分鐘）

1. 打開 https://script.google.com → 左上「新專案」
2. 左上專案名稱改成 `STT Export`
3. 把 `Code.gs` 預設內容全部刪掉，貼上本資料夾 `SttExport.gs` 的全文 → Ctrl/Cmd + S 存檔

## 第 2 步：開啟 BigQuery 服務（1 分鐘）

1. 左側欄「服務」旁邊的 **＋**
2. 清單裡找 **BigQuery API** → 版本選 **v2** → 識別碼保持 `BigQuery` → 「新增」

## 第 3 步：建一個只能寫這個 repo 的 GitHub token（4 分鐘）

1. 打開 https://github.com/settings/personal-access-tokens/new
2. 填：
   - **Token name**：`stt-export-apps-script`
   - **Expiration**：選 1 年（到期會收到失敗通知信，屆時重做這一步）
   - **Repository access**：選 **Only select repositories** → 只勾 `crosswang-collab/product-ops-bridge`
   - **Permissions → Repository permissions → Contents**：選 **Read and write**（其他全部維持 No access）
3. 最下面「Generate token」→ 複製 `github_pat_` 開頭那串（**只會顯示一次**）
4. 回到 Apps Script，把檔案最上面的 `PASTE_GITHUB_FINE_GRAINED_TOKEN_HERE` 換成這串 → 存檔

> 這個 token 只能改這一個 repo 的檔案，不能碰你其他 repo、不能碰 GCP。
> 它只存在你自己的 Apps Script 裡，不會進 repo。

## 第 4 步：測試（2 分鐘）

1. 上方函數選單選 **`testSttExport`** → 「執行」
2. 第一次會要求授權：選你的 17.media 帳號 →「進階」→「前往 STT Export（不安全）」→「允許」
   （「不安全」是因為這是你自己寫的腳本、沒經過 Google 審查，正常）
3. 下方執行紀錄應該出現：
   ```
   ✅ BigQuery 讀取成功（沒有推 GitHub）
   最新窗痛點前 5：X1.0=…、S2.1=…、S2.0=…
   ✅ GitHub token 可用
   ```
   出現紅字 → 整段複製貼給 Claude

## 第 5 步：正式跑一次 + 設排程（3 分鐘）

1. 函數選單選 **`runDaily`** → 執行 → 看到 `✅ 已推上 voc-graph/out/stt-latest.json`
2. 函數選單選 **`setupTrigger`** → 執行 → 看到 `✅ 排程已設定：每天 8:30 JST`
3. 到 GitHub → Actions → **roadmap-daily** → Run workflow（main）。跑完後 **voc-graph-daily** 會自動接著跑
4. voc-graph-daily 綠燈 → 打開你的 Vercel 網址加上 `/voc-graph/web/`

---

## 之後

- 每天 08:30 JST 自動更新。資料沒變就不推（不產生空 commit）
- 失敗會寄信到你的信箱，主旨 `[STT Export] 今天沒有更新 STT 資料`，把信貼給 Claude
- 就算這支默默停了：STT 超過 14 天沒更新，GitHub 的驗收（check.py C4）會紅燈寄信

## 已知限制

- **以你的身分執行**：你的 BigQuery 權限被收回、或帳號停用，這支就會停（會寄信）。
  之後若要交接給別人，對方用自己的帳號重做這 5 步即可
- GitHub token 最長 1 年到期，到期當天開始失敗（會寄信），重做第 3 步
