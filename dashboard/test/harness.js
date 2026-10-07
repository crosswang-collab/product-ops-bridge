// 本機模擬 Apps Script 環境，跑 dashboard/gas/Dashboard.gs 的伺服器端邏輯。
// - repo 檔：讀本機檔案（等同 raw.githubusercontent.com）
// - BigQuery：依 SQL 內容回傳虛構列（原話是假的；週人數取自 repo 的 stt-latest.json 並延伸成 12 週）
// - 試算表：虛構的 VoC_Raw_Log / VoC_Bot_Log
// 用法：node dashboard/test/harness.js <輸出 json 路徑>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = process.argv[2] || path.join(__dirname, 'out.json');
const log = [];
const bqCalls = [];
let viewer = 'crosswang@17.media';

function fmt(d, tz, pat) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz === 'UTC' ? 'UTC' : 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
  return pat.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour === '24' ? '00' : parts.hour).replace('mm', parts.minute);
}

// ---- 虛構 BigQuery ----
const stt = JSON.parse(fs.readFileSync(path.join(ROOT, 'voc-graph/out/stt-latest.json'), 'utf8'));
function painRows() {
  const rows = [];
  stt.pains.forEach(r => rows.push({ window_start: r.window_start, code: r.code, streamers: r.streamers }));
  // 往前補 5 週（S2.1 用遞減值，測得出 12 週截斷），讓序列超過 10 週
  ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'].forEach((w, i) => {
    rows.push({ window_start: w, code: 'S2.1', streamers: 150 + i });
  });
  return rows;
}
function bqRows(sql, params) {
  if (/stt_voc_weekly_metrics/.test(sql)) return painRows();
  const code = (params.find(p => p.name === 'code') || {}).parameterValue.value;
  if (/COUNT\(DISTINCT userID\) AS streamers/.test(sql)) {
    return [{ issue_kind: 'BUG', failure_layer: 'CLIENT', streamers: 12, stop_streamers: 2, judged: 20 },
            { issue_kind: 'UX', failure_layer: '', streamers: 5, stop_streamers: 0, judged: 20 }];
  }
  if (/stt_j/.test(sql)) {
    return [
      { week: '2026-09-21', tier: 'sTop', issue_kind: 'BUG', failure_layer: 'CLIENT',
        summary_j: JSON.stringify('假摘要 ' + code), stt_j: JSON.stringify('<img src=x onerror=alert(1)>假原話'),
        context_j: JSON.stringify(['前一句', '後一句']) },
      { week: '2026-09-14', tier: '', issue_kind: 'UX', failure_layer: '', summary_j: 'null',
        stt_j: JSON.stringify({ text: '結構型原話' }), context_j: 'null' }
    ];
  }
  throw new Error('未預期的 SQL');
}
function toRest(rows) {
  const names = rows.length ? Object.keys(rows[0]) : ['x'];
  return { jobComplete: true, jobReference: { jobId: 'j', location: 'US' },
    schema: { fields: names.map(n => ({ name: n, type: 'STRING' })) },
    rows: rows.map(r => ({ f: names.map(n => ({ v: r[n] === null ? null : String(r[n]) })) })) };
}

// ---- 虛構試算表 ----
function raw(ing, occ, origin, summary, body, verdict, code, link) {
  const r = new Array(20).fill('');
  r[2] = ing; r[3] = occ; r[4] = origin; r[8] = summary; r[9] = body; r[10] = '發話者姓名';
  r[12] = link; r[13] = verdict; r[14] = code;
  return r;
}
function ymdOffset(n) { const d = new Date(Date.now() + n * 86400000); return fmt(d, 'Asia/Tokyo', 'yyyy/MM/dd'); }
const rawRows = [
  raw(ymdOffset(-9), ymdOffset(-9), 'VIP Feedback', '舊的', '舊聲音', '既存一致', 'S2.1', 'https://x/1'),
  raw(ymdOffset(-1), ymdOffset(-2), 'Slack', '閃退', '開播就閃退<script>', '既存一致', 'S2.1', 'javascript:alert(1)'),
  raw(new Date(Date.now() - 86400000), ymdOffset(-1), 'Slack', '新需求', '想要新功能', '新規候補', 'CAND-001', 'https://slack/2'),
];
const logRows = [[new Date(Date.now() - 3600e3), 'RUN', 'DONE']];
function sheet(rows) {
  return { getLastRow: () => rows.length + 1,
    getRange: (r, c, n, w) => ({ getValues: () => rows.slice(r - 2, r - 2 + n).map(x => x.slice(c - 1, c - 1 + w)) }) };
}

