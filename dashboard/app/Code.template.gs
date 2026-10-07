/**
 * VoC 作戰台 —— 單一儀表板（Apps Script 網頁，只讀不寫）
 *
 * 部署見 dashboard/README.md（5 步）。這是「新的」Apps Script 專案，不要放進「STT Export」。
 * 這支檔案由 dashboard/build_gas.py 產生（Code.template.gs ＋ Page.html），頁面打包在檔案裡：
 * 改版一定要重新貼上並「部署 → 管理部署作業 → 新版本」，等於每次改版都經過 Cross 手動把關。
 *
 * === 存取控制 ===
 * 部署設定：執行身分＝我（Cross）、存取權＝17.media 網域內的使用者。
 * 網域內任何人都能直接呼叫 google.script.run 的公開函數，所以「每一個」公開函數第一行都呼叫 assertAllowed_()。
 * 回傳原話的函數都以 _ 結尾（瀏覽器呼叫不到），只透過已檢查權限的公開函數回傳。
 *
 * === 這支檔案不寫任何東西 ===
 * 沒有 GitHub token、沒有寫入 repo 的函數、不建 Sheet。資料來源：
 *   1. repo 的公開統計檔（raw.githubusercontent.com，repo 是公開的，不需要 token）
 *   2. BigQuery（以 Cross 身分）：25 痛點週人數、細分類、代表原話。SQL 固定，只吃參數 @code／@since
 *   3. VoC Daily Bot 的試算表（以 Cross 身分，只讀）：Slack＋表單的聲音
 * 原話只存在伺服器端快取（CacheService，6 小時），不寫進 repo、不寫進任何檔案。不取 userID。
 * 「全部原話」的翻譯用 Apps Script 內建的 Google 翻譯（LanguageApp，不需金鑰、免費）；摘要由 Cross 下載 CSV 後自己交給 Claude。——2026-10-07 Cross 決定。
 */

// ═══════════════ 設定 ═══════════════

/** 可以打開這個儀表板的人（小寫 email）。之後要加 PM，就在這裡加一行，再「部署 → 新版本」。 */
var ALLOWED_EMAILS = [
  'crosswang@17.media'
];
/** 只有這個人會看到「去指定負責的卡」按鈕（編輯頁只部署給 Cross 自己）。 */
var OWNER_EMAIL = 'crosswang@17.media';

var REPO_RAW = 'https://raw.githubusercontent.com/crosswang-collab/product-ops-bridge/main/';
var BQ_PROJECT = 'media17-1119';
var JUDGMENTS_TABLE = 'media17-1119.DataLab_Ayana.stt_voc_judgments';
var METRICS_TABLE = 'media17-1119.DataLab_Ayana.stt_voc_weekly_metrics';
var VOC_SHEET_ID = '12pH74KmMPFKrVWj7rLGyj3WDwDGTZmxQY4QdEe3kj4A';   // VoC Daily Bot 的試算表（voc-bot/Code.gs TARGET_SHEET_ID）

var SERIES_WEEKS = 12;          // 時間段分析抓幾週（規則最長用 6 週；多抓留給晚到的批次）
var DETAIL_WEEKS = 4;           // 細分類與原話看最近幾週
var QUOTES_PER_PAIN = 5;
var EXPORT_MAX = 3000;          // 輸出：單一痛點最近 4 週全部原話（只是保護上限，正常不會碰到）
var TRANSLATE_BATCH = 20;       // 一次翻幾則（Google 翻譯每則約 0.3 秒）

var CACHE_SECONDS = 6 * 60 * 60;
var CACHE_SECONDS_DEGRADED = 5 * 60;   // 有部分資料讀不到時只存 5 分鐘，重新整理很快就會重試
var CACHE_VER = 'v1';
var RAW_TAIL_ROWS = 4000;       // Slack＋表單只讀最新幾列
var TZ = 'Asia/Tokyo';

var EMERGE_MIN = 10;            // 新興：最近 2 週每週平均 ≥ 10 位
var PERSIST_MIN = 20;           // 持續：最近 6 週中 ≥ 4 週 ≥ 20 位
var READ_FLOOR = 10;            // 上週 ≥ 10 位才算「有聲音」（同 voc-graph rules.read_floor）
var STATUS_RANK = { 'On track': 0, 'Warning': 1, 'At Risk': 2, 'Off track': 3 };

// VoC_Raw_Log 欄位（voc-bot/Code.gs RAW_HEADERS，0 起算）
var RAW = { ingested: 2, occurred: 3, origin: 4, originDet: 5, summary: 8, body: 9,
            link: 12, verdict: 13, code: 14 };
var RAW_COLS = 20;
var V_MATCH = ['既存一致', '既存一致(要確認)', '規則式(精度低)'];
var V_NEW = '新規候補';

// ═══════════════ 網頁進入點 ═══════════════

