/**
 * VoC Daily Bot — 每天彙整 Slack + 各表單的用戶聲音，比對 VoC Roadmap，告訴你「哪些是新痛點」
 *
 * 部署方式：見 voc-bot/RUNBOOK.md
 * 這是一支自給自足的 Apps Script 檔案。所有設定都在下面 CONFIG 區塊。
 *
 * 核心邏輯（v2）：
 *   1. 抓 Slack + 4 份表單的原始聲音
 *   2. 把一則長訊息「切分」成獨立訴求（一則講三件事 = 三筆），並濾掉寒暄雜訊
 *   3. 每一筆去比對 VoC Roadmap 上的既有 pain point
 *        命中   → 舊痛點：件數 +N，並依 Roadmap 的 Status/Shipped 判斷是否仍未解決
 *        沒命中 → 新痛點：分群成候選，建議加入 VoC
 *        沒把握 → 未判定：留著下次自動重試，不靜默丟掉
 *   4. 產出今日摘要：先講「舊痛點又被抱怨了幾次且還沒解決」，再講「新痛點建議加入」
 *
 * 它會在目標試算表建立 5 個「機器人專屬」分頁（完全不碰任何既有分頁）：
 *   VoC_Daily_Brief      今日摘要（最新的在最上面）— 你每天只需要看這個
 *   VoC_Pain_Points      既有 VoC 痛點 × 累計件數 / 增減 / 是否未解決
 *   VoC_New_Candidates   不在 VoC 上的新痛點候選（建議加入）
 *   VoC_Raw_Log          原始紀錄（append-only，每筆都有連結與判定依據，稽核用）
 *   VoC_Bot_Log          執行紀錄與錯誤
 */

// ===========================================================================
// CONFIG — 只有這一區要改
// ===========================================================================

/** 產出要寫進去的試算表（VIP Feedback Sharing Sheet） */
var TARGET_SHEET_ID = '12pH74KmMPFKrVWj7rLGyj3WDwDGTZmxQY4QdEe3kj4A';

/**
 * VoC Roadmap —— 判斷「新／舊痛點」的唯一依據。
 * 這份表是唯讀的：機器人只讀不寫，建議都寫進上面的 VoC_New_Candidates。
 * GID 就是網址 #gid= 後面那串數字（Japan VoC roadmap workbook → JP Needs — Product Roadmap）。
 */
var VOC_ROADMAP_SHEET_ID = '16AuZeGSu2z1PwnTvhZI2HazyG16zltOs7eRxEC04rcE';
var VOC_ROADMAP_GID = 1005872232;

/** 要掃描的資料源試算表。label 會出現在「主な出所」欄。 */
var SOURCE_SHEETS = [
  { id: '12pH74KmMPFKrVWj7rLGyj3WDwDGTZmxQY4QdEe3kj4A', label: 'VIP Feedback' },
  { id: '1la1-k4pBxtWs-ol_4QsYg92cpDeMgrcsVKE5hcjipmY', label: 'JP feature requests Q3' },
  { id: '1gZoZVwV8FaC2KQyZyiz5eqzXwnuaEbk1DhpEXihqS4k', label: 'JP feedback for Cross' },
  { id: '1QDZ7FERDK1c4kSyH9_rvaKtN31FmvWHVp2tXga7tgzQ', label: 'プロライバー定例会' }
];

/**
 * Slack。SLACK_TOKEN 必須是 17media workspace 的 token（xoxb- 或 xoxp- 開頭）。
 * 取得方式見 RUNBOOK.md。
 */
var SLACK_TOKEN = 'xoxb-PASTE-YOUR-17MEDIA-SLACK-TOKEN-HERE';
var SLACK_CHANNEL_ID = 'C06PRMJ6HRD';

/**
 * Claude API key —— 強烈建議填。
 * 填了：用語意比對把日文聲音對到英文痛點清單（精度高）。
 * 留空：降級成規則式關鍵字比對，跨語言精度明顯較差，判定欄會標「規則式(精度低)」。
 */
var ANTHROPIC_API_KEY = '';
/** 比對用（量大、要快）。分類任務用 sonnet 足夠且比 opus 快很多。 */
var ANTHROPIC_MATCH_MODEL = 'claude-sonnet-5';
/** 摘要用（一次呼叫、要文筆）。 */
var ANTHROPIC_BRIEF_MODEL = 'claude-opus-5';

/** 每天幾點跑（0-23，依 Apps Script 專案時區，RUNBOOK 會設成 Asia/Tokyo） */
var DAILY_HOUR = 8;

/**
 * bot 掛掉時寄信給誰。**留空字串 = 完全不寄**（只有 VoC Console 的健康列會顯示）。
 *
 * 為什麼需要這個：bot 是每天 08:10 自己醒來的無人化排程，失敗時只會往 VoC_Bot_Log
 * 寫一列 ABORT，沒有人會知道。Console 的健康列會變紅，但那要你主動打開才看得到。
 *
 * 只在「狀態改變」時寄，不是每天寄：
 *   · 第一次失敗（上一次還是成功的）→ 寄
 *   · 連續第 3 次失敗（＝資料源真的壞了，不是暫時性抖動）→ 寄
 *   · 修好之後第一次成功 → 寄一封「已恢復」
 * 所以一次故障最多 3 封信，不會連續三週每天吵你。
 *
 * 收件人寫死成腳本擁有者自己的信箱：這是「寄給自己」，不是對外發送。
 */
var ALERT_EMAIL = 'crosswang@17.media';

/** 第一次執行時 Slack 往回抓幾天。之後只抓上次跑完之後的新訊息。 */
var FIRST_RUN_LOOKBACK_DAYS = 30;

/** 單次執行的上限（防爆量、防 Apps Script 逾時）。沒做完的下次會自動接續。 */
var SLACK_MAX_MESSAGES = 300;
var SLACK_MAX_THREADS = 40;
var TIME_BUDGET_MS = 4.5 * 60 * 1000;

/** 切分參數 */
var SEG_MAX_LEN = 180;              // 單一訴求的目標長度上限
var SEG_MIN_LEN = 8;                // 短於此視為雜訊
var SEG_MAX_PER_MESSAGE = 8;        // 一則訊息最多切成幾筆

/**
 * 比對參數。
 * 批次刻意壓小：Apps Script 的 UrlFetchApp 單次請求約 60 秒就會斷，
 * 而 Claude 有 thinking 過程，一次塞太多筆容易逾時整批重做。
 */
var MATCH_BATCH_SIZE = 15;          // 一次送幾筆給 Claude
var MATCH_MAX_BATCHES = 10;         // 單次執行最多幾批（超過的下次接續）
var MATCH_ACCEPT_CONF = 0.6;        // ≥ 這個信心才算「既存一致」
var MATCH_REVIEW_CONF = 0.4;        // 介於兩者之間 → 標「要確認」，仍計數但提醒你複核

/** 「直近」熱度的天數 */
var RECENT_DAYS = 30;

/** 時區（用於所有日期字串格式化） */
var TZ = 'Asia/Tokyo';

// --- 分頁名稱（機器人專屬）---
var TAB_BRIEF = 'VoC_Daily_Brief';
var TAB_PP = 'VoC_Pain_Points';
var TAB_NEW = 'VoC_New_Candidates';
var TAB_RAW = 'VoC_Raw_Log';
var TAB_LOG = 'VoC_Bot_Log';
/** 掃描來源表時要跳過的分頁（含 v1 遺留的 VoC_Index，避免把自己的產出當成聲音吃回去） */
var BOT_TABS = [TAB_BRIEF, TAB_PP, TAB_NEW, TAB_RAW, TAB_LOG, 'VoC_Index'];

var BRIEF_HEADERS = ['日時', '見出し', '内容'];

/** Raw_Log：第 1〜20 欄。第 14〜18 欄由比對階段回填。 */
var RAW_HEADERS = ['ハッシュ', '親ハッシュ', '取込日時', '発生日', '出所', '出所詳細',
                   '種類', 'テーマ', '要約', '本文', '起票者', 'ステータス', 'リンク',
                   '判定', 'VoCコード', 'VoC論点', '信頼度', '判定根拠', '分割', '原文'];
var RAW_COL_VERDICT = 14;   // 判定
var RAW_VERDICT_WIDTH = 5;  // 判定 → 判定根拠 共 5 欄

/** Pain_Points：第 1〜18 欄由機器人覆寫，第 19〜20 欄留給人手動填，機器人絕不動 */
var PP_HEADERS = ['VoCコード', '論点 (Request / Pain points)', '領域', '優先度',
                  'ロードマップ状態', '未解決', '件数(累計)', '直近' + RECENT_DAYS + '日',
                  '今回新規', '前回件数', '増減', '初出日', '最終出現日', '主な出所',
                  'ロードマップ記載件数', '代表的な声', '最新の声', '最新の声リンク',
                  'PM共有日', 'クロスメモ'];
var PP_BOT_COLS = 18;

/** New_Candidates：第 1〜16 欄由機器人覆寫，第 17〜18 欄留給人手動填 */
var NEW_HEADERS = ['候補ID', '提案タイトル(JP)', '提案タイトル(EN)', '推定領域', '推奨優先度',
                   '件数(累計)', '直近' + RECENT_DAYS + '日', '今回新規', '前回件数', '増減',
                   '初出日', '最終出現日', '主な出所', '代表的な声', '最新の声', '最新の声リンク',
                   'VoC追加状態(人手)', 'クロスメモ'];
var NEW_BOT_COLS = 16;

var LOG_HEADERS = ['日時', '種別', '結果', '内容'];

// --- 判定值 ---
var V_MATCH = '既存一致';
var V_MATCH_REVIEW = '既存一致(要確認)';
var V_NEW = '新規候補';
var V_PENDING = '未判定';
var V_NOISE = 'ノイズ';
var V_RULE = '規則式(精度低)';

// ===========================================================================
// 分類字典 — 只用來產生輔助標籤（テーマ／種類／推定領域），不再決定計數的分群
// ===========================================================================

/** 同義詞正規化 */
var CANON = [
  ['ギフボ', 'ギフトボード'], ['giftboard', 'ギフトボード'], ['gift board', 'ギフトボード'],
  ['リーダーボード', 'ギフトボード'], ['禮物榜', 'ギフトボード'],
  ['テロップ', 'ティッカー'], ['跑馬燈', 'ティッカー'], ['ticker', 'ティッカー'],
  ['マイイベ', 'マイイベント'], ['カスタムイベント', 'マイイベント'],
  ['ラッキー袋', 'ラッキーバッグ'], ['福袋', 'ラッキーバッグ'],
  ['アーミー', 'army'], ['ガーディアン', 'guardian'],
  ['ベイビーコイン', 'babycoin'], ['baby coin', 'babycoin'],
  ['マッチング', 'matching'], ['対戦', 'vsmode'], ['ｖｓ', 'vsmode']
];

var THEMES = [
  { name: 'ギフトボード / Gift Board',           area: 'S2 Broadcast / Ops',      kw: ['ギフトボード', 'ギフター', '贈り主'] },
  { name: 'ティッカー・表示UI / Ticker & Overlay', area: 'S2 Broadcast / Ops',      kw: ['ティッカー', '金テロ', 'エフェクト', '演出', '被り', '重なる', '邪魔な位置'] },
  { name: 'イベント・マイイベント / Events',      area: 'U6 Event / Compete',      kw: ['イベント', 'マイイベント', 'リーグ', 'グランプリ', '表彰', 'シャイニング', 'マンスリー'] },
  { name: 'ラッキーバッグ・ランダム / Lucky & Random', area: 'U4 Gifting / Spend',  kw: ['ラッキーバッグ', 'ラッキー', 'ランダム', 'ガチャ', '大当たり', 'クレイジー'] },
  { name: 'VS・PK・マッチング / VS & Matching',   area: 'U6 Event / Compete',      kw: ['vsmode', 'matching', 'pk', '待機室', '待機時間'] },
  { name: 'アーミー・ガーディアン・階級 / Community Rank', area: 'U5 Recognition / Status', kw: ['army', 'guardian', '階級', '大佐', 'バッジ', '称号', 'レベル'] },
  { name: '課金・報酬・BC / Payment & Revenue',   area: 'U4 Gifting / Spend',      kw: ['課金', '決済', 'atone', '支払', 'コイン', 'babycoin', '報酬', 'ロイヤリティ', 'マイレベニュー', '分潤'] },
  { name: 'バグ・不具合 / Bugs',                  area: 'S2 Broadcast / Ops',      kw: ['バグ', 'bug', '不具合', 'エラー', '落ちる', 'クラッシュ', 'crash', '真っ暗', '映らない', '表示されない', '反映されて'] },
  { name: '規約・不正対策 / Abuse & Policy',      area: 'U4 Gifting / Spend',      kw: ['ブロック', 'block', '通報', 'bot', 'ボット', '不正', 'サブ垢', '複数アカウント', '自投げ', 'ペナルティ', '取り締ま'] },
  { name: 'アプリUI・導線 / App UI & Navigation', area: 'U2 Watch / Return',       kw: ['ホーム画面', 'プロフィール', 'profile', '検索', 'タブ', '導線', 'たどり着', 'スクロール', 'ピックアップ', '注目欄', 'マイボックス', 'ipad'] },
  { name: 'DM・フォロー・通知 / Comms',           area: 'U2 Watch / Return',       kw: ['dm', 'フォロー', 'follow', '通知', 'コメント', 'タイムライン', 'メンション'] },
  { name: '社内システム・PMプロセス / Internal & PM', area: 'Z Strategy',          kw: ['bdsystem', 'bd system', 'prd', 'pm側', 'pmと', 'ロードマップ', 'roadmap', 'discovery', '定例', '認識合わせ', '契約カード', 'アンケート'] },
  { name: 'VOD・配信機能 / VOD & Streaming',      area: 'S2 Broadcast / Ops',      kw: ['vod', '17live+', 'obs', '録画', '配信画面', 'アーカイブ', '視聴データ'] }
];