// ---- 快取 ----
const store = new Map();
const cache = { get: k => store.has(k) ? store.get(k) : null, put: (k, v) => store.set(k, v),
  putAll: m => Object.entries(m).forEach(([k, v]) => store.set(k, v)),
  getAll: ks => Object.fromEntries(ks.map(k => [k, store.has(k) ? store.get(k) : null])), remove: k => store.delete(k) };

// ---- 虛構 Google 翻譯（LanguageApp） ----
let trMode = 'ok';               // ok | daily | burst | bad
const trCalls = [];
const LanguageApp = { translate: (text, from, to) => {
  trCalls.push({ text, from, to });
  if (trMode === 'daily') throw new Error('Service invoked too many times for one day: translate.');
  if (trMode === 'burst') throw new Error('Service invoked too many times in a short time: translate. Try Utilities.sleep(1000) between calls.');
  if (trMode === 'dailyAfter1' && trCalls.length > 1) throw new Error('Service invoked too many times for one day: translate.');
  if (trMode === 'bad' && /結構/.test(text)) throw new Error('Invalid argument');
  if (trMode === 'zhquota') throw new Error('服務在一天內叫用次數過多：translate。');
  if (trMode === 'allbad') throw new Error('發生錯誤');
  return '中譯' + text.slice(0, 4);
} };

const ctx = {
  LanguageApp,
  console: { log: m => log.push(String(m)) },
  Session: { getActiveUser: () => ({ getEmail: () => viewer }) },
  UrlFetchApp: { fetch: (url, opt) => {
    const rel = url.replace('https://raw.githubusercontent.com/crosswang-collab/product-ops-bridge/main/', '');
    const f = path.join(ROOT, rel);
    const ok = fs.existsSync(f);
    return { getResponseCode: () => ok ? 200 : 404, getContentText: () => ok ? fs.readFileSync(f, 'utf8') : '' };
  } },
  BigQuery: { Jobs: {
    query: (req) => {
      assert.strictEqual(req.parameterMode, 'NAMED');
      bqCalls.push(req);
      return toRest(bqRows(req.query, req.queryParameters));
    },
    getQueryResults: () => { throw new Error('不該被呼叫'); } } },
  SpreadsheetApp: { openById: id => ({ getSheetByName: n =>
    n === 'VoC_Raw_Log' ? sheet(rawRows) : n === 'VoC_Bot_Log' ? sheet(logRows) : null }) },
  CacheService: { getScriptCache: () => cache },
  Utilities: { formatDate: fmt, sleep: () => {} },
  HtmlService: { createHtmlOutput: h => ({ html: h, setTitle() { return this; }, addMetaTag() { return this; } }) },
};
vm.createContext(ctx);
// 試算表回傳的 Date 要是沙盒裡的 Date（Apps Script 裡是同一個 realm）
const VDate = vm.runInContext('Date', ctx);
[rawRows, logRows].forEach(rows => rows.forEach(r => r.forEach((v, i) => { if (v instanceof Date) r[i] = new VDate(v.getTime()); })));
// 沙盒裡的陣列／物件跟這裡不是同一個原型 → 用 JSON 比對
const same = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
vm.runInContext(fs.readFileSync(path.join(ROOT, 'dashboard/gas/Dashboard.gs'), 'utf8'), ctx);

