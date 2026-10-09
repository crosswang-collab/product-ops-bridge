/**
 * STT Export — 每天用「Cross 本人的 BigQuery 權限」讀 STT-VoC 統計數字，推進 GitHub repo。
 *
 * 為什麼是 Apps Script：公司禁止產生 GCP 服務帳號金鑰。Apps Script 以執行者本人的身分
 * 存取 BigQuery（跟 VoC Daily Bot 讀 Sheet 同一套機制），全程不產生任何 GCP 金鑰。
 *
 * 只抓「聚合後的數字」：userID / 原話（stt）/ context 從頭到尾不離開 BigQuery。
 * 寫進 repo 的 voc-graph/out/stt-latest.json 只有 人數、件數、代碼、hit_id。
 * GitHub 那邊的 check.py C8 會再掃一次，出現個資欄位一律 FAIL。
 *
 * 部署：見 voc-graph/gas/README.md（5 步）。
 *
 * 函數：
 *   testSttExport()  只讀 BigQuery、印出摘要，不推 GitHub。部署後第一個跑這個。
 *   runDaily()       正式執行：讀 → 驗證 → 跟 repo 現有檔比對 → 有變才推。排程跑這個。
 *   setupTrigger()   建立每天 08:30 JST 的排程（重複執行也只會有一個排程）。
 *
 * 失敗時：寄信給執行者本人，並讓這次執行顯示為失敗。不寫入任何半份資料。
 * 就算這支默默停了，GitHub 的 check.py C4 會在 STT 超過 14 天沒更新時紅燈寄信。
 */

// ═══════════════ 設定（只有 GITHUB_TOKEN 需要你填） ═══════════════

var GITHUB_TOKEN = 'PASTE_GITHUB_FINE_GRAINED_TOKEN_HERE';   // ← 第 3 步產生的 token（github_pat_ 開頭）

var GITHUB_OWNER = 'crosswang-collab';
var GITHUB_REPO = 'product-ops-bridge';
var GITHUB_BRANCH = 'main';
var GITHUB_PATH = 'voc-graph/out/stt-latest.json';

var BQ_PROJECT = 'media17-1119';                        // 查詢費用記在這個專案（你在主控台跑查詢用的同一個）
var JUDGMENTS_TABLE = 'media17-1119.DataLab_Ayana.stt_voc_judgments';      // F 主題（Gemini 判定）
var METRICS_TABLE = 'media17-1119.DataLab_Ayana.stt_voc_weekly_metrics';   // 25 痛點（週報定点）
var LOOKBACK_DAYS = 63;                                 // 9 週

var TRIGGER_HOUR_JST = 8;
var TRIGGER_MINUTE = 30;

// 已知欄位值（2026-10-05 Cross 在主控台實查確認）。出現清單外的值 = 上游定義變了，停下，不算錯。
var KNOWN_EXIST = ['TRUE_PAIN', 'TOPIC', 'NOISE', ''];
var KNOWN_TIER = ['sTop', 'Top', 'Regular', '無印', ''];
var PAIN_CODE_RE = '[SUX][0-9]\\.[0-9]';                // 在 SQL 字串裡會變成 [SUX][0-9]\.[0-9]

// ═══════════════ SQL（與先前 GitHub 版 fetch_stt.py 相同定義） ═══════════════

function sqlBase_() {
  return [
    'WITH base AS (',
    '  SELECT window_start, window_end, hit_id, userID,',
    "    IFNULL(priority, '') AS priority, IFNULL(exist, '') AS exist,",
    "    IFNULL(actionability, '') AS actionability, IFNULL(tier, '') AS tier,",
    "    IFNULL(prompt_version, '') AS prompt_version, IFNULL(dict_version, '') AS dict_version,",
    "    ARRAY(SELECT TRIM(c) FROM UNNEST(SPLIT(IFNULL(catalog, ''), '/')) c WHERE TRIM(c) != '') AS themes,",
    "    ARRAY(SELECT DISTINCT p FROM UNNEST(REGEXP_EXTRACT_ALL(IFNULL(pain25_tags, ''), r'" + PAIN_CODE_RE + "')) p) AS pains",
    '  FROM `' + JUDGMENTS_TABLE + '`',
    "  WHERE window_start >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL " + LOOKBACK_DAYS + ' DAY)',
    '),',
    'board AS (',
    "  SELECT * FROM base WHERE priority = 'P1' AND exist = 'TRUE_PAIN'",
    "    AND actionability IN ('PRODUCT_ACTIONABLE', 'OPERATION_ACTIONABLE')",
    ')'
  ].join('\n');
}

