# HANDOVER — JP Needs Tank Dashboard 部署任務

> **貼給 Claude Code（網頁版）用。** 你（Claude Code）在 Cross 的本機 `product-ops-bridge` repo 裡執行。
> 目標：把 5 個 dashboard 檔案整理進 repo、commit & push、部署到 Vercel 拿到可分享網址。

---

## 0. 你是誰、在哪、要做什麼

- **環境**：Cross 的 PC，Claude Code 網頁版，工作目錄 = 本機 `product-ops-bridge` git repo。
- **使用者**：Cross，COO（非工程師）。繁中溝通、no fluff、結論先講、table 優先。
- **任務**：部署一個**純靜態前端** dashboard（單檔 HTML + 內嵌資料，無 build step）到 Vercel，並把成品與 decision log 提交到 GitHub。
- **鐵則**：任何會改動外部世界的動作（git push、vercel deploy、刪檔）→ **先 preview 給 Cross、等他明確同意才執行**。不確定就當成要確認。

---

## 1. 前置狀態（Cross 已完成）

Cross 已從 Claude 對話下載一個 `deploy-pkg/` 資料夾，內含 6 個檔，並已放進本機 repo（可能在 repo 根目錄或某子資料夾）。**你的第一步是找到它們。**

預期檔案：
```
index.html                                      ← 語言選單首頁（部署入口）
JP_Needs_Heatmap_ZH.html                        ← 繁中版 dashboard (~370KB)
JP_Needs_Heatmap_JP.html                        ← 日文版 dashboard (~370KB)
vercel.json                                      ← Vercel 靜態部署設定（含 noindex 標頭）
DECISION-LOG-2025-06-30-jp-needs-ranking.md      ← 決策記錄
README.md                                        ← 部署說明（人看的）
```

---

## 2. 檔案內容背景（你要理解才能正確處理，別亂改）

- **兩支 HTML 是成品**：內嵌 291 筆日本用戶/實況主需求資料（`const DATA=[...]`）+ 對應表（`const LIMAP`）+ 排序資料（`const RANK`）。**不要重寫、不要重新產生、不要「順手優化」**。它們已通過驗證。
- **功能**：最上方 25 痛點總排序（可拖拉 + 匯出當前順序）、5 張 paincard、兩層 drill-down（點擊展開原始 requests）、繁中版 UI 繁中但 raw request 保留日文原聲。
- **不使用 localStorage**（前端環境會 fail）——拖拉順序是 session 內有效，這是刻意設計，別去加 localStorage。
- **隱私**：HTML 內嵌約 210 個 SVIP openID（敏感資料）。Cross 已決定**部署不設密碼**，但已加 `noindex,nofollow` 擋搜尋引擎。**不要**在未經 Cross 同意下更改隱私設定或移除資料。

---

## 3. 執行步驟

### Step 1 — 定位檔案 + 確認 repo 狀態
```bash
pwd
git remote -v
git status
# 找出 deploy-pkg 六個檔在哪
find . -name "JP_Needs_Heatmap_ZH.html" -not -path "*/node_modules/*"
find . -name "vercel.json" -not -path "*/node_modules/*"
```
把找到的路徑回報給 Cross，確認無誤再往下。若找不到 → 停下來問 Cross 檔案放哪了。

### Step 2 — 整理進 repo 結構（preview 後執行）
建議結構：dashboards 相關檔進 `dashboards/`，decision log 進 `decision-log/`。
**先把你打算執行的 mv/cp 指令列出來給 Cross 看，等同意。**
```bash
mkdir -p dashboards decision-log
# 依 Step 1 找到的實際來源路徑調整左側
mv <found>/index.html                    dashboards/
mv <found>/JP_Needs_Heatmap_ZH.html      dashboards/
mv <found>/JP_Needs_Heatmap_JP.html      dashboards/
mv <found>/vercel.json                   dashboards/
mv <found>/README.md                     dashboards/
mv <found>/DECISION-LOG-2025-06-30-jp-needs-ranking.md  decision-log/
```
> ⚠️ `vercel.json` 必須跟三支 HTML 在**同一層**（`dashboards/`），否則 Vercel 設定不生效。

