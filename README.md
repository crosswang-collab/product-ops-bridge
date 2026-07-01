# JP Needs Tank — Dashboard 部署包

內含繁中 + 日文兩版 dashboard、語言選單首頁、Vercel 設定、decision log。

```
deploy-pkg/
├── index.html                    ← 語言選單（部署後的入口）
├── JP_Needs_Heatmap_ZH.html      ← 繁中版
├── JP_Needs_Heatmap_JP.html      ← 日文版
├── vercel.json                   ← Vercel 靜態部署設定（含 noindex 標頭）
└── DECISION-LOG-2025-06-30-jp-needs-ranking.md
```

---

## A. 寫進 GitHub（decision log + dashboards）

> 前提：本機已有你的 `product-ops-bridge` repo，且已設好 remote。
> 把這 5 個檔放到 repo 對應位置後執行。建議結構：
> - `dashboards/` 放 3 支 HTML + `vercel.json` + `index.html`
> - `decision-log/` 放那份 MD

```bash
# 1) 進到你的 repo
cd ~/path/to/product-ops-bridge

# 2) 建目錄並放檔（把下載的 deploy-pkg 內容複製過來）
mkdir -p dashboards decision-log
cp /path/to/deploy-pkg/index.html                       dashboards/
cp /path/to/deploy-pkg/JP_Needs_Heatmap_ZH.html         dashboards/
cp /path/to/deploy-pkg/JP_Needs_Heatmap_JP.html         dashboards/
cp /path/to/deploy-pkg/vercel.json                      dashboards/
cp /path/to/deploy-pkg/DECISION-LOG-2025-06-30-jp-needs-ranking.md  decision-log/

# 3) commit + push
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

---

## B. 部署到 Vercel（拿到可分享網址）

⚠️ 我（Claude）在這個聊天環境**無法代你部署**——Vercel 部署需要你本機/帳號的登入狀態。以下兩條路你挑一條，都很快。

### 路徑 1：Vercel CLI（最快，1 分鐘）

```bash
# 一次性安裝（若沒裝過）
npm i -g vercel

# 進到含這些檔案的資料夾
cd /path/to/deploy-pkg

# 部署（第一次會問你登入 + 綁專案，照提示按即可）
vercel            # 產生 preview 網址
vercel --prod     # 產生正式網址 → 這就是你要分享的連結
```
部署完成 terminal 會印出網址，形如 `https://jp-needs-tank.vercel.app`。
入口是 `index.html`（語言選單），繁中/日文各一個連結。

### 路徑 2：Vercel 網頁拖拉（不碰終端機）

1. 開 https://vercel.com → 登入。
2. **Add New… → Project**。
3. 若走 GitHub：選你剛 push 的 `product-ops-bridge` repo，**Root Directory 設 `dashboards`** → Deploy。
4. 若不接 GitHub：直接把 `deploy-pkg` 整個資料夾**拖進** Vercel 的部署區（drag & drop deploy）。
5. 完成後點 **Visit** 拿網址。

### 更新 dashboard 後怎麼重新部署
- 走 CLI：改完檔 → `vercel --prod`。
- 走 GitHub 綁定：改完檔 → `git push`，Vercel 自動 redeploy。

---

## C. 重要提醒

- **openID 曝露**：兩版 HTML 內嵌約 210 個 SVIP openID。此部署**未設密碼**（你的決定）。已加 `noindex,nofollow` 擋搜尋引擎索引，但拿到網址的人都能看。若日後要收回 → 在 Vercel 刪除該 deployment/project。
- **要加密碼**（之後改主意）：Vercel → Project → Settings → **Deployment Protection** → 開 Password Protection（Pro 方案功能）。或改用團隊 SSO 限成員。
- **雙版 drift**：ZH/JP 共用資料邏輯，改一版記得同步另一版。