var SQL = {
  values: function () {
    return sqlBase_() + '\nSELECT ARRAY_AGG(DISTINCT exist) AS exist_values, ARRAY_AGG(DISTINCT tier) AS tier_values,' +
      ' ARRAY_AGG(DISTINCT priority) AS priority_values, COUNT(*) AS rows_total FROM base';
  },
  windows: function () {
    return sqlBase_() + '\n' + [
      'SELECT w.window_start, w.window_end, w.judged_rows, w.true_pain_rows,',
      '  IFNULL(b.board_rows, 0) AS board_rows, IFNULL(b.board_streamers, 0) AS board_streamers,',
      '  w.prompt_versions, w.dict_versions',
      'FROM (',
      '  SELECT window_start, window_end, COUNT(*) AS judged_rows,',
      "    COUNTIF(exist = 'TRUE_PAIN') AS true_pain_rows,",
      '    ARRAY_AGG(DISTINCT prompt_version) AS prompt_versions, ARRAY_AGG(DISTINCT dict_version) AS dict_versions',
      '  FROM base GROUP BY window_start, window_end',
      ') w LEFT JOIN (',
      '  SELECT window_start, COUNT(*) AS board_rows, COUNT(DISTINCT userID) AS board_streamers',
      '  FROM board GROUP BY window_start',
      ') b USING (window_start)',
      'ORDER BY w.window_start'
    ].join('\n');
  },
  themes: function () {
    return sqlBase_() + '\n' + [
      'SELECT window_start, theme AS code, COUNT(DISTINCT userID) AS streamers, COUNT(*) AS rows_n,',
      "  COUNT(DISTINCT IF(tier = 'sTop', userID, NULL)) AS stop_streamers,",
      "  COUNT(DISTINCT IF(tier = 'Top', userID, NULL)) AS top_streamers,",
      '  ARRAY_AGG(hit_id ORDER BY hit_id LIMIT 3) AS sample_hit_ids',
      'FROM board, UNNEST(themes) AS theme',
      'GROUP BY window_start, theme ORDER BY window_start, streamers DESC'
    ].join('\n');
  },
  // 25 痛點讀 weekly_metrics（週報定点）。判定表只收 P1+4 lane，大部分痛點進不去（2026-10-05 實測）。
  // 同一窗被重建過會有多次 loaded_at，只取最新。定点沒有 tier → sTop/Top 為 NULL。
  pains: function () {
    return [
      'SELECT window_start,',
      "  REGEXP_EXTRACT(metric_key, r'^(" + PAIN_CODE_RE + ")') AS code,",
      '  n_liver AS streamers, n_seg AS rows_n,',
      '  CAST(NULL AS INT64) AS stop_streamers, CAST(NULL AS INT64) AS top_streamers,',
      '  ARRAY<STRING>[] AS sample_hit_ids',
      'FROM `' + METRICS_TABLE + '`',
      "WHERE metric_type = 'pain25' AND REGEXP_CONTAINS(metric_key, r'^" + PAIN_CODE_RE + "')",
      "  AND window_start >= DATE_SUB(CURRENT_DATE('Asia/Tokyo'), INTERVAL " + LOOKBACK_DAYS + ' DAY)',
      'QUALIFY ROW_NUMBER() OVER (PARTITION BY window_start, metric_key ORDER BY loaded_at DESC) = 1',
      'ORDER BY window_start, streamers DESC'
    ].join('\n');
  },
  // 判讀覆蓋率：每週 × 痛點代碼 × 判定結果的人數（不限 P1／lane，判定表裡全部的列）。
  // 拿來對照 pains（週報定点人數），看哪些痛點「有人講、但幾乎沒被判讀」。沒有痛點代碼的列記成 (無代碼)。
  coverage: function () {
    return sqlBase_() + '\n' + [
      "SELECT window_start, IFNULL(pain, '(無代碼)') AS code, exist,",
      '  COUNT(DISTINCT userID) AS streamers, COUNT(*) AS rows_n',
      'FROM base LEFT JOIN UNNEST(base.pains) AS pain',
      'GROUP BY window_start, code, exist',
      'ORDER BY window_start, code, exist'
    ].join('\n');
  },
  themePain: function () {
    return sqlBase_() + '\n' + [
      'SELECT window_start, theme, pain, COUNT(DISTINCT userID) AS streamers',
      'FROM base, UNNEST(themes) AS theme, UNNEST(pains) AS pain',
      "WHERE exist = 'TRUE_PAIN'",
      'GROUP BY window_start, theme, pain HAVING streamers >= 2',
      'ORDER BY window_start, streamers DESC'
    ].join('\n');
  }
};

