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
