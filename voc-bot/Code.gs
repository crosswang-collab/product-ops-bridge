/**
 * VoC Daily Bot — 每天固定時間彙整 Slack + 各表單的用戶需求，寫回 VIP Feedback Sharing Sheet
 *
 * 部署方式：見 voc-bot/RUNBOOK.md（5 步）
 * 這是一支自給自足的 Apps Script 檔案。所有設定都在下面 CONFIG 區塊。
 *
 * 它會在目標試算表建立 4 個「機器人專屬」分頁（完全不碰任何既有分頁）：
 *   VoC_Daily_Brief  今日摘要（最新的在最上面）
 *   VoC_Index        主索引：一個議題一列，會累計件數與最近 30 天熱度
 *   VoC_Raw_Log      原始紀錄（append-only，每一則聲音都有連結，稽核用）
 *   VoC_Bot_Log      執行紀錄與錯誤
 */

// ===========================================================================
// CONFIG — 只有這一區要改
// ===========================================================================

/** 產出要寫進去的試算表（VIP Feedback Sharing Sheet） */
var TARGET_SHEET_ID = '12pH74KmMPFKrVWj7rLGyj3WDwDGTZmxQY4QdEe3kj4A';

/** 要掃描的資料源試算表。label 會出現在索引的「主な出所」欄。 */
var SOURCE_SHEETS = [
  { id: '12pH74KmMPFKrVWj7rLGyj3WDwDGTZmxQY4QdEe3kj4A', label: 'VIP Feedback' },
  { id: '1la1-k4pBxtWs-ol_4QsYg92cpDeMgrcsVKE5hcjipmY', label: 'JP feature requests Q3' },
  { id: '1gZoZVwV8FaC2KQyZyiz5eqzXwnuaEbk1DhpEXihqS4k', label: 'JP feedback for Cross' },
  { id: '1QDZ7FERDK1c4kSyH9_rvaKtN31FmvWHVp2tXga7tgzQ', label: 'プロライバー定例会' }
];

/**
 * Slack。這兩個是 PLACEHOLDER，部署前必須換掉。
 * SLACK_TOKEN 必須是 17media workspace 的 token（xoxb- 或 xoxp- 開頭）。
 * 取得方式見 RUNBOOK.md 第 2 步。
 */
var SLACK_TOKEN = 'xoxb-PASTE-YOUR-17MEDIA-SLACK-TOKEN-HERE';
var SLACK_CHANNEL_ID = 'C06PRMJ6HRD';

/**
 * Claude API key（選填）。留空 → 用規則式分類產生摘要，功能完整。
 * 填了 → 額外用 Claude 生成一段給 PM 討論用的自然語言摘要。
 */
var ANTHROPIC_API_KEY = '';
var ANTHROPIC_MODEL = 'claude-opus-5';

/** 每天幾點跑（0-23，依 Apps Script 專案時區，RUNBOOK 第 3 步會設成 Asia/Tokyo） */
var DAILY_HOUR = 8;

/** 第一次執行時 Slack 往回抓幾天。之後只抓上次跑完之後的新訊息。 */
var FIRST_RUN_LOOKBACK_DAYS = 30;

/** 單次執行的上限（防爆量、防 Apps Script 6 分鐘逾時）。沒抓完的下次會自動接續。 */
var SLACK_MAX_MESSAGES = 300;
var SLACK_MAX_THREADS = 40;
var TIME_BUDGET_MS = 4 * 60 * 1000;

/** 「直近」熱度的天數 */
var RECENT_DAYS = 30;

/** 時區（用於所有日期字串格式化） */
var TZ = 'Asia/Tokyo';

// --- 分頁名稱（機器人專屬）---
var TAB_BRIEF = 'VoC_Daily_Brief';
var TAB_INDEX = 'VoC_Index';
var TAB_RAW = 'VoC_Raw_Log';
var TAB_LOG = 'VoC_Bot_Log';
var BOT_TABS = [TAB_BRIEF, TAB_INDEX, TAB_RAW, TAB_LOG];

var BRIEF_HEADERS = ['日時', '見出し', '内容'];
var RAW_HEADERS = ['ハッシュ', '索引キー', '取込日時', '発生日', '出所', '出所詳細',
                   '種類', 'テーマ', '要約', '本文', '起票者', 'ステータス', 'リンク'];
