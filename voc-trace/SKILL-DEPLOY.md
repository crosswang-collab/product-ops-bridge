# voc-trace 部署說明 — 從 repo 層升級到帳號層

**問題**：skill 放在 `.claude/skills/voc-trace/` 只在 `product-ops-bridge` repo 內生效。
換 repo、開 Desktop、上 claude.ai 都不會載入 —— 但 PM 的提問不會只在這個 repo 裡發生。

**做法**：上傳成帳號層 custom skill。之後三種環境都會自動載入（能力差異見 SKILL.md「執行環境」段）。

---

## 上傳步驟（Cross 手動，約 2 分鐘）

帳號層 skill 只能從 claude.ai 上傳，**遠端 session 無法從容器內寫上去**
（容器裡的 `~/.claude/skills/synced/` 是單向下載的快取，且容器是暫時的）。

1. 取本 PR 附的 `voc-trace-skill.zip`（也可自行打包：`cd .claude/skills && zip -r voc-trace-skill.zip voc-trace/`）
2. claude.ai → **Settings → Capabilities → Skills** → Upload skill → 選該 zip
3. 上傳後應與 `checker`、`coding-rules`、`gstack` 等並列，`source: custom`
4. 驗收：開一個**與本 repo 無關**的新對話，貼一句「S2.7 的 VOC 來源是什麼？」
   → skill 應被觸發，且答案開頭標「⚠️ 未存檔」（環境 C 的正確行為）

zip 結構必須是 `voc-trace/SKILL.md`（有一層資料夾），不是把 `SKILL.md` 放在 zip 根目錄。

---

## ⚠️ 上傳後的重複載入問題

帳號層與 repo 層同名 skill 並存時，在本 repo 內會有兩份 `voc-trace`。
Claude Code 的解析規則是**目錄範圍優先** —— repo 內那份會蓋掉帳號層那份。

實務影響：**兩份會漂移**。改了 repo 那份，帳號層還是舊的；在別的 repo 用到的是舊版。

建議（Cross 決定，本 PR 未動）：

| 選項 | 做法 | 適合 |
|---|---|---|
| **A. 帳號層為唯一真相**（推薦） | 確認上傳成功後，`git rm -r .claude/skills/voc-trace/`，repo 只留 `voc-trace/` 的 ANSWER 檔 | 不想維護兩份 |
| B. repo 為版本控制真相 | 保留 repo 這份當 source of truth，每次改完重新打包上傳 | 想要 skill 本身有 git 歷史 |

選 B 的話，改 SKILL.md 的 PR 一律要在描述裡寫「**需重新上傳帳號層**」，否則一定漂移。

目前狀態：**尚未上傳，repo 這份仍是唯一一份。**