function doGet() {
  var who = viewer_();
  if (!isAllowed_(who)) {
    return HtmlService.createHtmlOutput(
      '<meta charset="utf-8"><div style="font-family:sans-serif;padding:24px;line-height:1.6">' +
      '<h2>沒有權限</h2><p>這個頁面只開放給指定的人。需要的話請找 Cross 開權限。</p></div>')
      .setTitle('VoC 作戰台');
  }
  return HtmlService.createHtmlOutput(PAGE_HTML)
    .setTitle('VoC 作戰台')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ═══════════════ 公開函數（瀏覽器呼叫，每一支都先檢查權限） ═══════════════

/** 儀表板主資料：痛點週人數與判定、Roadmap、Slack＋表單、來源狀態。 */
function getDashboard() {
  var who = assertAllowed_();
  var d = cacheGet_('dash');
  if (!d) {
    try {
      d = buildDashboard_();
    } catch (e) {
      throw new Error(friendly_(e));
    }
    cachePut_('dash', d, d.sttSource !== 'bigquery' || !d.slack.ok);
  }
  d.canEdit = (who === OWNER_EMAIL.toLowerCase());
  if (!d.canEdit) d.editorUrl = '';
  return d;
}

/** 單一痛點的細分類與代表原話。只接受 25 痛點清單內的代碼。 */
function getPainDetail(code) {
  assertAllowed_();
  code = assertPainCode_(code);
  var dash = cacheGet_('dash');
  var key = 'pain:' + code;
  var hit = cacheGet_(key);
  if (hit) return hit;
  var res = buildPainDetail_(code, dash ? dash.detailSince : addDays_(today_(), -DETAIL_WEEKS * 7));
  cachePut_(key, res, !res.ok || !!res.voicesProblem);
  return res;
}

/** 輸出用：單一痛點最近 4 週的全部原話（保護上限 EXPORT_MAX 則）。不含 userID。 */
function getPainExport(code) {
  assertAllowed_();
  code = assertPainCode_(code);
  try { return exportRows_(code); } catch (e) { throw new Error(friendly_(e)); }
}

/**
 * 用 Google 翻譯（Apps Script 內建 LanguageApp，不需金鑰）把一批原話翻成繁中。回傳 {id: 中文}，只含這批的編號。
 * 單則失敗就跳過；每日次數用完時，已翻好的先回傳，一則都沒翻到才報錯。
 */
function translateQuotes(items) {
  assertAllowed_();
  var batch = cleanItems_(items, TRANSLATE_BATCH, 1200);
  var out = {};
  for (var i = 0; i < batch.length; i++) {
    try {
      out[batch[i].id] = clip_(String(LanguageApp.translate(batch[i].text, '', 'zh-TW') || ''), 2000);
    } catch (e) {
      var msg = String(e && e.message || e);
      console.log('[ERROR] 翻譯 ' + batch[i].id + '：' + msg);
      if (!/too many times|invoked too many|quota/i.test(msg)) continue;   // 這一則有問題：跳過
      if (Object.keys(out).length) return out;
      throw new Error(/one day|per day|daily/i.test(msg)
        ? '今天的 Google 翻譯次數用完了，明天再按「補翻」'
        : 'Google 翻譯一時太忙，等一分鐘再按「補翻」');
    }
  }
  return out;
}

/** 頁面送回的原話：只收 {id:'Q數字', text:字串}，數量與長度都有上限。 */
function cleanItems_(items, maxN, maxLen) {
  if (!Array.isArray(items)) throw new Error('資料格式不對');
  if (items.length > maxN) throw new Error('一次送太多則（上限 ' + maxN + '）');
  var out = [];
  items.forEach(function (x) {
    if (!x || !/^Q\d{1,5}$/.test(String(x.id))) return;
    var t = clip_(String(x.text || ''), maxLen);
    if (t) out.push({ id: String(x.id), text: t });
  });
  return out;
}

/** 清掉快取、馬上重抓（只有 Cross 能用）。 */
function refreshNow() {
  var who = assertAllowed_();
  if (who !== OWNER_EMAIL.toLowerCase()) throw new Error('只有 Cross 可以重新整理資料');
  var c = CacheService.getScriptCache();
  var keys = ['dash'];
  (cacheGet_('dash') || { pains: [] }).pains.forEach(function (p) { keys.push('pain:' + p.code); });
  keys.forEach(function (k) { cacheRemove_(c, k); });
  return 'ok';
}

// ═══════════════ 部署前手動驗證（在 Apps Script 編輯器執行） ═══════════════

/** 每一行都是 ✅ 才去部署。只印數量，不印任何原話。 */
function testDashboard() {
  var who = viewer_();
  if (!isAllowed_(who)) throw new Error('沒有權限');
  console.log('✅ 你的帳號 ' + who + ' 在允許名單內');
  var d = buildDashboard_();
  console.log('✅ Roadmap：' + d.cards.length + ' 張卡（' + d.jiraAsOf + '），近 7 天變差 ' + d.worse.length + ' 件');
  console.log((d.sttSource === 'bigquery' ? '✅' : '⚠️') + ' 週人數來源：' + (d.sttSource === 'bigquery' ? 'BigQuery' : 'repo 備援（' + d.sttProblem + '）') +
    '，共 ' + d.weeks.length + ' 週，最新 ' + d.latestWeek.start);
  var em = d.pains.filter(function (p) { return p.rule.emerging; }).map(function (p) { return p.code; });
  var pe = d.pains.filter(function (p) { return p.rule.persistent; }).map(function (p) { return p.code; });
  var fa = d.pains.filter(function (p) { return p.rule.fading; }).map(function (p) { return p.code; });
  console.log((d.missingWeeks.length ? '⚠️ 週報缺 ' + d.missingWeeks.join('、') + ' 的資料' : '✅ 週報 ' + d.weeks.length + ' 週都有資料'));
  console.log((d.jiraAgeDays > 2 ? '⚠️ Roadmap 資料已 ' + d.jiraAgeDays + ' 天沒更新' : '✅ Roadmap 資料是最新的'));
  console.log('   新興：' + (em.join('、') || '無') + '／持續：' + (pe.join('、') || '無') + '／消退：' + (fa.join('、') || '無'));
  console.log((d.slack.ok ? '✅' : '❌') + ' Slack＋表單：' + (d.slack.ok ? '最新 ' + d.slack.latest.length + ' 筆、bot 最後成功 ' + (d.slack.lastRun || '未知') : d.slack.problem));
  var top = d.pains.slice().sort(function (a, b) { return b.latest - a.latest; })[0];
  if (!top) { console.log('❌ 讀不到任何痛點'); return; }
  var det = buildPainDetail_(top.code, d.detailSince);
  console.log((det.ok ? '✅' : '❌') + ' ' + top.code + ' 細分類 ' + det.groups.length + ' 組、原話 ' + det.quotes.length + ' 則' +
    '（判定過的主播 ' + det.judgedStreamers + ' 位）' + (det.ok ? '' : '：' + det.problem));
  var blank = det.quotes.filter(function (q) { return !q.text; }).length;
  var noCtx = det.quotes.filter(function (q) { return !q.context; }).length;
  console.log((blank ? '⚠️ ' + blank + ' 則原話文字是空的（欄位格式沒對上，把這行貼給 Claude）' : '✅ 原話文字都有內容') +
    '；前後文有內容 ' + (det.quotes.length - noCtx) + '／' + det.quotes.length + ' 則');
  var leak = JSON.stringify(d).match(/userID|liveStreamID/i);
  console.log((leak ? '❌ 主資料出現 ' + leak[0] : '✅ 主資料沒有 userID'));
}

/** 確認 Google 翻譯能不能用（不送任何原話）。部署前在編輯器執行一次。 */
function testTranslate() {
  var who = viewer_();
  if (!isAllowed_(who)) throw new Error('沒有權限');
  try {
    var zh = LanguageApp.translate('配信が落ちます', 'ja', 'zh-TW');
    console.log(zh ? '✅ Google 翻譯可以用（「配信が落ちます」→「' + zh + '」）' : '⚠️ Google 翻譯回空白，把這行貼給 Claude');
  } catch (e) {
    console.log('❌ ' + e.message);
  }
}

// ═══════════════ 權限 ═══════════════

function viewer_() {
  return String(Session.getActiveUser().getEmail() || '').toLowerCase();
}

function isAllowed_(email) {
  if (!email) return false;
  return ALLOWED_EMAILS.map(function (e) { return e.toLowerCase(); }).indexOf(email) >= 0;
}

/** 給畫面看的錯誤訊息只用中文；原始訊息（可能含技術名詞）只寫進伺服器紀錄。 */
function friendly_(e) {
  var msg = String(e && e.message || e);
  console.log('[ERROR] ' + msg + '\n' + (e && e.stack || ''));
  if (/[\u4e00-\u9fff]/.test(msg)) return msg;   // 本來就是我們寫的中文訊息
  if (/Access Denied|permission|forbidden|403/i.test(msg)) return '沒有讀取權限';
  if (/404/.test(msg)) return '找不到資料檔';
  return '暫時讀不到';
}

/** 只接受 25 痛點清單內的代碼（清單來自主資料）。 */
function assertPainCode_(code) {
  code = String(code || '');
  var dash = cacheGet_('dash');
  if (!dash) {
    try { dash = buildDashboard_(); } catch (e) { throw new Error(friendly_(e)); }
  }
  var known = dash.pains.map(function (p) { return p.code; });
  if (!/^[SU][0-9]\.[0-9]$/.test(code) || known.indexOf(code) < 0) throw new Error('不認得的痛點代碼');
  return code;
}

function assertAllowed_() {
  var who = viewer_();
  if (!isAllowed_(who)) throw new Error('沒有權限');
  return who;
}

// ═══════════════ 主資料 ═══════════════

function buildDashboard_() {
  var g = repoJson_('voc-graph/out/latest.json');
  var rm = repoJson_('roadmap-bot/out/latest.json');
  var mapping = repoJson_('voc-graph/mapping.json');
  var p2c = mapping.pain_to_cards || {};

  // 週人數：BigQuery 優先（≥ 10 週），失敗退回 repo 的 7 週，畫面會標示
  var series = null, sttSource = 'bigquery', sttProblem = '';
  try {
    series = painSeries_();
  } catch (e) {
    sttSource = 'repo';
    sttProblem = friendly_(e);
    series = {
      weeks: g.windows.slice(),
      byCode: {},
      missing: []
    };
    g.nodes.pains.forEach(function (p) { series.byCode[p.code] = p.stt.series.map(function (x) { return x.streamers; }); });
  }
  var weeks = series.weeks;
  var lastStart = weeks[weeks.length - 1];

  var themeNames = {};
  g.nodes.themes.forEach(function (t) { themeNames[t.code] = t.name; });
  var themesOf = {};
  g.edges.forEach(function (e) {
    if (e.type !== 'theme_pain') return;
    (themesOf[e.to] = themesOf[e.to] || []).push({ code: e.from, name: themeNames[e.from] || '', n: e.weight });
  });

  var pains = g.nodes.pains.map(function (p) {
    var s = series.byCode[p.code] || weeks.map(function () { return 0; });
    var cards = p2c[p.code] || [];
    return {
      code: p.code, title: p.title, vocScore: p.voc_score, series: s, latest: s[s.length - 1],
      cards: cards, noOwner: !cards.length && s[s.length - 1] >= READ_FLOOR,
      allZero: !s.some(function (v) { return v > 0; }),
      rule: classify_(s), themes: themesOf[p.code] || []
    };
  });

  var old = olderFacts_(rm.as_of_date);
  var worse = [];
  rm.cards.forEach(function (c) {
    var o = old.cards[c.key];
    if (!o) return;
    if ((STATUS_RANK[c.project_status] || 0) > (STATUS_RANK[o.project_status] || 0)) {
      worse.push({ key: c.key, summary: c.summary, url: c.url, what: '狀態變差', from: o.project_status, to: c.project_status });
    }
    if (o.release_date && c.release_date && c.release_date > o.release_date) {
      worse.push({ key: c.key, summary: c.summary, url: c.url, what: '上線日延後', from: o.release_date, to: c.release_date });
    }
  });

  var load = [];
  var cap = rm.aggregate.domains_by_capacity || {};
  Object.keys(cap).forEach(function (d) {
    load.push({ domain: d, cards: cap[d].cards, points: cap[d].points, months: cap[d].wip_months, verdict: cap[d].wip_verdict });
  });

  var endDate = addDays_(lastStart, 6);
  return {
    generatedAt: Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm'),
    weeks: weeks,
    latestWeek: { start: lastStart, end: endDate },
    detailSince: addDays_(today_(), -DETAIL_WEEKS * 7),
    sttSource: sttSource, sttProblem: sttProblem, missingWeeks: series.missing,
    sttAgeDays: daysBetween_(endDate, today_()),
    jiraAsOf: rm.as_of_date,
    jiraAgeDays: daysBetween_(rm.as_of_date, today_()),
    pains: pains,
    outside: g.views.outside_catalog || [],
    unbacked: g.views.unbacked_voc_cards || [],
    cards: rm.cards.map(function (c) {
      return { key: c.key, summary: c.summary, stage: c.stage, project_status: c.project_status,
               domain: c.domain, release_date: c.release_date, url: c.url };
    }),
    stages: rm.aggregate.stages,
    worse: worse, worseSince: old.date,
    load: load,
    baselineExpired: !!(rm.baseline && rm.baseline.expired),
    baselineExpiresAt: rm.baseline ? rm.baseline.expires_at : '',
    upcoming: (rm.aggregate.upcoming_releases || []).slice(0, 8),
    editorUrl: mapping._editor_url || '',
    rules: { emergeMin: EMERGE_MIN, persistMin: PERSIST_MIN },
    slack: slackSummary_()
  };
}

/** 三條時間段規則，每個痛點各自算。s＝由舊到新的週人數。 */
function classify_(s) {
  var n = s.length;
  var r2 = n >= 2 ? (s[n - 1] + s[n - 2]) / 2 : 0;
  var p4 = n >= 6 ? (s[n - 3] + s[n - 4] + s[n - 5] + s[n - 6]) / 4 : 0;
  var hot = 0;
  for (var i = Math.max(0, n - 6); i < n; i++) if (s[i] >= PERSIST_MIN) hot++;
  return {
    emerging: n >= 6 && r2 >= EMERGE_MIN && (r2 >= 2 * p4 || p4 < 2),
    persistent: n >= 6 && hot >= 4,
    fading: n >= 4 && s[n - 4] > s[n - 3] && s[n - 3] > s[n - 2] && s[n - 2] > s[n - 1],
    recent2: Math.round(r2 * 10) / 10, prior4: Math.round(p4 * 10) / 10, hotWeeks: hot
  };
}

/** 25 痛點週人數（週報定点）。同一窗重建過取最新 loaded_at。某痛點在某週沒有列＝0 位。 */
function painSeries_() {
  var sql = [
    'SELECT CAST(window_start AS STRING) AS window_start,',
    "  REGEXP_EXTRACT(metric_key, r'^([SUX][0-9]\\.[0-9])') AS code, n_liver AS streamers",
    'FROM `' + METRICS_TABLE + '`',
    "WHERE metric_type = 'pain25' AND REGEXP_CONTAINS(metric_key, r'^[SUX][0-9]\\.[0-9]')",
    '  AND window_start >= @since',
    'QUALIFY ROW_NUMBER() OVER (PARTITION BY window_start, metric_key ORDER BY loaded_at DESC) = 1'
  ].join('\n');
  var since = addDays_(today_(), -(SERIES_WEEKS + 8) * 7);   // 多抓 8 週：週報晚到時也不會誤報缺週
  var rows = bqQuery_(sql, [dateParam_('since', since)], '25 痛點週人數');
  if (!rows.length) throw new Error('週報最近 ' + SERIES_WEEKS + ' 週沒有痛點人數');
  var seen = {};
  rows.forEach(function (r) { seen[r.window_start] = true; });
  var all = Object.keys(seen).sort();
  var first = all[0], latest = all[all.length - 1];
  var wl = [];
  for (var w = SERIES_WEEKS - 1; w >= 0; w--) {
    var wk = addDays_(latest, -7 * w);
    if (wk >= first) wl.push(wk);   // 連續週一；週報開始統計之前的週不算缺，直接不列
  }
  var missing = wl.filter(function (x) { return !seen[x]; });   // 只有中間斷掉的週才算缺
  var byCode = {};
  rows.forEach(function (r) {
    var i = wl.indexOf(r.window_start);
    if (i < 0 || !r.code) return;
    if (!byCode[r.code]) byCode[r.code] = wl.map(function () { return 0; });
    byCode[r.code][i] += Number(r.streamers) || 0;
  });
  return { weeks: wl, byCode: byCode, missing: missing };
}

/** 找 7 天前（找不到就往前到 10 天）的 Jira 快照，給「變差」比較用。 */
function olderFacts_(asOf) {
  for (var back = 7; back <= 10; back++) {
    var d = addDays_(asOf, -back);
    var j = repoJson_('roadmap-bot/out/facts-' + d + '.json', true);
    if (j) {
      var m = {};
      j.cards.forEach(function (c) { m[c.key] = c; });
      return { date: d, cards: m };
    }
  }
  return { date: '', cards: {} };
}

// ═══════════════ 痛點細節（原話） ═══════════════

/** 細分類＋代表原話。SQL 固定，只吃 @code 與 @since；最終結果不含 userID。 */
function buildPainDetail_(code, since) {
  var out = { ok: true, code: code, since: since, judgedStreamers: 0, groups: [], quotes: [], voices: [], problem: '' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since))) since = addDays_(today_(), -DETAIL_WEEKS * 7);
  var params = [strParam_('code', code), dateParam_('since', since)];
  var base = [
    'WITH t AS (',
    '  SELECT window_start, userID, IFNULL(tier, \'\') AS tier,',
    "    IFNULL(issue_kind, '') AS issue_kind, IFNULL(failure_layer, '') AS failure_layer,",
    '    voc_summary_secondary, stt, context',
    '  FROM `' + JUDGMENTS_TABLE + '`',
    "  WHERE exist = 'TRUE_PAIN' AND window_start >= @since",
    "    AND @code IN UNNEST(REGEXP_EXTRACT_ALL(IFNULL(pain25_tags, ''), r'[SUX][0-9]\\.[0-9]'))",
    ')'
  ].join('\n');
  try {
    var groups = bqQuery_(base + '\n' + [
      'SELECT issue_kind, failure_layer, COUNT(DISTINCT userID) AS streamers,',
      "  COUNT(DISTINCT IF(tier = 'sTop', userID, NULL)) AS stop_streamers,",
      '  (SELECT COUNT(DISTINCT userID) FROM t) AS judged',
      'FROM t GROUP BY issue_kind, failure_layer ORDER BY streamers DESC LIMIT 8'
    ].join('\n'), params, code + ' 細分類');
    out.judgedStreamers = groups.length ? Number(groups[0].judged) : 0;
    out.groups = groups.map(function (r) {
      return { kind: r.issue_kind || '（未分類）', layer: r.failure_layer || '（未分類）',
               n: Number(r.streamers), stop: Number(r.stop_streamers) };
    });
    // 每位主播最多 1 則；sTop → Top → 其他，再依新到舊。最外層不選 userID。
    var quotes = bqQuery_(base + '\n' + [
      ', ranked AS (',
      '  SELECT *, ROW_NUMBER() OVER (PARTITION BY userID',
      "    ORDER BY CASE tier WHEN 'sTop' THEN 0 WHEN 'Top' THEN 1 ELSE 2 END, window_start DESC) AS rn FROM t",
      ')',
      'SELECT CAST(window_start AS STRING) AS week, tier, issue_kind, failure_layer,',
      '  TO_JSON_STRING(voc_summary_secondary) AS summary_j, TO_JSON_STRING(stt) AS stt_j, TO_JSON_STRING(context) AS context_j',
      'FROM ranked WHERE rn = 1',
      "ORDER BY CASE tier WHEN 'sTop' THEN 0 WHEN 'Top' THEN 1 ELSE 2 END, window_start DESC",
      'LIMIT ' + QUOTES_PER_PAIN
    ].join('\n'), params, code + ' 原話');
    out.quotes = quotes.map(function (r) {
      return { week: r.week, tier: r.tier, kind: r.issue_kind || '（未分類）', layer: r.failure_layer || '（未分類）',
               summary: clip_(jsonText_(r.summary_j), 300), text: clip_(jsonText_(r.stt_j), 1200),
               context: clip_(jsonText_(r.context_j), 3000) };
    });
  } catch (e) {
    out.ok = false;
    out.problem = '讀不到直播原話：' + friendly_(e);
  }
  var sv = slackVoicesFor_(code);
  out.voices = sv.list;
  out.voicesProblem = sv.problem;
  return out;
}