/** 索引：第 1〜12 欄由機器人覆寫，第 13〜14 欄留給人手動填，機器人絕不動 */
var INDEX_HEADERS = ['索引キー', 'テーマ', '種類', '論点', '代表要約', '最新の声',
                     '件数(累計)', '直近' + RECENT_DAYS + '日', '初出日', '最終更新日',
                     '優先スコア', '主な出所', 'PM共有日', 'クロスメモ'];
var INDEX_BOT_COLS = 12; // 機器人只寫到第 12 欄
var LOG_HEADERS = ['日時', '種別', '結果', '内容'];

// ===========================================================================
// 分類字典 — 沿用 JP Needs Heatmap 的痛點分群，讓索引跟現有 dashboard 對得上
// ===========================================================================

/** 同義詞正規化：先把說法統一，索引才不會把同一件事拆成好幾列 */
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
  { name: 'ギフトボード / Gift Board',           kw: ['ギフトボード', 'ギフター', '贈り主'] },
  { name: 'ティッカー・表示UI / Ticker & Overlay', kw: ['ティッカー', '金テロ', 'エフェクト', '演出', '被り', '重なる', '邪魔な位置'] },
  { name: 'イベント・マイイベント / Events',      kw: ['イベント', 'マイイベント', 'リーグ', 'グランプリ', '表彰', 'シャイニング', 'マンスリー'] },
  { name: 'ラッキーバッグ・ランダム / Lucky & Random', kw: ['ラッキーバッグ', 'ラッキー', 'ランダム', 'ガチャ', '大当たり', 'クレイジー'] },
  { name: 'VS・PK・マッチング / VS & Matching',   kw: ['vsmode', 'matching', 'pk', '待機室', '待機時間'] },
  { name: 'アーミー・ガーディアン・階級 / Community Rank', kw: ['army', 'guardian', '階級', '大佐', 'バッジ', '称号', 'レベル'] },
  { name: '課金・報酬・BC / Payment & Revenue',   kw: ['課金', '決済', 'atone', '支払', 'コイン', 'babycoin', '報酬', 'ロイヤリティ', 'マイレベニュー', '分潤'] },
  { name: 'バグ・不具合 / Bugs',                  kw: ['バグ', 'bug', '不具合', 'エラー', '落ちる', 'クラッシュ', 'crash', '真っ暗', '映らない', '表示されない', '反映されて'] },
  { name: '規約・不正対策 / Abuse & Policy',      kw: ['ブロック', 'block', '通報', 'bot', 'ボット', '不正', 'サブ垢', '複数アカウント', '自投げ', 'ペナルティ', '取り締ま'] },
  { name: 'アプリUI・導線 / App UI & Navigation', kw: ['ホーム画面', 'プロフィール', 'profile', '検索', 'タブ', '導線', 'たどり着', 'スクロール', 'ピックアップ', '注目欄', 'マイボックス', 'ipad'] },
  { name: 'DM・フォロー・通知 / Comms',           kw: ['dm', 'フォロー', 'follow', '通知', 'コメント', 'タイムライン', 'メンション'] },
  { name: '社内システム・PMプロセス / Internal & PM', kw: ['bdsystem', 'bd system', 'prd', 'pm側', 'pmと', 'ロードマップ', 'roadmap', 'discovery', '定例', '認識合わせ', '契約カード', 'アンケート'] },
  { name: 'VOD・配信機能 / VOD & Streaming',      kw: ['vod', '17live+', 'obs', '録画', '配信画面', 'アーカイブ', '視聴データ'] }
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