// ================= 測試 =================
const results = [];
function check(name, fn) {
  try { fn(); results.push('PASS ' + name); } catch (e) { results.push('FAIL ' + name + ' — ' + e.message); }
}

const d = ctx.getDashboard();
check('週數 = 12（BigQuery，超過 10 週）', () => { assert.strictEqual(d.sttSource, 'bigquery'); assert.strictEqual(d.weeks.length, 12); });
check('S2.1 序列 12 點、最新 242', () => { const p = d.pains.find(x => x.code === 'S2.1'); assert.strictEqual(p.series.length, 12); assert.strictEqual(p.latest, 242); });
check('判定：新興 U6.0、持續 5 個、消退 0', () => {
  same(d.pains.filter(p => p.rule.emerging).map(p => p.code), ['U6.0']);
  same(d.pains.filter(p => p.rule.persistent).map(p => p.code).sort(), ['S2.0', 'S2.1', 'U4.0', 'U4.1', 'U4.4']);
  assert.strictEqual(d.pains.filter(p => p.rule.fading).length, 0);
});
check('消退規則：每週都比前一週低才算', () => {
  assert.strictEqual(ctx.classify_([9, 8, 7, 6]).fading, true);
  assert.strictEqual(ctx.classify_([9, 8, 8, 6]).fading, false);
  assert.strictEqual(ctx.classify_([30, 25, 20, 40, 30, 20]).fading, false);
});
check('新興規則：前 4 週 < 2 位時不看倍數', () => {
  assert.strictEqual(ctx.classify_([0, 1, 1, 1, 10, 10]).emerging, true);
  assert.strictEqual(ctx.classify_([9, 9, 9, 9, 10, 10]).emerging, false);
  assert.strictEqual(ctx.classify_([1, 1, 1, 1, 9, 10]).emerging, false);
});
check('沒人負責 = 7 個（上週 ≥ 10 位且沒有卡）', () => assert.strictEqual(d.pains.filter(p => p.noOwner).length, 7));
check('Roadmap 變差 5 件、比較基準 9/29', () => { assert.strictEqual(d.worse.length, 5); assert.strictEqual(d.worseSince, '2026-09-29'); });
check('Cross 看得到編輯頁按鈕', () => { assert.ok(d.canEdit); assert.ok(d.editorUrl.startsWith('https://')); });
check('Slack：近 7 天 2 則、不含發話者姓名、只留 https 連結', () => {
  assert.strictEqual(d.slack.bySource.reduce((a, b) => a + b.week, 0), 2);
  assert.ok(!JSON.stringify(d).includes('發話者姓名'));
  assert.ok(!JSON.stringify(d).includes('javascript:'));
});
check('主資料沒有 userID', () => assert.ok(!/userID|liveStreamID/.test(JSON.stringify(d))));

const det = ctx.getPainDetail('S2.1');
check('原話：純文字、結構型也轉文字、前後文合併', () => {
  assert.strictEqual(det.quotes.length, 2);
  assert.strictEqual(det.quotes[1].text, '結構型原話');
  assert.strictEqual(det.quotes[0].context, '前一句\n後一句');
  assert.strictEqual(det.judgedStreamers, 20);
});
check('原話查詢只用具名參數 code／since，SQL 內沒有拼接代碼', () => {
  const q = bqCalls.filter(r => /stt_voc_judgments/.test(r.query));
  assert.ok(q.length === 2);
  q.forEach(r => {
    assert.ok(!r.query.includes("'S2.1'"));
    same(r.queryParameters.map(p => p.name).sort(), ['code', 'since']);
    assert.ok(!/SELECT[^;]*userID[^;]*FROM ranked/.test(r.query.split('FROM ranked')[0].split('\n').slice(-3).join(' ')));
  });
});
check('原話結果不含 userID', () => assert.ok(!/userID/.test(JSON.stringify(det))));
check('Slack 聲音對到 S2.1：2 則，連結 javascript: 被濾掉', () => {
  assert.strictEqual(det.voices.length, 2);
  assert.ok(det.voices.every(v => v.link === '' || v.link.startsWith('https://')));
});
check('第二次讀同一痛點走快取（不再查 BigQuery）', () => { const n = bqCalls.length; ctx.getPainDetail('S2.1'); assert.strictEqual(bqCalls.length, n); });
['', 'X1.0', "S2.1' OR '1'='1", 'U9.9', 'F01'].forEach(bad => check('拒絕不認得的代碼：' + JSON.stringify(bad), () => {
  assert.throws(() => ctx.getPainDetail(bad), /不認得/);
}));

