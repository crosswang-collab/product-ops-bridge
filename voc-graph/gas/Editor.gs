/**
 * Editor.gs —「誰在處理這個痛點」編輯頁（Apps Script 網頁版）
 *
 * 放在 STT Export 同一個 Apps Script 專案裡，當成第二個檔案。
 * 直接沿用 SttExport.gs 最上面的 GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH，不用再填任何東西。
 *
 * 為什麼放這裡：用 Cross 的 Google 帳號開，部署設成「只有我」才能存取 → 不用 GitHub token、別人打不開。
 *
 * 運作：
 *   doGet()            打開網頁時，從 repo 讀 voc-graph/gas/Editor.html（介面改版只要更新 repo，不用重貼這支）
 *   loadEditorData()   讀 repo 的對照圖（latest.json）與對應表（mapping.json），給介面用
 *   saveMapping()      介面自動儲存時呼叫：寫回 mapping.json → GitHub Actions 自動重算對照圖
 *
 * 安全：
 *   · 寫入前比對版本（sha）；編輯期間被別處改過就不存，請使用者重新整理，不蓋掉別人的修改
 *   · 只接受合法的痛點代碼（如 U6.0）與卡號（APPIDEAS-數字）
 *   · LockService：同時兩個分頁存檔時排隊，不會互相覆蓋
 */

var EDITOR_HTML_PATH = 'voc-graph/gas/Editor.html';
var GRAPH_PATH = 'voc-graph/out/latest.json';
var MAPPING_PATH = 'voc-graph/mapping.json';

function doGet() {
  var html = ghRaw_(EDITOR_HTML_PATH);
  return HtmlService.createHtmlOutput(html)
    .setTitle('誰在處理這個痛點')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function loadEditorData() {
  var g = JSON.parse(ghRaw_(GRAPH_PATH));
  var m = ghFile_(MAPPING_PATH);
  return {
    as_of: g.as_of_date,
    pains: g.nodes.pains.map(function (p) {
      return { code: p.code, title: p.title, latest: p.stt.latest, delta_pct: p.stt.delta_pct, voc_score: p.voc_score };
    }),
    cards: g.nodes.cards.map(function (c) {
      return { key: c.key, summary: c.summary, stage: c.stage, project_status: c.project_status, domain: c.domain };
    }),
    left_cards: g.nodes.left_cards || [],
    mapping: (m.doc && m.doc.pain_to_cards) || {},
    version: m.sha
  };
}

function saveMapping(mapJson, baseSha) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(20000)) return { ok: false, message: '另一個分頁正在儲存，請稍等幾秒再試' };
  try {
    var incoming = JSON.parse(mapJson);
    var clean = {};
    Object.keys(incoming).sort().forEach(function (code) {
      if (!/^[SU][0-9]\.[0-9]$/.test(code)) throw new Error('不認得的痛點代碼：' + code);
      var keys = (incoming[code] || []).filter(function (k, i, a) { return a.indexOf(k) === i; }).sort();
      keys.forEach(function (k) { if (!/^APPIDEAS-\d+$/.test(k)) throw new Error('卡號格式不對：' + k); });
      if (keys.length) clean[code] = keys;
    });

    var cur = ghFile_(MAPPING_PATH);
    if (baseSha && cur.sha !== baseSha) {
      return { ok: false, message: '對應表在別的地方被改過了。請重新整理頁面，再改一次（這次的修改沒有存）。' };
    }
    var doc = cur.doc || {};
    doc.pain_to_cards = clean;
    doc._owner = 'Cross 在「誰在處理這個痛點」網頁編輯（Apps Script）';
    try { doc._editor_url = ScriptApp.getService().getUrl(); } catch (e) { /* 未部署成網頁時沒有網址 */ }

    var n = Object.keys(clean).length;
    var newSha = ghPutFile_(MAPPING_PATH, JSON.stringify(doc, null, 1) + '\n', cur.sha,
      'mapping: ' + n + ' 個痛點已指定負責的卡（網頁編輯）');
    return { ok: true, version: newSha };
  } catch (e) {
    return { ok: false, message: String(e && e.message || e) };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════ GitHub（讀原始檔 / 讀含 sha 的檔 / 寫檔） ═══════════════

function ghUrl_(path) {
  return 'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/contents/' + path;
}

function ghFetch_(url, opt, label) {
  opt.muteHttpExceptions = true;
  opt.headers = opt.headers || {};
  opt.headers.Authorization = 'Bearer ' + GITHUB_TOKEN;
  return withRetry_(function () {
    var r = UrlFetchApp.fetch(url, opt);
    var code = r.getResponseCode();
    if (code === 429 || code >= 500) { var e = new Error('GitHub ' + code); e.transient = true; throw e; }
    if (code >= 300 && code !== 409 && code !== 422) {
      throw new Error(label + ' 失敗（GitHub ' + code + '）' + permissionHint_(code));
    }
    return r;
  }, label);
}

// 原始內容（最大 100MB），用於 HTML 與對照圖
function ghRaw_(path) {
  return ghFetch_(ghUrl_(path) + '?ref=' + GITHUB_BRANCH,
    { method: 'get', headers: { Accept: 'application/vnd.github.raw+json' } }, '讀取 ' + path).getContentText('UTF-8');
}

// 含版本號（sha）的小檔，用於 mapping.json
function ghFile_(path) {
  var r = ghFetch_(ghUrl_(path) + '?ref=' + GITHUB_BRANCH,
    { method: 'get', headers: { Accept: 'application/vnd.github+json' } }, '讀取 ' + path);
  var j = JSON.parse(r.getContentText());
  var text = Utilities.newBlob(Utilities.base64Decode(j.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  var doc = null;
  try { doc = JSON.parse(text); } catch (e) { /* 壞掉的檔：整份覆蓋 */ }
  return { sha: j.sha, doc: doc };
}

function ghPutFile_(path, text, sha, message) {
  var body = { message: message, content: Utilities.base64Encode(text, Utilities.Charset.UTF_8), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  var r = ghFetch_(ghUrl_(path), {
    method: 'put', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Accept: 'application/vnd.github+json' }
  }, '儲存 ' + path);
  if (r.getResponseCode() === 409 || r.getResponseCode() === 422) {
    throw new Error('對應表在別的地方被改過了。請重新整理頁面，再改一次。');
  }
  return JSON.parse(r.getContentText()).content.sha;
}
