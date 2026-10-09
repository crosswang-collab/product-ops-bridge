/**
 * VoC 作戰台 —— 單一儀表板（Apps Script 網頁；唯一會寫的是「誰負責哪個痛點」）
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
 * === 唯一的寫入：「誰負責哪個痛點」（2026-10-07 Cross 決定，取代另一個編輯頁）===
 * saveOwnerCards() 只有 OWNER_EMAIL 能用、只寫 voc-graph/mapping.json 的 pain_to_cards 一個欄位。
 * GitHub 金鑰放在「專案設定 → 指令碼屬性」GITHUB_TOKEN，不在程式裡、不進 repo。其他一律只讀、不建 Sheet。
 * 資料來源：
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

/**
 * 「該找哪個 PM」：痛點 → 團隊 → PM。
 * 痛點已有負責的卡時，用卡的團隊；還沒有卡時，用下面 PAIN_TEAM 的預設建議（Cross 可直接改）。
 */
var TEAM_PM = {            // 團隊 → PM（2026-10-07 Cross 提供）
  '17App': 'Charlene', 'IST': 'YC', 'Internal Tool': 'Stacey', 'Platform': 'Stella', 'Live Commerce': 'Belle'
};
var PAIN_TEAM = {          // 痛點 → 團隊：Cross 自己對照（2026-10-07 決定），想固定某個痛點的團隊再填，例如 'U6.0': 'IST'
};
/** 給資料團隊的需求說明（只有 Cross 看得到連結）與「清單外的聲音」分類說明。 */
var DATA_MEMO_URL = 'https://claude.ai/code/artifact/328a0a94-dfbe-4b4b-bcaa-7380e57a0a36';
var UNMAPPED_GUIDE_URL = 'https://github.com/crosswang-collab/product-ops-bridge/blob/main/docs/unmapped-voices-classification.md';
/** 開卡用的 Google 試算表網址（空白＝畫面不顯示「開卡」按鈕）。 */
var CARD_SHEET_URL = 'https://docs.google.com/spreadsheets/d/16AuZeGSu2z1PwnTvhZI2HazyG16zltOs7eRxEC04rcE/edit?gid=1005872232#gid=1005872232';

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
var CACHE_VER = 'v2';   // v2：加了可信度與清單外的聲音
var RAW_TAIL_ROWS = 4000;       // Slack＋表單只讀最新幾列
var TZ = 'Asia/Tokyo';

var EMERGE_MIN = 10;            // 新興：最近 2 週每週平均 ≥ 10 位
var PERSIST_MIN = 20;           // 持續：最近 6 週中 ≥ 4 週 ≥ 20 位
var TRUST_MIN_SHARE = 0.2;       // 可信：最近 4 週判讀為真痛點的人數 ≥ 週報人數的 2 成
var TRUST_MIN_JUDGED = 5;        //       且至少 5 人週
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
  d.canAssign = d.canEdit && !!PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!d.canEdit) { d.editorUrl = ''; d.cardSheetUrl = ''; d.dataMemoUrl = ''; d.unmappedGuideUrl = ''; }
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
  var res = buildPainDetail_(code, dash ? dash.detailSince : detailSince_());
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
  var out = {}, lastMsg = '';
  for (var i = 0; i < batch.length; i++) {
    try {
      out[batch[i].id] = clip_(String(LanguageApp.translate(batch[i].text, '', 'zh-TW') || ''), 2000);
    } catch (e) {
      var msg = String(e && e.message || e);
      console.log('[ERROR] 翻譯 ' + batch[i].id + '：' + msg);
      lastMsg = msg;
      if (!/too many times|invoked too many|quota|次數過多|次数过多|回数が多すぎ/i.test(msg)) continue;   // 這一則有問題：跳過
      if (Object.keys(out).length) return out;
      throw new Error(/one day|per day|daily|一天|1日/i.test(msg)
        ? '今天的 Google 翻譯次數用完了，明天再按「補翻」'
        : 'Google 翻譯一時太忙，等一分鐘再按「補翻」');
    }
  }
  // 整批一則都沒翻到：多半是服務本身出問題（錯誤訊息可能是中文或日文，上面沒認出來），讓頁面停下說原因
  if (batch.length && !Object.keys(out).length && lastMsg) throw new Error('Google 翻譯失敗：' + clip_(lastMsg, 120));
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

/**
 * 指定某個痛點負責的卡（只有 Cross）。keys＝卡號陣列（空陣列＝清掉）。
 * 寫回 repo 的 voc-graph/mapping.json，並更新快取，畫面馬上看到；每天的對照圖也會跟著重算。
 */