/** 單一痛點最近 4 週的全部原話（sTop → Top → 其他，新到舊，同週依 hit_id）。最外層不選 userID。不快取（可能上 MB）。 */
function exportRows_(code) {
  var since = addDays_(today_(), -DETAIL_WEEKS * 7);
  var rows = bqQuery_([
    'SELECT CAST(window_start AS STRING) AS week, IFNULL(tier, \'\') AS tier,',
    "  IFNULL(issue_kind, '') AS issue_kind, IFNULL(failure_layer, '') AS failure_layer,",
    '  TO_JSON_STRING(voc_summary_secondary) AS summary_j, TO_JSON_STRING(stt) AS stt_j, TO_JSON_STRING(context) AS context_j',
    'FROM `' + JUDGMENTS_TABLE + '`',
    "WHERE exist = 'TRUE_PAIN' AND window_start >= @since",
    "  AND @code IN UNNEST(REGEXP_EXTRACT_ALL(IFNULL(pain25_tags, ''), r'[SUX][0-9]\\.[0-9]'))",
    "ORDER BY CASE tier WHEN 'sTop' THEN 0 WHEN 'Top' THEN 1 ELSE 2 END, window_start DESC, hit_id",   // hit_id 讓同週排序固定
    'LIMIT ' + (EXPORT_MAX + 1)
  ].join('\n'), [strParam_('code', code), dateParam_('since', since)], code + ' 輸出原話');
  var capped = rows.length > EXPORT_MAX;
  var out = {
    code: code, since: since, capped: capped,
    rows: rows.slice(0, EXPORT_MAX).map(function (r, i) {
      return { id: 'Q' + (i + 1), week: r.week, tier: r.tier || '一般',
               kind: r.issue_kind || '（未分類）', layer: r.failure_layer || '（未分類）',
               summary: clip_(jsonText_(r.summary_j), 300), text: clip_(jsonText_(r.stt_j), 1500),
               context: clip_(jsonText_(r.context_j), 800) };
    }),
    batch: TRANSLATE_BATCH
  };
  return out;
}