var KIND_RULES = [
  { key: 'バグ',  kw: ['バグ', 'bug', '不具合', 'エラー', '落ちる', 'クラッシュ', '直して', '修正して'] },
  { key: '通報',  kw: ['通報', '不正', '違反', '取り締ま'] },
  { key: '要望',  kw: ['ほしい', '欲しい', 'したい', 'できるように', '実装', '追加して', '対応して',
                       'お願いします', '改善', '変更', '導入', '見直し', '増やして', 'あると良い'] },
  { key: '不満',  kw: ['邪魔', '不便', 'ストレス', '困って', '残念', 'いらない', '不信', '病んで',
                       '諦め', 'できない', '取得できない', '見れない'] },
  { key: '質問',  kw: ['ですか？', 'でしょうか', '教えて', '確認したい', 'どうなり'] },
  { key: '提案',  kw: ['のでは', '提案', 'いかがで', '検討して', 'した方が', 'すべき'] }
];

/**
 * 降級模式（沒有 Claude API key）用的日文別名表。
 * key = VoC Roadmap 的 Source 代碼。痛點清單是英文，這張表補上日文說法。
 * Roadmap 上新增的代碼若不在這裡，降級模式只能靠標題字面比對，命中率低。
 */
var PAIN_POINT_ALIASES = {
  'S2.0': ['金テロ', 'ティッカー', 'マーキー', '演出が邪魔', 'エフェクトが邪魔', '画面を覆', '被って見えない'],
  'S2.1': ['クラッシュ', '落ちる', '強制終了', 'フリーズ', 'キーボード', '入力できない', '回線不安定', '配信が切れ'],
  'S2.2': ['aiアシスタント', 'ai の回答', 'トークテーマ'],
  'S2.3': ['コメントが多', 'コメントを読み', 'コメント要約'],
  'S2.4': ['マイルストーン', 'bc達成', '目標達成'],
  'S2.5': ['guardian', '守護', 'ガーディアンが交代'],
  'S2.6': ['ギフトボード', 'ギフター', '非表示にしたい'],
  'S2.7': ['マイイベント', '子袋', 'イベント設定を記憶'],
  'S5.0': ['ブロックしたのに', '閲覧制限', '検索されたくない'],
  'U2.0': ['画面が邪魔', 'システム表示', 'すっきり', 'ui を隠'],
  'U2.1': ['プロフィール', '自己紹介', 'bio', 'リニューアルで消え'],
  'U2.2': ['タブ', '導線', 'たどり着', '見つからない', '入口が'],
  'U2.3': ['早送り', 'シーク', 'アーカイブ', '巻き戻し'],
  'U2.4': ['ハート', 'タップ', '連打'],
  'U2.5': ['コメントが合併', 'まとめられ', 'マイボックス', '連続で当たっ'],
  'U4.0': ['海外ボット', 'ボット', '自投げ', '紅包', '赤い封筒', 'お年玉', '不正に取得'],
  'U4.1': ['価格帯', '中間の価格', '高すぎ', '課金額の選択'],
  'U4.2': ['ギフトが多すぎ', '探しにくい', 'ギフト検索'],
  'U4.3': ['vipギフト', '導線が複雑'],
  'U4.4': ['誤爆', '誤送信', '取り消せない', '高額ギフト'],
  'U5.0': ['バッジが小さい', 'バッジが見えない', '実績が見えない'],
  'U5.1': ['army', '階級', '大佐', '所属感'],
  'U5.2': ['ランキングロジック', '順位の基準', 'ランキングが不明'],
  'U5.3': ['レベルを隠', 'レベル表示'],
  'U5.4': ['称号', '認証バッジ', '公式マーク'],
  'U6.0': ['vsmode', '切り替わらない', '対戦情報', 'マッチ情報'],
  'U6.1': ['pk', '勝っても', '報酬が少'],
  'U6.2': ['身内', 'ブロックしたのにマッチ', 'matching'],
  'U6.3': ['チャットが見えない', 'マッチ中', '待機'],
  'U6.4': ['オフラインイベント', 'コンテスト', 'ルールが不明']
};

/** 寒暄／確認等雜訊。整段只由這些構成 → 不算一筆聲音。 */
var NOISE_PHRASES = [
  'お疲れ様です', 'お疲れさまです', 'おつかれさまです', 'ありがとうございます', 'ありがとうございました',
  'ありがとう', 'よろしくお願いします', 'よろしくお願いいたします', 'よろしくお願い致します',
  'よろしくお願いします！', '承知しました', '承知いたしました', 'かしこまりました', '了解です',
  '了解しました', '確認します', '確認いたします', '確認しました', 'すみません', '失礼します',
  'おはようございます', 'こんにちは', 'こんばんは', 'お世話になっております', '以上です',
  '共有します', '共有いたします', 'ご確認ください', 'ご確認をお願いします', 'なるほど',
  '助かります', 'thanks', 'thank you', 'ok', 'okです', 'はい', 'いいえ', '対応します',
  'お待ちください', 'お待ちしております', '失礼しました', '申し訳ありません', 'すみませんでした'
];

// ===========================================================================
// 欄位自動辨識 — 4 份表單欄名不一致。同義字「越前面優先度越高」。
// ===========================================================================

var COLUMN_SYNONYMS = {
  date: ['created_date', '起案日', 'date', '日付', 'タイムスタンプ', 'timestamp', '受付日'],
  title: ['リクエストタイトル', '意見のテーマ', 'タイトル', 'topic', 'title', 'project', 'テーマ'],
  body: ['提案内容', 'リクエスト内容', '問題点、伝えてほしいこと、共有事項', 'raw_text',
         'summary', '課題・背景', 'ご意見', '意見', '内容', 'description'],
  kind: ['category', 'カテゴリ', '種別', 'tag'],
  source: ['情報源 source', '情報源', 'source', 'channel', 'チャネル'],
  owner: ['記入者', '部署', '担当', 'openid', 'owner'],
  status: ['回答', 'ステータス', 'status', '解決済み', '対応状況'],
  note: ['クロスコメント', '関連情報', 'notes', '備考', 'stakeholderコメント']
};

/** 這些欄位視為翻譯/衍生欄，不當作主要內容來源 */
function isDerivedHeader_(h) {
  return h.indexOf('english') >= 0 || h.indexOf('(en)') >= 0 ||
         h.indexOf('zh-tw') >= 0 || h.indexOf(' en') >= 0 ||
         h.indexOf('期待される効果') >= 0;
}

// ===========================================================================
// 入口函式
// ===========================================================================

/** 【第一次執行這個】建立分頁 + 安裝每日排程。可重複執行。 */
function setupAll() {
  var ss = openTarget_();
  setupSheets_(ss);
  installDailyTrigger();
  var tz = Session.getScriptTimeZone();
  logRow_(ss, 'SETUP', 'OK', '分頁已建立；每日 ' + DAILY_HOUR + ':00 排程已安裝');
  if (tz !== TZ) {
    logRow_(ss, 'SETUP', 'WARN',
      '專案時區目前是 ' + tz + '，排程會依這個時區觸發。' +
      '請到「專案設定 → 時區」改成 ' + TZ + '，再重跑一次 setupAll。');
  } else {
    logRow_(ss, 'SETUP', 'OK', '專案時區 = ' + tz + '（正確）');
  }
  if (ss.getSheetByName('VoC_Index')) {
    logRow_(ss, 'SETUP', 'INFO',
      'v1 的 VoC_Index 分頁還在。新版改用 VoC_Pain_Points，' +
      'VoC_Index 已不再更新，確認過後可以自行刪除。');
  }
  if (!ANTHROPIC_API_KEY) {
    logRow_(ss, 'SETUP', 'WARN',
      'Claude API key 未設定 → 新舊痛點比對會走規則式（跨語言精度較差）。' +
      '建議填入 ANTHROPIC_API_KEY。');
  }
  SpreadsheetApp.flush();
}

/** 【每天自動執行的主流程】也可以手動點來立刻跑一次。 */
function runDailyDigest() {
  var ss;
  try {
    ss = openTarget_();
  } catch (e) {
    throw new Error('無法開啟目標試算表 ' + TARGET_SHEET_ID + '：' + e.message +
      '\n請確認你的 Google 帳號對這份試算表有「編輯者」權限。');
  }

  setupSheets_(ss);
  var started = new Date();
  logRow_(ss, 'RUN', 'START', '開始執行');

  var problems = [];

  // --- 1. 讀 VoC Roadmap（新舊判斷的依據）---
  var roadmap = null;
  try {
    roadmap = loadRoadmap_();
    logRow_(ss, 'ROADMAP', 'OK',
      '讀取「' + roadmap.tabName + '」（gid=' + roadmap.gid + '）：' +
      roadmap.items.length + ' 個既有 pain point');
  } catch (e) {
    problems.push('VoC Roadmap: ' + e.message);
    logRow_(ss, 'ROADMAP', 'ERROR', e.message);
  }
  if (!roadmap || roadmap.items.length === 0) {
    logRow_(ss, 'RUN', 'ABORT',
      'VoC Roadmap 讀不到（或沒有任何痛點），無法判斷新舊，本次中止。' + problems.join(' | '));
    notifyRunState_(ss, 'ABORT', 'VoC Roadmap 讀不到：' + problems.join(' | '));
    SpreadsheetApp.flush();
    return;
  }

  // --- 2. 抓原始聲音 ---
  var messages = [];
  try {
    var slack = fetchSlack_(ss, started);
    messages = messages.concat(slack.messages);
    logRow_(ss, 'SLACK', 'OK', '取得 ' + slack.messages.length + ' 則' +
      (slack.truncated ? '（達單次上限，剩下的下次自動接續）' : ''));
  } catch (e) {
    problems.push('Slack: ' + e.message);
    logRow_(ss, 'SLACK', 'ERROR', e.message);
  }

  for (var i = 0; i < SOURCE_SHEETS.length; i++) {
    var src = SOURCE_SHEETS[i];
    try {
      var rows = fetchSpreadsheet_(src);
      messages = messages.concat(rows);
      logRow_(ss, 'SHEET', 'OK', src.label + '：擷取 ' + rows.length + ' 筆');
    } catch (e) {
      problems.push(src.label + ': ' + e.message);
      logRow_(ss, 'SHEET', 'ERROR', src.label + '：' + e.message);
    }
  }

  if (messages.length === 0 && problems.length >= SOURCE_SHEETS.length + 1) {
    logRow_(ss, 'RUN', 'ABORT', '所有資料源都失敗，本次不寫入。' + problems.join(' | '));
    notifyRunState_(ss, 'ABORT', '所有資料源都失敗：' + problems.join(' | '));
    SpreadsheetApp.flush();
    return;
  }

  // --- 3. 切分 → 分類 → 去重寫入 Raw_Log ---
  var ingest = appendRawLog_(ss, messages);
  logRow_(ss, 'INGEST', 'OK',
    '新訊息 ' + ingest.newMessages + ' 則 → 切分 ' + ingest.segments +
    ' 筆（雜訊濾掉 ' + ingest.noise + ' 筆）');

  // --- 4. 比對 VoC Roadmap（含補做上次的未判定）---
  var match = { matched: 0, newCand: 0, pending: 0, truncated: false, mode: '' };
  try {
    match = matchPending_(ss, roadmap, started);
    logRow_(ss, 'MATCH', 'OK',
      '比對方式=' + match.mode + '：既存一致 ' + match.matched + ' 筆／新規候補 ' +
      match.newCand + ' 筆／未判定 ' + match.pending + ' 筆' +
      (match.truncated ? '（達單次上限，剩下的下次自動接續）' : ''));
  } catch (e) {
    problems.push('比對: ' + e.message);
    logRow_(ss, 'MATCH', 'ERROR', e.message);
  }

  // --- 5. 重算兩張彙總表 ---
  var stats = { pp: [], cand: [], pending: 0 };
  try {
    stats = rebuildAggregates_(ss, roadmap, match.newlyDecided || {});
  } catch (e) {
    problems.push('彙總重算: ' + e.message);
    logRow_(ss, 'AGG', 'ERROR', e.message);
  }

  // --- 6. 今日摘要 ---
  try {
    prependBrief_(ss, buildBrief_(ss, stats, ingest, match, problems));
  } catch (e) {
    logRow_(ss, 'BRIEF', 'ERROR', e.message);
  }

  var secs = Math.round((new Date().getTime() - started.getTime()) / 1000);
  var runResult = problems.length ? 'DONE_WITH_WARNINGS' : 'DONE';
  var runDetail = '訊息 ' + messages.length + ' 則／新增切分 ' + ingest.segments + ' 筆／既有痛點 ' +
    stats.pp.length + ' 個／新候補 ' + stats.cand.length + ' 個／耗時 ' + secs + ' 秒' +
    (problems.length ? '。警告：' + problems.join(' | ') : '');
  logRow_(ss, 'RUN', runResult, runDetail);
  notifyRunState_(ss, runResult, runDetail);
  SpreadsheetApp.flush();
}