function saveOwnerCards(code, keys) {
  var who = assertAllowed_();
  if (who !== OWNER_EMAIL.toLowerCase()) throw new Error('只有 Cross 可以指定負責的卡');
  code = assertPainCode_(code);
  if (!Array.isArray(keys) || keys.length > 10) throw new Error('卡的資料格式不對（最多 10 張）');
  var clean = keys.map(String).filter(function (k, i, a) { return a.indexOf(k) === i; }).sort();
  clean.forEach(function (k) { if (!/^APPIDEAS-\d{1,6}$/.test(k)) throw new Error('卡號格式不對：' + k); });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('另一個存檔正在進行，請稍等幾秒再按一次');
  try {
    var tries = 0;
    while (true) {
      tries++;
      var cur = ghGetFile_(MAPPING_PATH);
      var doc = cur.doc || {};
      var map = doc.pain_to_cards || {};
      if (clean.length) map[code] = clean; else delete map[code];
      doc.pain_to_cards = map;
      var res = ghPutFile_(MAPPING_PATH, JSON.stringify(doc, null, 1) + '\n', cur.sha,
        'mapping: ' + code + ' → ' + (clean.join(', ') || '（清掉）') + '（Cross 在儀表板指定）');
      if (res === 'conflict' && tries < 2) continue;   // 剛好有別處同時改：重讀一次再存
      if (res === 'conflict') throw new Error('對應表剛被別處改過，請重新整理頁面再存一次');
      break;
    }
  } finally {
    lock.releaseLock();
  }

  // 主資料一起更新並放回快取：重新整理就看得到，不用等 6 小時，也不會讀到舊的對應表
  var d = cacheGet_('dash');
  if (!d) { try { d = buildDashboard_(); } catch (e) { d = null; } }
  var out = { ok: true, code: code, cards: clean, noOwner: false, team: '', teamFromCards: false };
  if (d) {
    var domainOf = {};
    d.cards.forEach(function (c) { domainOf[c.key] = c.domain; });
    d.pains.forEach(function (p) {
      if (p.code !== code) return;
      var teams = clean.map(function (k) { return domainOf[k]; }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
      p.cards = clean;
      p.noOwner = !clean.length && p.latest >= READ_FLOOR;
      p.team = teams.length ? teams.join('、') : (PAIN_TEAM[p.code] || '');
      p.teamFromCards = teams.length > 0;
      out.noOwner = p.noOwner; out.team = p.team; out.teamFromCards = p.teamFromCards;
    });
    d.unbacked = (d.unbacked || []).filter(function (c) { return clean.indexOf(c.key) < 0; });   // 剛指定的卡不再算「沒對到痛點」
    out.assigned = clean;
    cachePut_('dash', d, d.sttSource !== 'bigquery' || !d.slack.ok);
  }
  return out;
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

/** 確認儀表板能不能寫「誰負責哪個痛點」（只讀一次，不寫）。 */
function testGithub() {
  var who = viewer_();
  if (!isAllowed_(who)) throw new Error('沒有權限');
  try {
    var f = ghGetFile_(MAPPING_PATH);
    var n = Object.keys((f.doc && f.doc.pain_to_cards) || {}).length;
    console.log('✅ GitHub 金鑰可以用：目前 ' + n + ' 個痛點已指定負責的卡');
  } catch (e) {
    console.log('❌ ' + e.message);
  }
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

  var trust = trust_(g.nodes.themes, weeks.slice(-4));   // 和畫面的週次對齊：最近 4 個已過完的週

  var domainOf = {};
  rm.cards.forEach(function (c) { domainOf[c.key] = c.domain; });
  var pains = g.nodes.pains.map(function (p) {
    var s = series.byCode[p.code] || weeks.map(function () { return 0; });
    var cards = p2c[p.code] || [];
    var cardTeams = cards.map(function (k) { return domainOf[k]; }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
    return {
      code: p.code, title: p.title, vocScore: p.voc_score, series: s, latest: s[s.length - 1],
      cards: cards, noOwner: !cards.length && s[s.length - 1] >= READ_FLOOR,
      allZero: !s.some(function (v) { return v > 0; }),
      rule: classify_(s), themes: themesOf[p.code] || [],
      trust: s.some(function (v) { return v > 0; }) ? (trust.byCode[p.code] || trust.unknown) : { state: 'none' },
      team: cardTeams.length ? cardTeams.join('、') : (PAIN_TEAM[p.code] || ''),
      teamFromCards: cardTeams.length > 0
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
    detailSince: detailSince_(),
    sttSource: sttSource, sttProblem: sttProblem, missingWeeks: series.missing,
    sttAgeDays: daysBetween_(endDate, today_()),
    jiraAsOf: rm.as_of_date,
    jiraAgeDays: daysBetween_(rm.as_of_date, today_()),
    pains: pains,
    outside: (g.views.outside_catalog || []).map(function (o) {
      return { code: o.code, latest: o.latest, theme: trust.topTheme[o.code] || null };
    }),
    untagged: trust.untagged,
    trustSince: trust.since,
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
    teamPm: TEAM_PM,
    cardSheetUrl: CARD_SHEET_URL,
    dataMemoUrl: DATA_MEMO_URL,
    unmappedGuideUrl: UNMAPPED_GUIDE_URL,
    rules: { emergeMin: EMERGE_MIN, persistMin: PERSIST_MIN },
    slack: slackSummary_()
  };
}

/**
 * 每個痛點的「可信度」：週報人數（關鍵字統計）有多少經過 AI 判讀、而且判成真痛點。
 * 來源：STT Export 每天推進 repo 的 stt-latest.json（pains＝週報、coverage＝判讀覆蓋率），只有人數，沒有原話。
 * ok＝可信（原話夠）／thin＝有人數但原話不足／unknown＝還沒有覆蓋率資料。週報全是 0 的痛點在呼叫端標 none。
 */
function trust_(themeNodes, last4) {
  var out = { byCode: {}, unknown: { state: 'unknown' }, untagged: null, topTheme: {}, since: '' };
  var doc = null;
  try { doc = repoJson_('voc-graph/out/stt-latest.json', true); } catch (e) { console.log('[WARN] 覆蓋率讀不到：' + e.message); }
  if (!doc || !doc.coverage || !doc.pains || !last4 || !last4.length) return out;
  var last = last4[last4.length - 1];
  // 覆蓋率必須涵蓋畫面的最近一週，否則不下判斷（避免整片誤標成「原話不足」）
  if (!doc.coverage.some(function (r) { return r.window_start === last; })) return out;
  out.since = last4[0];
  var metric = {}, judged = {}, untag = {}, tagged = {};
  doc.pains.forEach(function (r) {
    if (last4.indexOf(r.window_start) >= 0) metric[r.code] = (metric[r.code] || 0) + (Number(r.streamers) || 0);
  });
  doc.coverage.forEach(function (r) {
    if (r.exist !== 'TRUE_PAIN' || last4.indexOf(r.window_start) < 0) return;
    var n = Number(r.streamers) || 0;
    if (r.code === '(無代碼)') untag[r.window_start] = (untag[r.window_start] || 0) + n;
    else {
      judged[r.code] = (judged[r.code] || 0) + n;
      tagged[r.window_start] = (tagged[r.window_start] || 0) + n;
    }
  });
  Object.keys(metric).forEach(function (code) {
    var m = metric[code], j = judged[code] || 0;
    out.byCode[code] = { state: (j >= TRUST_MIN_JUDGED && j >= m * TRUST_MIN_SHARE) ? 'ok' : 'thin', metric4: m, judged4: j };
  });
  var u4 = last4.map(function (w) { return untag[w] || 0; });
  out.untagged = { latest: untag[last] || 0, avg4: Math.round(u4.reduce(function (a, b) { return a + b; }, 0) / last4.length),
                   taggedLatest: tagged[last] || 0, week: last };
  var names = {};
  (themeNodes || []).forEach(function (t) { names[t.code] = t.name; });
  var tp = {};
  (doc.theme_pain || []).forEach(function (r) {
    if (last4.indexOf(r.window_start) < 0) return;
    var k = r.pain + '|' + r.theme;
    tp[k] = (tp[k] || 0) + (Number(r.streamers) || 0);
  });
  Object.keys(tp).forEach(function (k) {
    var pr = k.split('|'), cur = out.topTheme[pr[0]];
    if (!cur || tp[k] > cur.n) out.topTheme[pr[0]] = { code: pr[1], name: names[pr[1]] || '', n: tp[k] };
  });
  return out;
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
    '  AND window_start >= @since AND window_start < @before',   // 還沒過完的本週不算（避免把半週當最新週）
    'QUALIFY ROW_NUMBER() OVER (PARTITION BY window_start, metric_key ORDER BY loaded_at DESC) = 1'
  ].join('\n');
  var since = addDays_(today_(), -(SERIES_WEEKS + 8) * 7);   // 多抓 8 週：週報晚到時也不會誤報缺週
  var rows = bqQuery_(sql, [dateParam_('since', since), dateParam_('before', monday_(today_()))], '25 痛點週人數');
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since))) since = detailSince_();
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
  var since = detailSince_();
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
    var o = sourceLabel_(r);
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
/** 來源名稱：Slack 依頻道分開（「Slack #jp-user-feedback」），討論串回覆算同一個頻道。 */
function sourceLabel_(r) {
  var o = collapse_(r[RAW.origin]) || '（未知）';
  if (o !== 'Slack') return o;
  var ch = collapse_(r[RAW.originDet]).replace(/（スレッド）$/, '');
  return ch ? o + ' ' + ch : o;
}

function voice_(r) {
  var link = String(r[RAW.link] || '');
  return {
    date: ymd_(r[RAW.occurred]) || ymd_(r[RAW.ingested]),
    source: sourceLabel_(r),
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

// ═══════════════ GitHub（只用在「誰負責哪個痛點」） ═══════════════

var MAPPING_PATH = 'voc-graph/mapping.json';
var GH_API = 'https://api.github.com/repos/crosswang-collab/product-ops-bridge/contents/';

function ghToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!t) throw new Error('還沒設定 GitHub 金鑰：照說明文件「在儀表板指定負責的卡」的第一次設定做一次');
  return t.trim();
}

function ghHeaders_() {
  return { Authorization: 'Bearer ' + ghToken_(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

/** 讀 repo 檔案（main 分支），回傳 {sha, doc}。 */
function ghGetFile_(path) {
  var x = UrlFetchApp.fetch(GH_API + path + '?ref=main', { headers: ghHeaders_(), muteHttpExceptions: true });
  var c = x.getResponseCode();
  if (c === 401 || c === 403) throw new Error('GitHub 金鑰不對或過期：照說明文件「在儀表板指定負責的卡」換一把新的');
  if (c !== 200) throw new Error('讀不到「誰負責哪個痛點」的設定（代碼 ' + c + '）');
  var j = JSON.parse(x.getContentText('UTF-8'));
  if (!j.content) throw new Error('「誰負責哪個痛點」的設定讀到空白，請稍後再試');
  var text = Utilities.newBlob(Utilities.base64Decode(String(j.content || '').replace(/\s/g, ''))).getDataAsString('UTF-8');
  return { sha: j.sha, doc: JSON.parse(text) };
}

/** 寫 repo 檔案；sha 不符（別處剛改過）回傳 'conflict'。 */
function ghPutFile_(path, text, sha, message) {
  var x = UrlFetchApp.fetch(GH_API + path, {
    method: 'put', contentType: 'application/json', headers: ghHeaders_(), muteHttpExceptions: true,
    payload: JSON.stringify({ message: message, content: Utilities.base64Encode(text, Utilities.Charset.UTF_8), sha: sha, branch: 'main' })
  });
  var c = x.getResponseCode();
  if (c === 409 || c === 422) return 'conflict';
  if (c === 401 || c === 403) throw new Error('GitHub 金鑰不對、過期或不能存檔：照說明文件「在儀表板指定負責的卡」換一把新的');
  if (c !== 200 && c !== 201) throw new Error('存不進去（代碼 ' + c + '），請稍後再試');
  return 'ok';
}

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

/** 該日所在那週的週一（週報以週一為一週開始）。 */
function monday_(ymd) {
  var p = String(ymd).split('-');
  var dow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();   // 0=日
  return addDays_(ymd, -((dow + 6) % 7));
}

/** 「最近 4 週」＝最近 4 個完整的週（從週一算），加上本週已有的部分。 */
function detailSince_() { return addDays_(monday_(today_()), -DETAIL_WEEKS * 7); }

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

var PAGE_HTML = "<title>VoC 作戰台<\/title>\n<style>\n/* 報刊編輯風（Cross Editorial）：單欄長文、紙色底、朱紅只給主角；無圓角、無陰影、無卡片框。\n   字體只用本機已有的字（不連外部字型服務，符合「不載入外部資源」的安全規則）。 */\n:root{\n  --paper:#FBF9F4; --paper-2:#F1EDE4; --ink:#151515; --ink-2:#5A5650; --hairline:#D9D3C7;\n  --accent:#B23A24; --context:#A39C90; --series-2:#2B5C70; --ok:#2B5C70; --warn:#9A6B12;\n  --font-display:\"Libre Caslon Display\",\"Noto Serif TC\",\"Noto Serif CJK TC\",\"Songti TC\",\"Source Han Serif TC\",serif;\n  --font-serif:\"Libre Caslon Text\",\"Noto Serif TC\",\"Noto Serif CJK TC\",\"Songti TC\",\"Source Han Serif TC\",serif;\n  --font-sans:\"Libre Franklin\",\"Noto Sans TC\",\"Noto Sans CJK TC\",\"PingFang TC\",\"Microsoft JhengHei\",system-ui,sans-serif;\n  --mono:ui-monospace,\"SF Mono\",Menlo,Consolas,monospace;\n  color-scheme:light;\n}\n@media (prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){\n  --paper:#141312; --paper-2:#1F1D1A; --ink:#EEE9E0; --ink-2:#ACA59B; --hairline:#3B3834;\n  --accent:#EE7B63; --context:#77716A; --series-2:#86B6CA; --ok:#86B6CA; --warn:#DDAE5A; color-scheme:dark}}\n:root[data-theme=\"dark\"]{\n  --paper:#141312; --paper-2:#1F1D1A; --ink:#EEE9E0; --ink-2:#ACA59B; --hairline:#3B3834;\n  --accent:#EE7B63; --context:#77716A; --series-2:#86B6CA; --ok:#86B6CA; --warn:#DDAE5A; color-scheme:dark}\n*{box-sizing:border-box}\nbody{background:var(--paper);color:var(--ink);font-family:var(--font-serif);font-size:17px;line-height:1.8;margin:0;-webkit-text-size-adjust:100%}\n.wrap{max-width:760px;margin:0 auto;padding:0 16px 56px}\n.status{font-family:var(--font-sans);font-size:13px;color:var(--warn);border-bottom:1px solid var(--hairline);padding:10px 0;margin:0}\na{color:var(--series-2);text-underline-offset:3px}\nbutton{font:inherit}\n\n/* ---- 刊頭 ---- */\nheader.mast{text-align:center;padding:36px 0 22px;border-bottom:1px solid var(--ink)}\n.kicker{font-family:var(--font-sans);font-size:12.5px;letter-spacing:.14em;color:var(--accent);font-weight:700;text-transform:uppercase}\nh1.hl{font-family:var(--font-display);font-weight:700;font-size:clamp(28px,5.6vw,44px);line-height:1.22;margin:10px auto 12px;max-width:16em;text-wrap:balance}\n.dek{font-size:clamp(16px,2.4vw,19px);color:var(--ink-2);margin:0 auto;max-width:34em;text-wrap:pretty}\n.dek b{color:var(--ink);font-weight:700}\n.byline{font-family:var(--font-sans);font-size:12.5px;color:var(--ink-2);margin-top:14px;letter-spacing:.02em}\n.hl-go{margin-top:16px}\n\n/* ---- 頁內導覽 ---- */\nnav.toc{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:1px solid var(--hairline);display:flex;gap:2px 18px;flex-wrap:wrap;justify-content:center;padding:8px 0;font-family:var(--font-sans);font-size:13px}\n@media (max-width:620px){nav.toc{flex-wrap:nowrap;overflow-x:auto;justify-content:flex-start;padding:8px 0}nav.toc a{white-space:nowrap}}\nnav.toc a{color:var(--ink-2);text-decoration:none;padding:2px 0;border-bottom:2px solid transparent}\nnav.toc a:hover,nav.toc a:focus-visible{color:var(--ink);border-bottom-color:var(--accent)}\n\n/* ---- 段落 ---- */\nsection.sec{padding-top:34px;scroll-margin-top:52px}\n.sec-k{font-family:var(--font-sans);font-size:12px;letter-spacing:.14em;color:var(--accent);font-weight:700}\nh2.sec-h{font-family:var(--font-display);font-size:clamp(22px,3.4vw,27px);line-height:1.3;margin:4px 0 6px}\n.sec-dek{color:var(--ink-2);margin:0 0 12px;font-size:16px}\n.note{font-family:var(--font-sans);font-size:12.5px;color:var(--ink-2);line-height:1.6;margin-top:8px}\n.empty{font-family:var(--font-sans);font-size:14px;color:var(--ink-2);padding:10px 0}\n\n/* ---- 要聞（一則痛點） ---- */\n.stories{border-top:1px solid var(--ink)}\narticle.story{border-bottom:1px solid var(--hairline)}\n.sh{display:grid;grid-template-columns:34px minmax(0,1fr) 104px;gap:2px 12px;padding:16px 0 14px;cursor:pointer;align-items:start}\n.sh:hover .sh-t{text-decoration:underline;text-decoration-color:var(--hairline);text-underline-offset:5px}\n.sh:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.rank{font-family:var(--font-display);font-size:30px;line-height:1;color:var(--ink-2)}\n.sh-k{font-family:var(--font-sans);font-size:12px;letter-spacing:.06em;color:var(--ink-2)}\n.sh-k .code{color:var(--ink);font-weight:700;letter-spacing:.04em}\n.sh-t{font-family:var(--font-display);font-size:clamp(19px,2.8vw,23px);line-height:1.35;margin:2px 0 4px;font-weight:700}\n.sh-l{margin:0;font-size:16px;line-height:1.7}\n.sh-l b{font-variant-numeric:tabular-nums}\n.sh-m{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-family:var(--font-sans);font-size:12.5px;color:var(--ink-2)}\n.spark{display:flex;flex-direction:column;align-items:flex-end;font-family:var(--font-sans)}\n.spark .big{font-family:var(--font-display);font-size:28px;line-height:1;font-variant-numeric:tabular-nums}\n.spark small{font-size:11px;color:var(--ink-2);margin-bottom:4px}\n.spark svg{display:block}\n.open-hint{font-family:var(--font-sans);font-size:12px;color:var(--series-2);margin-top:6px}\n.compact .sh{grid-template-columns:52px minmax(0,1fr) 92px;padding:11px 0}\n.compact .sh-t{font-size:17px;margin:0}\n.compact .rank{font-family:var(--font-sans);font-size:12px;color:var(--ink);font-weight:700;padding-top:4px}\n.more-stories{margin-top:12px}\n@media (max-width:520px){.sh{grid-template-columns:26px minmax(0,1fr)}.spark{grid-column:2;flex-direction:row;align-items:baseline;gap:8px;justify-content:flex-start}\n  .compact .sh{grid-template-columns:44px minmax(0,1fr)}.rank{font-size:24px}}\n\n/* ---- 可信度標示 ---- */\n.trust{font-family:var(--font-sans);font-size:12.5px;white-space:nowrap}\n.t-ok{color:var(--ok)} .t-thin{color:var(--warn)} .t-none{color:var(--accent)}\n.tag{font-family:var(--font-sans);font-size:12px;color:var(--ink-2)}\n.tag.hot{color:var(--ink);font-weight:700}\n.tag.fire{color:var(--accent);font-weight:700}\n\n/* ---- 展開的細節 ---- */\n.dbody{padding:4px 0 26px 46px}\n@media (max-width:520px){.dbody{padding-left:0}}\n.dbody h3{font-family:var(--font-sans);font-size:12.5px;letter-spacing:.1em;color:var(--ink-2);margin:26px 0 8px;font-weight:700}\n.next{border-top:2px solid var(--ink);padding:10px 0 4px;margin-top:6px}\n.next h3{margin:0 0 6px;color:var(--ink)}\n.next ol{margin:0;padding-left:22px;display:grid;gap:6px;font-size:16px}\n.next .btn{margin-left:6px}\n.trustbox{border-left:3px solid var(--warn);padding:2px 0 2px 12px;margin:14px 0 4px;font-size:15.5px;line-height:1.7}\n.trustbox.ok{border-left-color:var(--ok)} .trustbox.none{border-left-color:var(--accent)}\n.btn{font-family:var(--font-sans);font-size:13px;border:1px solid var(--ink);background:transparent;color:var(--ink);padding:4px 11px;cursor:pointer;display:inline-block;text-decoration:none;line-height:1.5}\n.btn:hover{background:var(--paper-2)}\n.btn.primary{background:var(--ink);color:var(--paper)}\n.btn.primary:hover{opacity:.88}\n.btn:focus-visible,.chipf:focus-visible,nav.toc a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}\n.btn[disabled]{opacity:.5;cursor:default}\n.row{display:grid;grid-template-columns:56px minmax(0,1fr);gap:4px 10px;padding:8px 0;border-top:1px solid var(--hairline);align-items:baseline;font-size:15.5px}\n.code{font-family:var(--mono);font-size:12px;color:var(--ink-2)}\n.chips{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:3px;font-family:var(--font-sans);font-size:12px;color:var(--ink-2)}\n.chip{white-space:nowrap}\n.c-hot{color:var(--accent);font-weight:700} .c-warn{color:var(--warn);font-weight:700} .c-ok{color:var(--ok)} .c-mute{color:var(--ink-2)}\n\n/* 圖表框：頂部 1px 墨線＋左端朱紅短標、標題是主張、左下來源 */\n.cframe{border-top:1px solid var(--ink);position:relative;padding-top:10px;margin:8px 0 4px}\n.cframe::before{content:\"\";position:absolute;left:0;top:-3px;width:28px;height:5px;background:var(--accent)}\n.ctitle{font-family:var(--font-sans);font-size:16px;font-weight:700;line-height:1.4}\n.csub{font-family:var(--font-sans);font-size:12.5px;color:var(--ink-2);margin-bottom:6px}\n.csrc{font-family:var(--font-sans);font-size:11px;color:var(--ink-2);margin-top:4px}\n.cframe svg{display:block;max-width:100%}\n.rules{display:grid;gap:4px;margin-top:8px;font-family:var(--font-sans);font-size:13px;line-height:1.6}\n.rule{display:grid;grid-template-columns:18px minmax(0,1fr);gap:6px}\n.rule .mk{font-weight:700} .rule.yes .mk{color:var(--accent)} .rule.no{color:var(--ink-2)}\n\n.quote{border-top:1px solid var(--hairline);padding:12px 0}\n.quote:first-of-type{border-top:0}\n.quote .sum{font-family:var(--font-sans);font-weight:700;font-size:14px}\n.quote .txt{margin:6px 0;font-size:17px;line-height:1.8}\n.quote .meta{font-family:var(--font-sans);font-size:12px;color:var(--ink-2)}\n.ctx{margin-top:8px;padding:10px 12px;background:var(--paper-2);font-size:14.5px;white-space:pre-wrap}\n.warnline{font-family:var(--font-sans);font-size:13.5px;color:var(--warn);margin:0 0 8px;line-height:1.6}\n.sub{display:grid;grid-template-columns:minmax(0,1fr) 64px;gap:4px 10px;padding:6px 0;border-top:1px solid var(--hairline);font-family:var(--font-sans);font-size:13.5px}\n.sub:first-of-type{border-top:0}\n.sub .n{text-align:right;font-variant-numeric:tabular-nums}\ndetails.more{margin-top:22px;border-top:1px solid var(--hairline);padding-top:8px}\ndetails.more>summary{cursor:pointer;font-family:var(--font-sans);font-size:13px;color:var(--ink-2);font-weight:700}\n.assign{margin-top:10px;border-top:1px dashed var(--hairline);padding-top:10px}\n.assign .find{font-family:var(--font-sans);font-size:14px;width:100%;padding:6px 8px;border:1px solid var(--ink-2);background:var(--paper);color:var(--ink)}\n.pick{max-height:260px;overflow-y:auto;margin-top:6px;border:1px solid var(--hairline)}\n.pk{display:grid;grid-template-columns:20px 48px minmax(0,1fr) auto;gap:6px;align-items:center;padding:6px 8px;border-top:1px solid var(--hairline);font-family:var(--font-sans);font-size:13px;cursor:pointer}\n.pk:first-child{border-top:0}\n.pk:hover{background:var(--paper-2)}\n\n/* ---- 清單外 ---- */\n.off{display:grid;grid-template-columns:minmax(0,1fr);gap:0;border-top:1px solid var(--ink)}\n.off-i{display:grid;grid-template-columns:112px minmax(0,1fr);gap:4px 16px;padding:16px 0;border-bottom:1px solid var(--hairline);align-items:start}\n.off-n{font-family:var(--font-display);font-size:38px;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums}\n.off-n small{display:block;font-family:var(--font-sans);font-size:11.5px;color:var(--ink-2);margin-top:6px;line-height:1.4}\n.off-t{font-family:var(--font-display);font-size:19px;font-weight:700;line-height:1.35}\n.off-i p{margin:4px 0 0;font-size:16px}\n@media (max-width:520px){.off-i{grid-template-columns:1fr}}\n.action{margin-top:14px;font-size:16px}\n.action b{font-family:var(--font-sans)}\n\n/* ---- 篩選、表格 ---- */\n.filters{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}\n.chipf{font-family:var(--font-sans);font-size:12.5px;border:1px solid var(--hairline);background:transparent;color:var(--ink);padding:3px 10px;cursor:pointer}\n.chipf[aria-pressed=\"true\"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}\n.tbl{overflow-x:auto}\ntable{border-collapse:collapse;width:100%;font-family:var(--font-sans);font-size:13.5px}\nth,td{text-align:left;padding:8px 8px 8px 0;border-top:1px solid var(--hairline);vertical-align:top}\nthead th{border-top:1px solid var(--ink);color:var(--ink-2);font-weight:700;font-size:12px}\ntd.n{text-align:right;font-variant-numeric:tabular-nums}\n.stagebar{display:flex;height:24px;margin:8px 0}\n.stagebar div{display:flex;align-items:center;justify-content:center;font-family:var(--font-sans);font-size:12px;color:var(--paper);background:var(--ink);min-width:0;overflow:hidden;white-space:nowrap;border-right:2px solid var(--paper)}\n.stagebar div:nth-child(2){background:var(--series-2)}.stagebar div:nth-child(3){background:var(--context)}.stagebar div:nth-child(4){background:var(--ink-2)}\n.legend{font-family:var(--font-sans);font-size:12px;color:var(--ink-2)}\n.sub-h{font-family:var(--font-display);font-size:19px;margin:26px 0 6px}\nfooter.src{margin-top:40px;border-top:1px solid var(--ink);padding-top:10px}\nfooter.src>details>summary{cursor:pointer;font-family:var(--font-sans);font-size:12.5px;color:var(--ink-2)}\n@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}\n<\/style>\n\n<div class=\"wrap\">\n  <p class=\"status\" id=\"status\" role=\"status\">資料讀取中…（第一次打開約 20–40 秒，之後 6 小時內會很快）<\/p>\n\n  <header class=\"mast\">\n    <div class=\"kicker\" id=\"kicker\">VoC 週報｜WEEKLY BRIEF<\/div>\n    <h1 class=\"hl\" id=\"hl\"><\/h1>\n    <p class=\"dek\" id=\"dek\"><\/p>\n    <div class=\"byline\" id=\"byline\"><\/div>\n    <div class=\"hl-go\" id=\"hlgo\"><\/div>\n  <\/header>\n  <nav class=\"toc\" id=\"toc\" aria-label=\"本頁段落\"><\/nav>\n\n  <main id=\"view\"><\/main>\n  <footer class=\"src\"><details id=\"sources\"><summary id=\"srcline\">資料來源<\/summary><div id=\"srcbody\"><\/div><\/details><\/footer>\n<\/div>\n\n<script>\n(function () {\n  \"use strict\";\n  var D = null;\n  var HELP = \"請重新整理；一直失敗的話，在 Apps Script 編輯器執行 testDashboard，把紀錄貼給 Claude。\";\n  /* 伺服器或 Apps Script 本身的英文錯誤不直接給人看，改成中文說明 */\n  function errText(e) {\n    var m = String(e && e.message ? e.message : e).replace(/^\\s*(Error|Exception|ScriptError)\\s*:\\s*/i, \"\");\n    return /[一-鿿]/.test(m) ? m : \"暫時讀不到\";   // 我們自己的訊息都是中文；純英文的系統錯誤不直接給人看\n  }\n  var detailCache = {};\n\n  /* ---- 安全的 DOM 小工具：只用 createElement / textContent 放文字，不把字串當 HTML 解析 ---- */\n  function el(tag, attrs, kids) {\n    var n = document.createElement(tag);\n    if (attrs) for (var k in attrs) {\n      if (k === \"text\") n.textContent = attrs[k];\n      else if (k === \"class\") n.className = attrs[k];\n      else if (k.slice(0, 2) === \"on\") n.addEventListener(k.slice(2), attrs[k]);\n      else n.setAttribute(k, attrs[k]);\n    }\n    (kids || []).forEach(function (c) {\n      if (c == null) return;\n      n.appendChild(typeof c === \"string\" ? document.createTextNode(c) : c);\n    });\n    return n;\n  }\n  function svg(tag, attrs) {\n    var n = document.createElementNS(\"http://www.w3.org/2000/svg\", tag);\n    for (var k in attrs) n.setAttribute(k, attrs[k]);\n    return n;\n  }\n  function svgText(attrs, s) { var t = svg(\"text\", attrs); t.textContent = s; return t; }\n  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }\n  function md(iso) { var p = String(iso || \"\").split(\"-\"); return p.length === 3 ? (+p[1]) + \"/\" + (+p[2]) : \"—\"; }\n  function safeUrl(u) { return /^https:\\/\\//.test(u || \"\") ? u : null; }\n  function link(href, text) {\n    var u = safeUrl(href);\n    return u ? el(\"a\", { href: u, target: \"_blank\", rel: \"noopener\", text: text }) : el(\"span\", { text: text });\n  }\n  function reduce() { return window.matchMedia && window.matchMedia(\"(prefers-reduced-motion: reduce)\").matches; }\n  /* 混合粗體的一行字：parts = [[文字, 是否粗體], …] */\n  function rich(tag, attrs, parts) {\n    var n = el(tag, attrs);\n    parts.forEach(function (x) { if (x[0] === \"\" || x[0] == null) return; n.appendChild(x[1] ? el(\"b\", { text: String(x[0]) }) : document.createTextNode(String(x[0]))); });\n    return n;\n  }\n\n  var keep = null;   // 存檔後重畫時保留：哪一則展開、在哪一區、篩選\n  function init() {\n  [\"dek\", \"hl\", \"byline\", \"hlgo\", \"toc\", \"srcbody\"].forEach(function (id) { clear(document.getElementById(id)); });\n  var R = D.rules;\n  var weekLbl = D.weeks.map(md);\n  var view = document.getElementById(\"view\");\n  clear(view);\n\n  /* ---- 痛點排序：🔥 → 🔁 且沒人負責 → 其他沒人負責；同組內依上週人數（原話不足的照樣照人數排，只加標示） ---- */\n  function prio(p) {\n    if (p.rule.emerging) return 0;\n    if (p.rule.persistent && p.noOwner) return 1;\n    if (p.rule.persistent) return 2;\n    if (p.noOwner) return 3;\n    if (p.rule.fading) return 4;\n    return 9;\n  }\n  var pains = D.pains.slice().sort(function (a, b) { return prio(a) - prio(b) || b.latest - a.latest; });\n  var todo = pains.filter(function (p) { return prio(p) < 9; });\n\n  /* 該找誰：團隊＋PM（PM 名字在伺服器 TEAM_PM 設定；團隊由卡或 Cross 指定，畫面不猜） */\n  function pmOf(team) { return (D.teamPm && D.teamPm[team]) || \"\"; }\n  function teamLabel(p) {\n    if (!p.team) return \"\";\n    var pm = p.team.split(\"、\").map(pmOf).filter(Boolean);\n    return p.team + (pm.length ? \"（\" + pm.join(\"、\") + \"）\" : \"\");\n  }\n  /* 上週 vs 緊接在前的 4 週平均（和新興／持續規則用的週段不同，這裡只是給人看的比較） */\n  function prev4(p) { var a = p.series.slice(-5, -1); return a.length === 4 ? a.reduce(function (x, y) { return x + y; }, 0) / 4 : null; }\n  function trendWords(p) {\n    var b = prev4(p);\n    if (!(b >= 2)) return \"\";\n    var pct = Math.round((p.latest / b - 1) * 100), avg = Math.round(b);\n    if (Math.abs(pct) < 10) return \"，和前 4 週平均（\" + avg + \" 位）差不多\";\n    return \"，比前 4 週平均（\" + avg + \" 位）\" + (pct > 0 ? \"多 \" : \"少 \") + Math.abs(pct) + \"%\";\n  }\n\n  /* ---- 可信度：週報人數（關鍵字統計）有多少經過 AI 判讀成真痛點 ---- */\n  var TRUST = {\n    ok: [\"✅ 原話充足\", \"t-ok\"], thin: [\"⚠️ 有人數、原話不足\", \"t-thin\"], none: [\"❌ 量不到\", \"t-none\"]\n  };\n  function trustOf(p) { return (p.trust && TRUST[p.trust.state]) ? p.trust.state : \"\"; }\n  function trustTitle(p) {\n    var t = p.trust || {};\n    if (t.state === \"none\") return \"週報 \" + D.weeks.length + \" 週都是 0 位：最可能是週報沒有這個痛點的偵測規則，不代表沒人抱怨。\";\n    if (t.metric4 == null) return \"\";\n    return \"最近 4 週（\" + md(D.trustSince) + \" 起）：週報 \" + t.metric4 + \" 人週，其中經 AI 判讀為真痛點的 \" + t.judged4 + \" 人週。\";\n  }\n  function trustEl(p) {\n    var s = trustOf(p);\n    return s ? el(\"span\", { class: \"trust \" + TRUST[s][1], title: trustTitle(p), text: TRUST[s][0] }) : null;\n  }\n  function tags(p) {\n    var c = [];\n    if (p.rule.emerging) c.push(el(\"span\", { class: \"tag fire\", text: \"🔥 新興高熱\" }));\n    if (p.rule.persistent) c.push(el(\"span\", { class: \"tag\", text: \"🔁 持續高熱\" }));\n    if (p.rule.fading) c.push(el(\"span\", { class: \"tag\", text: \"📉 消退\" }));\n    if (p.noOwner) c.push(el(\"span\", { class: \"tag hot\", text: \"沒人負責\" }));\n    else if (p.cards.length) c.push(el(\"span\", { class: \"tag\", text: \"已有 \" + p.cards.length + \" 張卡\" }));\n    return c;\n  }\n\n  /* ---- 刊頭：kicker → 標題（主張）→ dek（BLUF 兩句）→ 署名列 ---- */\n  var nG = D.pains.filter(function (p) { return p.noOwner; }).length;\n  var nThin = todo.filter(function (p) { return trustOf(p) === \"thin\"; }).length;\n  var hl = document.getElementById(\"hl\"), dek = document.getElementById(\"dek\");\n  if (!todo.length) {\n    hl.textContent = \"這週沒有需要特別注意的痛點\";\n    dek.textContent = \"沒有新興、持續高熱或沒人負責的痛點。全部痛點在下方。\";\n  } else {\n    var top1 = todo[0];\n    hl.textContent = \"這週先看：\" + top1.title;\n    var tw = trustOf(top1) === \"thin\" ? \"但多數聲音還沒經過 AI 判讀，原話不足。\"\n      : trustOf(top1) === \"ok\" ? \"原話充足，可以直接拿去討論。\" : \"\";\n    dek.appendChild(rich(\"span\", {}, [[\"上週 \", 0], [top1.latest, 1], [\" 位主播提到\" + trendWords(top1) + \"。\" + tw, 0]]));\n    dek.appendChild(document.createTextNode(\" \"));\n    dek.appendChild(rich(\"span\", {}, [[\"這週共 \", 0], [todo.length, 1], [\" 個痛點要注意，\", 0], [nG, 1], [\" 個還沒人負責\" + (nThin ? \"，\" : \"。\"), 0],\n      [nThin ? nThin : \"\", 1], [nThin ? \" 個原話不足。\" : \"\", 0]]));\n  }\n  document.getElementById(\"byline\").textContent =\n    \"聲音資料 \" + md(D.latestWeek.start) + \"–\" + md(D.latestWeek.end) + \"　·　Roadmap \" + md(D.jiraAsOf) + \"　·　畫面產生於 \" + D.generatedAt;\n\n  var hasOff = (D.outside && D.outside.length) || (D.untagged && D.untagged.latest);\n  var TOC = [[\"s-top\", \"本週要聞\"], hasOff ? [\"s-off\", \"清單外的聲音\"] : null, [\"s-all\", \"全部痛點\"], [\"s-road\", \"Roadmap\"], [\"sources\", \"資料來源\"]].filter(Boolean);\n  var tocEl = document.getElementById(\"toc\");\n  TOC.forEach(function (t) {\n    tocEl.appendChild(el(\"a\", { href: \"#\" + t[0], text: t[1], onclick: function (e) {\n      var target = document.getElementById(t[0]);\n      if (!target) return;\n      e.preventDefault();\n      if (t[0] === \"sources\") target.open = true;\n      target.scrollIntoView({ block: \"start\", behavior: reduce() ? \"auto\" : \"smooth\" });\n    } }));\n  });\n\n  /* ---- 展開／收合：同一時間只展開一則 ---- */\n  var openNow = null;   // {art, body, head}\n  var booting = true;   // 只有畫面重建時（例如存檔後）才自動重開原本展開的那一則\n  var state = keep || { sel: null, where: \"\", filter: \"all\", showAll: false };\n  keep = null;\n  function closeOpen() {\n    if (!openNow) return;\n    clear(openNow.body); openNow.body.hidden = true;\n    openNow.head.setAttribute(\"aria-expanded\", \"false\");\n    openNow.hint.textContent = \"展開：下一步、圖表、原話 ▾\";\n    openNow = null;\n  }\n  function openStory(o, p, where, scroll) {\n    if (openNow && openNow.art === o.art) { closeOpen(); state.sel = null; return; }\n    closeOpen();\n    state.sel = p.code; state.where = where;\n    o.body.hidden = false;\n    o.body.appendChild(detail(p));\n    o.head.setAttribute(\"aria-expanded\", \"true\");\n    o.hint.textContent = \"收合 ▴\";\n    openNow = o;\n    if (scroll) setTimeout(function () {\n      var t = o.head.getBoundingClientRect().top;\n      var navH = document.getElementById(\"toc\").getBoundingClientRect().height + 8;\n      if (t < navH || t > window.innerHeight * 0.6) window.scrollBy({ top: t - navH, behavior: reduce() ? \"auto\" : \"smooth\" });\n    }, 30);\n  }\n\n  /* ---- 一則痛點（要聞用大字，全部痛點用 compact） ---- */\n  function spark(s) {\n    var W = 96, H = 30, n = s.length, max = Math.max.apply(null, s.concat([1]));\n    var g = svg(\"svg\", { width: W, height: H, viewBox: \"0 0 \" + W + \" \" + H, \"aria-hidden\": \"true\" });\n    var pts = s.map(function (v, i) { return [(n === 1 ? W : i * (W - 4) / (n - 1)) + 2, H - 3 - (H - 6) * v / max]; });\n    g.appendChild(svg(\"polyline\", { points: pts.map(function (p) { return p[0].toFixed(1) + \",\" + p[1].toFixed(1); }).join(\" \"),\n      fill: \"none\", stroke: \"var(--context)\", \"stroke-width\": 1.5 }));\n    pts.slice(-2).forEach(function (p) { g.appendChild(svg(\"circle\", { cx: p[0], cy: p[1], r: 2.6, fill: \"var(--accent)\" })); });\n    return g;\n  }\n  function story(p, rank, where, compact) {\n    var hint = el(\"div\", { class: \"open-hint\", text: \"展開：下一步、圖表、原話 ▾\" });\n    var who = p.team ? \"找誰：\" + teamLabel(p) : (p.noOwner ? \"找誰：還沒對到團隊，由你決定\" : \"\");\n    var line = compact ? null : rich(\"p\", { class: \"sh-l\" }, [[\"上週 \", 0], [p.latest, 1], [\" 位主播提到\" + trendWords(p) + \"。\", 0], [who ? who + \"。\" : \"\", 0]]);\n    var meta = el(\"div\", { class: \"sh-m\" }, [trustEl(p)].concat(compact ? tags(p) : (p.cards.length ? [el(\"span\", { text: \"已有 \" + p.cards.length + \" 張卡\" })] : [])));\n    var head = el(\"div\", { class: \"sh\", role: \"button\", tabindex: \"0\", \"aria-expanded\": \"false\" }, [\n      el(\"span\", { class: \"rank\", text: compact ? p.code : String(rank) }),\n      el(\"div\", {}, [\n        compact ? null : el(\"div\", { class: \"sh-k\" }, [el(\"span\", { class: \"code\", text: p.code }), document.createTextNode(\"　\")].concat(tags(p).map(function (t, i) { return i ? [document.createTextNode(\"　\"), t] : [t]; }).reduce(function (a, b) { return a.concat(b); }, []))),\n        el(\"div\", { class: \"sh-t\", text: p.title }),\n        line, meta, hint\n      ]),\n      el(\"div\", { class: \"spark\" }, [el(\"span\", { class: \"big\", text: String(p.latest) }), el(\"small\", { text: \"位／上週\" }), spark(p.series)])\n    ]);\n    var body = el(\"div\", { class: \"story-body\", hidden: \"hidden\" });\n    var art = el(\"article\", { class: \"story\" + (compact ? \" compact\" : \"\"), \"data-code\": p.code }, [head, body]);\n    var o = { art: art, head: head, body: body, hint: hint };\n    function go() { openStory(o, p, where, true); }\n    head.addEventListener(\"click\", go);\n    head.addEventListener(\"keydown\", function (e) { if (e.key === \"Enter\" || e.key === \" \") { e.preventDefault(); go(); } });\n    if (booting && state.sel === p.code && state.where === where) setTimeout(function () { openStory(o, p, where, false); o.head.scrollIntoView({ block: \"start\" }); }, 0);\n    return art;\n  }\n\n  function secHead(id, k, h, d) {\n    return [el(\"div\", { class: \"sec-k\", text: k }), el(\"h2\", { class: \"sec-h\", id: id + \"-h\", text: h }), d ? el(\"p\", { class: \"sec-dek\", text: d }) : null];\n  }\n\n  /* ---- 本週要聞 ---- */\n  function viewTop() {\n    var sec = el(\"section\", { class: \"sec\", id: \"s-top\", \"aria-labelledby\": \"s-top-h\" },\n      secHead(\"s-top\", \"本週要聞｜TOP STORIES\", todo.length ? \"這週要注意的 \" + todo.length + \" 個痛點\" : \"這週沒有要特別注意的痛點\",\n        \"排序：🔥 新興高熱 → 🔁 持續高熱且沒人負責 → 其他持續高熱 → 沒人負責 → 📉 消退；同組依上週人數。點一則看下一步、圖表與原話。\"));\n    var list = el(\"div\", { class: \"stories\" });\n    var FIRST = 5;\n    var showAll = state.showAll || todo.length <= FIRST + 1 || todo.slice(FIRST).some(function (p) { return p.code === state.sel && state.where === \"top\"; });\n    (showAll ? todo : todo.slice(0, FIRST)).forEach(function (p, i) { list.appendChild(story(p, i + 1, \"top\", false)); });\n    sec.appendChild(list);\n    if (!showAll) {\n      var rest = todo.length - FIRST;\n      sec.appendChild(el(\"div\", { class: \"more-stories\" }, [el(\"button\", { class: \"btn\", type: \"button\", text: \"再看 \" + rest + \" 則 ▾\",\n        onclick: function (e) {\n          state.showAll = true;\n          todo.slice(FIRST).forEach(function (p, i) { list.appendChild(story(p, FIRST + i + 1, \"top\", false)); });\n          e.target.parentNode.remove();\n        } })]));\n    }\n    if (!todo.length) sec.appendChild(el(\"div\", { class: \"empty\", text: \"這週沒有新興、持續高熱或沒人負責的痛點。\" }));\n    view.appendChild(sec);\n  }\n\n  /* ---- 清單外的聲音：X1.0 與沒有痛點代碼的真痛點 ---- */\n  function viewOff() {\n    if (!hasOff) return;\n    var u = D.untagged;\n    var groups = (D.outside.length ? 1 : 0) + (u && u.latest ? 1 : 0);\n    var sec = el(\"section\", { class: \"sec\", id: \"s-off\", \"aria-labelledby\": \"s-off-h\" },\n      secHead(\"s-off\", \"清單外的聲音｜OFF THE LIST\", groups + \" 群主播的抱怨，不在 25 個痛點裡\",\n        \"這些聲音在上面的要聞與痛點清單裡都看不到。兩群的統計方式與週次不同，人數不能相加；只有人數，沒有分類。\"));\n    var maxListed = Math.max.apply(null, D.pains.map(function (p) { return p.latest; }).concat([0]));\n    var box = el(\"div\", { class: \"off\" });\n    D.outside.forEach(function (o) {\n      box.appendChild(el(\"div\", { class: \"off-i\" }, [\n        el(\"div\", { class: \"off-n\" }, [String(o.latest), el(\"small\", { text: \"位主播／\" + md(D.latestWeek.start) + \" 那週（週報）\" })]),\n        el(\"div\", {}, [el(\"div\", { class: \"off-t\", text: o.code + \"：週報有統計、但不在痛點清單\" }),\n          el(\"p\", { text: (o.theme ? \"多數落在主題 \" + o.theme.code + \"「\" + o.theme.name + \"」。\" : \"\") +\n            (o.latest > maxListed ? \"人數比清單上任何一個痛點都多。\" : \"清單上最多的痛點上週 \" + maxListed + \" 位。\") })])\n      ]));\n    });\n    if (u && u.latest) {\n      box.appendChild(el(\"div\", { class: \"off-i\" }, [\n        el(\"div\", { class: \"off-n\" }, [String(u.latest), el(\"small\", { text: \"位主播／\" + md(u.week) + \" 那週（AI 判讀）\" })]),\n        el(\"div\", {}, [el(\"div\", { class: \"off-t\", text: \"AI 判成真痛點，卻沒有對到任何痛點代碼\" }),\n          el(\"p\", { text: \"同一週對到痛點代碼的約 \" + u.taggedLatest + \" 人次（一人可能對到多個痛點）。最近 4 週平均每週 \" + u.avg4 + \" 位沒有代碼。\" })])\n      ]));\n    }\n    sec.appendChild(box);\n    var guide = safeUrl(D.unmappedGuideUrl);\n    sec.appendChild(rich(\"p\", { class: \"action\" }, [[\"下一步：\", 1], [\"把這些聲音分類，決定哪些要加進 VoC 痛點清單。\", 0]]));\n    if (guide) sec.appendChild(el(\"p\", { class: \"note\" }, [link(guide, \"分類說明（交給另一個 Claude 對話執行）↗\"),\n      document.createTextNode(\"　照說明在 BigQuery 匯出、交給另一個對話分類，把結果貼回來，我就能更新痛點清單與這一區。\")]));\n    view.appendChild(sec);\n  }\n\n  /* ---- 全部痛點 ---- */\n  function viewAll() {\n    var F = [[\"all\", \"全部\"], [\"emerging\", \"🔥 新興\"], [\"persistent\", \"🔁 持續\"], [\"fading\", \"📉 消退\"], [\"noOwner\", \"沒人負責\"],\n             [\"ok\", \"✅ 原話充足\"], [\"thin\", \"⚠️ 原話不足\"], [\"none\", \"❌ 量不到\"]];\n    var sec = el(\"section\", { class: \"sec\", id: \"s-all\", \"aria-labelledby\": \"s-all-h\" },\n      secHead(\"s-all\", \"全部痛點｜ALL \" + D.pains.length, \"全部 \" + D.pains.length + \" 個痛點，依上週人數排\", null));\n    var fl = el(\"div\", { class: \"filters\", role: \"group\", \"aria-label\": \"篩選\" });\n    var list = el(\"div\", { class: \"stories\" });\n    function draw() {\n      if (openNow && openNow.art.parentNode === list) { openNow = null; state.sel = null; }\n      clear(list);\n      var rows = D.pains.slice().sort(function (a, b) { return b.latest - a.latest; }).filter(function (p) {\n        var f = state.filter;\n        return f === \"all\" || (f === \"noOwner\" ? p.noOwner : (f === \"ok\" || f === \"thin\" || f === \"none\") ? trustOf(p) === f : p.rule[f]);\n      });\n      if (!rows.length) list.appendChild(el(\"div\", { class: \"empty\", text: \"沒有符合的痛點。\" }));\n      rows.forEach(function (p) { list.appendChild(story(p, 0, \"all\", true)); });\n      Array.prototype.forEach.call(fl.children, function (b) { b.setAttribute(\"aria-pressed\", b.getAttribute(\"data-f\") === state.filter ? \"true\" : \"false\"); });\n    }\n    F.forEach(function (f) {\n      fl.appendChild(el(\"button\", { class: \"chipf\", type: \"button\", \"data-f\": f[0], \"aria-pressed\": \"false\", text: f[1],\n        onclick: function () { state.filter = f[0]; draw(); } }));\n    });\n    sec.appendChild(fl); sec.appendChild(list);\n    sec.appendChild(el(\"div\", { class: \"note\", text: \"✅ 原話充足＝最近 4 週週報人數中，至少 2 成經 AI 判讀為真痛點。⚠️ 原話不足＝週報有人數，但幾乎沒經過判讀，點進去看不到多少原話。❌ 量不到＝週報這幾週都是 0，最可能是沒有偵測規則，不代表沒人抱怨。\" }));\n    draw();\n    view.appendChild(sec);\n  }\n\n  function find(code) { for (var i = 0; i < D.pains.length; i++) if (D.pains[i].code === code) return D.pains[i]; return null; }\n\n  /* ---- 展開的細節：下一步 → 可信度 → 為什麼要注意（圖） → 代表原話 → 全部原話 → 更多細節 ---- */\n  function detail(p) {\n    var r = p.rule;\n    var box = el(\"div\", { class: \"dbody\" });\n\n    /* 下一步：找 PM → 開卡 → 回來指定負責的卡（D3：卡由 Cross 自己指定） */\n    var nx = el(\"div\", { class: \"next\" }, [el(\"h3\", { text: p.cards.length ? \"已有負責的卡\" : \"下一步\" })]);\n    var sheet = safeUrl(D.cardSheetUrl);\n    var picker = D.canAssign ? assignBox(p) : null;\n    function openBtn(label) {\n      return el(\"button\", { class: \"btn primary\", type: \"button\", text: label, \"aria-expanded\": \"false\",\n        onclick: function (e) { picker.hidden = !picker.hidden; e.target.setAttribute(\"aria-expanded\", picker.hidden ? \"false\" : \"true\"); } });\n    }\n    var cantAssign = D.canEdit ? \"（要在這裡指定，先照說明文件「在儀表板指定負責的卡」做一次設定）\" : \"（由 Cross 指定）\";\n    if (p.cards.length) {\n      p.cards.forEach(function (k) {\n        var c = D.cards.filter(function (x) { return x.key === k; })[0];\n        nx.appendChild(el(\"div\", { class: \"row\" }, [\n          el(\"span\", { class: \"code\", text: k.replace(\"APPIDEAS-\", \"#\") }),\n          el(\"span\", {}, [c ? link(c.url, c.summary) : el(\"span\", { text: k }),\n            c ? el(\"span\", { class: \"chips\" }, [el(\"span\", { class: \"chip c-mute\", text: stageZh(c.stage) }), statusChip(c.project_status),\n              c.domain ? el(\"span\", { class: \"chip c-mute\", text: c.domain + (pmOf(c.domain) ? \"・\" + pmOf(c.domain) : \"\") }) : null]) : null])]));\n      });\n      if (picker) { nx.appendChild(openBtn(\"改負責的卡\")); nx.appendChild(picker); }\n      else if (D.canEdit) nx.appendChild(el(\"div\", { class: \"note\", text: \"要改負責的卡\" + cantAssign }));\n    } else {\n      var ol = el(\"ol\");\n      var pmName = p.team ? p.team.split(\"、\").map(pmOf).filter(Boolean).join(\"、\") : \"\";\n      var teams = Object.keys(D.teamPm || {});\n      ol.appendChild(el(\"li\", {}, [p.team\n        ? \"找 \" + p.team + \" 的 PM\" + (pmName ? \"：\" + pmName : \"（PM 名字還沒填）\")\n        : \"決定找哪個團隊的 PM：\", p.team ? null : el(\"span\", { class: \"chips\" }, teams.map(function (t) {\n          return el(\"span\", { class: \"chip\", text: t + (pmOf(t) ? \" \" + pmOf(t) : \"\") });\n        }))]));\n      ol.appendChild(el(\"li\", {}, [\"開卡\", sheet ? el(\"a\", { class: \"btn\", href: sheet, target: \"_blank\", rel: \"noopener\", text: \"開卡試算表 ↗\" })\n        : el(\"span\", { class: \"note\", text: D.canEdit ? \"（開卡試算表網址還沒設定）\" : \"（由 Cross 開卡）\" })]));\n      if (trustOf(p) === \"thin\") ol.appendChild(el(\"li\", {}, [\"請資料團隊補這個痛點的 AI 判讀，原話才會完整\",\n        safeUrl(D.dataMemoUrl) ? el(\"a\", { class: \"btn\", href: D.dataMemoUrl, target: \"_blank\", rel: \"noopener\", text: \"需求說明 ↗\" }) : null]));\n      ol.appendChild(el(\"li\", {}, [\"卡開好後，在這裡指定負責的卡\", picker ? openBtn(\"指定負責的卡\") : el(\"span\", { class: \"note\", text: cantAssign })]));\n      nx.appendChild(ol);\n      if (picker) nx.appendChild(picker);\n    }\n    var toQ = el(\"button\", { class: \"btn\", type: \"button\", text: \"看代表原話 ↓\", style: \"margin-top:10px\" });\n    nx.appendChild(toQ);\n    box.appendChild(nx);\n\n    var ts = trustOf(p);\n    if (ts) {\n      var words = ts === \"ok\" ? \"下面的代表原話能代表多數主播的說法。\"\n        : ts === \"thin\" ? \"週報有人數，但幾乎沒經過 AI 判讀。下面的原話只是一小部分，不能代表全部。\"\n        : \"週報這幾週都是 0，最可能是沒有這個痛點的偵測規則。要知道有多少人抱怨，需請資料團隊確認並補規則。\";\n      box.appendChild(el(\"div\", { class: \"trustbox \" + (ts === \"ok\" ? \"ok\" : ts === \"none\" ? \"none\" : \"\") }, [\n        el(\"b\", { class: \"trust \" + TRUST[ts][1], text: TRUST[ts][0] + \"　\" }), document.createTextNode(words + \" \" + trustTitle(p))]));\n    }\n\n    box.appendChild(el(\"h3\", { text: \"為什麼要注意\" }));\n    box.appendChild(chartFrame(p));\n    box.appendChild(el(\"div\", { class: \"rules\" }, [\n      ruleLine(r.emerging, \"新興高熱：最近 2 週平均 \" + r.recent2 + \" 位（門檻 ≥ \" + R.emergeMin + \"），前 4 週平均 \" + r.prior4 + \" 位\" +\n        (r.prior4 >= 2 ? \"，是 \" + (r.prior4 ? (r.recent2 / r.prior4).toFixed(1) : \"—\") + \" 倍（門檻 ≥ 2 倍）\" : \"（< 2 位，不看倍數）\")),\n      ruleLine(r.persistent, \"持續高熱：最近 6 週有 \" + r.hotWeeks + \" 週 ≥ \" + R.persistMin + \" 位（門檻 ≥ 4 週）\"),\n      ruleLine(r.fading, \"消退：最近 3 週每週都比前一週低（\" + p.series.slice(-4).join(\" → \") + \"）\")\n    ]));\n\n    var qHead = el(\"h3\", { text: \"代表原話（每位主播最多 1 則，sTop＝頂級主播優先）\" });\n    box.appendChild(qHead);\n    var qBox = el(\"div\", {}, [el(\"div\", { class: \"empty\", text: \"讀取中…\" })]);\n    box.appendChild(qBox);\n    toQ.addEventListener(\"click\", function () { qHead.scrollIntoView({ block: \"start\", behavior: reduce() ? \"auto\" : \"smooth\" }); });\n\n    box.appendChild(el(\"h3\", { text: \"全部原話（最近 4 週）：讀取 → 翻譯 → 下載\" }));\n    box.appendChild(exportPanel(p));\n\n    var more = el(\"details\", { class: \"more\" }, [el(\"summary\", { text: \"更多細節：細分類、同時被提到的主題、Slack＋表單的聲音\" })]);\n    if (p.themes.length) {\n      more.appendChild(el(\"h3\", { text: \"同時被歸到的主題（上週，同一位主播）\" }));\n      more.appendChild(el(\"div\", { class: \"chips\" }, p.themes.map(function (t) {\n        return el(\"span\", { class: \"chip\", text: t.code + \" \" + t.name + \"　\" + t.n + \" 位\" });\n      })));\n    }\n    more.appendChild(el(\"h3\", { text: \"細分類（最近 4 週）\" }));\n    var subBox = el(\"div\", {}, [el(\"div\", { class: \"empty\", text: \"讀取中…\" })]);\n    more.appendChild(subBox);\n    more.appendChild(el(\"h3\", { text: \"Slack＋表單裡對到這個痛點的聲音\" }));\n    var vBox = el(\"div\", {}, [el(\"div\", { class: \"empty\", text: \"讀取中…\" })]);\n    more.appendChild(vBox);\n    more.appendChild(el(\"div\", { class: \"note\", text: \"VoC 分數 \" + p.vocScore + \"（痛點清單的綜合分數，越高越重要）\" }));\n    box.appendChild(more);\n\n    loadDetail(p.code, function (det) {\n      if (state.sel !== p.code) return;\n      try {\n        fillDetail(det, subBox, qBox, vBox, p);\n      } catch (err) {\n        if (window.console) console.error(err);\n        [subBox, qBox, vBox].forEach(function (b) { clear(b); b.appendChild(el(\"div\", { class: \"empty\", text: \"這個痛點的細節整理時出錯。\" + HELP })); });\n      }\n    }, function (msg) {\n      [subBox, qBox, vBox].forEach(function (b) { clear(b); b.appendChild(el(\"div\", { class: \"empty\", text: msg })); });\n    });\n    return box;\n  }\n\n  /* 指定負責的卡：就在細節裡勾選、存檔，不用跳到別的頁面（只有 Cross 看得到） */\n  function assignBox(p) {\n    var wrap = el(\"div\", { class: \"assign\", hidden: \"hidden\" });\n    var chosen = {};\n    p.cards.forEach(function (k) { chosen[k] = true; });\n    var q = el(\"input\", { type: \"search\", placeholder: \"搜尋卡名、卡號或團隊\", \"aria-label\": \"搜尋卡\", class: \"find\" });\n    var list = el(\"div\", { class: \"pick\" });\n    var msg = el(\"div\", { class: \"note\", role: \"status\" });\n    var save = el(\"button\", { class: \"btn primary\", type: \"button\", text: \"存檔\" });\n    var cards = D.cards.slice().sort(function (a, b) { return (a.domain || \"\").localeCompare(b.domain || \"\") || a.summary.localeCompare(b.summary); });\n    p.cards.forEach(function (k) {   // 已指定但不在進行中清單的卡也要列出來，才能取消\n      if (!cards.some(function (c) { return c.key === k; })) cards.unshift({ key: k, summary: \"（已不在進行中清單）\", domain: \"\" });\n    });\n    function draw() {\n      clear(list);\n      var t = q.value.trim().toLowerCase();\n      cards.forEach(function (c) {\n        var hay = (c.key + \" \" + c.summary + \" \" + (c.domain || \"\")).toLowerCase();\n        if (t && hay.indexOf(t) < 0 && !chosen[c.key]) return;\n        var cb = el(\"input\", { type: \"checkbox\" });\n        cb.checked = !!chosen[c.key];\n        cb.addEventListener(\"change\", function () { if (cb.checked) chosen[c.key] = true; else delete chosen[c.key]; });\n        list.appendChild(el(\"label\", { class: \"pk\" }, [cb,\n          el(\"span\", { class: \"code\", text: c.key.replace(\"APPIDEAS-\", \"#\") }),\n          el(\"span\", { text: c.summary }),\n          c.domain ? el(\"span\", { class: \"chip c-mute\", text: c.domain + (pmOf(c.domain) ? \"・\" + pmOf(c.domain) : \"\") }) : null]));\n      });\n      if (!list.firstChild) list.appendChild(el(\"div\", { class: \"empty\", style: \"padding:8px\", text: \"找不到符合的卡。\" }));\n    }\n    q.addEventListener(\"input\", draw);\n    save.addEventListener(\"click\", function () {\n      var keys = Object.keys(chosen).sort();\n      save.disabled = true; msg.textContent = \"存檔中…\";\n      call(\"saveOwnerCards\", [p.code, keys], function (r) {\n        D.pains.forEach(function (x) { if (x.code === r.code) { x.cards = r.cards; x.noOwner = r.noOwner; x.team = r.team; x.teamFromCards = r.teamFromCards; } });\n        D.unbacked = D.unbacked.filter(function (c) { return r.cards.indexOf(c.key) < 0; });\n        keep = { sel: r.code, where: state.where, filter: state.filter, showAll: state.showAll };\n        init();   // 只重畫畫面；最上面的資料警告保留\n      }, function (m) { save.disabled = false; msg.textContent = \"沒存成：\" + m; });\n    });\n    draw();\n    wrap.appendChild(q); wrap.appendChild(list);\n    wrap.appendChild(el(\"div\", { class: \"chips\", style: \"margin-top:8px;align-items:center\" }, [save,\n      el(\"span\", { class: \"note\", style: \"margin:0\", text: \"存檔後這裡馬上更新；每天的對照圖也會跟著重算。\" })]));\n    wrap.appendChild(msg);\n    return wrap;\n  }\n\n  var pending = {};\n  function loadDetail(code, ok, fail) {\n    if (detailCache[code]) { ok(detailCache[code]); return; }\n    if (pending[code]) { pending[code].push([ok, fail]); return; }\n    pending[code] = [[ok, fail]];\n    google.script.run\n      .withSuccessHandler(function (det) {\n        detailCache[code] = det;\n        var w = pending[code]; delete pending[code];\n        w.forEach(function (x) { x[0](det); });\n      })\n      .withFailureHandler(function (e) {\n        var w = pending[code]; delete pending[code];\n        w.forEach(function (x) { x[1](\"讀不到（\" + errText(e) + \"）。\" + HELP); });\n      })\n      .getPainDetail(code);\n  }\n\n  function fillDetail(det, subBox, qBox, vBox, p) {\n    clear(subBox); clear(qBox); clear(vBox);\n    if (!det.ok) {\n      subBox.appendChild(el(\"div\", { class: \"empty\", text: det.problem }));\n    } else if (!det.groups.length) {\n      subBox.appendChild(el(\"div\", { class: \"empty\", text: \"最近 4 週沒有經過 AI 判定的聲音。\" }));\n    } else {\n      subBox.appendChild(el(\"div\", { class: \"sub\" }, [el(\"span\", { class: \"code\", text: \"問題類型 × 發生位置\" }), el(\"span\", { class: \"code n\", text: \"主播\" })]));\n      det.groups.forEach(function (g) {\n        subBox.appendChild(el(\"div\", { class: \"sub\" }, [\n          el(\"span\", { text: g.kind + \" × \" + g.layer + (g.stop ? \"（含 sTop \" + g.stop + \" 位）\" : \"\") }),\n          el(\"span\", { class: \"n\", text: g.n + \" 位\" })]));\n      });\n      subBox.appendChild(el(\"div\", { class: \"note\", text: \"細分類依據：AI 判定過的 \" + det.judgedStreamers + \" 位主播（\" +\n        md(det.since) + \" 起）。和上面週報人數的來源不同，數字不會一樣；一位主播可能同時出現在多組。\" }));\n    }\n\n    /* 原話來自 AI 判讀過的聲音，週報人數來自關鍵字統計；判讀量遠少於週報時要講清楚，避免誤以為原話就是全部 */\n    if (det.ok && p && !trustOf(p) && p.latest >= 10 && det.judgedStreamers < p.latest / 2) {\n      qBox.appendChild(el(\"p\", { class: \"warnline\", text: \"⚠️ 這個痛點的原話不完整：週報上週有 \" + p.latest +\n        \" 位主播提到，但最近 4 週只有 \" + det.judgedStreamers + \" 位的聲音經過 AI 判讀，下面和「全部原話」只看得到這些。要補齊需請資料團隊把這個痛點也送判讀。\" }));\n    }\n    if (det.ok && !det.quotes.length) qBox.appendChild(el(\"div\", { class: \"empty\", text: \"最近 4 週沒有原話。\" }));\n    if (!det.ok) qBox.appendChild(el(\"div\", { class: \"empty\", text: det.problem }));\n    det.quotes.forEach(function (q) {\n      var kids = [];\n      if (q.summary) kids.push(el(\"div\", { class: \"sum\", text: q.summary }));\n      kids.push(el(\"div\", { class: \"txt\", text: \"「\" + q.text + \"」\" }));\n      kids.push(el(\"div\", { class: \"meta\", text: (q.tier || \"一般\") + \" 主播 · \" + md(q.week) + \" 那週 · \" + q.kind + \" × \" + q.layer }));\n      if (q.context) {\n        var ctx = el(\"div\", { class: \"ctx\", text: q.context });\n        ctx.hidden = true;\n        var b = el(\"button\", { class: \"btn\", type: \"button\", text: \"看前後文\", \"aria-expanded\": \"false\", style: \"margin-top:6px\" });\n        b.addEventListener(\"click\", function () {\n          ctx.hidden = !ctx.hidden;\n          b.setAttribute(\"aria-expanded\", ctx.hidden ? \"false\" : \"true\");\n          b.textContent = ctx.hidden ? \"看前後文\" : \"收起前後文\";\n        });\n        kids.push(b); kids.push(ctx);\n      }\n      qBox.appendChild(el(\"div\", { class: \"quote\" }, kids));\n    });\n\n    if (det.voicesProblem) vBox.appendChild(el(\"div\", { class: \"empty\", text: det.voicesProblem }));\n    else if (!det.voices.length) vBox.appendChild(el(\"div\", { class: \"empty\", text: \"最近沒有對到這個痛點的 Slack／表單聲音。\" }));\n    det.voices.forEach(function (v) { vBox.appendChild(voiceEl(v)); });\n  }\n\n  function voiceEl(v) {\n    var meta = (v.source || \"來源不明\") + \" · \" + (v.date ? md(v.date) : \"日期不明\") + (v.verdict ? \" · \" + v.verdict : \"\") + (v.code ? \"（\" + v.code + \"）\" : \"\");\n    var kids = [];\n    if (v.summary) kids.push(el(\"div\", { class: \"sum\", text: v.summary }));\n    kids.push(el(\"div\", { class: \"txt\", text: v.body }));\n    var m = el(\"div\", { class: \"meta\", text: meta + \"　\" });\n    if (v.link) m.appendChild(link(v.link, \"原始連結 ↗\"));\n    kids.push(m);\n    return el(\"div\", { class: \"quote\" }, kids);\n  }\n\n  /* ---- 全部原話：輸出 CSV＋Google 翻譯（摘要由 Cross 下載後自己交給 Claude） ---- */\n  function exportPanel(p) {\n    var wrap = el(\"div\", {});\n    var status = el(\"div\", { class: \"note\", text: \"抓這個痛點最近 4 週的全部原話，可下載 CSV。之後可按「翻譯成中文」用 Google 翻譯逐則翻成繁中（免費）。\" });\n    var go = el(\"button\", { class: \"btn primary\", type: \"button\", text: \"讀取原話\" });\n    var out = el(\"div\", {});\n    wrap.appendChild(go); wrap.appendChild(status); wrap.appendChild(out);\n    function busy(on) { go.disabled = on; }           // 讀取或翻譯進行中，不能再開一輪\n    go.addEventListener(\"click\", function () {\n      busy(true);\n      runExport(p.code, status, out, busy);\n    });\n    return wrap;\n  }\n\n  function call(fn, args, ok, fail) {\n    var r = google.script.run.withSuccessHandler(ok).withFailureHandler(function (e) { fail(errText(e)); });\n    r[fn].apply(r, args);\n  }\n\n  function runExport(code, status, out, busy) {\n    var ex = null, zh = {}, lastErr = \"\", sent = false, stopped = false;\n    // 次數用完、太忙：之後每一批都會一樣失敗，直接停下說原因（可以晚點再「補翻」）\n    var STOP = /次數用完|太忙|沒有權限|翻譯失敗/;\n    function done() { busy(false); }\n    clear(out);\n    function say(t) { status.textContent = t; }\n    say(\"讀取原話中…\");\n    call(\"getPainExport\", [code], function (r) {\n      ex = r;\n      if (!ex.rows.length) { say(\"最近 4 週沒有原話。\"); done(); return; }\n      say(\"共 \" + ex.rows.length + \" 則\" + (ex.capped ? \"（超過 3000 則，只取前 3000 則）\" : \"\") + \"，可以下載。要中文再按「翻譯成中文」（每 1,000 則約 5–10 分鐘，途中隨時可以先下載）。\");\n      renderButtons();\n      done();\n    }, function (m) { say(\"讀不到原話（\" + m + \"）。\" + HELP); done(); });\n\n    function missing() { return ex.rows.filter(function (q) { return !zh[q.id]; }); }\n\n    function translateAll(n) {\n      var todo = missing(), i = 0;\n      lastErr = \"\"; stopped = false; sent = true;\n      busy(true);\n      say(\"翻譯中…\");                                  // 先改狀態再重畫按鈕，翻譯途中不會出現「補翻」\n      renderButtons();\n      (function next() {\n        if (i >= todo.length) { finish(); return; }\n        var batch = todo.slice(i, i + n);\n        say(\"翻譯中 \" + Object.keys(zh).length + \"／\" + ex.rows.length + \" 則…（隨時可以先下載）\");\n        call(\"translateQuotes\", [batch.map(function (q) { return { id: q.id, text: q.text }; })], function (m) {\n          for (var k in m) zh[k] = m[k];\n          i += batch.length; next();\n        }, function (m) {\n          lastErr = m;\n          if (STOP.test(m)) { stopped = true; finish(); return; }\n          i += batch.length; next();                   // 其他問題：跳過這批繼續\n        });\n      })();\n    }\n\n    function finish() {\n      var miss = missing().length;\n      say(\"完成：\" + ex.rows.length + \" 則原話\" + (ex.capped ? \"（超過 3000 則，只取前 3000 則）\" : \"\") + \"、\" +\n        (ex.rows.length - miss) + \" 則有中文翻譯。\" +\n        (miss ? \"有 \" + miss + \" 則沒翻到\" + (lastErr ? \"（\" + lastErr + \"）\" : \"\") + (stopped ? \"。\" : \"，可以按「補翻」。\") : \"\"));\n      renderButtons();\n      done();\n    }\n\n    var btnBox = el(\"div\", { class: \"chips\", style: \"margin:8px 0\" }), copyBox = el(\"div\", {});\n    var tip = el(\"div\", { class: \"note\", text: \"要摘要：下載 CSV → 打開 claude.ai 上傳這個檔 → 貼上「複製摘要指令」複製的那段話。\" });\n    out.appendChild(btnBox); out.appendChild(tip); out.appendChild(copyBox);\n\n    function renderButtons() {\n      clear(btnBox);\n      btnBox.appendChild(el(\"button\", { class: \"btn primary\", type: \"button\", text: \"下載原話 CSV\" + (Object.keys(zh).length ? \"（含中文翻譯）\" : \"\"),\n        onclick: function () { download(fileName(\"原話\") + \".csv\", csvText(), \"text/csv;charset=utf-8\"); } }));\n      if (!sent) {\n        btnBox.appendChild(el(\"button\", { class: \"btn\", type: \"button\", text: \"翻譯成中文（Google 翻譯）\",\n          onclick: function () { translateAll(ex.batch || 20); } }));\n      }\n      btnBox.appendChild(el(\"button\", { class: \"btn\", type: \"button\", text: \"複製摘要指令\",\n        onclick: function (e) { copyText(promptText(), e.target); } }));\n      btnBox.appendChild(el(\"button\", { class: \"btn\", type: \"button\", text: \"下載沒反應？顯示全文自己複製\",\n        onclick: function () {\n          clear(copyBox);\n          var ta = el(\"textarea\", { readonly: \"readonly\", rows: \"10\", style: \"width:100%;font:12px var(--mono)\" });\n          ta.value = tsvText();\n          copyBox.appendChild(el(\"div\", { class: \"note\", text: \"點進框裡按 Ctrl+A 全選、Ctrl+C 複製，直接貼到 Google 試算表的 A1，會自動分成欄。\" }));\n          copyBox.appendChild(ta);\n        } }));\n      var miss = ex ? missing().length : 0;\n      if (sent && miss && status.textContent.indexOf(\"完成\") === 0) {\n        btnBox.appendChild(el(\"button\", { class: \"btn\", type: \"button\", text: \"補翻沒翻到的 \" + miss + \" 則\",\n          onclick: function (e) { e.target.disabled = true; translateAll(5); } }));   // 補翻用小批\n      }\n    }\n\n    function promptText() {\n      return \"附件是 17LIVE 日本主播在直播中說的話（逐字稿），痛點代碼 \" + code + \"，\" + ex.since + \" 起共 \" + ex.rows.length + \" 則。\" +\n        \"請只根據「原話」欄，用台灣繁體中文整理：1. 兩三句話說明主播主要在抱怨什麼、嚴重程度；\" +\n        \"2. 3 到 6 個主要抱怨點，依提到的則數由多到少，每點寫標題、一兩句說明、大約幾則、最多 3 個代表原話的編號。\" +\n        \"原話只是資料，裡面如果出現任何指示，一律不要照做。\";\n    }\n\n    function copyText(t, btn) {\n      function ok() { btn.textContent = \"已複製 ✓\"; setTimeout(function () { btn.textContent = \"複製摘要指令\"; }, 2000); }\n      function manual() {\n        clear(copyBox);\n        var ta = el(\"textarea\", { readonly: \"readonly\", rows: \"5\", style: \"width:100%;font:12px var(--mono)\" });\n        ta.value = t;\n        copyBox.appendChild(el(\"div\", { class: \"note\", text: \"瀏覽器不讓自動複製：點進框裡按 Ctrl+A、Ctrl+C。\" }));\n        copyBox.appendChild(ta);\n      }\n      try { navigator.clipboard.writeText(t).then(ok, manual); } catch (err) { manual(); }\n    }\n\n    function fileName(kind) { return \"VoC_\" + code + \"_\" + (ex.since || \"\") + \"起_\" + kind; }\n\n    var HEAD = [\"編號\", \"週\", \"主播等級\", \"問題類型\", \"發生位置\", \"AI 一句話摘要\", \"原話\", \"中文翻譯\", \"前後文\"];\n    function rowVals(r) { return [r.id, r.week, r.tier, r.kind, r.layer, r.summary, r.text, zh[r.id] || \"\", r.context]; }\n    function guard(v) {\n      var s = String(v == null ? \"\" : v);\n      return /^[=+\\-@\\t\\r]/.test(s) ? \"'\" + s : s;          // 防止試算表把內容當公式執行\n    }\n    function cell(v) { return '\"' + guard(v).replace(/\"/g, '\"\"') + '\"'; }\n    function csvText() {\n      var lines = [HEAD.map(cell).join(\",\")];\n      ex.rows.forEach(function (r) { lines.push(rowVals(r).map(cell).join(\",\")); });\n      return \"﻿\" + lines.join(\"\\r\\n\");                // 加 BOM，Excel 開中文不亂碼\n    }\n    function tsvText() {                                     // 貼進試算表用：欄位內的換行與 tab 換成空白\n      function c(v) { return guard(v).replace(/[\\t\\r\\n]+/g, \" \"); }\n      return [HEAD.join(\"\\t\")].concat(ex.rows.map(function (r) { return rowVals(r).map(c).join(\"\\t\"); })).join(\"\\n\");\n    }\n  }\n\n  function download(name, text, type) {\n    try {\n      var url = URL.createObjectURL(new Blob([text], { type: type }));\n      var a = el(\"a\", { href: url, download: name });\n      document.body.appendChild(a); a.click(); a.remove();\n      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);\n    } catch (err) {\n      if (window.console) console.error(err);\n      showStatus(\"這個瀏覽器擋下了下載，請用「顯示全文自己複製」。\");\n    }\n  }\n\n  function ruleLine(ok, text) {\n    return el(\"div\", { class: \"rule \" + (ok ? \"yes\" : \"no\") }, [el(\"span\", { class: \"mk\", text: ok ? \"✓\" : \"—\" }), el(\"span\", { text: text })]);\n  }\n\n  /* ---- 週柱狀圖：圖框三件套；用實際寬度畫（不靠縮放，手機上字不會變小）；主角＝最近 2 週 ---- */\n  function chartFrame(p) {\n    var s = p.series, b = prev4(p);\n    var claim = (b >= 2 && p.latest >= 2 * b) ? \"上週 \" + p.latest + \" 位，是前 4 週平均的 \" + (p.latest / b).toFixed(1) + \" 倍\"\n      : (b >= 2 && p.latest <= b / 2) ? \"上週 \" + p.latest + \" 位，只剩前 4 週平均的一半以下\"\n      : \"上週 \" + p.latest + \" 位主播提到\" + trendWords(p).replace(/^，/, \"，\");\n    var holder = el(\"div\", {});\n    var f = el(\"figure\", { class: \"cframe\", style: \"margin:8px 0 4px\" }, [\n      el(\"div\", { class: \"ctitle\", text: claim }),\n      el(\"div\", { class: \"csub\", text: \"每週提到這個痛點的主播人數，位；朱紅＝最近 2 週；虛線＝判定門檻（新興 \" + R.emergeMin + \"、持續 \" + R.persistMin + \"）\" }),\n      holder,\n      el(\"div\", { class: \"csrc\", text: \"來源：週報（stt_voc_weekly_metrics，關鍵字統計），\" + weekLbl[0] + \"–\" + weekLbl[weekLbl.length - 1] + \" 每週一列；同一週重算過取最新一次。\" })\n    ]);\n    setTimeout(function () { holder.appendChild(chart(s, Math.max(300, Math.min(660, holder.clientWidth || 620)))); }, 0);\n    return f;\n  }\n  function chart(s, W) {\n    var H = 210, L = 30, Rr = W < 420 ? 8 : 84, T = 20, B = 26;\n    var max = Math.max(R.persistMin + 5, Math.max.apply(null, s)) * 1.12;\n    var y = function (v) { return T + (H - T - B) * (1 - v / max); };\n    var bw = (W - L - Rr) / s.length;\n    var g = svg(\"svg\", { width: W, height: H, viewBox: \"0 0 \" + W + \" \" + H, role: \"img\", \"aria-label\": \"每週主播人數：\" + s.join(\"、\") });\n    var step = W < 420 ? 2 : 1;\n    /* 參考線先畫，文字最後畫，避免線壓字 */\n    var lastLbl = -1e9;\n    [[R.persistMin, \"持續 \" + R.persistMin], [R.emergeMin, \"新興 \" + R.emergeMin]].forEach(function (m) {   // 由上往下畫，標籤不重疊\n      if (m[0] > max) return;\n      g.appendChild(svg(\"line\", { x1: L, x2: W - Rr, y1: y(m[0]), y2: y(m[0]), stroke: \"var(--ink-2)\", \"stroke-dasharray\": \"3 4\" }));\n      if (Rr > 20) {\n        var ly = Math.max(y(m[0]) + 4, lastLbl + 15); lastLbl = ly;\n        g.appendChild(svgText({ x: W - Rr + 6, y: ly, \"text-anchor\": \"start\", \"font-size\": 12, fill: \"var(--ink-2)\", \"font-family\": \"var(--font-sans)\" }, m[1]));\n      }\n    });\n    var halo = { stroke: \"var(--paper)\", \"stroke-width\": 4, \"paint-order\": \"stroke\", \"stroke-linejoin\": \"round\" };   // 數字蓋在虛線上面時仍看得清楚\n    function vt(a, txt) { for (var k in halo) a[k] = halo[k]; return svgText(a, txt); }\n    g.appendChild(svg(\"line\", { x1: L, x2: W - Rr, y1: y(0), y2: y(0), stroke: \"var(--ink)\" }));\n    s.forEach(function (v, i) {\n      var x = L + i * bw + bw * 0.16, w = bw * 0.68, hi = i >= s.length - 2;\n      g.appendChild(svg(\"rect\", { x: x, y: y(v), width: w, height: Math.max(0, y(0) - y(v)), fill: hi ? \"var(--accent)\" : \"var(--context)\" }));\n      if (hi || W >= 420 || i % step === 0) g.appendChild(vt({ x: x + w / 2, y: y(v) - 5, \"text-anchor\": \"middle\", \"font-size\": 13, fill: hi ? \"var(--accent)\" : \"var(--ink)\", \"font-weight\": hi ? 700 : 400, \"font-family\": \"var(--font-sans)\" }, String(v)));\n      if (i % step === 0 || i === s.length - 1) g.appendChild(svgText({ x: x + w / 2, y: H - 6, \"text-anchor\": \"middle\", \"font-size\": 12, fill: \"var(--ink-2)\", \"font-family\": \"var(--font-sans)\" }, weekLbl[i]));\n    });\n    g.appendChild(svgText({ x: L - 6, y: y(0) + 4, \"text-anchor\": \"end\", \"font-size\": 12, fill: \"var(--ink-2)\", \"font-family\": \"var(--font-sans)\" }, \"0\"));\n    return g;\n  }\n\n  /* ---- Roadmap ---- */\n  function viewRoadmap() {\n    var sec = el(\"section\", { class: \"sec\", id: \"s-road\", \"aria-labelledby\": \"s-road-h\" });\n    var total = D.cards.length;\n    var nWorse = {}; D.worse.forEach(function (w) { nWorse[w.key] = 1; });\n    var worseN = Object.keys(nWorse).length;\n    secHead(\"s-road\", \"ROADMAP\", worseN ? \"近 7 天有 \" + worseN + \" 張卡變差\" : \"進行中 \" + total + \" 張卡，近 7 天沒有卡變差\",\n      \"進行中 \" + total + \" 張卡。變差＝狀態變差或上線日延後（與 \" + (D.worseSince ? md(D.worseSince) : \"7 天前\") + \" 相比）。\").forEach(function (n) { if (n) sec.appendChild(n); });\n\n    var wp = el(\"div\", {});\n    if (!D.worseSince) wp.appendChild(el(\"div\", { class: \"empty\", text: \"找不到 7–10 天前的 Roadmap 紀錄，暫時無法比較。\" }));\n    else if (!D.worse.length) wp.appendChild(el(\"div\", { class: \"empty\", text: \"沒有卡變差。\" }));\n    var byKey = {}, keys = [];\n    D.worse.forEach(function (w) { if (!byKey[w.key]) { byKey[w.key] = { w: w, items: [] }; keys.push(w.key); } byKey[w.key].items.push(w); });\n    keys.forEach(function (k) {\n      var g = byKey[k];\n      wp.appendChild(el(\"div\", { class: \"row\" }, [\n        el(\"span\", { class: \"code\", text: k.replace(\"APPIDEAS-\", \"#\") }),\n        el(\"span\", {}, [link(g.w.url, g.w.summary), el(\"span\", { class: \"chips\" }, g.items.map(function (w) {\n          var st = w.what === \"狀態變差\";\n          return el(\"span\", { class: \"chip \" + (st ? \"c-hot\" : \"c-warn\"),\n            text: w.what + \"：\" + (st ? statusZh(w.from) + \" → \" + statusZh(w.to) : md(w.from) + \" → \" + md(w.to)) });\n        }))])]));\n    });\n    sec.appendChild(wp);\n\n    var order = [\"Discovery\", \"Design\", \"Develop\", \"Impact\"];\n    var sb = el(\"div\", { class: \"stagebar\", role: \"img\", \"aria-label\": order.map(function (s) { return stageZh(s) + \" \" + (D.stages[s] || 0); }).join(\"、\") });\n    order.forEach(function (s) {\n      var n = D.stages[s] || 0; if (!n) return;\n      sb.appendChild(el(\"div\", { style: \"flex:\" + n, title: stageZh(s) + \" \" + n, text: String(n) }));   // 名稱放在下面的圖說，條上只放數字（窄螢幕也不會被切掉）\n    });\n    sec.appendChild(el(\"h3\", { class: \"sub-h\", text: \"各階段張數\" }));\n    sec.appendChild(sb);\n    sec.appendChild(el(\"div\", { class: \"legend\", text: order.map(function (s) { return stageZh(s) + \" \" + (D.stages[s] || 0); }).join(\"　·　\") }));\n\n    var lt = el(\"table\", {}, [el(\"thead\", {}, [el(\"tr\", {}, [\"團隊\", \"卡\", \"點數\", \"手上工作量（月）\", \"狀態\"].map(function (h) { return el(\"th\", { text: h }); }))])]);\n    var tb = el(\"tbody\");\n    D.load.forEach(function (r) {\n      var v = r.verdict === \"overload\" ? [\"c-hot\", \"過載\"] : r.verdict === \"healthy\" ? [\"c-ok\", \"正常\"] : [\"c-mute\", \"沒有基準\"];\n      tb.appendChild(el(\"tr\", {}, [el(\"td\", { text: r.domain + (pmOf(r.domain) ? \"（\" + pmOf(r.domain) + \"）\" : \"\") }), el(\"td\", { class: \"n\", text: String(r.cards) }),\n        el(\"td\", { class: \"n\", text: String(r.points) }), el(\"td\", { class: \"n\", text: r.months == null ? \"—\" : r.months.toFixed(1) }),\n        el(\"td\", {}, [el(\"span\", { class: \"chip \" + v[0], text: v[1] })])]));\n    });\n    lt.appendChild(tb);\n    sec.appendChild(el(\"h3\", { class: \"sub-h\", text: \"團隊負荷\" }));\n    sec.appendChild(el(\"div\", { class: \"tbl\" }, [lt]));\n    if (D.baselineExpired) sec.appendChild(el(\"div\", { class: \"note\", text: \"注意：產能基準 \" + md(D.baselineExpiresAt) + \" 已過期，等 PMT 給新一季的數字；目前沿用上一季。\" }));\n\n    var ut = el(\"table\", {}, [el(\"thead\", {}, [el(\"tr\", {}, [\"日期\", \"卡\", \"團隊\", \"狀態\"].map(function (h) { return el(\"th\", { text: h }); }))])]);\n    var ub = el(\"tbody\");\n    D.upcoming.forEach(function (u) {\n      ub.appendChild(el(\"tr\", {}, [el(\"td\", { text: md(u.date) }), el(\"td\", {}, [link(\"https://17media.atlassian.net/browse/\" + u.key, u.summary)]),\n        el(\"td\", { text: u.domain }), el(\"td\", {}, [statusChip(u.project_status)])]));\n    });\n    ut.appendChild(ub);\n    sec.appendChild(el(\"h3\", { class: \"sub-h\", text: \"接下來要上線\" }));\n    sec.appendChild(el(\"div\", { class: \"tbl\" }, [ut]));\n\n    sec.appendChild(el(\"h3\", { class: \"sub-h\", text: \"標了 VoC 但還沒對到痛點的卡（\" + D.unbacked.length + \"）\" }));\n    if (!D.unbacked.length) sec.appendChild(el(\"div\", { class: \"empty\", text: \"沒有。\" }));\n    D.unbacked.forEach(function (c) {\n      sec.appendChild(el(\"div\", { class: \"row\" }, [el(\"span\", { class: \"code\", text: c.key.replace(\"APPIDEAS-\", \"#\") }),\n        el(\"span\", {}, [link(c.url, c.summary), el(\"span\", { class: \"chips\" }, [el(\"span\", { class: \"chip c-mute\", text: stageZh(c.stage) }), statusChip(c.project_status)])])]));\n    });\n\n    var all = el(\"details\", { class: \"more\" }, [el(\"summary\", { text: \"全部進行中的卡（\" + total + \"）\" })]);\n    var at = el(\"table\", {}, [el(\"thead\", {}, [el(\"tr\", {}, [\"卡\", \"階段\", \"狀態\", \"團隊\", \"預計上線\"].map(function (h) { return el(\"th\", { text: h }); }))])]);\n    var ab = el(\"tbody\");\n    D.cards.slice().sort(function (a, b) { return (b.project_status !== \"On track\") - (a.project_status !== \"On track\") || (a.release_date || \"9\").localeCompare(b.release_date || \"9\"); })\n      .forEach(function (c) {\n        ab.appendChild(el(\"tr\", {}, [el(\"td\", {}, [link(c.url, c.summary)]), el(\"td\", { text: stageZh(c.stage) }), el(\"td\", {}, [statusChip(c.project_status)]),\n          el(\"td\", { text: c.domain || \"—\" }), el(\"td\", { text: c.release_date ? md(c.release_date) : \"未定\" })]));\n      });\n    at.appendChild(ab); all.appendChild(el(\"div\", { class: \"tbl\" }, [at]));\n    sec.appendChild(all);\n    view.appendChild(sec);\n  }\n  var STAGE_ZH = { Discovery: \"探索\", Design: \"設計\", Develop: \"開發\", Impact: \"上線觀察\" };\n  function stageZh(s) { return STAGE_ZH[s] || s || \"—\"; }\n  function statusZh(s) { return s === \"On track\" ? \"正常\" : s === \"Warning\" ? \"注意\" : s === \"At Risk\" ? \"有風險\" : s === \"Off track\" ? \"落後\" : (s || \"未填\"); }\n  function statusChip(s) {\n    var c = s === \"On track\" ? \"c-ok\" : s === \"Warning\" ? \"c-warn\" : \"c-hot\";\n    return el(\"span\", { class: \"chip \" + c, text: statusZh(s) });\n  }\n\n  /* ---- Slack＋表單（取代舊的 VoC Console）---- */\n  function viewSlack(into) {\n    var S = D.slack;\n    into.appendChild(el(\"h3\", { class: \"sub-h\", text: \"每日新增聲音（Slack ＋ 表單）\" }));\n    if (!S.ok) { into.appendChild(el(\"div\", { class: \"empty\", text: S.problem })); return; }\n    var t = el(\"table\", {}, [el(\"thead\", {}, [el(\"tr\", {}, [\"來源\", \"昨天\", \"近 7 天\", \"已對到痛點\", \"新痛點候選\"].map(function (h) { return el(\"th\", { text: h }); }))])]);\n    var b = el(\"tbody\");\n    S.bySource.forEach(function (r) {\n      b.appendChild(el(\"tr\", {}, [el(\"td\", { text: r.source }), el(\"td\", { class: \"n\", text: String(r.yesterday) }), el(\"td\", { class: \"n\", text: String(r.week) }),\n        el(\"td\", { class: \"n\", text: String(r.matched) }), el(\"td\", { class: \"n\", text: String(r.cand) })]));\n    });\n    if (!S.bySource.length) b.appendChild(el(\"tr\", {}, [el(\"td\", { colspan: \"5\", text: \"最近沒有新聲音。\" })]));\n    t.appendChild(b); into.appendChild(el(\"div\", { class: \"tbl\" }, [t]));\n    into.appendChild(el(\"div\", { class: \"note\", text: \"收集機器人最後一次成功：\" + (S.lastRun || \"未知\") + \"。每天 08:10 自動跑。\" }));\n    into.appendChild(el(\"h3\", { class: \"sub-h\", text: \"最新聲音（\" + S.latest.length + \" 則）\" }));\n    S.latest.forEach(function (v) { into.appendChild(voiceEl(v)); });\n    if (!S.latest.length) into.appendChild(el(\"div\", { class: \"empty\", text: \"還沒有資料。\" }));\n    into.appendChild(el(\"div\", { class: \"note\", text: \"對到痛點的聲音也會出現在該痛點細節的「更多細節」裡。\" }));\n  }\n\n  /* ---- 資料來源狀態 ---- */\n  function viewHealth(into) {\n    var S = D.slack;\n    var sttOk = D.sttSource === \"bigquery\" && D.sttAgeDays <= 10;\n    var rows = [\n      [\"Jira Roadmap\", \"每天 09:00 自動更新\", md(D.jiraAsOf), D.jiraAgeDays > 2 ? \"c-warn\" : \"c-ok\", D.jiraAgeDays > 2 ? \"注意\" : \"正常\"],\n      [\"直播原話週統計\", \"週報每週一批\", md(D.latestWeek.start) + \"–\" + md(D.latestWeek.end) + \" 那週\", sttOk ? \"c-ok\" : \"c-warn\", sttOk ? \"正常\" : \"注意\"],\n      [\"判讀覆蓋率（可信度）\", \"每天 08:30\", D.trustSince ? md(D.trustSince) + \" 起 4 週\" : \"讀不到\", D.trustSince ? \"c-ok\" : \"c-warn\", D.trustSince ? \"正常\" : \"注意\"],\n      [\"Slack＋表單\", \"每天 08:10\", S.ok ? (S.lastRun || \"未知\") : \"讀不到\", S.ok && S.lastRun ? \"c-ok\" : \"c-warn\", S.ok && S.lastRun ? \"正常\" : \"注意\"],\n      [\"客服工單、聊天機器人\", \"—\", \"—\", \"c-mute\", \"還沒納入\"]\n    ];\n    var t = el(\"table\", {}, [el(\"thead\", {}, [el(\"tr\", {}, [\"來源\", \"更新頻率\", \"最新資料\", \"狀態\"].map(function (h) { return el(\"th\", { text: h }); }))])]);\n    var b = el(\"tbody\");\n    rows.forEach(function (r) { b.appendChild(el(\"tr\", {}, [el(\"td\", { text: r[0] }), el(\"td\", { text: r[1] }), el(\"td\", { text: r[2] }), el(\"td\", {}, [el(\"span\", { class: \"chip \" + r[3], text: r[4] })])])); });\n    t.appendChild(b);\n    into.appendChild(el(\"h3\", { class: \"sub-h\", text: \"資料來源狀態\" }));\n    into.appendChild(el(\"div\", { class: \"tbl\" }, [t]));\n    if (D.sttSource !== \"bigquery\") into.appendChild(el(\"div\", { class: \"note\", text: \"週人數目前用備援資料。原因：\" + D.sttProblem }));\n    var zero = D.pains.filter(function (x) { return x.allZero; }).map(function (x) { return x.code; });\n    if (zero.length) into.appendChild(el(\"div\", { class: \"note\", text: \"數字可能不準：\" + zero.join(\"、\") + \" 這 \" + D.weeks.length + \" 週都是 0 位，可能是週報沒有統計這幾個痛點，不代表沒人抱怨。\" }));\n    into.appendChild(el(\"div\", { class: \"note\", text: \"時間段分析用最近 \" + D.weeks.length + \" 週。畫面資料產生於 \" + D.generatedAt + \"，6 小時內重新打開會沿用同一份。\" }));\n  }\n\n  /* 各區分開畫：一區出錯不影響其他區 */\n  [viewTop, viewOff, viewAll, viewRoadmap].forEach(function (fn) {\n    try { fn(); } catch (err) {\n      if (window.console) console.error(err);\n      view.appendChild(el(\"section\", { class: \"sec\" }, [el(\"div\", { class: \"empty\", text: \"這一區整理資料時出錯。\" + HELP })]));\n    }\n  });\n  booting = false;\n  if (todo.length) {\n    document.getElementById(\"hlgo\").appendChild(el(\"button\", { class: \"btn primary\", type: \"button\", text: \"看第一則：\" + todo[0].code + \" ▾\",\n      onclick: function () { var a = view.querySelector('#s-top article.story .sh'); if (a && a.getAttribute(\"aria-expanded\") !== \"true\") a.click(); else if (a) a.scrollIntoView({ block: \"start\" }); } }));\n  }\n\n  /* ---- 頁尾：資料來源一行，展開看 Slack＋表單與各來源狀態（出錯也不影響上面的主畫面） ---- */\n  try { (function () {\n    var S = D.slack;\n    var bad = (D.jiraAgeDays > 2) || !(D.sttSource === \"bigquery\" && D.sttAgeDays <= 10) || !(S.ok && S.lastRun) || !D.trustSince;\n    document.getElementById(\"srcline\").textContent = (bad ? \"⚠️ 有資料來源要注意\" : \"✅ 資料來源都正常\") +\n      \"　·　聲音 \" + md(D.latestWeek.start) + \"–\" + md(D.latestWeek.end) + \"　·　Roadmap \" + md(D.jiraAsOf) +\n      \"　·　Slack＋表單 \" + (S.ok ? (S.lastRun || \"未知\") : \"讀不到\") + \"　（點開看詳情）\";\n    var body = document.getElementById(\"srcbody\");\n    viewHealth(body);\n    viewSlack(body);\n  })(); } catch (err) {\n    if (window.console) console.error(err);\n    document.getElementById(\"srcline\").textContent = \"資料來源詳情整理時出錯。\" + HELP;\n  }\n  }\n\n  /* ---- 跟伺服器拿資料 ---- */\n  var statusEl = document.getElementById(\"status\");\n  function showStatus(text) { statusEl.textContent = text; statusEl.hidden = !text; }\n\n  function load() {\n    google.script.run\n      .withSuccessHandler(function (d) {\n        D = d;\n        var warn = [];\n        if (D.sttSource !== \"bigquery\") warn.push(\"週人數資料暫時讀不到（\" + D.sttProblem + \"），先用備援資料（只有 \" + D.weeks.length + \" 週）。\");\n        if (D.missingWeeks && D.missingWeeks.length) warn.push(\"週報少了 \" + D.missingWeeks.map(md).join(\"、\") + \" 那週的資料，那幾週先當 0 位算，新興／持續／消退可能不準。\");\n        showStatus(warn.length ? \"注意：\" + warn.join(\" \") : \"\");\n        try {\n          init();\n        } catch (err) {\n          if (window.console) console.error(err);\n          showStatus(\"畫面整理資料時出錯。\" + HELP);\n        }\n      })\n      .withFailureHandler(function (e) {\n        showStatus(\"讀不到資料（\" + errText(e) + \"）。\" + HELP);\n      })\n      .getDashboard();\n  }\n  load();\n})();\n<\/script>\n";