var SEVERITY_WEIGHT = { 'バグ': 3, '通報': 3, '不満': 2, '要望': 2, '提案': 1, '質問': 1, 'その他': 1 };

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

  var records = [];
  var problems = [];

  // --- 1. Slack ---
  try {
    var slack = fetchSlack_(ss, started);
    records = records.concat(slack.records);
    logRow_(ss, 'SLACK', 'OK', '取得 ' + slack.records.length + ' 則' +
      (slack.truncated ? '（達單次上限，剩下的下次自動接續）' : ''));
  } catch (e) {
    problems.push('Slack: ' + e.message);
    logRow_(ss, 'SLACK', 'ERROR', e.message);
  }

  // --- 2. 各表單 ---
  for (var i = 0; i < SOURCE_SHEETS.length; i++) {
    var src = SOURCE_SHEETS[i];
    try {
      var rows = fetchSpreadsheet_(src);
      records = records.concat(rows);
      logRow_(ss, 'SHEET', 'OK', src.label + '：擷取 ' + rows.length + ' 筆');
    } catch (e) {
      problems.push(src.label + ': ' + e.message);
      logRow_(ss, 'SHEET', 'ERROR', src.label + '：' + e.message);
    }
  }

  if (records.length === 0 && problems.length === SOURCE_SHEETS.length + 1) {
    logRow_(ss, 'RUN', 'ABORT', '所有資料源都失敗，本次不寫入。' + problems.join(' | '));
    return;
  }

  // --- 3. 分類 → 去重寫入 Raw_Log ---
  for (var j = 0; j < records.length; j++) classify_(records[j]);
  var fresh = appendRawLog_(ss, records);

  // --- 4. 從 Raw_Log 全量重算索引 ---
  var stats;
  try {
    stats = rebuildIndex_(ss);
  } catch (e) {
    stats = { total: 0, recent: 0 };
    problems.push('索引重算: ' + e.message);
    logRow_(ss, 'INDEX', 'ERROR', e.message);
  }

  // --- 5. 今日摘要 ---
  try {
    prependBrief_(ss, buildBrief_(ss, fresh, stats, problems));
  } catch (e) {
    logRow_(ss, 'BRIEF', 'ERROR', e.message);
  }

  var secs = Math.round((new Date().getTime() - started.getTime()) / 1000);
  logRow_(ss, 'RUN', problems.length ? 'DONE_WITH_WARNINGS' : 'DONE',
    '掃描 ' + records.length + ' 筆／新增 ' + fresh.length + ' 筆／索引 ' + stats.total +
    ' 個議題／耗時 ' + secs + ' 秒' + (problems.length ? '。警告：' + problems.join(' | ') : ''));
  SpreadsheetApp.flush();
}