viewer = 'someone@17.media';
check('名單外：getDashboard 拒絕', () => assert.throws(() => ctx.getDashboard(), /沒有權限/));
check('名單外：getPainDetail 拒絕', () => assert.throws(() => ctx.getPainDetail('S2.1'), /沒有權限/));
check('名單外：refreshNow 拒絕', () => assert.throws(() => ctx.refreshNow(), /沒有權限/));
check('名單外：testDashboard 拒絕', () => assert.throws(() => ctx.testDashboard(), /沒有權限/));
check('名單外：doGet 只給「沒有權限」頁，不含資料', () => { const h = ctx.doGet().html; assert.ok(h.includes('沒有權限') && !h.includes('getDashboard')); });
viewer = '';
check('未登入：拒絕', () => assert.throws(() => ctx.getDashboard(), /沒有權限/));
viewer = 'crosswang@17.media';
check('Cross：doGet 給完整頁面', () => assert.ok(ctx.doGet().html.includes('getDashboard')));
check('testDashboard 跑完且全部 ✅', () => { log.length = 0; ctx.testDashboard(); assert.ok(log.every(l => !l.startsWith('❌')), log.join(' | ')); });

// BigQuery 掛掉 → 退回 repo 7 週
store.clear();
const orig = ctx.BigQuery.Jobs.query;
ctx.BigQuery.Jobs.query = () => { throw new Error('Access Denied'); };
const d2 = ctx.getDashboard();
check('BigQuery 失敗：改用 repo 7 週並標示原因', () => { assert.strictEqual(d2.sttSource, 'repo'); assert.strictEqual(d2.weeks.length, 7); assert.strictEqual(d2.sttProblem, '沒有讀取權限'); });
const det2 = ctx.getPainDetail('U6.0');
check('BigQuery 失敗：痛點細節回 ok:false＋原因，不會整頁壞掉', () => { assert.strictEqual(det2.ok, false); assert.strictEqual(det2.problem, '讀不到直播原話：沒有讀取權限'); });
ctx.BigQuery.Jobs.query = orig;

// 原話／前後文是結構資料時，ID 類欄位不能出現在畫面上
check('原話結構含 userID／liveStreamID／時間：這些值不輸出', () => {
  const t = ctx.jsonText_(JSON.stringify([{ userID: 'U123456', liveStreamID: 'L999', speaker_name: '王小明', ts: 1700000000, text: '鍵盤卡住' },
                                          { user_id: 'U2', utterance: '又閃退' }]));
  assert.strictEqual(t, '鍵盤卡住\n又閃退');
  const t2 = ctx.jsonText_(JSON.stringify([{ sender: 'U777', host: 'H1', text: '留言A' }, '{"from":"U888","message":"留言B"}']));
  assert.strictEqual(t2, '留言A\n留言B');
});
check('讀取失敗的結果只快取 5 分鐘', () => {
  const puts = []; const op = cache.put; cache.put = (k, v, ttl) => { puts.push(ttl); op(k, v); };
  ctx.cachePut_('x', { a: 1 }, true); ctx.cachePut_('y', { a: 1 }, false);
  cache.put = op; same(puts, [300, 21600]);
});