/** 原話／前後文若是結構資料，只輸出「文字類」欄位（白名單），其他欄位（主播 ID、發話者、時間…）一律不輸出。 */
var TEXT_KEY_RE = /^(text|texts|stt|utterance|utterances|content|contents|message|messages|comment|comments|body|sentence|sentences|transcript|line|lines|before|after|context|prev|next)$/i;

/** TO_JSON_STRING 的結果 → 純文字。字串、陣列轉成文字；物件只輸出白名單欄位；字串本身若是 JSON 物件就再拆一次。 */
function jsonText_(j) {
  if (j === null || j === undefined || j === 'null') return '';
  var v;
  try { v = JSON.parse(j); } catch (e) { return String(j); }
  var parts = [];
  (function walk(x) {
    if (x === null || x === undefined) return;
    if (typeof x === 'string') {
      var t = x.trim();
      if (/^[\[{]/.test(t)) { try { walk(JSON.parse(t)); return; } catch (e) { /* 不是 JSON，當一般文字 */ } }
      if (t) parts.push(t);
      return;
    }
    if (typeof x === 'number' || typeof x === 'boolean') { parts.push(String(x)); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    Object.keys(x).forEach(function (k) { if (TEXT_KEY_RE.test(k)) walk(x[k]); });
  })(v);
  return parts.join('\n');
}

// ═══════════════ Slack＋表單（VoC Daily Bot 試算表，只讀） ═══════════════

function rawTail_() {
  var sh = SpreadsheetApp.openById(VOC_SHEET_ID).getSheetByName('VoC_Raw_Log');
  if (!sh) throw new Error('找不到 VoC_Raw_Log 分頁');
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(last - 1, RAW_TAIL_ROWS);
  return sh.getRange(last - n + 1, 1, n, RAW_COLS).getValues();
}

function slackSummary_() {
  var out = { ok: true, problem: '', lastRun: '', bySource: [], latest: [] };
  var rows;
  try {
    rows = rawTail_();
  } catch (e) {
    out.ok = false;
    out.problem = '讀不到收集機器人的試算表：' + friendly_(e);
    return out;
  }
  var today = today_(), yest = addDays_(today, -1), wk = addDays_(today, -6);
  var src = {};
  rows.forEach(function (r) {
    var d = ymd_(r[RAW.ingested]);
    var o = collapse_(r[RAW.origin]) || '（未知）';
    var s = src[o] || (src[o] = { source: o, yesterday: 0, week: 0, matched: 0, cand: 0 });
    if (d === yest) s.yesterday++;
    if (d >= wk) {
      s.week++;
      var v = collapse_(r[RAW.verdict]);
      if (V_MATCH.indexOf(v) >= 0) s.matched++;
      if (v === V_NEW) s.cand++;
    }
  });
  out.bySource = Object.keys(src).map(function (k) { return src[k]; }).sort(function (a, b) { return b.week - a.week; });
  out.latest = rows.slice().reverse().slice(0, 20).map(voice_);
  try { out.lastRun = lastBotRun_(); } catch (e) { out.lastRun = ''; }
  return out;
}

function slackVoicesFor_(code) {
  try {
    return { problem: '', list: rawTail_().filter(function (r) { return collapse_(r[RAW.code]) === code; })
      .reverse().slice(0, 5).map(voice_) };
  } catch (e) {
    return { problem: '讀不到收集機器人的試算表：' + friendly_(e), list: [] };
  }
}

/** 一列 → 畫面用的聲音。不帶發話者（起票者）。 */
function voice_(r) {
  var link = String(r[RAW.link] || '');
  return {
    date: ymd_(r[RAW.occurred]) || ymd_(r[RAW.ingested]),
    source: collapse_(r[RAW.origin]),
    summary: clip_(collapse_(r[RAW.summary]), 200),
    body: clip_(String(r[RAW.body] || ''), 600),
    verdict: collapse_(r[RAW.verdict]),
    code: collapse_(r[RAW.code]),
    link: /^https:\/\//.test(link) ? link : ''
  };
}

/** VoC_Bot_Log 倒著找最後一次成功（DONE / DONE_WITH_WARNINGS）。 */
function lastBotRun_() {
  var sh = SpreadsheetApp.openById(VOC_SHEET_ID).getSheetByName('VoC_Bot_Log');
  if (!sh || sh.getLastRow() < 2) return '';
  var n = Math.min(sh.getLastRow() - 1, 400);
  var vals = sh.getRange(sh.getLastRow() - n + 1, 1, n, 3).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][1]) !== 'RUN') continue;
    var res = String(vals[i][2] || '');
    if (res === 'DONE' || res === 'DONE_WITH_WARNINGS') {
      var t = vals[i][0];
      return t instanceof Date ? Utilities.formatDate(t, TZ, 'yyyy/MM/dd HH:mm') : String(t);
    }
  }
  return '';
}

