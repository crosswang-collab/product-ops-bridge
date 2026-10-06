# mapping 草稿 — 痛點 ↔ Jira 卡（2026-10-06，待確認）

> **這份是草稿，還沒生效。** 頁面讀的是 `mapping.json`（目前是空的）。
> 確認方式：在「確認」欄打 ✅ / ❌，或直接回 Claude「高信心全收，中信心收 X、Y」。
> 確認後 Claude 才寫進 `mapping.json`。

## 依據

- 痛點：`catalog.json` 的 VoC roadmap 25 痛點
- 卡片：roadmap-bot 目前 active 24 張 ＋ 8/24 以來離開 active 的 21 張（多半已發布）
- 判斷：讀每張卡的 Jira 描述（Problem & Cause 段），不是只看標題

| 信心 | 定義 |
|---|---|
| **高** | 卡片描述直接引用該痛點代碼，或描述的是同一個問題 |
| **中** | 同一個問題領域，但卡只解了一部分 |
| **低** | 沾得上邊，大概不該算 —— 列出來只是讓你知道我看過 |

## A. 建議對應（14 條）

| 痛點 | 卡 | 卡的狀態 | 信心 | 依據（卡片描述原文） | 確認 |
|---|---|---|---|---|---|
| **U6.0** VS 模式錯亂 | 1985 iPad UI Layout（Group PK） | 已離開 active（9/17 Impact） | **高** | 描述直接引用「JP VoC **U6.0**」：iPad 2v2 Group PK 下方按鈕按不到 | |
| **U6.0** VS 模式錯亂 | 2169 PK/Group Call 與 17Shop/Gacha 共存 | 已離開 active（9/24 Impact） | 中 | 開 17Shop 時 PK 按鈕消失、開 Gacha 時 Group Call 直接結束直播 | |
| **U6.0** VS 模式錯亂 | 2258 PK Tutorial & Invite Cooldown | Develop／正常 | 中 | 「VSを経験していないライバーが突然・連続して招待を受ける」—— 解的是邀請壓力，不是錯亂本身 | |
| **S2.0** ticker 蓋畫面 | 2251 拖曳直播間中央 UI | Develop／正常 | **高** | 「tickers blocking critical live stream content … requested the ability to reposition」 | |
| **U2.0** 畫面被系統元素塞滿 | 2251 拖曳直播間中央 UI | Develop／正常 | 中 | 同上，可移動但不能關 | |
| **U4.0** 抽選被 bot 鑽 | 2241 紅包搶奪條件 | 已離開 active（9/24 Impact） | **高** | 描述連到 JP P0 VoC：「sub-accounts, bots, or scripts keep coming in to grab red envelopes」 | |
| **U4.2** 禮物找不到 | 2121 AI Cohost 送禮推薦 | Design／**注意** | **高** | 「Viewers can't name or find the gift they want … gift box has 17 tabs」（Army 那半不在範圍） | |
| **U5.4** 稱號／徽章想客製 | 2238 Profile Badge Customization | Develop／正常 | **高** | 「Let users choose which badges appear … and in what order」 | |
| **U5.0** 徽章太小又擠 | 2238 Profile Badge Customization | Develop／正常 | 中 | 解的是「顯示哪幾個」，不是尺寸 | |
| **U2.1** 個人檔案改版失去自介 | 2277 Profile Revamp Improvement | Develop／正常 | 中 | 「Clear the two largest VOC clusters from the Phase 1 launch」—— 是改版後 VoC，但主打追蹤導覽，不確定含自介 | |
| **U2.2** 分頁被藏、找不到入口 | 2277 Profile Revamp Improvement | Develop／正常 | **高** | 「The following list is now two taps deep … users lost the path」 | |
| **U5.2** 排行邏輯看不懂 | 2281 Fix Achievement Score Inflation | Design／正常 | 中 | 熱門頁排名被掛機灌分，「genuine efforts … unfairly deprioritized」—— 是公平性，不是看不懂 | |
| **S2.1** 開播閃退 | 2148 開播前測速與畫質選擇 | 已離開 active（9/30 Impact） | 低 | 解的是畫質驟降與網路不匹配，不是 App 閃退本身 | |
| **U5.1** Army 歸屬感 | 1928 Call in - Army only stream | Impact／正常 | 低 | 社群內通話工具，沾到 Army 但不是「階級」 | |

## B. 有聲音、找不到任何卡（確認是真缺口，還是有卡我沒看到）

| 痛點 | 最新一週 STT 人數 | 說明 |
|---|---|---|
| **S2.1** 開播閃退 | **242** | 只有 2148（測速）沾邊；**沒有任何卡在處理 App 閃退本身** |
| **U4.1** 課金價位斷層 | **105** | 找不到 |
| **U4.4** 禮物誤送不能取消 | **64** | 找不到（2116 是動畫排隊，不同問題） |
| U6.1 PK 玩法單薄 | — | 找不到 |
| U4.3 VIP 禮物動線 | — | 找不到 |
| U5.3 等級被強制顯示 | — | 2238 反而規定等級徽章「always shown」，方向相反 |
| U2.3 回放沒有快轉 | — | 找不到 |
| U6.2 好友戰刷勝、封鎖仍被配對 | — | 找不到 |
| U6.4 線上線下賽制脫節 | — | 找不到 |
| U6.3 比賽中看不到留言 | — | 找不到 |
| S2.2 AI 助手 bug | — | 2121 是 AI Cohost 新功能，不是修 bug |
| S2.3 留言太多想要摘要 | — | 找不到 |
| S2.4 BC 達標 ticker 提示 | — | 找不到 |
| U2.4 點愛心爽快感被砍 | — | 找不到 |

## C. 標了 [VoC] 但不屬於 25 痛點的卡（建議維持「無對應」）

| 卡 | 解的是什麼 | 判斷 |
|---|---|---|
| 2265 禮物榜只給主播看 | 榜單公開造成主播壓力 | 不在 25 痛點內（最接近 U5.2，但方向不同） |
| 2243 付費禮物留言不合併（已離開 active） | 送禮的真實感、Combo 數字太小 | 不在 25 痛點內 |
| 2116 高額禮物動畫插隊 | 高額禮物動畫排隊 10–20 分鐘 | 不在 25 痛點內 |

這三張頁面上會一直列在「[VoC] 卡對不到痛點」。如果它們代表的痛點重要，該做的是**把痛點加進 VoC roadmap**，不是硬塞進現有 25 個。

## 套用後頁面會怎麼變

- 「有聲音、沒有卡」從 7 個 → **3 個**（S2.1 開播閃退 242 人、U4.1 課金斷層 105 人、U4.4 禮物誤送 64 人）
- U6.0 會顯示：對應卡 1985、2169「已離開 active」，加上 2258 開發中 —— 也就是**修過了、聲音卻還在漲（23→28 人）**
- 「[VoC] 卡對不到痛點」從 4 張 → 1 張（2265）
