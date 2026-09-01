# roadmap-bot

每天把 17LIVE 的 product roadmap 從 Jira 抓成一份**事實層 JSON**，
給 dashboard 讀、給判讀層讀。

這一層只做事實，不做判讀。「哪個紅燈是真的、哪個是帳面波動」由判讀層另外做。
分層的理由：判讀是 LLM 產物，會錯；事實是機器算的，可回溯。
把兩者混在同一個檔案裡，錯誤會在隔天被當成事實讀進來。

## 現在的狀態

`extract.py` 已完成並通過 dry-run（2026-08-24）。尚未接排程。

## 跑法

```bash
# dry-run（不需 token，讀已匯出的 JSON）
python3 extract.py --from-file raw-16245.json --release-file raw-15906.json --out out/

# 正式（需 token）
export JIRA_EMAIL="你的 17.media 信箱"
export JIRA_TOKEN="Atlassian API token"
python3 extract.py --live --out out/
```

Exit code：`0` = 對帳通過／`1` = 對帳有差異（需人工看）／`2` = 有 blocker（STAGE_MAP 漏接）

## 產出

| 檔案 | 給誰看 |
|---|---|
| `facts-YYYY-MM-DD.json` | dashboard + 判讀層。當日快照，append-only 不覆寫 |
| `latest.json` | dashboard 固定讀這支 |
| `reconcile-YYYY-MM-DD.md` | 人看的。抓到幾張、對不對得上、哪裡怪 |

## dry-run 查到的四件事（2026-08-24）

這些都不在 PMT 報告的文件裡，是逐欄比對才挖出來的。

1. **`filter 16245` 回 40 張不是 32 張。** 要自己扣掉 9 張 `Parking lot`。
   報告寫「filter 16245（status != Parking lot）」，但那個條件不在 filter 裡面。

2. **產能表是用 Teams 歸戶，不是卡片的 domain 欄位。**
   用 Teams 展開後，四個 domain 的卡數與點數與 8/21 報告精確吻合
   （17App 9張24pts、Internal Tool 7/16、Live Commerce 5/11、Platform 6/18）。
   用 domain 欄位算會得到完全不同的數字。`2171` 的 domain 是 17App
   但 Teams 是 Platform，報告把它算在 Platform。

3. **發布日是 `customfield_10436`，不是 `10610`。**
   `10610` 是 Config On。`1927` 兩個欄位分別是 9/1 與 9/7，只有 10436 對得上報告。

4. **發布清單需要第二個母體 `filter 15906`。**
   `1888`（iOS Liquid glass，9/1 發布）的 issuetype 是 `Tech`，
   不在只含 `Idea` 的 16245 裡。只撈一個母體，「9/1 有幾張」會低估。

## 已知限制

- Q2 baseline 是 PMT 每季手動鎖定的值，不在 Jira 裡。寫在 `BASELINES`，
  `2026-10-01` 季度切換要更新（含 Platform 的第一個 baseline）。過期會在對帳報告警告。
- IST（n=5）與 Live Commerce（n=3）的 baseline 樣本很薄，
  在途存量的絕對值誤差區間很寬。`baseline_thin` 旗標會標出來，判讀層必須讀。
- `--live` 的 HTTP 路徑尚未實測（寫這份時沒有 token）。
- 工作日只扣週末不扣假日，且僅在 Jira 的 `12515` 為空時才自己算，
  自己算的值標 `stage_duration_estimated=true`。

## 每日排程（`.github/workflows/roadmap-daily.yml`）

每天 00:00 UTC（09:00 JST）跑一次：`extract.py --live` → commit `out/` 回 main → Vercel 自動 redeploy。

**上線前你要做一件事**：在 repo Settings → Secrets and variables → Actions 加兩個 secret。
少任何一個，workflow 會在第一步就紅燈退出，不會寫出半份檔案。

| Secret | 值 |
|---|---|
| `JIRA_EMAIL` | 你的 17.media 信箱 |
| `JIRA_TOKEN` | Atlassian API token（https://id.atlassian.com/manage-profile/security/api-tokens） |

加完後可以用 Actions 頁面的 **Run workflow** 手動跑一次驗證，不用等到隔天。

Exit code 的處理：

| code | 意義 | workflow |
|---|---|---|
| `0` | 對帳與上一份週報一致 | 綠燈，commit |
| `1` | 對帳有差異（卡片會動，正常） | 綠燈，commit |
| `2` | 資料有結構性問題，沒寫出東西 | 紅燈，不 commit |
| `3` | 程式崩潰 | 紅燈，不 commit |

`2` 最常見的原因是 Jira 新增了 `STAGE_MAP` 沒有的 status，需要人改 code。
對帳報告會貼在每次執行的 job summary 裡。

抓取完成後還有一道獨立守門：檢查 `out/latest.json` 的 `as_of_date` 真的等於今天，
不是就紅燈。exit code 是程式**自己說**它成功了，這一步是去看檔案**真的**變了 ——
2026-08-31 就發生過程式崩潰、workflow 綠燈、什麼都沒寫的情況，這道守門是為了讓
「回報成功但沒產出」不可能再安靜地過關。

## 介面（`roadmap-bot/web/index.html`）

Vercel 網址：`/roadmap-bot/web/`（目前受 Vercel SSO 保護，只有團隊成員能開）

**設計前提：這不是資料表，是決策隊列。** 第一屏只回答一個問題——今天有沒有需要你決策的事。
沒有就寫「沒有」然後結束；其他細節全部摺疊在下面。

會進決策隊列的六個門檻（寫死在頁面裡，不是 LLM 判斷）：

| 門檻 | 為什麼 |
|---|---|
| 同日發布 ≥ 5 張 | 回歸測試與強制更新風險集中 |
| 在途存量 overload | domain 過載 |
| 上游存量 starving | 兩個月後會斷炊 |
| 卡片 `project_status = At Risk` | 有明確 owner 與日期的單卡卡死 |
| 資料品質 blocker | 數字失真，其他紅燈先別信 |
| baseline 過期 | 所有月數都是舊基準算的 |

另外兩個誠實機制：
- **資料不是今天的** → 頁面最上方紅色橫幅，直接說排程可能失敗了
- **基準樣本薄**（n<5）→ 該條目標記「絕對值不可信，只能看方向」
