# APPIDEAS Roadmap Status — trilingual public page

三語（繁中 / English / 日本語）產品開發狀況頁。**Jira 為唯一真實來源**；
試算表（JP Needs Roadmap）與 Jira 不一致時，一律以 Jira 為準。

```
roadmap/
├── data.json     ← 唯一要改的檔案（三語內容 + 上線日 + 狀態）
├── build.py      ← 把 data.json 算成 index.html
└── index.html    ← 產出物（自帶樣式與資料，無外部請求）
```

## 每週更新流程

1. 用 Jira MCP 重查 `data.json` 裡列出的票（status / 上線日 / 新票）
2. 改 `data.json`，並更新 `meta.generated_at` 與 `stats`
3. `python3 roadmap/build.py`
4. commit + push → Vercel 自動部署

`index.html` 是 build 產物，**不要手改**，改了下次 build 會被蓋掉。

## 資料規則

- 每個項目都要有 `zh` / `en` / `ja` 三語，缺一不可
- 日文用日本新字體（開発、検証），不要寫成繁中的「開發」「檢證」
- `groups[].id` 決定狀態顏色：
  `released`→綠、`august`/`sept1`/`late`→藍、`design`→黃、`parking`→灰
- `highlight: true` 會把該列的上線日標成綠色（用於「最近就要上線」的項目）
- `untracked` 是「JP Needs 清單上有、但 Jira 還沒開票」的需求，只有 `rank` / `p` / 三語標題

## 存取控制

頁面含 17LIVE 內部 roadmap（票號、營收相關項目、日本收入政策），
已加 `noindex, nofollow, noarchive`，但**搜尋引擎不收錄 ≠ 保密**。
部署後務必在 Vercel 專案設定裡開啟保護（密碼或 SSO），不要留公開連結。