// ═══════════════ BigQuery（只接受具名參數） ═══════════════

function strParam_(name, value) {
  return { name: name, parameterType: { type: 'STRING' }, parameterValue: { value: String(value) } };
}

function dateParam_(name, ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) throw new Error('日期格式不對');
  return { name: name, parameterType: { type: 'DATE' }, parameterValue: { value: String(ymd) } };
}

function bqQuery_(sql, params, label) {
  var req = { query: sql, useLegacySql: false, timeoutMs: 60000, parameterMode: 'NAMED', queryParameters: params || [] };
  var res = withRetry_(function () { return BigQuery.Jobs.query(req, BQ_PROJECT); }, 'BigQuery ' + label);
  var jobId = res.jobReference.jobId, location = res.jobReference.location;
  var deadline = Date.now() + 3 * 60 * 1000;
  while (!res.jobComplete) {
    if (Date.now() > deadline) throw new Error('BigQuery ' + label + ' 超過 3 分鐘沒跑完');
    Utilities.sleep(1500);
    res = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { location: location, timeoutMs: 30000 });
  }
  var fields = res.schema.fields;
  var rows = (res.rows || []).slice();
  var token = res.pageToken;
  while (token) {
    var page = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { location: location, pageToken: token });
    rows = rows.concat(page.rows || []);
    token = page.pageToken;
  }
  return rows.map(function (r) {
    var o = {};
    fields.forEach(function (f, i) { o[f.name] = r.f[i].v === undefined ? null : r.f[i].v; });
    return o;
  });
}

