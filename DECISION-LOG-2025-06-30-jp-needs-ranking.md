# Decision Log — JP Needs Tank Dashboard: 25 痛點總排序 + 雙語 + 部署

- **Date:** 2025-06-30
- **Owner:** Cross (Strategy / Product-Ops Bridge)
- **Phase:** C（深化 D1）→ 邊界觸及 delivery 呈現層
- **Artifacts:** `JP_Needs_Heatmap_ZH.html`, `JP_Needs_Heatmap_JP.html`, `index.html`, `vercel.json`

---

## 1. What changed（本次交付）

| # | 變更 | 說明 |
|---|---|---|
| 1 | **兩層 drill-down** | (a) 下方明細表列點擊展開 detail panel；(b)「PMが着手できる項目」5 paincard × 5 li 點擊，展開對應原始 requests（summary 痛點/誰/如何影響 + provenance）|
| 2 | **繁中版** | 介面層全繁中；raw request（`item_ja` 等）**保留日文原聲**（287/291 仍為日文）|
| 3 | **25 痛點總排序區** | 置於最上方，可拖拉重排；痛點導向 title；點卡片展開原始 requests；可匯出當前順序為文字 |
| 4 | **雙語同步** | ZH + JP 兩版共用同一 DATA / LIMAP / RANK 邏輯 |
| 5 | **部署** | Vercel 靜態部署（`index.html` 語言選單 + `vercel.json` 安全標頭）|

---

## 2. Key decisions & rationale

### 2.1 資料來源與 phantom row 陷阱
- 來源：`JP_Needs_Tank_v1.xlsx`，**291 筆 real rows**。
- **Gotcha:** openpyxl `read_only=True` 會虛報約 999 phantom rows；必須 bound 到 `id 非 None` 才拿到真實筆數。

### 2.2 li → records 對應（LIMAP）採「精確對應優先」
- xlsx **無 subtheme 欄**，5×5=25 個 li 是手寫 cluster。
- 對應方式：keyword matching + 人工收斂，**非欄位重現**。
- badge `×N` 已同步改為**實際對應筆數**，不沿用原手寫寬鬆計數。
- 結果：25 li → 144 筆 records，全部驗證存在於 DATA。
- **微調路徑:** 改 HTML 內 `LIMAP` 資料區塊即可。

### 2.3 25 痛點初始排序公式
```
score = 需求量(N) × 3  +  優先度(maxPri, 1–5) × 4
```
- bug 類**不加成**（避免蓋過真實聲量），但保留 🐞/⚡/🧩 type badge。
- 這是**機械排序**，不含策略判斷 → 因此提供**拖拉手動覆蓋**。
- Top 5 初始序：U4.0 抽選bot / S2.0 ticker蓋畫面 / U2.0 系統元素塞滿 / U4.4 誤送+閃退 / U5.0 徽章看不見。

### 2.4 拖拉排序的狀態存續（明確限制）
- artifact/前端環境**不使用 localStorage**。
- 拖拉後順序存於**記憶體，重整回預設**。
- 固化方式：「匯出目前順序」→ 複製成文字清單 → 貼進簡報/Notion。
- 設計意圖：會議中與 COO/PM 拖出共識序 → 匯出 → 進正式文件。

### 2.5 title 改「痛點導向」
- 從功能導向改為**用戶第一人稱的痛**（例：「像沒遙控器」「一夜失去自介」）。
- 目的：跟 TW 產品團隊對齊「目線」時更快進入同理。

---

## 3. Open risks / GOTCHA

| 風險 | 說明 | 緩解 |
|---|---|---|
| **雙版 drift** | ZH/JP 共用同一 DATA/LIMAP/RANK；改一邊要同步另一邊 | 未來若頻繁改 → 重構為單檔 + 語言 toggle |
| **SVIP openID 曝露** | HTML 內嵌約 210 個 openID（17 governance 敏感欄位）| 部署選**公開無密碼**（Cross 拍板）；已加 `noindex` 擋搜尋引擎；收回需刪部署 |
| **公式 ≠ 真實優先** | score 是聲量+優先的機械排序，不含策略 | 靠拖拉手動覆蓋；共識序以匯出為準 |
| **JIRA 連結 ≈ 0** | 25 item 對應 records 中 JIRA 連結數 ~1 | 呼應 charter kill-condition：瓶頸在 HQ dev 信任/政治，非工具 |

---

## 4. Deployment note
- 目標：Vercel 靜態部署，產出可分享網址。
- 未設密碼（Cross 決定）；`vercel.json` + index meta 已設 `noindex,nofollow`。
- 更新流程：改 HTML → `git push`（若接 GitHub）或 `vercel --prod` 重新部署。

---

## 5. Next
- [ ] （可選）重構為單檔語言切換，消除 drift。
- [ ] 若 openID 曝露顧慮升高 → 補密碼保護或改 Drive 限定分享。
- [ ] delivery 閉環：25 排序 → 對 COO/PM 拍板 → 要 scrum 資源 → 回報 ops。