// ═══════════════ 對外函數 ═══════════════

function testSttExport() {
  var doc = buildDoc_();
  var w = doc.windows[doc.windows.length - 1];
  console.log('✅ BigQuery 讀取成功（沒有推 GitHub）');
  console.log('週數：' + doc.windows.length + '，最新窗：' + w.window_start + '〜' + w.window_end);
  console.log('F 主題 ' + doc.themes.length + ' 列，25 痛點 ' + doc.pains.length + ' 列，共現 ' + doc.theme_pain.length +
    ' 列，覆蓋率 ' + doc.coverage.length + ' 列');
  var latestPains = doc.pains.filter(function (r) { return r.window_start === w.window_start; }).slice(0, 5);
  console.log('最新窗痛點前 5：' + latestPains.map(function (r) { return r.code + '=' + r.streamers; }).join('、'));
  if (GITHUB_TOKEN.indexOf('PASTE_') === 0) {
    console.log('⚠️ GITHUB_TOKEN 還沒填。填好後跑 runDaily()。');
  } else {
    var cur = githubGet_();
    console.log('✅ GitHub token 可用（repo 目前' + (cur ? '已有' : '還沒有') + ' stt-latest.json）');
  }
}

function runDaily() {
  try {
    if (GITHUB_TOKEN.indexOf('PASTE_') === 0) throw new Error('GITHUB_TOKEN 還沒填（檔案最上面）');
    var doc = buildDoc_();
    var cur = githubGet_();
    if (cur && sameData_(cur.doc, doc)) {
      console.log('資料跟 repo 現有版本相同，不推（避免空 commit）');
      return;
    }
    var w = doc.windows[doc.windows.length - 1];
    githubPut_(JSON.stringify(doc, null, 1) + '\n', cur ? cur.sha : null,
      'data(stt): ' + w.window_start + '〜' + w.window_end + ' STT 聚合（Apps Script 以 Cross 身分讀取）');
    console.log('✅ 已推上 ' + GITHUB_PATH);
  } catch (e) {
    notifyFailure_(e);
    throw e;   // 讓 Apps Script 也把這次標成失敗
  }
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDaily').timeBased().everyDays(1)
    .atHour(TRIGGER_HOUR_JST).nearMinute(TRIGGER_MINUTE).inTimezone('Asia/Tokyo').create();
  console.log('✅ 排程已設定：每天 ' + TRIGGER_HOUR_JST + ':' + TRIGGER_MINUTE + ' JST 跑 runDaily()');
}

// ═══════════════ 組資料 ═══════════════

