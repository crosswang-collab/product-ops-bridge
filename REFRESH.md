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