/**
 * 只在「跑的結果從上次改變了」的時候寄一封信。這支是 loop-contract FAIL 格裡
 * 「連續 3 輪同一條 FAIL → 升級給 Cross」的實作 —— 紅色的介面元件只是顯示，
 * 主動寄出來的信才叫升級。
 *
 * 判斷方式：從 VoC_Bot_Log 倒著讀 RUN 那幾列（這次的已經寫進去了），
 * 數「從最新往上，連續有幾個 ABORT」。
 *   aborts === 1 → 剛壞（上一次還好的）        → 寄
 *   aborts === 3 → 三振（連三次，資料源真的壞了）→ 寄
 *   這次成功、但上一次是 ABORT                  → 寄「已恢復」
 *   其他（連續第 2、4、5… 次失敗；本來就一直好） → 不寄
 *
 * 寄信失敗（超出 Gmail 每日配額等）不可以炸掉主流程 —— 資料已經寫完了，
 * 通知失敗只記一列 log。
 */
function notifyRunState_(ss, thisResult, thisDetail) {
  if (!ALERT_EMAIL) return;                       // 留空＝關閉通知

  var runs;
  try {
    SpreadsheetApp.flush();                       // 確保剛剛那列讀得到
    var sh = ss.getSheetByName(TAB_LOG);
    if (!sh) return;
    var last = sh.getLastRow();
    if (last < 2) return;
    var n = Math.min(last - 1, 400);
    var vals = sh.getRange(last - n + 1, 1, n, LOG_HEADERS.length).getValues();
    runs = [];
    for (var i = 0; i < vals.length; i++) {
      var kind = String(vals[i][1]), res = String(vals[i][2]);
      if (kind === 'RUN' && res !== 'START') runs.push(res);
    }
  } catch (e) {
    logRow_(ss, 'ALERT', 'ERROR', '讀不到執行紀錄，無法判斷要不要通知：' + e.message);
    return;
  }
  if (runs.length === 0) return;

  // 從最新往上數連續 ABORT
  var aborts = 0;
  for (var j = runs.length - 1; j >= 0; j--) {
    if (runs[j] === 'ABORT') aborts++; else break;
  }
  var prev = runs.length >= 2 ? runs[runs.length - 2] : '';

  var subject = '', body = '';
  if (thisResult === 'ABORT' && aborts === 1) {
    subject = '[VoC bot] 今天沒跑起來';
    body = 'VoC Daily Bot 今天早上失敗了，這次沒有寫入任何資料。\n\n' +
           '原因：' + thisDetail + '\n\n' +
           '影響：VoC Console 上的「昨日新增」會是 0，那不代表用戶沒抱怨，是 bot 沒抓到。\n' +
           '現在還不用緊張 —— 如果是暫時性的（Slack 或 Claude API 抖一下），明天早上會自己恢復。\n' +
           '連續失敗到第 3 次我會再寄一封。';
  } else if (thisResult === 'ABORT' && aborts === 3) {
    subject = '[VoC bot] 連續失敗 3 次，要你處理了';
    body = 'VoC Daily Bot 已經連續 3 天失敗。連三次代表不是暫時性抖動，是資料源真的壞了。\n\n' +
           '最近一次的原因：' + thisDetail + '\n\n' +
           '要做什麼：\n' +
           '1. 打開試算表的 VoC_Bot_Log 分頁，看最後幾列 ABORT 寫了什麼\n' +
           '2. 最常見的兩個原因：SLACK_TOKEN 過期了、或你對 VoC Roadmap 那張表的檢視權被收回\n' +
           '3. 修好之後在 Apps Script 手動跑一次 runDailyDigest\n\n' +
           '在修好之前，VoC Console 的健康列會是紅的 —— 不要拿那頁上的數字對外講。';
  } else if (thisResult !== 'ABORT' && prev === 'ABORT') {
    subject = '[VoC bot] 已恢復';
    body = 'VoC Daily Bot 今天早上跑成功了，資料是新的，Console 的數字可以用了。\n\n' +
           '這次的結果：' + thisDetail;
  } else {
    return;                                        // 狀態沒改變，不吵
  }

  try {
    MailApp.sendEmail(ALERT_EMAIL, subject, body);
    logRow_(ss, 'ALERT', 'OK', '已寄出通知「' + subject + '」給 ' + ALERT_EMAIL);
  } catch (e) {
    // 寄不出去不影響資料，但要留痕：Console 的健康列仍然會顯示紅燈
    logRow_(ss, 'ALERT', 'ERROR', '通知寄不出去（' + e.message + '）。' +
      '資料本身沒問題，但你只能靠 Console 的健康列看到這次失敗。');
  }
}

/** 【驗證用】檢查 Roadmap、Slack、每份表單、目標表寫入權限。結果寫進 VoC_Bot_Log。 */
function testConnections() {
  var ss = openTarget_();
  setupSheets_(ss);
  logRow_(ss, 'TEST', 'START', '=== 連線測試開始 ===');

  var scriptTz = Session.getScriptTimeZone();
  logRow_(ss, 'TEST', scriptTz === TZ ? 'OK' : 'WARN',
    '專案時區 = ' + scriptTz + (scriptTz === TZ ? '（正確）' : '（建議改成 ' + TZ + '）'));

  try {
    ss.getSheetByName(TAB_LOG).getRange('A1').getValue();
    logRow_(ss, 'TEST', 'OK', '目標試算表可寫入：' + ss.getName());
  } catch (e) {
    logRow_(ss, 'TEST', 'FAIL', '目標試算表寫入失敗：' + e.message);
  }

  try {
    var rm = loadRoadmap_();
    logRow_(ss, 'TEST', 'OK', 'VoC Roadmap 可讀取：分頁「' + rm.tabName + '」gid=' + rm.gid +
      '，' + rm.items.length + ' 個 pain point（前 3 個：' +
      rm.items.slice(0, 3).map(function (x) { return x.code + ' ' + x.title; }).join(' / ') + '）');
    var noCode = rm.items.filter(function (x) { return x.codeAuto; }).length;
    if (noCode > 0) {
      logRow_(ss, 'TEST', 'WARN', 'Roadmap 有 ' + noCode +
        ' 列沒填 Source 代碼，機器人改用標題雜湊當 key。' +
        '若之後改動這些列的標題，累計件數會斷掉 —— 建議每列都給一個代碼。');
    }
  } catch (e) {
    logRow_(ss, 'TEST', 'FAIL', 'VoC Roadmap：' + e.message);
  }

  if (SLACK_TOKEN.indexOf('PASTE') >= 0) {
    logRow_(ss, 'TEST', 'FAIL', 'Slack token 還是 placeholder，請先換成 17media workspace 的真 token');
  } else {
    try {
      var probe = slackCall_('conversations.history', { channel: SLACK_CHANNEL_ID, limit: 1 });
      logRow_(ss, 'TEST', 'OK', 'Slack 連線成功，頻道可讀（測試取得 ' +
        ((probe.messages || []).length) + ' 則）');
    } catch (e) {
      logRow_(ss, 'TEST', 'FAIL', 'Slack：' + e.message);
    }
  }

  for (var i = 0; i < SOURCE_SHEETS.length; i++) {
    var src = SOURCE_SHEETS[i];
    try {
      var s = SpreadsheetApp.openById(src.id);
      logRow_(ss, 'TEST', 'OK', src.label + ' 可讀取（' + s.getSheets().length + ' 個分頁）');
    } catch (e) {
      logRow_(ss, 'TEST', 'FAIL', src.label + '：' + e.message);
    }
  }

  if (!ANTHROPIC_API_KEY) {
    logRow_(ss, 'TEST', 'WARN',
      'Claude API key 未設定 → 比對走規則式（跨語言精度較差）。強烈建議填入。');
  } else {
    try {
      logRow_(ss, 'TEST', 'OK', 'Claude API 連線成功：' +
        String(callClaude_('回覆兩個字：OK', ANTHROPIC_MATCH_MODEL, 100, 'low')).substring(0, 40));
    } catch (e) {
      logRow_(ss, 'TEST', 'FAIL', 'Claude API：' + e.message);
    }
  }

  logRow_(ss, 'TEST', 'END', '=== 測試結束，請看上面每一列的結果 ===');
  SpreadsheetApp.flush();
}

/** 【除錯用】把 VoC Roadmap 讀到的痛點清單完整 dump 到 VoC_Bot_Log。 */
function inspectRoadmap() {
  var ss = openTarget_();
  setupSheets_(ss);
  logRow_(ss, 'ROADMAP', 'START', '=== Roadmap 痛點清單 ===');
  try {
    var rm = loadRoadmap_();
    for (var i = 0; i < rm.items.length; i++) {
      var x = rm.items[i];
      logRow_(ss, 'ROADMAP', x.code,
        x.title + ' ｜領域=' + x.area + ' ｜優先度=' + x.priority +
        ' ｜状態=' + x.status + ' ｜Shipped=' + x.shipped +
        ' ｜未解決=' + (x.resolved ? 'いいえ' : 'はい') + ' ｜記載件数=' + x.requests);
    }
  } catch (e) {
    logRow_(ss, 'ROADMAP', 'ERROR', e.message);
  }
  logRow_(ss, 'ROADMAP', 'END', '=== 掃描結束 ===');
  SpreadsheetApp.flush();
}

/** 【除錯用】把每份來源表的分頁名稱與欄位 dump 到 VoC_Bot_Log。 */
function inspectSources() {
  var ss = openTarget_();
  setupSheets_(ss);
  logRow_(ss, 'INSPECT', 'START', '=== 來源結構掃描 ===');
  for (var i = 0; i < SOURCE_SHEETS.length; i++) {
    var src = SOURCE_SHEETS[i];
    try {
      var tabs = SpreadsheetApp.openById(src.id).getSheets();
      for (var t = 0; t < tabs.length; t++) {
        if (BOT_TABS.indexOf(tabs[t].getName()) >= 0) continue;
        var hdr = findHeaderRow_(readTabValues_(tabs[t], 12));
        var map = hdr.index >= 0 ? mapColumns_(hdr.headers) : null;
        logRow_(ss, 'INSPECT', src.label,
          '分頁「' + tabs[t].getName() + '」 列數=' + tabs[t].getLastRow() +
          ' 標題列=' + (hdr.index + 1) +
          ' 欄位=[' + hdr.headers.join(' | ') + ']' +
          (map ? ' → 判定 本文欄=' + JSON.stringify(map.bodyCols) +
                 ' 日期欄=' + map.date + ' 種類欄=' + map.kind : ' → 無法判定'));
      }
    } catch (e) {
      logRow_(ss, 'INSPECT', 'ERROR', src.label + '：' + e.message);
    }
  }
  logRow_(ss, 'INSPECT', 'END', '=== 掃描結束 ===');
  SpreadsheetApp.flush();
}