// 錯誤訊息：畫面只看到中文
store.clear();
const origFetch = ctx.UrlFetchApp.fetch;
ctx.UrlFetchApp.fetch = url => /mapping/.test(url) ? { getResponseCode: () => 404, getContentText: () => '' } : origFetch(url);
check('repo 檔讀不到：錯誤訊息是中文、沒有 mapping／JSON 字樣', () => {
  try { ctx.getDashboard(); assert.fail('應該丟錯'); } catch (e) {
    assert.ok(!/mapping|json/i.test(e.message), e.message); assert.ok(/讀不到/.test(e.message), e.message);
  }
});
ctx.UrlFetchApp.fetch = origFetch;
check('BigQuery 英文錯誤轉成中文', () => {
  assert.strictEqual(ctx.friendly_(new Error('Access Denied: Table x')), '沒有讀取權限');
  assert.strictEqual(ctx.friendly_(new Error('Exceeded maximum execution time')), '暫時讀不到');
  assert.strictEqual(ctx.friendly_(new Error('讀不到 Roadmap 每日紀錄（代碼 500）')), '讀不到 Roadmap 每日紀錄（代碼 500）');
});

// 整週缺資料：週數仍是連續 12 週，並列出缺的週
store.clear();
const origQ = ctx.BigQuery.Jobs.query;
ctx.BigQuery.Jobs.query = req => {
  const r = origQ(req);
  if (/stt_voc_weekly_metrics/.test(req.query)) r.rows = r.rows.filter(x => x.f[0].v !== '2026-09-14');
  return r;
};
const dg = ctx.getDashboard();
check('整週缺資料：12 個連續週一、標出缺 9/14', () => {
  assert.strictEqual(dg.weeks.length, 12);
  same(dg.missingWeeks, ['2026-09-14']);
  assert.strictEqual(dg.weeks[10], '2026-09-14');
});
ctx.BigQuery.Jobs.query = origQ;

// 週報開始統計之前的週：不算缺，週數變少
store.clear();
ctx.BigQuery.Jobs.query = req => {
  const r = origQ(req);
  if (/stt_voc_weekly_metrics/.test(req.query)) r.rows = r.rows.filter(x => x.f[0].v >= '2026-08-10');
  return r;
};
const dl = ctx.getDashboard();
check('週報從 8/10 才開始：不報缺週、只列 7 週、判定照常', () => {
  same(dl.missingWeeks, []);
  assert.strictEqual(dl.weeks.length, 7);
  assert.strictEqual(dl.weeks[0], '2026-08-10');
  same(dl.pains.filter(p => p.rule.emerging).map(p => p.code), ['U6.0']);
});
ctx.BigQuery.Jobs.query = origQ;

// 試算表讀不到：痛點細節要說讀不到，不能裝作沒有聲音
store.clear();
const origSS = ctx.SpreadsheetApp.openById;
ctx.SpreadsheetApp.openById = () => { throw new Error('You do not have permission'); };
const ds = ctx.getPainDetail('S2.1');
check('試算表讀不到：細節標示原因、主資料 slack.ok=false', () => {
  assert.ok(/讀不到/.test(ds.voicesProblem)); assert.strictEqual(ds.voices.length, 0);
  assert.strictEqual(ctx.getDashboard().slack.ok, false);
});
ctx.SpreadsheetApp.openById = origSS;

// 大資料快取分段
check('快取超過 30000 字會分段（每段 ≤ 100KB）且讀得回來', () => {
  const big = { s: '中'.repeat(100000) };
  ctx.cachePut_('big', big);
  for (const [k, v] of store) assert.ok(Buffer.byteLength(String(v)) <= 100 * 1024, k + ' 超過 100KB');
  same(ctx.cacheGet_('big'), big);
});

