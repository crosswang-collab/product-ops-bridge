# Roadmap 抓取對帳報告 — 2026-08-24

> 這份是**抓取品質的自我檢查**，不是給人做決策用的。決策看 dashboard。
> 它唯一要回答的問題是：「今天抓到的數字，跟上一份 PMT 週報對得上嗎？」
> **對不上是常態**——卡片每天在動，數字當然會變。
> 只有在你看不出差異原因、或出現 blocker 時才需要找人。

- 來源：檔案 /tmp/claude-0/-home-user-product-ops-bridge/79946f72-aa0f-5a3d-9e04-aa159aa284b2/scratchpad/raw-16245.json（未提供發布母體）
- 原始 40 張 → active **31** 張（排除 9、未分類 0）
- baseline 鎖定於 2026-08-21，2026-10-01 重算

## 與上一份 PMT 週報（2026-08-21）的逐項比對

| 項目 | 本次抓到 | 上一份週報 | 差異 |
| --- | --- | --- | --- |
| active 卡數 | 31 | 32 | 差 -1 |
| stage Discovery | 2 | 2 | 一致 |
| stage Design | 10 | 11 | 差 -1 |
| stage Develop | 15 | 15 | 一致 |
| stage Impact | 4 | 4 | 一致 |
| 產能 17App 張數 | 9 | 9 | 一致 |
| 產能 17App 點數 | 24 | 24 | 一致 |
| 產能 Internal Tool 張數 | 7 | 7 | 一致 |
| 產能 Internal Tool 點數 | 16 | 16 | 一致 |
| 產能 IST 張數 | 8 | 9 | 差 -1 |
| 產能 IST 點數 | 22 | 24 | 差 -2 |
| 產能 Live Commerce 張數 | 5 | 5 | 一致 |
| 產能 Live Commerce 點數 | 11 | 11 | 一致 |
| 產能 Platform 張數 | 6 | 6 | 一致 |
| 產能 Platform 點數 | 18 | 18 | 一致 |
| Teams 參與計數 | 35 | 36 | 差 -1 |
| 2026-09-01 同日發布 | 5 | 7 | 差 -2 |
| 被排除（Parking lot） | 9 | — | 參考 |
| status 未分類 | 0 | 0 | 一致 |

**與上一份週報有差異。** 這通常代表卡片移動了（做完、換 stage、改發布日），不代表抓取出錯。逐項差異見上表；資料真的有問題時會出現在下面的「資料品質」段，而不是這裡。

## Stage 分布

| Stage | 張數 |
| --- | --- |
| Design | 10 |
| Develop | 15 |
| Discovery | 2 |
| Impact | 4 |

## 產能（Teams 歸戶 — 對應 PMT 📈 Capacity）

Teams 參與計數 35（>31 是正常的：跨團隊卡對每個參與團隊都計入完整 effort）

| Domain | 卡 | pts | 在途(月) | 判定 | 上游卡 | 上游(月) | 判定 | 基準薄弱 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 17App | 9 | 24 | 2.33 | healthy | 3 | 0.64 | medium |  |
| IST | 8 | 22 | 5.12 | overload | 1 | 0.59 | medium |  |
| Internal Tool | 7 | 16 | 1.93 | healthy | 2 | 0.67 | medium |  |
| Live Commerce | 5 | 11 | 4.07 | overload | 2 | 2.0 | ample | 是 |
| Platform | 6 | 18 | — | 無基準 | 4 | — | 無基準 |  |

## 健康度歸戶（owner domain — 對應 PMT 🩺 Health）

| Domain | 卡 | Project Status 分布 |
| --- | --- | --- |
| 17App | 9 | On track 9 |
| IST | 6 | On track 6 |
| Internal Tool | 5 | At Risk 2, On track 3 |
| Live Commerce | 5 | On track 5 |
| Platform | 6 | On track 6 |

> ⚠ Teams 有值但沒有對應到任何產能池：**Data** —— 這些團隊的投入在產能報告裡完全看不見（8/21 報告也點出過 Data 這一條）。

## 發布集中度（同日 ≥2 張）

> ⚠ **未提供 filter 15906 母體，這份發布清單不完整**（會漏掉 issuetype=Tech 的卡，例如 1888）。集中度是低估值。

- **2026-09-01**：5 張 — APPIDEAS-1910, APPIDEAS-1927, APPIDEAS-2135, APPIDEAS-2169, APPIDEAS-2212
- **2026-09-15**：2 張 — APPIDEAS-1985, APPIDEAS-2148
- **2026-09-29**：2 張 — APPIDEAS-1928, APPIDEAS-2116

## 資料品質（blocker 0 / warn 0）

- 無問題

## Teams 逐卡明細（已查證欄位）

讀的是 `customfield_10430`。此欄位已於 2026-08-24 用 8/21 報告的產能數字反推驗證。

| 卡 | Domain | Teams 讀到 |
| --- | --- | --- |
| APPIDEAS-1758 | 17App | Feature team, Data |
| APPIDEAS-1797 | 17App | Feature team |
| APPIDEAS-1910 | Platform | Eventory, Platform |
| APPIDEAS-1927 | 17App | Feature team |
| APPIDEAS-1928 | 17App | Feature team, IST |
| APPIDEAS-1933 | Platform | Feature team |
| APPIDEAS-1938 | Internal Tool | Billing, Webapp |
| APPIDEAS-1985 | IST | IST |
| APPIDEAS-1986 | Internal Tool | Billing, Webapp |
| APPIDEAS-2004 | Internal Tool | Billing, Webapp |
| APPIDEAS-2104 | Platform | Platform |
| APPIDEAS-2112 | IST | IST |
| APPIDEAS-2116 | IST | IST |
| APPIDEAS-2133 | Live Commerce | Live Commerce |
| APPIDEAS-2135 | Live Commerce | Webapp, Live Commerce |
| APPIDEAS-2137 | Live Commerce | Live Commerce |
| APPIDEAS-2148 | IST | IST |
| APPIDEAS-2161 | Platform | Eventory, Platform |
| APPIDEAS-2169 | Live Commerce | Webapp, Live Commerce |
| APPIDEAS-2171 | 17App | Platform |
| APPIDEAS-2172 | 17App | Feature team |
| APPIDEAS-2192 | IST | IST |
| APPIDEAS-2211 | Internal Tool | Billing, Webapp |
| APPIDEAS-2212 | 17App | Feature team, IST |
| APPIDEAS-2219 | Live Commerce | Live Commerce |
| APPIDEAS-2224 | Platform | Platform |
| APPIDEAS-2225 | Platform | Platform |
| APPIDEAS-2230 | Internal Tool | Billing, Webapp |
| APPIDEAS-2238 | 17App | Feature team |
| APPIDEAS-2241 | 17App | Feature team |
| APPIDEAS-2243 | IST | IST |