/** 【驗證用】檢查 Slack、每份表單、目標表寫入權限。結果寫進 VoC_Bot_Log。 */
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
    logRow_(ss, 'TEST', 'INFO', 'Claude API key 未設定 → 使用規則式摘要（功能完整）');
  } else {
    try {
      logRow_(ss, 'TEST', 'OK', 'Claude API 連線成功：' +
        String(callClaude_('回覆兩個字：OK')).substring(0, 40));
    } catch (e) {
      logRow_(ss, 'TEST', 'FAIL', 'Claude API：' + e.message);
    }
  }

  logRow_(ss, 'TEST', 'END', '=== 測試結束，請看上面每一列的結果 ===');
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
  ensureSheet_(ss, TAB_INDEX, INDEX_HEADERS);
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
    if (err === 'not_in_channel') hint = '（請在該頻道輸入 /invite @你的bot名稱，把 bot 加進去）';
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
    var text = cleanSlackText_(msg.text || '');
    if (text) {
      out.push(makeRecord_({
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
          var rt = cleanSlackText_(rs[r].text || '');
          if (!rt) continue;
          out.push(makeRecord_({
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

  return { records: out, truncated: truncated };
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

function cleanSlackText_(t) {
  return String(t)
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!channel>|<!here>/g, '')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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
      if (!content || content.length < 6) continue;

      out.push(makeRecord_({
        date: normalizeDate_(pick_(row, map.date)),
        origin: src.label,
        originDetail: tab.getName(),
        body: (title && body && title !== body) ? (title + '｜' + body) : content,
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
 * body 回傳所有候選欄的排序清單，讓每一列可以挑第一個非空的。
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

function pick_(row, idx) {
  if (idx < 0 || idx >= row.length) return '';
  var v = String(row[idx] === null || row[idx] === undefined ? '' : row[idx]).trim();
  if (v === '-' || v === '—' || v === 'FALSE' || v === 'TRUE' || v === 'N/A') return '';
  return v;
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
  m = s.match(/^(\d{1,2})月/);                              // 只有「4月」
  if (m) return new Date().getFullYear() + '/' + pad2_(m[1]) + '/01';
  return s.substring(0, 20);
}

function pad2_(n) { return ('0' + String(n)).slice(-2); }

// ===========================================================================
// 記錄建構 / 分類 / 去重
// ===========================================================================

function makeRecord_(o) {
  var body = String(o.body || '').replace(/\s+/g, ' ').trim();
  return {
    date: o.date || nowDateStr_(),
    origin: o.origin || '',
    originDetail: o.originDetail || '',
    body: body,
    kindHint: o.kindHint || '',
    owner: o.owner || '',
    status: o.status || '',
    link: o.link || '',
    hash: md5short_(normalizeForHash_(body))
  };
}

function normalizeForHash_(text) {
  return String(text).toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[、。，．,.!！?？「」『』（）()\[\]【】~〜ー・:：;；'"<>]/g, '')
    .substring(0, 220);
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

function classify_(rec) {
  var hay = canonicalize_(rec.body + ' ' + rec.kindHint + ' ' + rec.originDetail);

  // 主題判定：用「命中關鍵字的總長度」計分，不是命中次數。
  // 否則 "BDsystemのSlack通知機能" 會因為 bdsystem 與 通知 各命中 1 次而平手，
  // 被前面的「DM・通知」主題搶走 —— 具體詞應該贏過泛用詞。
  var theme = 'その他 / Other';
  var bestScore = 0;
  var focus = '';
  for (var i = 0; i < THEMES.length; i++) {
    var hits = 0, matchedLen = 0, longest = '';
    for (var k = 0; k < THEMES[i].kw.length; k++) {
      var kw = THEMES[i].kw[k];
      if (kwHit_(hay, kw)) {
        hits++;
        matchedLen += kw.length;
        if (kw.length > longest.length) longest = kw;
      }
    }
    var score = matchedLen * 10 + hits;
    if (score > bestScore) { bestScore = score; theme = THEMES[i].name; focus = longest; }
  }

  // 種類：來源表已標註的優先
  var kind = '';
  var known = ['バグ', '不満', '提案', '要望', '質問', '意見', '通報'];
  for (var q = 0; q < known.length; q++) {
    if (String(rec.kindHint).indexOf(known[q]) >= 0) { kind = known[q]; break; }
  }
  if (!kind) {
    for (var j = 0; j < KIND_RULES.length && !kind; j++) {
      for (var m = 0; m < KIND_RULES[j].kw.length; m++) {
        if (kwHit_(hay, KIND_RULES[j].kw[m])) { kind = KIND_RULES[j].key; break; }
      }
    }
  }
  if (!kind) kind = 'その他';

  rec.theme = theme;
  rec.kind = kind;
  rec.focus = focus || '全般';
  rec.indexKey = md5short_(theme + '|' + kind + '|' + rec.focus);
  rec.summary = rec.body.length > 90 ? rec.body.substring(0, 88) + '…' : rec.body;
  return rec;
}

/** 只把沒看過的 hash 寫進 Raw_Log，回傳這次真正新增的紀錄 */
function appendRawLog_(ss, records) {
  var sh = ss.getSheetByName(TAB_RAW);
  var seen = {};
  var last = sh.getLastRow();
  if (last > 1) {
    var hashes = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < hashes.length; i++) seen[String(hashes[i][0])] = true;
  }

  var rows = [], fresh = [], batch = {};
  var ts = nowStr_();
  for (var r = 0; r < records.length; r++) {
    var rec = records[r];
    if (!rec.hash || seen[rec.hash] || batch[rec.hash]) continue;
    batch[rec.hash] = true;
    fresh.push(rec);
    rows.push([rec.hash, rec.indexKey, ts, rec.date, rec.origin, rec.originDetail,
               rec.kind, rec.theme, rec.summary, rec.body.substring(0, 4000),
               rec.owner, rec.status, rec.link]);
  }
  if (rows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, RAW_HEADERS.length).setValues(rows);
  }
  return fresh;
}

// ===========================================================================
// 主索引：每次從 Raw_Log 全量重算（第 13/14 欄是人手填的，絕不覆寫）
// ===========================================================================

function rebuildIndex_(ss) {
  var raw = ss.getSheetByName(TAB_RAW);
  var last = raw.getLastRow();
  if (last < 2) return { total: 0, recent: 0 };

  var vals = raw.getRange(2, 1, last - 1, RAW_HEADERS.length).getValues();
  var C = {};
  for (var h = 0; h < RAW_HEADERS.length; h++) C[RAW_HEADERS[h]] = h;

  var cutoff = new Date().getTime() - RECENT_DAYS * 86400000;
  var buckets = {};
  var order = [];

  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var key = String(row[C['索引キー']]);
    if (!key) continue;
    var d = String(row[C['発生日']]);
    var dt = parseYmd_(d);

    if (!buckets[key]) {
      buckets[key] = {
        key: key, theme: row[C['テーマ']], kind: row[C['種類']],
        focus: '', first: d, last: d, firstTime: dt, lastTime: dt,
        total: 0, recent: 0, repSummary: row[C['要約']], latest: row[C['要約']],
        origins: {}
      };
      order.push(key);
    }
    var b = buckets[key];
    b.total++;
    if (dt && dt >= cutoff) b.recent++;
    if (dt && (!b.firstTime || dt < b.firstTime)) { b.firstTime = dt; b.first = d; }
    if (dt && (!b.lastTime || dt >= b.lastTime)) {
      b.lastTime = dt; b.last = d; b.latest = row[C['要約']];
    }
    b.origins[String(row[C['出所']])] = true;
  }

  // 論点欄：從 索引キー 反推不出來，改用最新那筆的主題關鍵字段
  var out = [];
  for (var o = 0; o < order.length; o++) {
    var x = buckets[order[o]];
    var origins = [];
    for (var k in x.origins) if (k) origins.push(k);
    var score = (SEVERITY_WEIGHT[x.kind] || 1) * 3 + x.recent * 2 + Math.min(x.total, 30) +
                (x.origins['Slack'] ? 3 : 0);
    out.push([x.key, x.theme, x.kind, x.theme.split(' / ')[0], x.repSummary, x.latest,
              x.total, x.recent, x.first, x.last, score, origins.join(', ')]);
  }

  // 優先スコア 由高到低
  out.sort(function (a, b) { return b[10] - a[10]; });

  // 保留人手填的 PM共有日 / クロスメモ（用索引キー對回去）
  var idx = ss.getSheetByName(TAB_INDEX);
  var manual = {};
  var idxLast = idx.getLastRow();
  if (idxLast > 1) {
    var old = idx.getRange(2, 1, idxLast - 1, INDEX_HEADERS.length).getValues();
    for (var m = 0; m < old.length; m++) {
      var ok = String(old[m][0]);
      if (ok) manual[ok] = [old[m][12], old[m][13]];
    }
    idx.getRange(2, 1, idxLast - 1, INDEX_HEADERS.length).clearContent();
  }

  if (out.length) {
    var full = [];
    for (var f = 0; f < out.length; f++) {
      var man = manual[out[f][0]] || ['', ''];
      full.push(out[f].concat([man[0], man[1]]));
    }
    idx.getRange(2, 1, full.length, INDEX_HEADERS.length).setValues(full);
  }

  var recentTotal = 0;
  for (var rr = 0; rr < out.length; rr++) recentTotal += out[rr][7];
  return { total: out.length, recent: recentTotal };
}

function parseYmd_(s) {
  var m = String(s).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

// ===========================================================================
// 今日摘要
// ===========================================================================

function buildBrief_(ss, fresh, stats, problems) {
  var byTheme = {}, byKind = {};
  for (var i = 0; i < fresh.length; i++) {
    byTheme[fresh[i].theme] = (byTheme[fresh[i].theme] || 0) + 1;
    byKind[fresh[i].kind] = (byKind[fresh[i].kind] || 0) + 1;
  }
  var themeRank = sortCounts_(byTheme), kindRank = sortCounts_(byKind);

  var lines = [];
  lines.push('新規 ' + fresh.length + ' 件／索引の論点 ' + stats.total +
             ' 件（直近' + RECENT_DAYS + '日の声 ' + stats.recent + ' 件）');

  if (themeRank.length) {
    var tp = [];
    for (var t = 0; t < Math.min(5, themeRank.length); t++) {
      tp.push(themeRank[t].key.split(' / ')[0] + ' ' + themeRank[t].n);
    }
    lines.push('■ テーマ上位：' + tp.join('、'));
  }
  if (kindRank.length) {
    var kp = [];
    for (var k = 0; k < kindRank.length; k++) kp.push(kindRank[k].key + ' ' + kindRank[k].n);
    lines.push('■ 種類内訳：' + kp.join('、'));
  }

  // PM と話す候補：バグ・通報を優先
  var picks = [];
  for (var p = 0; p < fresh.length && picks.length < 8; p++) {
    if (fresh[p].kind === 'バグ' || fresh[p].kind === '通報') picks.push(fresh[p]);
  }
  for (var q = 0; q < fresh.length && picks.length < 8; q++) {
    if (picks.indexOf(fresh[q]) < 0) picks.push(fresh[q]);
  }
  if (picks.length) {
    lines.push('■ PM と話す候補：');
    for (var x = 0; x < picks.length; x++) {
      lines.push('  ' + (x + 1) + '. [' + picks[x].theme.split(' / ')[0] + '／' +
        picks[x].kind + '] ' + picks[x].summary + '（' + picks[x].origin + '）');
    }
  }
  if (problems.length) lines.push('■ 注意：' + problems.join(' / '));

  var body = lines.join('\n');
  var headline = fresh.length === 0 ? '新規なし'
    : (themeRank.length ? themeRank[0].key.split(' / ')[0] + ' 中心に ' + fresh.length + ' 件'
                        : fresh.length + ' 件');

  if (ANTHROPIC_API_KEY && fresh.length > 0) {
    try {
      var ai = summarizeWithClaude_(fresh);
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

function sortCounts_(obj) {
  var arr = [];
  for (var k in obj) arr.push({ key: k, n: obj[k] });
  arr.sort(function (a, b) { return b.n - a.n; });
  return arr;
}

/** 最新的放最上面（插在第 2 列） */
function prependBrief_(ss, brief) {
  var sh = ss.getSheetByName(TAB_BRIEF);
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 3).setValues([[brief.date, brief.headline, brief.body]])
    .setVerticalAlignment('top').setWrap(true);
  sh.setColumnWidth(1, 140);
  sh.setColumnWidth(2, 240);
  sh.setColumnWidth(3, 760);
}

// ===========================================================================
// Claude（選填）
// ===========================================================================

function summarizeWithClaude_(fresh) {
  var items = [];
  var limit = Math.min(fresh.length, 60);
  for (var i = 0; i < limit; i++) {
    items.push('- [' + fresh[i].theme + '／' + fresh[i].kind + '／' + fresh[i].origin + '] ' +
      fresh[i].body.substring(0, 240));
  }

  var prompt =
    'あなたは 17LIVE の JP プロダクト運営を支える分析アシスタントです。\n' +
    '以下は今日新しく集まったユーザー／ライバーの声です。COO が PM と議論するための要約を作ってください。\n\n' +
    items.join('\n') + '\n\n' +
    '次の JSON だけを返してください。前後に説明文やコードフェンスを付けないこと。\n' +
    '{"headline":"20文字以内の見出し","text":"本文"}\n\n' +
    '本文の構成：\n' +
    '1. 今日の要点を3行以内\n' +
    '2. 「PM と詰めるべき論点」を最大5件。各件は「論点／なぜ重要か／PM への問い」の3点セット\n' +
    '3. 既知課題の再燃があれば指摘\n' +
    '日本語で簡潔に。与えられた声に無い数字や事実を作らないこと。';

  var parsed = parseJsonLoose_(callClaude_(prompt));
  if (parsed && parsed.text) return parsed;
  return null;
}

function callClaude_(prompt) {
  var payload = {
    model: ANTHROPIC_MODEL,
    max_tokens: 8000,
    output_config: { effort: 'medium' },
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

  var blocks = body.content || [];
  for (var i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'text' && blocks[i].text) return blocks[i].text;
  }
  throw new Error('回應中沒有文字內容');
}

// ===========================================================================
// 小工具
// ===========================================================================

function safeJson_(t) { try { return JSON.parse(t); } catch (e) { return null; } }

/** JSON 解析 4 層 fallback */
function parseJsonLoose_(text) {
  var s = String(text || '').trim();
  var v = safeJson_(s);
  if (v) return v;

  var stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  v = safeJson_(stripped);
  if (v) return v;

  var m = stripped.match(/\{[\s\S]*\}/);
  if (m) { v = safeJson_(m[0]); if (v) return v; }

  var h = s.match(/"headline"\s*:\s*"([^"]*)"/);
  var t = s.match(/"text"\s*:\s*"([\s\S]*?)"\s*\}/);
  if (h || t) {
    return { headline: h ? h[1] : '', text: t ? t[1].replace(/\\n/g, '\n') : s };
  }
  return null;
}

function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm'); }
function nowDateStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'); }