/**
 * 【維護用｜會刪資料】清空 VoC_Raw_Log **與 VoC_New_Candidates**，然後重新抓取。
 *
 * 兩張都要清：候選編號（CAND-xxx）是依附在 Raw_Log 的判定結果上的。
 * 只清 Raw_Log 會讓舊候選變成沒有任何聲音對應的孤兒列，而重跑時模型對同一件事
 * 可能提出略微不同的標題 → 又發一個新編號，候選數就會一路灌水（67→92→104）。
 *
 * 影響：Slack 只會回抓最近 FIRST_RUN_LOOKBACK_DAYS 天；表單來源會全部重讀。
 * VoC_Pain_Points 你手填的最後兩欄會保留；VoC_New_Candidates 因為整張重建，
 * 你在候選表上手填的備註會一併清掉 —— 有重要備註請先另存。
 */
function resetRawLogAndRebuild() {
  var ss = openTarget_();
  setupSheets_(ss);

  var raw = ss.getSheetByName(TAB_RAW);
  var rawLast = raw.getLastRow();
  if (rawLast > 1) raw.getRange(2, 1, rawLast - 1, raw.getLastColumn()).clearContent();

  var cand = ss.getSheetByName(TAB_NEW);
  var candLast = cand.getLastRow();
  if (candLast > 1) cand.getRange(2, 1, candLast - 1, cand.getLastColumn()).clearContent();

  logRow_(ss, 'RESET', 'OK',
    'VoC_Raw_Log 已清空（' + (rawLast - 1) + ' 列）、VoC_New_Candidates 已清空（' +
    (candLast - 1) + ' 列），接著重新抓取');
  SpreadsheetApp.flush();
  runDailyDigest();
}

/**
 * 【積壓補完用】只做比對，不重新抓取資料源。
 *
 * 什麼時候用：VoC_Bot_Log 的 MATCH 那列出現「達單次上限」且未判定還很多的時候。
 * runDailyDigest 每次要先花 1～2 分鐘重讀 4 份表單，剩下的時間才拿來比對；
 * 這支跳過抓取，把整個時間預算都花在消化積壓，追進度快很多。
 * 可以連續執行多次，直到未判定歸零。
 */
function catchUpMatching() {
  var ss = openTarget_();
  setupSheets_(ss);
  var started = new Date();
  logRow_(ss, 'CATCHUP', 'START', '只比對、不抓取');

  var roadmap;
  try {
    roadmap = loadRoadmap_();
  } catch (e) {
    logRow_(ss, 'CATCHUP', 'ABORT', 'VoC Roadmap 讀不到：' + e.message);
    SpreadsheetApp.flush();
    return;
  }

  var match;
  try {
    match = matchPending_(ss, roadmap, started);
    logRow_(ss, 'CATCHUP', 'OK',
      '既存一致 ' + match.matched + ' 筆／新規候補 ' + match.newCand +
      ' 筆／殘り未判定 ' + match.pending + ' 筆' +
      (match.truncated ? '（達單次上限，請再執行一次 catchUpMatching）' : '（已全部判定完畢）'));
  } catch (e) {
    logRow_(ss, 'CATCHUP', 'ERROR', e.message);
    SpreadsheetApp.flush();
    return;
  }

  try {
    rebuildAggregates_(ss, roadmap, match.newlyDecided || {});
    logRow_(ss, 'CATCHUP', 'DONE', '彙總已重算（本次不產生新的 Daily Brief）');
  } catch (e) {
    logRow_(ss, 'CATCHUP', 'ERROR', '彙總重算：' + e.message);
  }
  SpreadsheetApp.flush();
}

/** 安裝每日排程（會先清掉舊的，可重複執行） */
function installDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('runDailyDigest')
    .timeBased().atHour(DAILY_HOUR).nearMinute(10).everyDays(1).create();
}

/** 移除本腳本所有排程 */
function removeTriggers() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'runDailyDigest') ScriptApp.deleteTrigger(ts[i]);
  }
}

// ===========================================================================
// 分頁建立（冪等）
// ===========================================================================

function openTarget_() { return SpreadsheetApp.openById(TARGET_SHEET_ID); }

function setupSheets_(ss) {
  ensureSheet_(ss, TAB_BRIEF, BRIEF_HEADERS);
  ensureSheet_(ss, TAB_PP, PP_HEADERS);
  ensureSheet_(ss, TAB_NEW, NEW_HEADERS);
  ensureSheet_(ss, TAB_RAW, RAW_HEADERS);
  ensureSheet_(ss, TAB_LOG, LOG_HEADERS);
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getMaxColumns() < headers.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
  }
  var existing = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var needs = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(existing[i]).trim() !== headers[i]) { needs = true; break; }
  }
  if (needs) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#efefef');
  }
  if (sh.getFrozenRows() < 1) sh.setFrozenRows(1);
  return sh;
}

function logRow_(ss, kind, result, detail) {
  try {
    var sh = ss.getSheetByName(TAB_LOG) || ensureSheet_(ss, TAB_LOG, LOG_HEADERS);
    sh.appendRow([nowStr_(), kind, result, String(detail).substring(0, 4000)]);
  } catch (e) { /* log 寫不進去不該炸掉主流程 */ }
}

// ===========================================================================
// VoC Roadmap 讀取 —— 新舊判斷的唯一依據
// ===========================================================================

function sheetByGid_(ss, gid) {
  var shs = ss.getSheets();
  for (var i = 0; i < shs.length; i++) {
    if (shs[i].getSheetId() === gid) return shs[i];
  }
  return null;
}

/**
 * 讀 Roadmap。優先用 GID 精準命中；GID 找不到（分頁被重建過）就掃描所有分頁，
 * 找標題列含「Request / Pain points」的那一個，避免因為 GID 變動整支停擺。
 */
function loadRoadmap_() {
  var ss;
  try {
    ss = SpreadsheetApp.openById(VOC_ROADMAP_SHEET_ID);
  } catch (e) {
    throw new Error('開不了 Roadmap 試算表 ' + VOC_ROADMAP_SHEET_ID + '：' + e.message +
      '（請確認你的帳號對它至少有「檢視者」權限）');
  }

  var tab = sheetByGid_(ss, VOC_ROADMAP_GID);
  var values = null;
  var hdr = { index: -1, headers: [] };

  if (tab) {
    values = readTabValues_(tab, 0);
    hdr = findRoadmapHeader_(values);
  }
  if (hdr.index < 0) {
    var tabs = ss.getSheets();
    for (var t = 0; t < tabs.length; t++) {
      var v = readTabValues_(tabs[t], 15);
      var h = findRoadmapHeader_(v);
      if (h.index >= 0) { tab = tabs[t]; values = readTabValues_(tabs[t], 0); hdr = findRoadmapHeader_(values); break; }
    }
  }
  if (!tab || hdr.index < 0) {
    throw new Error('找不到含「Request / Pain points」標題列的分頁（gid=' + VOC_ROADMAP_GID +
      ' 也沒命中）。請確認 VOC_ROADMAP_GID 是否正確。');
  }

  var m = mapRoadmapCols_(hdr.headers);
  if (m.title < 0) throw new Error('Roadmap 找不到「Request / Pain points」欄');

  var items = [];
  var byCode = {};
  for (var r = hdr.index + 1; r < values.length; r++) {
    var row = values[r];
    var title = collapse_(pick_(row, m.title));
    if (!title || title.length < 4) continue;

    var code = collapse_(pick_(row, m.code));
    var codeAuto = false;
    if (!code) { code = 'AUTO-' + md5short_(normalizeForHash_(title)).substring(0, 6); codeAuto = true; }
    // Roadmap 上代碼重複（例如多列都填 Z）時，加後綴避免不同痛點被併成一列
    if (byCode[code]) {
      code = code + '#' + md5short_(normalizeForHash_(title)).substring(0, 4);
      codeAuto = true;
    }
    if (byCode[code]) continue;

    var shipped = collapse_(pickRaw_(row, m.shipped));   // TRUE/FALSE 是資料，不能被 pick_ 濾掉
    var status = collapse_(pick_(row, m.status));
    var item = {
      code: code,
      codeAuto: codeAuto,
      title: title.substring(0, 300),
      area: collapse_(pick_(row, m.area)),
      sourceType: collapse_(pick_(row, m.sourceType)),
      priority: collapse_(pick_(row, m.priority)),
      status: status,
      shipped: shipped,
      resolved: isResolved_(status, shipped),
      requests: collapse_(pick_(row, m.requests)),
      note: collapse_(pick_(row, m.note)).substring(0, 300),
      // rank / submitDate 只給 VoC Console 顯示「層級多高」用，比對邏輯不吃這兩欄。
      // Roadmap 沒有這兩欄時是空字串，介面會自動隱藏該欄，不會壞掉。
      rank: collapse_(pick_(row, m.rank)),
      submitDate: toYmd_(pickRaw_(row, m.date)),
      rowNum: r + 1
    };
    items.push(item);
    byCode[code] = item;
  }

  return { items: items, byCode: byCode, tabName: tab.getName(), gid: tab.getSheetId() };
}

function findRoadmapHeader_(values) {
  var limit = Math.min(15, values.length);
  for (var i = 0; i < limit; i++) {
    for (var c = 0; c < values[i].length; c++) {
      if (normHeader_(values[i][c]).indexOf('pain point') >= 0) {
        var norm = [];
        for (var k = 0; k < values[i].length; k++) norm.push(normHeader_(values[i][k]));
        return { index: i, headers: norm };
      }
    }
  }
  return { index: -1, headers: [] };
}

/** Roadmap 有「兩個」都叫 Source 的欄：第一個是代碼(S2.0)，第二個是 VoC/Strategy */
function mapRoadmapCols_(headers) {
  var m = { code: -1, sourceType: -1, date: -1, title: -1, area: -1, priority: -1,
            status: -1, shipped: -1, requests: -1, note: -1, rank: -1 };
  var sources = [];
  for (var c = 0; c < headers.length; c++) {
    var h = headers[c];
    if (!h) continue;
    if (h === 'source') { sources.push(c); continue; }
    if (h.indexOf('pain point') >= 0 && m.title < 0) m.title = c;
    else if (h.indexOf('date of submission') >= 0 && m.date < 0) m.date = c;
    else if (h.indexOf('user journey') >= 0 && m.area < 0) m.area = c;
    else if (h.indexOf('priority') >= 0 && m.priority < 0) m.priority = c;
    else if (h === 'status' && m.status < 0) m.status = c;
    else if (h.indexOf('shipped') >= 0 && m.shipped < 0) m.shipped = c;
    else if (h.indexOf('requests') >= 0 && m.requests < 0) m.requests = c;
    else if (h.indexOf('note') >= 0 && m.note < 0) m.note = c;
    else if (h.indexOf('rank') >= 0 && m.rank < 0) m.rank = c;
  }
  m.code = sources.length > 0 ? sources[0] : -1;
  m.sourceType = sources.length > 1 ? sources[1] : -1;
  return m;
}

function isResolved_(status, shipped) {
  var sp = String(shipped).trim().toUpperCase();
  if (sp === 'TRUE' || sp === 'YES' || sp === '済' || sp === 'V') return true;
  var st = String(status).toLowerCase();
  return st.indexOf('shipped') >= 0 || st.indexOf('released') >= 0 ||
         st.indexOf('done') >= 0 || st.indexOf('closed') >= 0 || st.indexOf('完了') >= 0;
}

function priorityRank_(p) {
  var m = String(p).toUpperCase().match(/P(\d)/);
  return m ? Number(m[1]) : 9;
}

// ===========================================================================
// Slack 擷取
// ===========================================================================

function slackCall_(method, params) {
  var qs = [];
  for (var k in params) {
    if (params[k] === null || params[k] === undefined || params[k] === '') continue;
    qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  }
  var url = 'https://slack.com/api/' + method + (qs.length ? '?' + qs.join('&') : '');
  var opts = { method: 'get', headers: { Authorization: 'Bearer ' + SLACK_TOKEN }, muteHttpExceptions: true };

  var res;
  try {
    res = UrlFetchApp.fetch(url, opts);
  } catch (e) {
    throw new Error(method + ' 網路錯誤：' + e.message);
  }

  var code = res.getResponseCode();
  if (code === 429 || code >= 500) {   // 暫時性錯誤 → 重試一次
    Utilities.sleep(3000);
    try { res = UrlFetchApp.fetch(url, opts); code = res.getResponseCode(); }
    catch (e2) { throw new Error(method + ' 重試仍失敗：' + e2.message); }
  }
  if (code !== 200) {
    throw new Error(method + ' HTTP ' + code + '：' + res.getContentText().substring(0, 300));
  }

  var body = safeJson_(res.getContentText());
  if (!body || body.ok !== true) {
    var err = body ? body.error : 'unparseable_response';
    var hint = '';
    if (err === 'not_in_channel') hint = '（bot token 需要被 /invite 進頻道；或改用 xoxp- user token 免邀請）';
    else if (err === 'channel_not_found') hint = '（token 不屬於 17media workspace，或頻道 ID 錯誤）';
    else if (err === 'missing_scope') hint = '（token 缺少 channels:history / groups:history / users:read 權限）';
    else if (err === 'invalid_auth' || err === 'token_revoked') hint = '（token 無效或已被撤銷，需重新產生）';
    throw new Error(method + ' 失敗：' + err + hint);
  }
  return body;
}