// ---- 輸出＋摘要＋翻譯 ----
store.clear();
viewer = 'crosswang@17.media';
const exq = ctx.getPainExport('S2.1');
check('輸出：全部原話有編號、固定排序、不含 userID、結構原話轉文字', () => {
  assert.strictEqual(exq.rows.length, 2); assert.strictEqual(exq.rows[0].id, 'Q1'); assert.strictEqual(exq.batch, 20);
  assert.strictEqual(exq.rows[1].text, '結構型原話'); assert.ok(!/userID/.test(JSON.stringify(exq)));
  const q = bqCalls.filter(r => /LIMIT 3001/.test(r.query)); assert.strictEqual(q.length, 1);
  assert.ok(/window_start DESC, hit_id/.test(q[0].query));
  same(q[0].queryParameters.map(p => p.name).sort(), ['code', 'since']);
});
const items = exq.rows.map(r => ({ id: r.id, text: r.text }));
const tr = ctx.translateQuotes(items);
check('翻譯：Google 翻譯逐則翻成繁中、自動偵測來源語言、只回本批編號', () => {
  assert.deepStrictEqual(Object.keys(tr).sort(), ['Q1', 'Q2']);
  assert.ok(trCalls.every(c => c.from === '' && c.to === 'zh-TW'), JSON.stringify(trCalls));
});
check('翻譯：一次超過 20 則拒絕；格式不對的編號略過', () => {
  assert.throws(() => ctx.translateQuotes(Array.from({ length: 21 }, (_, i) => ({ id: 'Q' + i, text: 'x' }))), /上限 20/);
  same(ctx.translateQuotes([{ id: 'bad', text: 'x' }, { id: 'Q1', text: '' }]), {});
  assert.throws(() => ctx.translateQuotes('nope'), /格式不對/);
});
trMode = 'bad';
check('翻譯：單則出錯只跳過那一則', () => assert.deepStrictEqual(Object.keys(ctx.translateQuotes(items)), ['Q1']));
trMode = 'daily';
check('翻譯：每日次數用完 → 中文說明天補翻', () => assert.throws(() => ctx.translateQuotes(items), /今天的 Google 翻譯次數用完了/));
trMode = 'burst';
check('翻譯：短時間太多次 → 中文說太忙', () => assert.throws(() => ctx.translateQuotes(items), /太忙/));
trMode = 'zhquota';
check('翻譯：中文的次數用完訊息也認得', () => assert.throws(() => ctx.translateQuotes(items), /今天的 Google 翻譯次數用完了/));
trMode = 'allbad';
check('翻譯：整批都失敗 → 報錯讓頁面停下', () => assert.throws(() => ctx.translateQuotes(items), /Google 翻譯失敗：發生錯誤/));
trMode = 'dailyAfter1'; trCalls.length = 0;
check('翻譯：中途用完時，已翻好的先回傳', () => assert.deepStrictEqual(Object.keys(ctx.translateQuotes(items)), ['Q1']));
trMode = 'ok';
check('testTranslate 回報可以用', () => { log.length = 0; ctx.testTranslate(); assert.ok(log.some(l => l.startsWith('✅ Google 翻譯')), log.join('|')); });
["", "X1.0", "S2.1' OR '1'='1"].forEach(bad => check('輸出拒絕不認得的代碼：' + JSON.stringify(bad), () => {
  assert.throws(() => ctx.getPainExport(bad), /不認得/);
}));
viewer = 'someone@17.media';
check('名單外：輸出／翻譯／testTranslate 都拒絕', () => {
  assert.throws(() => ctx.getPainExport('S2.1'), /沒有權限/);
  assert.throws(() => ctx.translateQuotes(items), /沒有權限/);
  assert.throws(() => ctx.testTranslate(), /沒有權限/);
});

store.clear();
viewer = 'crosswang@17.media';
const out = { dash: ctx.getDashboard(), details: {} };
out.dash.pains.forEach(p => { out.details[p.code] = ctx.getPainDetail(p.code); });
out.export = ctx.getPainExport('S2.1'); out.zh = ctx.translateQuotes(out.export.rows.map(r => ({ id: r.id, text: r.text })));
fs.writeFileSync(OUT, JSON.stringify(out));

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n${results.length - fails} PASS / ${fails} FAIL`);
process.exit(fails ? 2 : 0);
