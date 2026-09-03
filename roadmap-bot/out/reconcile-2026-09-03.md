# Roadmap 抓取對帳報告 — 2026-09-03

> 這份是**抓取品質的自我檢查**，不是給人做決策用的。決策看 dashboard。
> 它唯一要回答的問題是：「今天抓到的數字，跟上一份 PMT 週報對得上嗎？」
> **對不上是常態**——卡片每天在動，數字當然會變。
> 只有在你看不出差異原因、或出現 blocker 時才需要找人。

- 來源：Jira REST live pull（filter = 16245 ORDER BY key ASC ＋ filter = 15906 ORDER BY key ASC）
- 原始 40 張 → active **30** 張（排除 10、未分類 0）
- baseline 鎖定於 2026-08-21，2026-10-01 重算

## 與上一份 PMT 週報（2026-08-21）的逐項比對

| 項目 | 本次抓到 | 上一份週報 | 差異 |
| --- | --- | --- | --- |
| active 卡數 | 30 | 32 | 差 -2 |
| stage Discovery | 1 | 2 | 差 -1 |
| stage Design | 8 | 11 | 差 -3 |
| stage Develop | 16 | 15 | 差 +1 |
| stage Impact | 5 | 4 | 差 +1 |
| 產能 17App 張數 | 8 | 9 | 差 -1 |
| 產能 17App 點數 | 23 | 24 | 差 -1 |
| 產能 Internal Tool 張數 | 7 | 7 | 一致 |
| 產能 Internal Tool 點數 | 16 | 16 | 一致 |
| 產能 IST 張數 | 8 | 9 | 差 -1 |
| 產能 IST 點數 | 22 | 24 | 差 -2 |
| 產能 Live Commerce 張數 | 5 | 5 | 一致 |
| 產能 Live Commerce 點數 | 11 | 11 | 一致 |
| 產能 Platform 張數 | 6 | 6 | 一致 |
| 產能 Platform 點數 | 18 | 18 | 一致 |
| Teams 參與計數 | 34 | 36 | 差 -2 |
| 2026-09-01 同日發布 | 0 | 7 | 差 -7 |
| 被排除（Parking lot） | 10 | — | 參考 |
| status 未分類 | 0 | 0 | 一致 |

**與上一份週報有差異。** 這通常代表卡片移動了（做完、換 stage、改發布日），不代表抓取出錯。逐項差異見上表；資料真的有問題時會出現在下面的「資料品質」段，而不是這裡。

## Stage 分布

| Stage | 張數 |
| --- | --- |
| Design | 8 |
| Develop | 16 |
| Discovery | 1 |
| Impact | 5 |

## 產能（Teams 歸戶 — 對應 PMT 📈 Capacity）

Teams 參與計數 34（>30 是正常的：跨團隊卡對每個參與團隊都計入完整 effort）

| Domain | 卡 | pts | 在途(月) | 判定 | 上游卡 | 上游(月) | 判定 | 基準薄弱 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 17App | 8 | 23 | 2.23 | healthy | 3 | 0.64 | medium |  |
| IST | 8 | 22 | 5.12 | overload | 1 | 0.59 | medium |  |
| Internal Tool | 7 | 16 | 1.93 | healthy | 1 | 0.33 | starving |  |
| Live Commerce | 5 | 11 | 4.07 | overload | 2 | 2.0 | ample | 是 |
| Platform | 6 | 18 | — | 無基準 | 3 | — | 無基準 |  |

## 健康度歸戶（owner domain — 對應 PMT 🩺 Health）

| Domain | 卡 | Project Status 分布 |
| --- | --- | --- |
| 17App | 7 | On track 6, Warning 1 |
| IST | 7 | On track 5, Warning 2 |
| Internal Tool | 5 | On track 4, Warning 1 |
| Live Commerce | 5 | On track 5 |
| Platform | 6 | On track 3, Warning 3 |

## 發布集中度（同日 ≥2 張）

- **2026-09-29**：3 張 — APPIDEAS-1928, APPIDEAS-2116, APPIDEAS-2243
- **2026-09-08**：2 張 — APPIDEAS-2133, APPIDEAS-2241
- **2026-09-15**：2 張 — APPIDEAS-2148, APPIDEAS-1888

## 資料品質（blocker 0 / warn 0）

- `info` **APPIDEAS-1910** — Estimate Effort 與 size 文字不一致（權威值是 Estimate Effort）（size=S(應為2) 但 effort=3.0）
- `info` **APPIDEAS-2133** — Estimate Effort 與 size 文字不一致（權威值是 Estimate Effort）（size=S(應為2) 但 effort=3.0）

## Teams 逐卡明細（已查證欄位）

讀的是 `customfield_10430`。此欄位已於 2026-08-24 用 8/21 報告的產能數字反推驗證。

| 卡 | Domain | Teams 讀到 |
| --- | --- | --- |
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
| APPIDEAS-2137 | Live Commerce | Feature team, Live Commerce |
| APPIDEAS-2148 | IST | IST |
| APPIDEAS-2161 | Platform | Eventory, Platform |
| APPIDEAS-2169 | Live Commerce | Webapp, Live Commerce |
| APPIDEAS-2171 | 17App | Platform |
| APPIDEAS-2172 | 17App | Feature team |
| APPIDEAS-2192 | IST | IST |
| APPIDEAS-2211 | Internal Tool | Billing, Webapp |
| APPIDEAS-2219 | Live Commerce | Live Commerce |
| APPIDEAS-2224 | Platform | Platform |
| APPIDEAS-2225 | Platform | Platform |
| APPIDEAS-2230 | Internal Tool | Billing, Webapp |
| APPIDEAS-2238 | 17App | Feature team |
| APPIDEAS-2241 | 17App | Feature team |
| APPIDEAS-2243 | IST | IST |
| APPIDEAS-2258 | IST | IST |
