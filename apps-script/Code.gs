/**
 * JP Needs Roadmap — Google Sheet 橋接 (讀取 + 拖拉排序寫回)
 *
 * 用途：讓 GitHub Pages 上的 roadmap.html 能「讀」你的 Google Sheet，
 *       並在你於網頁拖拉排序後把新順序「寫回」Sheet 的 sort 欄。
 * 新增需求／改 RACI／狀態／日期，一律直接在 Sheet 編輯（此腳本不處理）。
 *
 * 部署：Google Sheet → 擴充功能 → Apps Script → 貼上本檔 → 儲存
 *   → 部署 → 新增部署作業 → 類型「網頁應用程式」
 *   → 執行身分：我(你自己)；具有存取權：任何人
 *   → 部署 → 授權 → 複製 /exec 網址 → 貼進 roadmap.html 的 SHEET_API。
 */

var SHEET_NAME = 'Roadmap'; // ← 你的資料分頁名稱（請把分頁改名為 Roadmap，或改這裡）

function doGet(e) {
  var cb = e && e.parameter && e.parameter.callback;
  var json = JSON.stringify({ rows: readRows_() });
  if (cb) {
    // JSONP：給瀏覽器跨網域讀取用
    return ContentService.createTextOutput(cb + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'reorder') {
      writeOrder_(body.order || []);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

function readRows_() {
  var sh = sheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(function (c) { return c === ''; })) continue; // 跳過空列
    var o = { _row: r + 1 };
    head.forEach(function (h, i) { if (h) o[h] = row[i] === '' ? '' : row[i]; });
    out.push(o);
  }
  return out;
}

function writeOrder_(order) {
  var sh = sheet_();
  var values = sh.getDataRange().getValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  var sortCol = head.indexOf('sort');
  if (sortCol === -1) sortCol = 0; // 找不到 sort 欄就退回第一欄
  order.forEach(function (o) {
    var r = parseInt(o.row, 10);
    if (r && r >= 2 && r <= values.length) {
      sh.getRange(r, sortCol + 1).setValue(o.sort);
    }
  });
}