// ═══════════════ repo 讀取（公開檔，不需要 token） ═══════════════

function repoJson_(path, optional) {
  var r = withRetry_(function () {
    var x = UrlFetchApp.fetch(REPO_RAW + path, { muteHttpExceptions: true });
    var c = x.getResponseCode();
    if (c === 429 || c >= 500) { var e = new Error('GitHub ' + c); e.transient = true; throw e; }
    return { code: c, text: x.getContentText('UTF-8') };
  }, '讀取 ' + path);
  if (r.code === 404 && optional) return null;
  if (r.code !== 200) {
    console.log('[ERROR] 讀取 ' + path + ' 回 ' + r.code);
    throw new Error('讀不到' + repoLabel_(path) + '（代碼 ' + r.code + '）');
  }
  return JSON.parse(r.text);
}

function repoLabel_(path) {
  if (/roadmap-bot/.test(path)) return ' Roadmap 每日紀錄';
  if (/mapping/.test(path)) return '「誰負責哪個痛點」的設定';
  return '痛點統計';
}

// ═══════════════ 快取（伺服器端；超過 30000 字自動分段） ═══════════════

function cacheGet_(key) {
  var c = CacheService.getScriptCache();
  var k = CACHE_VER + ':' + key;
  var head = c.get(k);
  if (!head) return null;
  try {
    var n = Number(head);
    if (!n) return JSON.parse(head.slice(1));
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(k + ':' + i);
    var parts = c.getAll(keys);
    var s = '';
    for (var j = 0; j < n; j++) {
      if (parts[keys[j]] == null) return null;
      s += parts[keys[j]];
    }
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function cachePut_(key, obj, degraded) {
  var ttl = degraded ? CACHE_SECONDS_DEGRADED : CACHE_SECONDS;
  var c = CacheService.getScriptCache();
  var k = CACHE_VER + ':' + key;
  var s = JSON.stringify(obj);
  var SIZE = 30000;   // CacheService 每個值上限 100KB（位元組）；中文 1 字約 3 bytes
  try {
    if (s.length < SIZE) { c.put(k, '=' + s, ttl); return; }
    var m = {}, n = Math.ceil(s.length / SIZE);
    for (var i = 0; i < n; i++) m[k + ':' + i] = s.slice(i * SIZE, (i + 1) * SIZE);
    c.putAll(m, ttl);
    c.put(k, String(n), ttl);
  } catch (e) {
    console.log('[WARN] 快取寫入失敗（不影響畫面，只是下次會比較慢）：' + e);
  }
}

function cacheRemove_(c, key) {
  var k = CACHE_VER + ':' + key;
  var head = c.get(k);
  var n = Number(head);
  for (var i = 0; i < (n || 0); i++) c.remove(k + ':' + i);
  c.remove(k);
}

// ═══════════════ 共用 ═══════════════

function withRetry_(fn, label) {
  var last;
  for (var i = 1; i <= 3; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      var msg = String(e && e.message);
      var transient = e.transient || /backendError|rateLimitExceeded|internalError|timed out|Timeout|503|502|500/.test(msg);
      if (!transient || i === 3) throw e;
      console.log('[RETRY] ' + label + '（第 ' + i + ' 次）：' + msg);
      Utilities.sleep(Math.pow(2, i) * 1000);
    }
  }
  throw last;
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function addDays_(ymd, n) {
  var p = String(ymd).split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function daysBetween_(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

/** Sheet 的日期儲存格可能是 Date 或 'yyyy/MM/dd' 字串 → 'yyyy-MM-dd'。 */
function ymd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  var m = String(v || '').match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function collapse_(s) { return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim(); }

function clip_(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

// ═══════════════ 頁面（由 build_gas.py 從 Page.html 填入，不要手改） ═══════════════

var PAGE_HTML = __PAGE_HTML__;
