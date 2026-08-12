# Access Request — Slack `#UserFeedback`（17LIVE workspace）

**目的**：讓 Claude 能唯讀 17LIVE Slack 的 `#UserFeedback`，以便 VOC 溯源時**逐字驗證**以 Slack permalink 為出處的引文。
**建立日**：2026-08-12 ・ **狀態**：草稿，未送出 ・ **請求人**：Cross Wang（crosswang@17.media）

---

## 1. 這是什麼問題（先確認：不是權限不足，是連錯 workspace）

實測（2026-08-12，`slack_read_user_profile` 無參數 = 查目前連線身分）：

| 欄位 | 實測值 |
|---|---|
| User ID | `U0A5JJ3LHDF` |
| Email | `crosswang@mikai.co.jp` |
| Organization | **`mikai inc.`** |
| Admin / Owner | **Yes / Yes** |

同一輪的兩個查詢：

- `slack_read_channel(channel_id="C06PRMJ6HRD")` → 硬錯誤 `channel_not_found`
- `slack_search_channels(query="UserFeedback", channel_types=public_channel,private_channel)` → **0 筆**

**結論**：Claude 的 Slack 連接器授權到 **mikai inc.** workspace，而 `#UserFeedback` 在 **17LIVE** workspace。
Cross 在 mikai 是 Owner，所以「加權限」方向是錯的 —— 一個 workspace 的 Owner 也看不到另一個 workspace 的 channel。
要修的是**連接器綁在哪個 workspace**。

> 這也解釋了為什麼重試無效：`channel_not_found` 在跨 workspace 情境下是硬錯誤，不是暫時性失敗。

---

## 2. 兩條路，**先試 Path A**

### Path A — 自助（不需要別人，5 分鐘，先試這條）

在 Claude 的 Connectors 設定裡新增 / 重新授權 Slack，登入時**改用 17LIVE workspace 的身分**（`crosswang@17.media`），而不是 mikai。

- **成功**：`slack_search_channels("UserFeedback")` 應該撈得到 `C06PRMJ6HRD`。收工，不必送 Path B。
- **卡住**：若授權畫面出現「需要管理員核准 / このアプリの承認が必要です」或安裝後仍 0 筆 → 表示 17LIVE workspace 限制了第三方 app 安裝 → 走 Path B。

⚠️ 兩個 workspace 都要保留的話，確認連接器支援多 workspace 並存；若只能綁一個，換成 17LIVE 會讓 mikai 那邊的 Slack 查詢失效 —— 換之前先確認沒有其他自動化依賴 mikai 連線。

### Path B — 需要 17LIVE Slack workspace 管理員

只有 Path A 撞到核准牆時才送。要問到的三件事：

1. Claude（Anthropic）app 是否已在 17LIVE workspace 核准安裝？未核准 → 請核准，或說明公司政策不允許。
2. 若已核准，`crosswang@17.media` 是否為 `#UserFeedback` 成員？（private channel 需要先在 channel 內）
3. 需要的 scope 僅 **唯讀**：`channels:history` / `channels:read`（若為 private channel：`groups:history` / `groups:read`）。**不需要**任何寫入或發訊 scope。

---

## 3. 可直接貼的請求訊息

### 日文（給 17LIVE 側 Slack 管理者 / IT）

> お忙しいところ恐れ入ります。VOC の出典確認の効率化について、1点ご相談させてください。
>
> プロダクト側から「この roadmap 項目の VOC の根拠となるユーザーの原文はどこか」という問い合わせを受けることが多く、現在は Google Drive 上のまとめファイルを手作業で追う運用になっています。出典が Slack の permalink である場合、原文の逐語確認ができず、検証が止まってしまいます。
>
> つきましては、Claude（Anthropic）の Slack 連携を 17LIVE workspace で利用し、`#UserFeedback` を**閲覧のみ**で参照できるようにしたいと考えております。
>
> - 対象チャンネル：`#UserFeedback`（`C06PRMJ6HRD`）
> - 必要な権限：`channels:history` / `channels:read` の**読み取りのみ**（投稿・書き込み権限は不要です）
> - 用途：VOC の原文の逐語確認のみ。個人情報（openID / メールアドレス / プロフィール URL）は成果物には一切記載しません
>
> 現状、私のアカウントで連携を試みたところ、別 workspace（mikai inc.）の認証となってしまい、`channel_not_found` となります。17LIVE workspace 側で Claude アプリの承認が必要かどうか、ご確認いただけますでしょうか。
>
> ポリシー上難しい場合は、代替として Drive 上のまとめファイル運用を継続しますので、その旨お知らせいただければ幸いです。よろしくお願いいたします。

### 繁中（給內部 IT / workspace admin）

> 想申請一項唯讀權限，說明如下。
>
> PM 經常問「這條 roadmap 的 VOC 依據、用戶原話在哪」。目前靠 Google Drive 的彙整檔人工回溯；但若出處是 Slack permalink，就無法逐字驗證原話，溯源會斷在那裡。
>
> 申請內容：讓 Claude（Anthropic）的 Slack 連接器能在 **17LIVE workspace** 唯讀 `#UserFeedback`。
>
> - 對象：`#UserFeedback`（`C06PRMJ6HRD`）
> - 權限：僅 `channels:history` / `channels:read` **唯讀**，不需要任何發訊或寫入權限
> - 用途：只做 VOC 原話的逐字比對。個資（openID / email / profile URL）不會寫進任何產出物
>
> 目前我自行授權時，連到的是另一個 workspace（mikai inc.）的身分，因此回 `channel_not_found`。想確認 17LIVE workspace 是否需要管理員核准 Claude app 的安裝。
>
> 若公司政策不允許，我會繼續用 Drive 彙整檔的替代方案，麻煩告知即可。

---

## 4. 沒有這個權限的話，會少什麼

| 項目 | 影響 |
|---|---|
| Slack permalink 出處的引文 | **無法逐字驗證** → 依引文契約第 4 條只能標「不可驗」，不得當成已驗證引文交付 |
| 替代來源 | 註冊表 #8 `#jp-user_feedback まとめ`（Sheet `1zlck3SzMq7nHzLiv6qJ7J-bLxTNAWF0erkjQgMaBWjs`，ryoyamamoto@）—— 但那是**人工轉錄**，轉錄就可能走鐘（正是 S2.7「小袋/子袋」錯位的成因） |
| voc-bot | Slack 那段會被跳過，判定降級為「規則式（精度低）」 |

**這不是 blocker，是精度上限**：沒有它，溯源仍能跑完，只是最後一哩的逐字驗證得靠轉錄檔，而轉錄檔本身已被證實會出現術語走鐘。

---

## 5. 送出後回填

- [ ] Path A 試過？結果：
- [ ] Path B 送出日 / 對象：
- [ ] 結果（核准 / 駁回 / 政策不允許）：
- [ ] 若核准：回 `.claude/skills/voc-trace/SKILL.md` 移除陷阱 §D，並把 Slack 加回資料源註冊表