function fetchSlack_(ss, started) {
  if (SLACK_TOKEN.indexOf('PASTE') >= 0) {
    throw new Error('Slack token 尚未設定（還是 placeholder）');
  }

  var oldest = lastSlackTs_(ss);
  var raw = [];
  var cursor = '';
  var guard = 0;

  // 先把整個時間窗的訊息都抓下來（history 是新→舊）
  while (guard < 25) {
    guard++;
    var page = slackCall_('conversations.history', {
      channel: SLACK_CHANNEL_ID, oldest: oldest, limit: 200, cursor: cursor
    });
    var msgs = page.messages || [];
    for (var i = 0; i < msgs.length; i++) raw.push(msgs[i]);
    cursor = (page.response_metadata && page.response_metadata.next_cursor) || '';
    if (!cursor) break;
    if (outOfTime_(started)) break;
  }

  // 由舊到新排序，再從最舊端截斷 → 時間水位一定連續前進，不會永久跳過舊訊息
  raw.sort(function (a, b) { return parseFloat(a.ts) - parseFloat(b.ts); });
  var truncated = raw.length > SLACK_MAX_MESSAGES;
  if (truncated) raw = raw.slice(0, SLACK_MAX_MESSAGES);

  var out = [];
  var userCache = {};
  var threadsFetched = 0;

  for (var m = 0; m < raw.length; m++) {
    var msg = raw[m];
    if (msg.subtype && msg.subtype !== 'thread_broadcast') continue; // 略過 join/leave 等系統訊息
    if (msg.bot_id) continue;                                        // 略過 bot 貼文
    var text = cleanSlackText_(msg.text || '');
    if (text) {
      out.push(makeMessage_({
        date: tsToDate_(msg.ts),
        origin: 'Slack',
        originDetail: '#UserFeedback',
        body: text,
        owner: slackUserName_(msg.user, userCache),
        link: slackPermalink_(msg.ts)
      }));
    }

    // 討論串回覆常常才是真正的需求細節
    if (msg.thread_ts && msg.reply_count > 0 &&
        threadsFetched < SLACK_MAX_THREADS && !outOfTime_(started)) {
      threadsFetched++;
      try {
        var rep = slackCall_('conversations.replies',
          { channel: SLACK_CHANNEL_ID, ts: msg.thread_ts, limit: 50 });
        var rs = rep.messages || [];
        for (var r = 1; r < rs.length; r++) {   // index 0 是母訊息本身
          if (rs[r].bot_id) continue;
          var rt = cleanSlackText_(rs[r].text || '');
          if (!rt) continue;
          out.push(makeMessage_({
            date: tsToDate_(rs[r].ts),
            origin: 'Slack',
            originDetail: '#UserFeedback（スレッド）',
            body: rt,
            owner: slackUserName_(rs[r].user, userCache),
            link: slackPermalink_(rs[r].ts)
          }));
        }
      } catch (e) {
        logRow_(ss, 'SLACK', 'WARN', '討論串 ' + msg.thread_ts + ' 讀取失敗：' + e.message);
      }
    }
  }

  return { messages: out, truncated: truncated };
}

function outOfTime_(started) {
  return (new Date().getTime() - started.getTime()) > TIME_BUDGET_MS;
}

/** 從 Raw_Log 的 Slack 連結推算上次抓到哪，不需要額外存狀態 */
function lastSlackTs_(ss) {
  var fallback = String(Math.floor(new Date().getTime() / 1000) - FIRST_RUN_LOOKBACK_DAYS * 86400);
  var sh = ss.getSheetByName(TAB_RAW);
  var last = sh.getLastRow();
  if (last < 2) return fallback;

  var colOrigin = RAW_HEADERS.indexOf('出所') + 1;
  var colLink = RAW_HEADERS.indexOf('リンク') + 1;
  var width = colLink - colOrigin + 1;
  var n = Math.min(last - 1, 5000);

  var vals = sh.getRange(last - n + 1, colOrigin, n, width).getValues();
  var maxTs = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] !== 'Slack') continue;
    var mm = String(vals[i][width - 1]).match(/\/p(\d{10})(\d{6})/);
    if (mm) {
      var ts = parseFloat(mm[1] + '.' + mm[2]);
      if (ts > maxTs) maxTs = ts;
    }
  }
  return maxTs === 0 ? fallback : String(maxTs + 0.000001);
}

function slackUserName_(userId, cache) {
  if (!userId) return '';
  if (cache[userId]) return cache[userId];
  try {
    var p = (slackCall_('users.info', { user: userId }).user) || {};
    var name = (p.profile && (p.profile.display_name || p.profile.real_name)) || p.name || userId;
    cache[userId] = name;
    return name;
  } catch (e) {
    cache[userId] = userId;   // 失敗就用 ID，不重試
    return userId;
  }
}

function slackPermalink_(ts) {
  return 'https://17media.slack.com/archives/' + SLACK_CHANNEL_ID + '/p' + String(ts).replace('.', '');
}

/**
 * 清理 Slack 標記。
 * 關鍵：**保留換行**。換行是切分訴求最可靠的訊號，v1 把它壓成空白，
 * 導致一則講三件事的訊息只被算成一件。
 */
function cleanSlackText_(t) {
  return String(t)
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!channel>|<!here>/g, '')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \n]+|[ \n]+$/g, '');
}

function tsToDate_(ts) {
  return Utilities.formatDate(new Date(parseFloat(ts) * 1000), TZ, 'yyyy/MM/dd');
}

// ===========================================================================
// 試算表擷取
// ===========================================================================

function fetchSpreadsheet_(src) {
  var tabs = SpreadsheetApp.openById(src.id).getSheets();
  var out = [];

  for (var t = 0; t < tabs.length; t++) {
    var tab = tabs[t];
    if (BOT_TABS.indexOf(tab.getName()) >= 0) continue;   // 不吃自己產生的分頁
    if (tab.isSheetHidden()) continue;

    var values;
    try { values = readTabValues_(tab, 0); } catch (e) { continue; }
    if (values.length < 2) continue;

    var hdr = findHeaderRow_(values);
    if (hdr.index < 0) continue;
    var map = mapColumns_(hdr.headers);
    if (map.bodyCols.length === 0 && map.title < 0) continue;

    for (var r = hdr.index + 1; r < values.length; r++) {
      var row = values[r];
      // 依同義字優先序找第一個「非空」的本文欄 —— 這是關鍵：
      // 有些表把「課題・背景」留白、內容全放在「提案内容」
      var body = '';
      for (var b = 0; b < map.bodyCols.length; b++) {
        body = pick_(row, map.bodyCols[b]);
        if (body) break;
      }
      var title = pick_(row, map.title);
      var content = body || title;
      if (!content || collapse_(content).length < 6) continue;

      out.push(makeMessage_({
        date: normalizeDate_(pick_(row, map.date)),
        origin: src.label,
        originDetail: tab.getName(),
        body: (title && body && title !== body) ? (title + '\n' + body) : content,
        kindHint: pick_(row, map.kind),
        owner: pick_(row, map.owner),
        status: pick_(row, map.status) || pick_(row, map.note),
        link: firstUrl_(pick_(row, map.source)) ||
              ('https://docs.google.com/spreadsheets/d/' + src.id + '/edit')
      }));
    }
  }
  return out;
}

function readTabValues_(tab, maxRows) {
  var lastRow = tab.getLastRow(), lastCol = tab.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];
  var rows = maxRows > 0 ? Math.min(maxRows, lastRow) : lastRow;
  return tab.getRange(1, 1, rows, lastCol).getDisplayValues();
}

/** 前 10 列裡找最像標題列的那一列（命中已知欄名者優先） */
function findHeaderRow_(values) {
  var best = { index: -1, headers: [], score: 0 };
  var limit = Math.min(10, values.length);
  for (var i = 0; i < limit; i++) {
    var filled = 0, hits = 0, norm = [];
    for (var c = 0; c < values[i].length; c++) {
      var v = normHeader_(values[i][c]);
      norm.push(v);
      if (v) filled++;
      if (v && matchesAnySynonym_(v)) hits++;
    }
    var score = filled + hits * 5;
    if (hits > 0 && score > best.score) best = { index: i, headers: norm, score: score };
  }
  return best;
}

function normHeader_(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesAnySynonym_(h) {
  for (var field in COLUMN_SYNONYMS) {
    var list = COLUMN_SYNONYMS[field];
    for (var i = 0; i < list.length; i++) if (h.indexOf(list[i]) >= 0) return true;
  }
  return false;
}

/**
 * 同義字「越前面優先度越高」：外層跑同義字、內層跑欄位，
 * 所以「提案内容」會贏過「課題・背景」。
 */
function mapColumns_(headers) {
  var map = { date: -1, title: -1, kind: -1, source: -1, owner: -1, status: -1, note: -1, bodyCols: [] };

  for (var field in COLUMN_SYNONYMS) {
    var syns = COLUMN_SYNONYMS[field];
    for (var s = 0; s < syns.length; s++) {
      for (var c = 0; c < headers.length; c++) {
        var h = headers[c];
        if (!h || isDerivedHeader_(h)) continue;
        if (h.indexOf(syns[s]) < 0) continue;
        if (field === 'body') {
          if (map.bodyCols.indexOf(c) < 0) map.bodyCols.push(c);
        } else if (map[field] < 0) {
          map[field] = c;
        }
      }
    }
  }
  return map;
}

/** 取欄位當「內容」用：把佔位符視為空 */
function pick_(row, idx) {
  if (idx < 0 || idx >= row.length) return '';
  var v = String(row[idx] === null || row[idx] === undefined ? '' : row[idx]).trim();
  if (v === '-' || v === '—' || v === 'FALSE' || v === 'TRUE' || v === 'N/A') return '';
  return v;
}

/** 取欄位原值：Shipped 這種 TRUE/FALSE 本身就是資料的欄位要用這個 */
function pickRaw_(row, idx) {
  if (idx < 0 || idx >= row.length) return '';
  return String(row[idx] === null || row[idx] === undefined ? '' : row[idx]).trim();
}

function firstUrl_(s) {
  var m = String(s || '').match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}

function normalizeDate_(v) {
  var s = String(v || '').trim();
  if (!s) return '';
  var m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return m[1] + '/' + pad2_(m[2]) + '/' + pad2_(m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);          // M/D/YYYY
  if (m) return m[3] + '/' + pad2_(m[1]) + '/' + pad2_(m[2]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);                    // M/D（Roadmap 常見）
  if (m) return new Date().getFullYear() + '/' + pad2_(m[1]) + '/' + pad2_(m[2]);
  m = s.match(/^(\d{1,2})月/);                              // 只有「4月」
  if (m) return new Date().getFullYear() + '/' + pad2_(m[1]) + '/01';
  return s.substring(0, 20);
}

function pad2_(n) { return ('0' + String(n)).slice(-2); }

function collapse_(s) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim(); }

// ===========================================================================
// 訊息 → 切分 → 分類
// ===========================================================================

/** 一則「原始訊息」（可能包含多個訴求） */
function makeMessage_(o) {
  var body = String(o.body || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \n]+|[ \n]+$/g, '');
  return {
    date: o.date || nowDateStr_(),
    origin: o.origin || '',
    originDetail: o.originDetail || '',
    body: body,
    kindHint: o.kindHint || '',
    owner: o.owner || '',
    status: o.status || '',
    link: o.link || '',
    parentHash: md5short_(normalizeForHash_(body))
  };
}

/**
 * 把一則訊息切成獨立訴求。
 * 順序：明確的條列／編號 → 行 → 過長的行再依句尾切 → 太短的相鄰句黏回去。
 * 這是 v1 精度不足的主因：v1 一則訊息只算一筆，講三件事也只計一次。
 */