function buildDoc_() {
  var vals = bqQuery_(SQL.values(), '欄位值檢查')[0];
  var problems = validateValues_(vals);
  if (problems.length) throw new Error('STT 判定表的欄位值跟預期不同，不寫檔：' + problems.join('；'));

  var windows = bqQuery_(SQL.windows(), '週次摘要');
  var themes = bqQuery_(SQL.themes(), 'F 主題');
  var pains = bqQuery_(SQL.pains(), '25 痛點');
  var themePain = bqQuery_(SQL.themePain(), '主題×痛點共現');
  var coverage = bqQuery_(SQL.coverage(), '判讀覆蓋率');

  if (!windows.length) throw new Error(JUDGMENTS_TABLE + ' 最近 ' + LOOKBACK_DAYS + ' 天沒有任何窗');
  if (!pains.length) throw new Error(METRICS_TABLE + " 最近 " + LOOKBACK_DAYS + " 天沒有 pain25 —— 25 痛點會全部變 0，不寫檔");

  [themes, pains, coverage].forEach(function (rows) {
    rows.forEach(function (r) { r.rows = r.rows_n; delete r.rows_n; });
  });

  var now = new Date();
  return {
    schema_version: 1,
    fetched_at: now.toISOString().replace(/\.\d+Z$/, '+00:00'),
    fetched_date: Utilities.formatDate(now, 'UTC', 'yyyy-MM-dd'),
    fetched_by: 'apps-script',
    source_table: JUDGMENTS_TABLE,
    lookback_days: LOOKBACK_DAYS,
    definitions: {
      board: "priority='P1' ∧ exist='TRUE_PAIN' ∧ actionability ∈ PRODUCT/OPERATION_ACTIONABLE（F 主題母體）",
      pain: 'stt_voc_weekly_metrics 的 pain25（＝週報定点：正規表現檢知，不經 Gemini 判定，無 tier）',
      streamers: 'COUNT(DISTINCT userID)，主指標',
      coverage: '判定表全部列（不限 P1／lane）依 週×痛點代碼×exist 的人數；(無代碼)＝pain25_tags 沒有代碼',
      precision_note: 'Gemini 判定適合率 77–86%、再現率 96–100%（ayana n=90 盲檢）→ F 主題人數約多算 1–2 成'
    },
    windows: windows,
    themes: themes,
    pains: pains,
    theme_pain: themePain,
    coverage: coverage
  };
}

function validateValues_(v) {
  var p = [];
  if (!v || !Number(v.rows_total)) p.push(JUDGMENTS_TABLE + ' 最近 ' + LOOKBACK_DAYS + ' 天沒有任何列');
  var badExist = (v.exist_values || []).filter(function (x) { return KNOWN_EXIST.indexOf(x) < 0; });
  var badTier = (v.tier_values || []).filter(function (x) { return KNOWN_TIER.indexOf(x) < 0; });
  if (badExist.length) p.push('exist 出現沒見過的值：' + badExist.join(','));
  if (badTier.length) p.push('tier 出現沒見過的值：' + badTier.join(','));
  if ((v.priority_values || []).indexOf('P1') < 0) p.push("priority 裡沒有 'P1'（實際：" + (v.priority_values || []).join(',') + '）');
  return p;
}

// 比對時忽略 fetched_at / fetched_date：數字沒變就不推
function sameData_(a, b) {
  var strip = function (d) {
    var c = JSON.parse(JSON.stringify(d));
    delete c.fetched_at; delete c.fetched_date;
    return JSON.stringify(c);
  };
  try { return strip(a) === strip(b); } catch (e) { return false; }
}

// ═══════════════ BigQuery ═══════════════

