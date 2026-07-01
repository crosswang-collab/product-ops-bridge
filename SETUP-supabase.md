# 手動新增項目 + 即時同步 — Supabase 設定指南

讓「手動新增痛點 + 拖拉排序」的結果**跨人即時同步**（誰都能改、改完別人畫面自動更新）。
全程在網頁點，約 5–10 分鐘。**不設密碼**（你的決定）。

> 沒設定也不會壞：URL/KEY 留空時，dashboard 右上顯示「● 本機模式」，新增/拖拉功能照常，只是不同步、重整就清空。

---

## 你要做的 5 步

### 1. 建 Supabase 專案（免費）
1. 開 https://supabase.com → 登入 → **New project**。
2. 隨便取名（如 `jp-needs`）、設一組資料庫密碼（自己留著，之後用不到）、選離台灣近的區域（如 Tokyo）。
3. 等它建好（約 1–2 分鐘）。

### 2. 建表 + 開權限 + 開即時同步（貼 SQL 一次搞定）
左側 **SQL Editor** → **New query** → 貼下面整段 → **Run**：

```sql
create table if not exists public.jp_needs_board (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.jp_needs_board enable row level security;

create policy "public read"   on public.jp_needs_board for select using (true);
create policy "public insert" on public.jp_needs_board for insert with check (true);
create policy "public update" on public.jp_needs_board for update using (true) with check (true);

insert into public.jp_needs_board (id, state)
values ('jp-needs-v1', '{}'::jsonb)
on conflict (id) do nothing;

alter publication supabase_realtime add table public.jp_needs_board;
```

> 若重跑出現 `already exists`／`already member`，可忽略，代表已設定過。

### 3. 拿 2 個值：Project URL + anon key
左側 **Project Settings → API**：
- **Project URL**（形如 `https://xxxxxxxx.supabase.co`）
- **Project API keys → `anon` `public`**（一長串）

> `anon` key 本來就是設計成可公開嵌在前端的，貼進 HTML 沒問題；真正的權限由上面的 RLS 政策控管。

### 4. 貼進兩支 HTML 的設定區
`JP_Needs_Heatmap_ZH.html` 和 `JP_Needs_Heatmap_JP.html` 各有一段設定區，找到並填入（**兩檔要填一模一樣的值**，排序才會共用）：

```js
const SUPA_URL   = "";              // ← 貼 Project URL
const SUPA_KEY   = "";              // ← 貼 anon public key
const SUPA_TABLE = "jp_needs_board";   // 不用改
const BOARD_ID   = "jp-needs-v1";      // 不用改（ZH/JP 共用同一份排序）
```

### 5. 部署
- 若已接 Vercel Git 整合：`git push` → Vercel 自動 redeploy。
- 或在本機 `vercel --prod`。

---

## 驗證是否成功
1. 打開部署網址，右上角狀態應顯示 **「☁ 已同步」**（日文版：「☁ 同期済み」）。
2. 開兩個分頁（或兩台裝置）同時打開 → 一邊「➕ 新增項目」或拖拉排序 → 另一邊**幾秒內自動更新**。
3. 繁中版加的項目，日文版也看得到（共用同一份）。

---

## 重要提醒（安全）
- **讀 + 寫都公開、無密碼**：任何拿到網址的人都能新增／改排序／刪除自訂項目。
- 動得到的只有「**排序 + 自訂項目**」這層；原始 291 筆需求資料與約 210 個 openID **不進資料庫**、仍是唯讀嵌在 HTML，無法被線上改動。
- 最壞情況只是排序被亂改 → 按「↺ 回預設排序」或在 Supabase 把該 row 的 `state` 清成 `{}` 即可復原。
- 日後想收緊：可改 RLS 政策要求登入、或在 Vercel 開 Deployment Protection 密碼。

## 併發說明
多人同時改採「最後寫入者為準」。小團隊策展用途沒問題；若兩人同一秒各拖一次，可能有一次被覆蓋——重整即可看到最新共用狀態。