function segment_(text) {
  var t = String(text || '');
  // 行內的「1. 」「2) 」「・」等條列符號前面補換行，讓同一行的多個訴求分開
  t = t.replace(/([^\n])[ ]+(?=(?:\d{1,2}[\.\)][ ]|[・●○▪][ ]?))/g, '$1\n');

  var lines = t.split('\n');
  var chunks = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^[ ]*(?:\d{1,2}[\.\)]|[・●○▪\-\*])[ ]*/, '').trim();
    if (!line) continue;
    if (line.length <= SEG_MAX_LEN) {
      // 換行與條列符號是「作者自己標出來的邊界」→ 自成一筆，絕不跟別行黏合。
      // （早期版本無條件黏合短片段，會把「1. 2. 3.」三個訴求併成一筆而少算件數）
      chunks.push(line);
    } else {
      // 只有「同一行內」被句尾切開的碎片才允許黏回去，避免把一句話切成碎片
      var glued = glue_(splitSentences_(line));
      for (var g = 0; g < glued.length; g++) chunks.push(glued[g]);
    }
  }

  var out = [];
  for (var c = 0; c < chunks.length; c++) {
    var s = collapse_(chunks[c]);
    if (s.length < SEG_MIN_LEN) continue;
    if (isNoise_(s)) continue;
    out.push(s);
    if (out.length >= SEG_MAX_PER_MESSAGE) break;
  }
  // 全部被濾掉但原文有實質內容 → 保留整段，寧可讓人判斷也不要靜默丟掉
  if (out.length === 0) {
    var whole = collapse_(text);
    if (whole.length >= SEG_MIN_LEN && !isNoise_(whole)) out.push(whole.substring(0, 1000));
  }
  return out;
}

/** 依句尾符號切句；沒有句尾符號的長句才硬切（保留原文欄可稽核） */
function splitSentences_(s) {
  var out = [], buf = '';
  var enders = '。！？!?';
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    buf += ch;
    if (enders.indexOf(ch) >= 0) { out.push(buf); buf = ''; }
    else if (buf.length >= SEG_MAX_LEN * 2) { out.push(buf); buf = ''; }
  }
  if (buf.replace(/\s/g, '')) out.push(buf);
  return out;
}

/** 把過短的相鄰句黏成一個完整訴求（避免把一句抱怨切成碎片） */
function glue_(chunks) {
  var out = [], buf = '';
  for (var i = 0; i < chunks.length; i++) {
    var c = String(chunks[i]).trim();
    if (!c) continue;
    if (!buf) { buf = c; }
    else if (buf.length < 40 && (buf.length + c.length) <= SEG_MAX_LEN) { buf = buf + ' ' + c; }
    else { out.push(buf); buf = c; }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 整段扣掉寒暄後幾乎沒東西 → 雜訊。
 * 注意：只剝掉標點/數字/空白，**不能剝英文字母** ——
 * 4 份表單裡有純英文的聲音，剝掉字母會讓它們全被誤判成雜訊。
 */
function isNoise_(s) {
  var t = String(s).toLowerCase();
  for (var i = 0; i < NOISE_PHRASES.length; i++) {
    t = t.split(NOISE_PHRASES[i].toLowerCase()).join('');
  }
  t = t.replace(/https?:\/\/\S+/g, '')
       .replace(/@\S+/g, '')
       .replace(/[\s、。，．,.!！?？「」『』（）()\[\]【】~〜ー・:：;；'"<>+\-*\/=|#0-9]/g, '');
  return t.length < 6;
}

function normalizeForHash_(text) {
  return String(text).toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[、。，．,.!！?？「」『』（）()\[\]【】~〜ー・:：;；'"<>]/g, '')
    .substring(0, 400);
}

function md5short_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < 8; i++) out += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  return out;
}

/** 純 ASCII 關鍵字要求邊界，避免 "bc" 命中 "abcd"、"dm" 命中 "admin" */
function kwHit_(hay, kw) {
  if (/^[a-z0-9 .+]+$/.test(kw)) {
    var esc = kw.replace(/[.+]/g, function (ch) { return '\\' + ch; });
    return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)').test(hay);
  }
  return hay.indexOf(kw) >= 0;
}

function canonicalize_(s) {
  var out = String(s).toLowerCase();
  for (var i = 0; i < CANON.length; i++) {
    out = out.split(CANON[i][0]).join(CANON[i][1]);
  }
  return out;
}

/** 產生輔助標籤：テーマ／種類／推定領域。不再決定計數分群。 */
function classifySegment_(seg, kindHint, originDetail) {
  var hay = canonicalize_(seg + ' ' + kindHint + ' ' + originDetail);

  var theme = 'その他 / Other';
  var area = '';
  var bestScore = 0;
  for (var i = 0; i < THEMES.length; i++) {
    var hits = 0, matchedLen = 0;
    for (var k = 0; k < THEMES[i].kw.length; k++) {
      if (kwHit_(hay, THEMES[i].kw[k])) { hits++; matchedLen += THEMES[i].kw[k].length; }
    }
    var score = matchedLen * 10 + hits;
    if (score > bestScore) { bestScore = score; theme = THEMES[i].name; area = THEMES[i].area; }
  }

  var kind = '';
  var known = ['バグ', '不満', '提案', '要望', '質問', '意見', '通報'];
  for (var q = 0; q < known.length; q++) {
    if (String(kindHint).indexOf(known[q]) >= 0) { kind = known[q]; break; }
  }
  if (!kind) {
    for (var j = 0; j < KIND_RULES.length && !kind; j++) {
      for (var m = 0; m < KIND_RULES[j].kw.length; m++) {
        if (kwHit_(hay, KIND_RULES[j].kw[m])) { kind = KIND_RULES[j].key; break; }
      }
    }
  }
  if (!kind) kind = 'その他';

  return { theme: theme, kind: kind, area: area };
}

// ===========================================================================
// 寫入 Raw_Log（訊息層級去重 + 切分成多列）
// ===========================================================================

/**
 * 去重是「訊息層級」：同一則訊息只會被切分一次，之後永遠跳過。
 * 這樣即使日後調整切分規則，也不會把舊訊息重新切一遍造成重複計數。
 *
 * 相容 v1 資料：v1 的 ハッシュ 就是「整段本文的雜湊」，等同 v2 的 親ハッシュ，
 * 所以 v1 舊列（ハッシュ 不含 '-'）直接當成 親ハッシュ 收進 seen。
 */
function appendRawLog_(ss, messages) {
  var sh = ss.getSheetByName(TAB_RAW);
  var seenParent = {};
  var last = sh.getLastRow();
  if (last > 1) {
    var old = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < old.length; i++) {
      var h = String(old[i][0]);
      var p = String(old[i][1]);
      if (!h) continue;
      if (h.indexOf('-') >= 0) { if (p) seenParent[p] = true; }
      else { seenParent[h] = true; }          // v1 遺留列
    }
  }

  var rows = [], batch = {};
  var ts = nowStr_();
  var newMessages = 0, noiseCount = 0;

  for (var m = 0; m < messages.length; m++) {
    var msg = messages[m];
    if (!msg.parentHash || seenParent[msg.parentHash] || batch[msg.parentHash]) continue;
    batch[msg.parentHash] = true;
    newMessages++;

    var segs = segment_(msg.body);
    if (segs.length === 0) { noiseCount++; continue; }

    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      var tag = classifySegment_(seg, msg.kindHint, msg.originDetail);
      rows.push([
        msg.parentHash + '-' + pad2_(s + 1),
        msg.parentHash,
        ts,
        msg.date,
        msg.origin,
        msg.originDetail,
        tag.kind,
        tag.theme,
        seg.length > 90 ? seg.substring(0, 88) + '…' : seg,
        seg.substring(0, 4000),
        msg.owner,
        msg.status,
        msg.link,
        V_PENDING, '', '', '', '',
        (s + 1) + '/' + segs.length,
        msg.body.substring(0, 2000)
      ]);
    }
  }

  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, RAW_HEADERS.length).setValues(rows);
  }
  return { newMessages: newMessages, segments: rows.length, noise: noiseCount };
}

// ===========================================================================
// 比對 VoC Roadmap
// ===========================================================================

/**
 * 找出 Raw_Log 裡所有還沒判定的列（含上次逾時留下的），比對後回填第 14〜18 欄。
 * 自我修復：這次沒做完的下次會自動接續，不會有聲音永久卡在未判定。
 */
function matchPending_(ss, roadmap, started) {
  var sh = ss.getSheetByName(TAB_RAW);
  var last = sh.getLastRow();
  var result = { matched: 0, newCand: 0, pending: 0, truncated: false,
                 mode: ANTHROPIC_API_KEY ? 'Claude 語意比對' : '規則式(無 API key)',
                 newlyDecided: {} };
  if (last < 2) return result;

  var all = sh.getRange(2, 1, last - 1, RAW_HEADERS.length).getValues();
  var pendingIdx = [];
  for (var i = 0; i < all.length; i++) {
    var v = String(all[i][RAW_COL_VERDICT - 1]).trim();
    if (!v || v === V_PENDING) pendingIdx.push(i);
  }
  result.pending = pendingIdx.length;
  if (pendingIdx.length === 0) return result;

  var candidates = loadCandidates_(ss);
  var decisions = {};   // rowIndex → [判定, code, 論点, conf, 根拠]

  if (!ANTHROPIC_API_KEY) {
    for (var r = 0; r < pendingIdx.length; r++) {
      var ri = pendingIdx[r];
      var rm = ruleMatch_(String(all[ri][9]), roadmap);
      if (rm) {
        decisions[ri] = [V_RULE, rm.code, roadmap.byCode[rm.code].title, rm.conf,
                         '規則式命中：' + rm.why];
      } else {
        decisions[ri] = [V_PENDING, '', '', '',
                         '規則式無法判定。填入 ANTHROPIC_API_KEY 可大幅提升命中率。'];
      }
    }
  } else {
    var batches = 0;
    for (var b = 0; b < pendingIdx.length; b += MATCH_BATCH_SIZE) {
      if (batches >= MATCH_MAX_BATCHES || outOfTime_(started)) { result.truncated = true; break; }
      batches++;
      var slice = pendingIdx.slice(b, b + MATCH_BATCH_SIZE);
      var items = [];
      for (var k = 0; k < slice.length; k++) {
        items.push({
          i: k,
          text: String(all[slice[k]][9]).substring(0, 400),
          origin: String(all[slice[k]][4]),
          date: toYmd_(all[slice[k]][3])
        });
      }
      var got;
      try {
        got = claudeMatchBatch_(items, roadmap, candidates);
      } catch (e) {
        logRow_(ss, 'MATCH', 'WARN', '第 ' + batches + ' 批比對失敗，留待下次重試：' + e.message);
        continue;
      }
      for (var g = 0; g < got.length; g++) {
        var d = got[g];
        if (d.i < 0 || d.i >= slice.length) continue;
        var ri2 = slice[d.i];
        if (d.code && roadmap.byCode[d.code]) {
          var verdict = d.conf >= MATCH_ACCEPT_CONF ? V_MATCH
                      : (d.conf >= MATCH_REVIEW_CONF ? V_MATCH_REVIEW : null);
          if (verdict) {
            decisions[ri2] = [verdict, d.code, roadmap.byCode[d.code].title, d.conf, d.why];
            continue;
          }
        }
        if (d.code && candidates.byId[d.code]) {
          decisions[ri2] = [V_NEW, d.code, candidates.byId[d.code].titleJp, d.conf, d.why];
          continue;
        }
        if (d.isNoise) {
          decisions[ri2] = [V_NOISE, '', '', d.conf, d.why || '実質的な訴求なしと判定'];
          continue;
        }
        if (d.newTitleJp) {
          var cid = registerCandidate_(candidates, d.newTitleJp, d.newTitleEn, d.area, d.priority);
          decisions[ri2] = [V_NEW, cid, candidates.byId[cid].titleJp, d.conf, d.why];
          continue;
        }
        decisions[ri2] = [V_PENDING, '', '', d.conf, d.why || '判定できず（次回再試行）'];
      }
    }
  }

  // 回填第 14〜18 欄（一次寫整塊，避免逐列 setValue 太慢）
  var block = [];
  for (var q = 0; q < all.length; q++) {
    if (decisions[q]) {
      var dd = decisions[q];
      block.push([dd[0], dd[1], String(dd[2]).substring(0, 300), dd[3], String(dd[4]).substring(0, 500)]);
    } else {
      block.push([all[q][13], all[q][14], all[q][15], all[q][16], all[q][17]]);
    }
  }
  sh.getRange(2, RAW_COL_VERDICT, block.length, RAW_VERDICT_WIDTH).setValues(block);

  var noiseCount = 0;
  for (var z in decisions) {
    var v2 = decisions[z][0];
    if (v2 === V_MATCH || v2 === V_MATCH_REVIEW || v2 === V_RULE || v2 === V_NEW) {
      result.newlyDecided[decisions[z][1]] = (result.newlyDecided[decisions[z][1]] || 0) + 1;
      if (v2 === V_NEW) result.newCand++; else result.matched++;
    } else if (v2 === V_NOISE) {
      noiseCount++;
    }
  }
  // 雜訊也算「已判定」，否則未判定數會被高估
  result.pending = pendingIdx.length - result.matched - result.newCand - noiseCount;
  saveCandidateSeeds_(ss, candidates);
  return result;
}