function bqQuery_(sql, label) {
  var res = withRetry_(function () {
    return BigQuery.Jobs.query({ query: sql, useLegacySql: false, timeoutMs: 60000 }, BQ_PROJECT);
  }, 'BigQuery ' + label);
  var jobId = res.jobReference.jobId;
  var location = res.jobReference.location;
  var deadline = Date.now() + 5 * 60 * 1000;
  while (!res.jobComplete) {
    if (Date.now() > deadline) throw new Error('BigQuery ' + label + ' 超過 5 分鐘沒跑完');
    Utilities.sleep(2000);
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
  var out = rows.map(function (r) { return convertRow_(fields, r); });
  console.log('[OK] ' + label + '：' + out.length + ' 列');
  return out;
}

// BigQuery REST 的列格式 {f:[{v:...}]} → 一般物件。INTEGER 轉數字，REPEATED 轉陣列，NULL 保持 null。
function convertRow_(fields, row) {
  var o = {};
  fields.forEach(function (f, i) {
    o[f.name] = convertValue_(f, row.f[i].v);
  });
  return o;
}

function convertValue_(f, v) {
  if (v === null || v === undefined) return f.mode === 'REPEATED' ? [] : null;
  if (f.mode === 'REPEATED') {
    return v.map(function (x) { return convertValue_({ type: f.type, mode: 'NULLABLE' }, x.v); });
  }
  if (f.type === 'INTEGER' || f.type === 'INT64') return Number(v);
  if (f.type === 'FLOAT' || f.type === 'FLOAT64' || f.type === 'NUMERIC') return Number(v);
  return v;  // DATE 已是 'YYYY-MM-DD' 字串，STRING 原樣
}

// ═══════════════ GitHub ═══════════════

function githubApi_(method, body) {
  var url = 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + GITHUB_PATH +
    (method === 'get' ? '?ref=' + GITHUB_BRANCH : '');
  var opt = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      Accept: 'application/vnd.github+json'
    }
  };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  return withRetry_(function () {
    var r = UrlFetchApp.fetch(url, opt);
    var code = r.getResponseCode();
    if (code === 429 || code >= 500) { var e = new Error('GitHub ' + code); e.transient = true; throw e; }
    return { code: code, body: r.getContentText() };
  }, 'GitHub ' + method.toUpperCase());
}

function githubGet_() {
  var r = githubApi_('get');
  if (r.code === 404) return null;
  if (r.code !== 200) throw new Error('GitHub 讀檔失敗 ' + r.code + '：' + r.body.slice(0, 300) + permissionHint_(r.code));
  var j = JSON.parse(r.body);
  var text = Utilities.newBlob(Utilities.base64Decode(j.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  var doc = null;
  try { doc = JSON.parse(text); } catch (e) { /* 壞掉的舊檔：直接覆蓋 */ }
  return { sha: j.sha, doc: doc };
}

function githubPut_(text, sha, message) {
  var body = {
    message: message,
    content: Utilities.base64Encode(text, Utilities.Charset.UTF_8),
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;
  var r = githubApi_('put', body);
  if (r.code === 409) {   // 剛好有人同時改了這個檔：重抓 sha 再試一次
    var cur = githubGet_();
    if (cur) body.sha = cur.sha;
    r = githubApi_('put', body);
  }
  if (r.code !== 200 && r.code !== 201) {
    throw new Error('GitHub 寫檔失敗 ' + r.code + '：' + r.body.slice(0, 300) + permissionHint_(r.code));
  }
}

function permissionHint_(code) {
  if (code === 401) return '（token 錯誤或已過期 → 重新產生 token，貼回檔案最上面）';
  if (code === 403 || code === 404) return '（token 沒有這個 repo 的 Contents 讀寫權限）';
  return '';
}

// ═══════════════ 共用 ═══════════════

// 只對暫時性錯誤重試（429/5xx/逾時/BigQuery 的 backendError、rateLimitExceeded）；其他直接丟出
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
      console.log('[RETRY] ' + label + ' 暫時性錯誤（第 ' + i + ' 次）：' + msg);
      Utilities.sleep(Math.pow(2, i) * 1000);
    }
  }
  throw last;
}

function notifyFailure_(e) {
  try {
    var to = Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(to, '[STT Export] 今天沒有更新 STT 資料',
      '錯誤：' + (e && e.message) + '\n\n' +
      '影響：voc-graph 頁面的 STT 數字停在上一次成功的版本；超過 14 天會讓 GitHub 驗收紅燈。\n' +
      '處理：把這封信的錯誤訊息貼給 Claude。\n\n' + (e && e.stack || ''));
  } catch (mailErr) {
    console.log('寄信失敗：' + mailErr);
  }
}
