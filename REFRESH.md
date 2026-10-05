# JP Product Dashboard — 怎麼更新資料

> 給 Cross。整個更新流程就一句話,不用碰程式。

## 平常怎麼更新(推薦)

1. 開 Claude Code(網頁版即可),選 `product-ops-bridge` 這個 repo。
2. 對它說:**「更新 JP dashboard」**。
3. 等它跑完(約 10–20 分鐘,票多的時候會久一點),它會回報更新了幾張票、有幾張需要你處理。

Claude 會自動:重抓 JIRA 全部未結案票 → 重寫三語白話摘要 → 重建 `dashboard/jp-product-dashboard.html` → commit + push(Vercel 有綁 repo 的話會自動重新部署)。

## 想剔除/加回某張票

直接告訴 Claude 票號,例如:「dashboard 把 APPIDEAS-1234 剔掉」。

## 備用:只抓資料不寫摘要(工程師用)

```bash
export JIRA_EMAIL="你的Atlassian登入email"
export JIRA_API_TOKEN="到 id.atlassian.com/manage-profile/security/api-tokens 建一個"
python3 scripts/fetch_appideas.py     # 寫出 data/appideas_open.json(不會進 git)
python3 scripts/build_dashboard.py    # 用 data/jpdash_payload.json 重建 HTML
```

注意:`fetch_appideas.py` 只抓原始資料;三語白話摘要需要 Claude 重寫,所以完整更新請走上面那條路。

## 出錯了怎麼辦

把畫面上的錯誤訊息整段複製,貼回 Claude 對話即可,不用自己修。

---

## JP Needs ロードマップ 分頁(第二個分頁)

Dashboard 上方有兩個分頁:

| 分頁 | 內容 | 資料來源 |
|---|---|---|
| **開發現況** | APPIDEAS 全部未結案的票(進行中 + 停車場) | `data/jpdash_payload.json` |
| **JP Needs 進度** | JP Needs 清單 52 件對照 Jira,依上線時間分組 | `data/roadmap_jp_needs.json` |

### 更新第二個分頁

跟 Claude 說:**「更新 JP Needs 分頁」**。它會重查 `data/roadmap_jp_needs.json` 裡列到的票、
更新狀態與上線日、重跑 `python3 scripts/build_dashboard.py`,然後 commit + push。

手動改的話只要動 `data/roadmap_jp_needs.json`,再跑一次 build 就好:

```bash
python3 scripts/build_dashboard.py
```

### 這份資料的規則

- **Jira 是唯一真實來源。** 試算表(JP Needs Roadmap)與 Jira 不一致時一律以 Jira 為準。
- 每個項目的 `title` / `date` / `status` 都必須有 `zh` / `en` / `ja` 三語,缺一 build 會直接失敗擋下來。
- 日文請用日本新字體(開発、検証),不要寫成繁中的「開發」「檢證」。
- `groups[].id` 決定狀態顏色:`released`→綠、`august`/`sept1`/`late`→藍、`design`→黃、`parking`→灰。
- `highlight: true` 會把該列的上線日標綠(用於「最近就要上線」的項目)。
- `untracked` 是「JP Needs 清單上有、但 Jira 還沒開票」的需求,只有 `rank` / `p` / 三語標題。