/** 降級模式：別名表 + 標題字面比對。跨語言精度有限，判定欄會標「規則式(精度低)」。 */
function ruleMatch_(seg, roadmap) {
  var hay = canonicalize_(seg);
  var best = null;

  for (var i = 0; i < roadmap.items.length; i++) {
    var it = roadmap.items[i];
    var score = 0, why = [];

    var aliases = PAIN_POINT_ALIASES[it.code] || [];
    for (var a = 0; a < aliases.length; a++) {
      if (kwHit_(hay, canonicalize_(aliases[a]))) { score += aliases[a].length * 3; why.push(aliases[a]); }
    }
    // 標題裡的英文長字（4 字以上）也當關鍵字，讓英文原文的聲音有機會命中
    var words = String(it.title).toLowerCase().match(/[a-z]{4,}/g) || [];
    for (var w = 0; w < words.length; w++) {
      if (['with', 'from', 'that', 'this', 'their', 'when', 'want', 'wants', 'cannot',
           'user', 'users', 'make', 'more', 'allow', 'still', 'like', 'have'].indexOf(words[w]) >= 0) continue;
      if (kwHit_(hay, words[w])) { score += words[w].length; why.push(words[w]); }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { code: it.code, score: score, why: why.join('/') };
    }
  }
  if (!best || best.score < 12) return null;
  return { code: best.code, conf: Math.min(0.59, 0.3 + best.score / 100), why: best.why };
}

/** 把一批聲音交給 Claude 對到既有痛點／既有候選／全新 */
function claudeMatchBatch_(items, roadmap, candidates) {
  var lines = [];
  for (var i = 0; i < roadmap.items.length; i++) {
    var it = roadmap.items[i];
    lines.push('  ' + it.code + ' | ' + it.title +
      (it.area ? ' | 領域:' + it.area : '') + (it.priority ? ' | ' + it.priority : ''));
  }
  var candLines = [];
  for (var c = 0; c < candidates.list.length; c++) {
    candLines.push('  ' + candidates.list[c].id + ' | ' + candidates.list[c].titleJp);
  }
  var voices = [];
  for (var v = 0; v < items.length; v++) {
    voices.push(items[v].i + ' :: [' + items[v].origin + ' ' + items[v].date + '] ' + items[v].text);
  }

  var prompt =
    'あなたは 17LIVE の JP プロダクト運営アシスタントです。\n' +
    'ユーザー／ライバーの生の声を、既存の VoC 痛点リストに突き合わせる作業をしてください。\n\n' +
    '【A: 公式 VoC 痛点リスト（英語表記）】\n' + lines.join('\n') + '\n\n' +
    (candLines.length
      ? '【B: 追加検討中の候補（まだ VoC 未登録）】\n' + candLines.join('\n') + '\n\n'
      : '【B: 追加検討中の候補】まだ無し\n\n') +
    '【C: 判定対象の声（日本語・各行の先頭は連番）】\n' + voices.join('\n') + '\n\n' +
    '各声について次を判定してください。声は日本語・中国語・英語が混在し、リストは英語なので、意味で照合すること。\n' +
    '次の優先順で判定する（上から順に検討し、当てはまった時点で確定）：\n' +
    '1. A に同じ痛点があれば、その code を返す\n' +
    '2. A に無く B に同じ痛点があれば、その CAND-xxx を返す（表現が違っても中身が同じなら必ず B を使う）\n' +
    '3. 実質的な訴求が無ければ noise=true\n' +
    '4. 上のどれでもない場合に限り、code を null にして new_title_jp / new_title_en を提案する\n\n' +
    '重要な原則：\n' +
    '- 表面的な単語の一致ではなく「ユーザーが困っている中身」で判断する\n' +
    '- 同じ機能の話でも困りごとが別なら別の痛点として扱う\n' +
    '- 迷ったら conf を低くする。無理に既存へ寄せないこと\n' +
    '- **新規作成は最後の手段**。B に少しでも近い候補があれば新規を作らず B を選ぶ。\n' +
    '  同じ痛点に毎回違う名前が付くと件数が分散し、集計が意味を失う\n' +
    '- **痛点でないものを新規にしない。** 次はすべて noise=true：\n' +
    '    ・称賛や満足の声（「便利です」「助かりました」など、改善要求を含まないもの）\n' +
    '    ・事実の共有・報告のみで要望や困りごとを含まないもの\n' +
    '    ・社内の連絡事項、議事メモの見出し、日程調整\n' +
    '    ・質問への回答や「対応しました」といった処理済みの記録\n' +
    '- new_title_jp は 30 文字以内、**困りごととして読める**書き方にする\n' +
    '    良い例「月跨ぎでギフトボードが確認できない」（何に困っているか分かる）\n' +
    '    悪い例「非公開で相談できる機能への評価」（評価であって痛点ではない）\n' +
    '- area は次から選ぶ: U2 Watch / Return, U4 Gifting / Spend, U5 Recognition / Status, ' +
    'U6 Event / Compete, S2 Broadcast / Ops, Z Strategy\n\n' +
    '次の JSON のみを返すこと。前後に説明やコードフェンスを付けない。\n' +
    '{"results":[{"i":0,"code":"S2.0","conf":0.9,"why":"理由を20字以内","noise":false,' +
    '"new_title_jp":"","new_title_en":"","area":"","priority":"P2"}]}\n' +
    'conf は 0〜1。すべての声について 1 件ずつ、i を必ず付けて返すこと。';

  var raw = callClaude_(prompt, ANTHROPIC_MATCH_MODEL, 12000, 'low');
  var parsed = parseJsonLoose_(raw);
  var arr = parsed && parsed.results ? parsed.results : (parsed && parsed.length ? parsed : null);
  if (!arr || !arr.length) throw new Error('比對回應無法解析：' + String(raw).substring(0, 200));

  var out = [];
  for (var k = 0; k < arr.length; k++) {
    var r = arr[k] || {};
    var conf = Number(r.conf);
    if (isNaN(conf) || conf < 0) conf = 0;
    if (conf > 1) conf = 1;
    out.push({
      i: Number(r.i),
      code: r.code ? String(r.code).trim() : '',
      conf: conf,
      why: String(r.why || '').substring(0, 200),
      isNoise: r.noise === true,
      newTitleJp: collapse_(r.new_title_jp || '').substring(0, 60),
      newTitleEn: collapse_(r.new_title_en || '').substring(0, 120),
      area: collapse_(r.area || ''),
      priority: collapse_(r.priority || '')
    });
  }
  return out;
}

// ===========================================================================
// 新痛點候選（維持跨日穩定的 CAND-xxx 編號）
// ===========================================================================

function loadCandidates_(ss) {
  var sh = ss.getSheetByName(TAB_NEW);
  var box = { list: [], byId: {}, bySlug: {}, maxNum: 0, dirty: false };
  var last = sh.getLastRow();
  if (last < 2) return box;
  var vals = sh.getRange(2, 1, last - 1, NEW_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    var id = collapse_(vals[i][0]);
    var jp = collapse_(vals[i][1]);
    if (!id || !jp) continue;
    var item = { id: id, titleJp: jp, titleEn: collapse_(vals[i][2]),
                 area: collapse_(vals[i][3]), priority: collapse_(vals[i][4]) };
    box.list.push(item);
    box.byId[id] = item;
    box.bySlug[candSlug_(jp)] = item;
    var m = id.match(/CAND-(\d+)/);
    if (m && Number(m[1]) > box.maxNum) box.maxNum = Number(m[1]);
  }
  return box;
}

function candSlug_(titleJp) { return md5short_(normalizeForHash_(titleJp)); }

function registerCandidate_(box, titleJp, titleEn, area, priority) {
  var slug = candSlug_(titleJp);
  if (box.bySlug[slug]) return box.bySlug[slug].id;
  box.maxNum++;
  var id = 'CAND-' + ('00' + box.maxNum).slice(-3);
  var item = { id: id, titleJp: titleJp, titleEn: titleEn,
               area: area, priority: priority || 'P2' };
  box.list.push(item);
  box.byId[id] = item;
  box.bySlug[slug] = item;
  box.dirty = true;
  return id;
}

/**
 * 先把新產生的候選「種子列」寫進 VoC_New_Candidates，
 * 這樣即使後面彙總步驟失敗，候選 ID 也不會在下次執行被重新發號。
 */
function saveCandidateSeeds_(ss, box) {
  if (!box.dirty) return;
  var sh = ss.getSheetByName(TAB_NEW);
  var existing = {};
  var last = sh.getLastRow();
  if (last > 1) {
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) existing[collapse_(ids[i][0])] = true;
  }
  var rows = [];
  for (var c = 0; c < box.list.length; c++) {
    var it = box.list[c];
    if (existing[it.id]) continue;
    rows.push([it.id, it.titleJp, it.titleEn, it.area, it.priority,
               0, 0, 0, 0, 0, '', '', '', '', '', '']);
  }
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, NEW_BOT_COLS).setValues(rows);
  }
}

// ===========================================================================
// 彙總：VoC_Pain_Points + VoC_New_Candidates
// ===========================================================================

function rebuildAggregates_(ss, roadmap, newlyDecided) {
  var raw = ss.getSheetByName(TAB_RAW);
  var last = raw.getLastRow();
  var agg = {};   // code → 統計
  var pendingCount = 0;

  if (last >= 2) {
    var vals = raw.getRange(2, 1, last - 1, RAW_HEADERS.length).getValues();
    var cutoff = new Date().getTime() - RECENT_DAYS * 86400000;
    for (var i = 0; i < vals.length; i++) {
      var verdict = String(vals[i][13]).trim();
      if (verdict === V_PENDING || !verdict) { pendingCount++; continue; }
      if (verdict === V_NOISE) continue;
      var code = collapse_(vals[i][14]);
      if (!code) continue;

      var d = toYmd_(vals[i][3]);   // 儲存格可能是 Date 型別，必須正規化
      var dt = parseYmd_(d);
      if (!agg[code]) {
        agg[code] = { total: 0, recent: 0, first: d, last: d, firstTime: dt, lastTime: dt,
                      origins: {}, rep: collapse_(vals[i][8]), latest: collapse_(vals[i][8]),
                      latestLink: String(vals[i][12]), review: 0 };
      }
      var b = agg[code];
      b.total++;
      if (dt && dt >= cutoff) b.recent++;
      if (verdict === V_MATCH_REVIEW || verdict === V_RULE) b.review++;
      if (dt && (!b.firstTime || dt < b.firstTime)) { b.firstTime = dt; b.first = d; }
      if (dt && (!b.lastTime || dt >= b.lastTime)) {
        b.lastTime = dt; b.last = d;
        b.latest = collapse_(vals[i][8]);
        b.latestLink = String(vals[i][12]);
      }
      b.origins[String(vals[i][4])] = true;
    }
  }

  var pp = writePainPoints_(ss, roadmap, agg, newlyDecided);
  var cand = writeCandidates_(ss, agg, newlyDecided);
  return { pp: pp, cand: cand, pending: pendingCount };
}

function writePainPoints_(ss, roadmap, agg, newlyDecided) {
  var sh = ss.getSheetByName(TAB_PP);
  var prev = {}, manual = {};
  var last = sh.getLastRow();
  if (last > 1) {
    var old = sh.getRange(2, 1, last - 1, PP_HEADERS.length).getValues();
    for (var i = 0; i < old.length; i++) {
      var k = collapse_(old[i][0]);
      if (!k) continue;
      prev[k] = Number(old[i][6]) || 0;
      manual[k] = [old[i][18], old[i][19]];
    }
  }

  var rows = [];
  for (var r = 0; r < roadmap.items.length; r++) {
    var it = roadmap.items[r];
    var a = agg[it.code] || { total: 0, recent: 0, first: '', last: '', origins: {},
                              rep: '', latest: '', latestLink: '' };
    var origins = [];
    for (var o in a.origins) if (o) origins.push(o);
    var before = prev[it.code] === undefined ? 0 : prev[it.code];
    rows.push({
      resolved: it.resolved,
      prank: priorityRank_(it.priority),
      delta: a.total - before,
      recent: a.recent,
      data: [it.code, it.title, it.area, it.priority, it.status,
             it.resolved ? '' : '未解決', a.total, a.recent,
             newlyDecided[it.code] || 0, before, a.total - before,
             a.first, a.last, origins.join(', '), it.requests,
             a.rep, a.latest, a.latestLink]
    });
  }

  // 未解決優先 → 本次增加多的優先 → 優先度高的優先 → 直近熱度
  rows.sort(function (x, y) {
    if (x.resolved !== y.resolved) return x.resolved ? 1 : -1;
    if (y.delta !== x.delta) return y.delta - x.delta;
    if (x.prank !== y.prank) return x.prank - y.prank;
    return y.recent - x.recent;
  });

  if (last > 1) sh.getRange(2, 1, last - 1, PP_HEADERS.length).clearContent();
  if (rows.length) {
    var full = [];
    for (var f = 0; f < rows.length; f++) {
      var man = manual[rows[f].data[0]] || ['', ''];
      full.push(rows[f].data.concat([man[0], man[1]]));
    }
    sh.getRange(2, 1, full.length, PP_HEADERS.length).setValues(full);
  }
  return rows;
}

