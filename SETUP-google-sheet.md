# 開發 Roadmap — Google Sheet 設定指南

架構：**Google Sheet = 唯一真相** · **roadmap.html（GitHub Pages）= 顯示 + 拖拉排序介面** · **Apps Script = 中間橋接（讀 + 把拖拉後的順序寫回）**。

- 新增需求／改 RACI／狀態／日期／JIRA → 都在 **Google Sheet** 編輯。
- 開發順序 → 在**網頁拖 ⠿** 調整，會自動存回 Sheet。
- 沒設定時 roadmap.html 會用內建 25 筆預設（僅本機展示、拖拉不存回），不會壞。

---

## 1. 建立 Google Sheet（用範本）
1. 開一個新的 Google Sheet。
2. **檔案 → 匯入 → 上傳** `roadmap-template.csv`（本 repo 內）→ 匯入位置選「取代目前工作表」。
3. 把該分頁**改名為 `Roadmap`**（左下角分頁按右鍵 → 重新命名）。
   - 前 25 筆已預填；`key` 欄 🔒 請勿更動（連結內建的日文原始 requests）。

### 欄位說明
| 欄 | 說明 |
|---|---|
| `sort` | 開發順序（數字小→前）。**網頁拖拉會自動改這欄**，你也可手動改。|
| `key` 🔒 | 前 25 筆已填，勿動；新需求**留空**。|
| `title` `area` | 標題、領域（如 U4 禮物・課金）。|
| `priority` | P0 / P1 / P2 / P3。|
| `status` | Backlog / Up Next / In Progress / In Review / Shipped / Blocked。|
| `accountable` | 當責（單一人，A）。|
| `responsible` `consulted` `informed` | R／C／I，多人用逗號分隔。|
| `target_ship` `shipped_on` | 目標上線日／實際上線日 YYYY/MM/DD。|
| `next_step` | 下一步（office-hours：具體可執行）。|
| `blocker_ask` | 卡關／需要的決策 → 會出現在網頁頂部「需要決策」。|
| `jira` | JIRA 單號或完整連結。|
| `demand_n` | 用戶需求件數（前 25 已帶）。|
| `jp_original` | 原始日文（**新需求**用；前 25 筆用內建的）。|

**新增一筆需求** = 在最下面加一列，`key` 留空，填 title/area/priority/status/RACI…，`sort` 給個數字或留空（留空排在最後）。

---

## 2. 部署 Apps Script（讀 + 寫回的橋接）
1. 在這張 Sheet：**擴充功能 → Apps Script**。
2. 把本 repo 的 `apps-script/Code.gs` 內容整段貼進去（覆蓋預設的 `Code.gs`）→ 儲存 💾。
3. 右上 **部署 → 新增部署作業** → 齒輪選「**網頁應用程式**」。
4. 設定：
   - **執行身分：我（你自己）**
   - **具有存取權：任何人**
5. **部署** → 依指示**授權**（會問你允許存取這張 Sheet，按同意）。
6. 複製最後給的 **網頁應用程式網址**（形如 `https://script.google.com/macros/s/XXXX/exec`）。

---

## 3. 貼進 roadmap.html
打開 `roadmap.html`，最上面設定區：
```js
const SHEET_API = "";   // ← 貼上剛剛的 /exec 網址
```
填好後 `git push`（GitHub Pages 會自動更新）。

---

## 4. 開啟 GitHub Pages
repo **Settings → Pages → Build and deployment → Source: `Deploy from a branch` → Branch: `main` `/ (root)` → Save**。
約 1 分鐘後得到網址：`https://crosswang-collab.github.io/product-ops-bridge/`
- 入口 `index.html`（語言／視圖選單）→ 開發 Roadmap。
- 或直接開 `.../roadmap.html`。

---

## 5. 驗收
1. 開 roadmap 網址，右上角顯示 **「☁ 已連結 Sheet」**。
2. **拖 ⠿ 調整順序** → 右上顯示「順序已存回 Sheet」→ 重整仍是新順序 → 打開 Sheet 看 `sort` 欄有更新。
3. 在 **Sheet** 改某列的 status/owner/日期 → 重整網頁即反映。
4. 在 **Sheet** 最下面加一列（key 留空）→ 重整網頁看到新項目。
5. 點任一列 → 展開 RACI 分工 + 下一步/Ask + 原始日文 requests。

---

## 重要提醒
- **公開、無密碼**（既定決策）：拿到網址的人都能看，且能拖拉改順序（透過 Apps Script「任何人」存取）。其他欄位的編輯需有這張 Sheet 的 Google 權限。
- GitHub Pages 免費版無法設密碼；已在頁面加 `noindex,nofollow` 擋搜尋引擎。要更嚴格可改用私有部署或加登入。
- 原始 291 筆需求資料與 openID **不在這張 Sheet**；roadmap.html 只內嵌 25 個痛點的日文 request 文字（不含 openID）。
- 改用 GitHub Pages 後，記得到 **Vercel 刪除舊的 product-ops-bridge project**，收回舊的公開網址。
- 併發：多人同時拖拉採「最後寫入為準」；小團隊策展沒問題，重整即見最新。