### Step 3 — 驗證檔案完整（不改內容，只檢查）
```bash
# 兩支 HTML 應各含 1 個排序區、DATA 陣列非空
grep -c 'class="rankwrap"' dashboards/JP_Needs_Heatmap_ZH.html
grep -c 'class="rankwrap"' dashboards/JP_Needs_Heatmap_JP.html
grep -c 'const DATA=' dashboards/JP_Needs_Heatmap_ZH.html
# index 連結指向兩支 HTML
grep -o 'href="[^"]*"' dashboards/index.html
# vercel.json 是合法 JSON
python3 -c "import json;json.load(open('dashboards/vercel.json'));print('vercel.json OK')"
```
預期：rankwrap 各 =1、DATA =1、index 有兩個 href、vercel.json OK。任何不符 → 回報 Cross，別自行修改 HTML。

### Step 4 — Git commit & push（**preview 後執行**）
先 `git diff --stat` 給 Cross 看要提交什麼，等同意：
```bash
git add dashboards decision-log
git commit -m "feat(jp-needs): 25痛點總排序(拖拉+匯出) + 雙語版 + 兩層drill-down

- 最上方新增可拖拉的25痛點總排序區, 初始序=N*3+pri*4, 可匯出當前順序
- 繁中版: 介面繁中, raw request保留日文原聲
- paincard 5x5 li → 對應原始requests (LIMAP精確對應, badge=實際筆數)
- 明細表列點擊展開 detail panel (summary + provenance)
- 部署: Vercel靜態(index語言選單 + noindex標頭)
- decision log: 公式/對應原則/drift風險/openID governance"
git push
```

### Step 5 — 部署到 Vercel（**preview 後執行**）
偵測 Vercel 能力，選一條：

**5a. 若你有 Vercel MCP / 連線**：直接用它部署 `dashboards/` 目錄，Root Directory 設 `dashboards`。部署後把網址回報 Cross。

**5b. 若沒有 MCP，用 CLI**（先確認 Cross 電腦裝了 Node）：
```bash
node -v            # 確認有 Node
npm i -g vercel    # 沒裝過才要
cd dashboards
vercel             # 首次會要 Cross 登入 + 綁專案；產生 preview 網址
vercel --prod      # 產生正式網址 → 這是要分享的連結
```
> CLI 首次互動需要 Cross 本人操作登入/授權。遇到互動提示時，**停下來請 Cross 完成登入**，別假裝能代按。

**5c. 若走 GitHub 綁定**：告訴 Cross 去 vercel.com → Add New Project → 選 `product-ops-bridge` repo → **Root Directory 設 `dashboards`** → Deploy。

### Step 6 — 驗收
- 打開部署網址，確認：入口是語言選單、繁中/日文各能開、25 痛點排序區可拖拉、點 paincard 能展開原始 requests。
- 把最終網址 + 一句話狀態回報 Cross。

---

## 4. 部署後可能要處理

| 情況 | 動作 |
|---|---|
| 更新 dashboard 內容 | 改檔 → `git push`（若 Vercel 綁 repo 會自動 redeploy）或 `cd dashboards && vercel --prod` |
| Cross 之後要加密碼 | Vercel → Project → Settings → Deployment Protection → Password Protection（Pro 方案）|
| 要收回公開網址 | Vercel → 刪除該 deployment/project |

---

## 5. 絕對不要做

- ❌ 重寫、重新產生、或「優化」兩支 HTML 的內容（含 DATA/LIMAP/RANK）。它們是驗證過的成品。
- ❌ 加 localStorage 到拖拉排序（環境會 fail，且刻意不用）。
- ❌ 未經 Cross 同意更改隱私設定、移除 openID、或改部署權限。
- ❌ 在互動式登入提示上假裝代 Cross 操作——停下來請他本人做。
- ❌ silent push——每個 git/vercel 動作先 preview 等同意。

---

## 6. 若卡住

回報 Cross 時：貼出實際錯誤訊息、你在哪一步、你判斷的原因、以及你建議的下一步（給 A/B/C 選項）。不要反覆試同一招。