function writeCandidates_(ss, agg, newlyDecided) {
  var sh = ss.getSheetByName(TAB_NEW);
  var box = loadCandidates_(ss);
  var prev = {}, manual = {};
  var last = sh.getLastRow();
  if (last > 1) {
    var old = sh.getRange(2, 1, last - 1, NEW_HEADERS.length).getValues();
    for (var i = 0; i < old.length; i++) {
      var k = collapse_(old[i][0]);
      if (!k) continue;
      prev[k] = Number(old[i][5]) || 0;
      manual[k] = [old[i][16], old[i][17]];
    }
  }

  var rows = [];
  for (var c = 0; c < box.list.length; c++) {
    var it = box.list[c];
    var a = agg[it.id] || { total: 0, recent: 0, first: '', last: '', origins: {},
                            rep: '', latest: '', latestLink: '' };
    var origins = [];
    for (var o in a.origins) if (o) origins.push(o);
    var before = prev[it.id] === undefined ? 0 : prev[it.id];
    rows.push({
      total: a.total,
      delta: a.total - before,
      data: [it.id, it.titleJp, it.titleEn, it.area, it.priority,
             a.total, a.recent, newlyDecided[it.id] || 0, before, a.total - before,
             a.first, a.last, origins.join(', '), a.rep, a.latest, a.latestLink]
    });
  }

  rows.sort(function (x, y) {
    if (y.delta !== x.delta) return y.delta - x.delta;
    return y.total - x.total;
  });

  if (last > 1) sh.getRange(2, 1, last - 1, NEW_HEADERS.length).clearContent();
  if (rows.length) {
    var full = [];
    for (var f = 0; f < rows.length; f++) {
      var man = manual[rows[f].data[0]] || ['', ''];
      full.push(rows[f].data.concat([man[0], man[1]]));
    }
    sh.getRange(2, 1, full.length, NEW_HEADERS.length).setValues(full);
  }
  return rows;
}

// ===========================================================================
// 今日摘要 —— 你每天只需要看這個
// ===========================================================================

function buildBrief_(ss, stats, ingest, match, problems) {
  var lines = [];

  var rising = [];
  for (var i = 0; i < stats.pp.length; i++) {
    if (!stats.pp[i].resolved && stats.pp[i].delta > 0) rising.push(stats.pp[i]);
  }
  var newCand = [];
  for (var j = 0; j < stats.cand.length; j++) {
    if (stats.cand[j].total > 0) newCand.push(stats.cand[j]);
  }

  lines.push('取込 ' + ingest.newMessages + ' 件 → 訴求に分割 ' + ingest.segments +
             ' 件（雑音除外 ' + ingest.noise + ' 件）／比対 ' + match.mode);
  lines.push('');

  lines.push('■ 既存 VoC の再燃（未解決・件数が増えたもの）: ' + rising.length + ' 件');
  if (rising.length === 0) {
    lines.push('  今回の増加はありません。');
  } else {
    for (var r = 0; r < Math.min(8, rising.length); r++) {
      var p = rising[r].data;
      lines.push('  ' + (r + 1) + '. [' + p[0] + '／' + (p[3] || '-') + '／' + (p[4] || '-') + '] ' + p[1]);
      lines.push('     累計 ' + p[6] + ' 件（今回 +' + rising[r].delta + '、直近' + RECENT_DAYS +
                 '日 ' + p[7] + ' 件）← 未解決のまま');
      if (p[16]) lines.push('     最新の声: ' + String(p[16]).substring(0, 100));
      if (p[17]) lines.push('     ' + p[17]);
    }
    if (rising.length > 8) lines.push('  …ほか ' + (rising.length - 8) + ' 件（VoC_Pain_Points 参照）');
  }
  lines.push('');

  lines.push('■ VoC 未登録の新しい痛点（追加を推奨）: ' + newCand.length + ' 件');
  if (newCand.length === 0) {
    lines.push('  新しい痛点は見つかりませんでした。');
  } else {
    for (var n = 0; n < Math.min(8, newCand.length); n++) {
      var c = newCand[n].data;
      lines.push('  ' + (n + 1) + '. 【新規】' + c[1] + (c[2] ? '（' + c[2] + '）' : ''));
      lines.push('     ' + c[0] + '／累計 ' + c[5] + ' 件（今回 +' + c[7] + '）／初出 ' + c[10] +
                 '／出所 ' + (c[12] || '-'));
      if (c[13]) lines.push('     代表的な声: ' + String(c[13]).substring(0, 100));
      lines.push('     → 推奨: 領域 ' + (c[3] || '未定') + '／' + (c[4] || 'P2') + ' として VoC に追加');
      if (c[15]) lines.push('     ' + c[15]);
    }
    if (newCand.length > 8) lines.push('  …ほか ' + (newCand.length - 8) + ' 件（VoC_New_Candidates 参照）');
  }
  lines.push('');

  if (stats.pending > 0) {
    lines.push('■ 判定できなかった声: ' + stats.pending + ' 件（次回実行で自動再試行）');
  }
  if (!ANTHROPIC_API_KEY) {
    lines.push('■ 注意: ANTHROPIC_API_KEY 未設定のため規則式で比対しています。' +
               '日本語の声を英語の痛点リストへ突き合わせる精度は低めです。');
  }
  if (problems.length) lines.push('■ 警告: ' + problems.join(' / '));

  var body = lines.join('\n');
  var headline = rising.length === 0 && newCand.length === 0
    ? '新しい動きなし'
    : ('再燃 ' + rising.length + ' 件／新規 ' + newCand.length + ' 件');

  if (ANTHROPIC_API_KEY && (rising.length > 0 || newCand.length > 0)) {
    try {
      var ai = summarizeWithClaude_(rising, newCand);
      if (ai && ai.text) {
        if (ai.headline) headline = ai.headline;
        body = ai.text + '\n\n――――― 以下は自動集計 ―――――\n' + body;
      }
    } catch (e) {
      logRow_(ss, 'CLAUDE', 'WARN', 'AI 摘要失敗，改用規則式：' + e.message);
    }
  }

  return { date: nowStr_(), headline: headline, body: body };
}

/** 最新的放最上面（插在第 2 列） */
function prependBrief_(ss, brief) {
  var sh = ss.getSheetByName(TAB_BRIEF);
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 3).setValues([[brief.date, brief.headline, brief.body]])
    .setVerticalAlignment('top').setWrap(true);
  sh.setColumnWidth(1, 140);
  sh.setColumnWidth(2, 240);
  sh.setColumnWidth(3, 900);
}

// ===========================================================================
// Claude
// ===========================================================================

function summarizeWithClaude_(rising, newCand) {
  var a = [];
  for (var i = 0; i < Math.min(rising.length, 12); i++) {
    var p = rising[i].data;
    a.push('- [' + p[0] + '／' + p[3] + '／状態:' + p[4] + '] ' + p[1] +
           ' — 累計' + p[6] + '件(今回+' + rising[i].delta + ')／最新の声「' +
           String(p[16]).substring(0, 120) + '」');
  }
  var b = [];
  for (var j = 0; j < Math.min(newCand.length, 12); j++) {
    var c = newCand[j].data;
    b.push('- ' + c[1] + ' — ' + c[5] + '件／代表的な声「' + String(c[13]).substring(0, 120) + '」');
  }

  var prompt =
    'あなたは 17LIVE の JP プロダクト運営を支える分析アシスタントです。\n' +
    'COO が PM と議論するための要約を作ってください。\n\n' +
    '【未解決のまま件数が増えた既存 VoC 痛点】\n' + (a.length ? a.join('\n') : '（なし）') + '\n\n' +
    '【VoC 未登録の新しい痛点候補】\n' + (b.length ? b.join('\n') : '（なし）') + '\n\n' +
    '次の JSON だけを返してください。前後に説明文やコードフェンスを付けないこと。\n' +
    '{"headline":"20文字以内の見出し","text":"本文"}\n\n' +
    '本文の構成：\n' +
    '1. 今日の要点を3行以内\n' +
    '2. 「未解決なのに声が増えている痛点」を重要な順に最大3件。' +
    '各件は「なぜ放置が効いてくるか／PM への具体的な問い」の2点セット\n' +
    '3. 「VoC に追加すべき新しい痛点」を最大3件。各件は「なぜ独立した痛点なのか」を一言\n' +
    '日本語で簡潔に。与えられた情報に無い数字や事実を作らないこと。';

  var parsed = parseJsonLoose_(callClaude_(prompt, ANTHROPIC_BRIEF_MODEL, 16000, 'medium'));
  if (parsed && parsed.text) return parsed;
  return null;
}

/**
 * 呼叫 Claude。
 * 重要：Opus 5 / Sonnet 5 的思考（thinking）預設是開啟的，而 max_tokens 是
 * 「思考 + 回答」的總上限。所以 max_tokens 必須給足餘裕，否則回答會被思考
 * 吃掉額度而中途截斷（會被下面的 max_tokens 檢查擋下並留待下次重試）。
 * 另外不可傳 temperature / top_p / top_k，這些參數在 5 系列會直接 400。
 */
function callClaude_(prompt, model, maxTokens, effort) {
  var payload = {
    model: model || ANTHROPIC_BRIEF_MODEL,
    max_tokens: maxTokens || 12000,
    output_config: { effort: effort || 'medium' },
    messages: [{ role: 'user', content: prompt }]
  };
  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  var url = 'https://api.anthropic.com/v1/messages';

  var res;
  try { res = UrlFetchApp.fetch(url, opts); }
  catch (e) { throw new Error('網路錯誤：' + e.message); }

  var code = res.getResponseCode();
  if (code === 429 || code >= 500) {            // 暫時性錯誤 → 重試一次
    Utilities.sleep(5000);
    try { res = UrlFetchApp.fetch(url, opts); code = res.getResponseCode(); }
    catch (e2) { throw new Error('重試仍失敗：' + e2.message); }
  }
  if (code !== 200) throw new Error('HTTP ' + code + '：' + res.getContentText().substring(0, 300));

  var body = safeJson_(res.getContentText());
  if (!body) throw new Error('回應無法解析為 JSON');
  if (body.stop_reason === 'refusal') throw new Error('模型拒絕回應此內容');
  if (body.stop_reason === 'max_tokens') throw new Error('回應被 max_tokens 截斷，內容不完整');

  // thinking 區塊可能排在前面，逆序找最後一個 text 區塊
  var blocks = body.content || [];
  for (var i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text' && blocks[i].text) return blocks[i].text;
  }
  throw new Error('回應中沒有文字內容');
}

// ===========================================================================
// 小工具
// ===========================================================================

function safeJson_(t) { try { return JSON.parse(t); } catch (e) { return null; } }

/** JSON 解析 4 層 fallback（物件與陣列都支援） */
function parseJsonLoose_(text) {
  var s = String(text || '').trim();
  var v = safeJson_(s);
  if (v) return v;

  var stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  v = safeJson_(stripped);
  if (v) return v;

  var m = stripped.match(/\{[\s\S]*\}/);
  if (m) { v = safeJson_(m[0]); if (v) return v; }
  m = stripped.match(/\[[\s\S]*\]/);
  if (m) { v = safeJson_(m[0]); if (v) return v; }

  var h = s.match(/"headline"\s*:\s*"([^"]*)"/);
  var t = s.match(/"text"\s*:\s*"([\s\S]*?)"\s*\}/);
  if (h || t) {
    return { headline: h ? h[1] : '', text: t ? t[1].replace(/\\n/g, '\n') : s };
  }
  return null;
}

function parseYmd_(s) {
  var m = String(s).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * 把儲存格讀回來的「日期」正規化成 yyyy/MM/dd。
 *
 * 為什麼需要這個：我們寫進去的是字串 '2025/10/09'，但 Google Sheets 會自動
 * 把它辨識成日期型別；用 getValues() 讀回來就變成 Date 物件，String() 之後
 * 是 'Thu Oct 09 2025 01:00:00 GMT+0900'。parseYmd_ 比對不到 → 直近N日
 * 永遠算成 0，摘要的初出日也會印出那串英文。
 */
function toYmd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy/MM/dd');
  return normalizeDate_(String(v === null || v === undefined ? '' : v));
}

function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm'); }
function nowDateStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'); }
