/**
 * JP Needs Roadmap — Google Sheet bridge (read + drag-reorder write).
 *
 * Deploy: open the Sheet → Extensions → Apps Script → paste this → Save
 *   → Deploy → New deployment → type "Web app"
 *   → Execute as: Me ; Who has access: Anyone → Deploy → authorize → copy the /exec URL
 *   → paste that URL into roadmap.html  (const SHEET_API = "...").
 *
 * The web page only reorders rows (drag). Everything else (add rows, RACI, status,
 * dates, Z strategic items) is edited directly in the Sheet.
 * Column A ("Seq") is a =SEQUENCE() formula — reordering moves rows B..end and leaves A intact.
 */

var SHEET_NAME = 'Roadmap';

// Map normalized header -> canonical field the web page expects.
var ALIAS = {
  seq:'sort', sort:'sort', '#':'sort',
  code:'key', key:'key',
  request_pain:'title', request:'title', pain:'title', title:'title',
  area:'area', category:'area',
  source:'source',
  priority:'priority', status:'status',
  accountable:'accountable', responsible:'responsible', consulted:'consulted', informed:'informed',
  target_ship:'target_ship', target:'target_ship',
  shipped:'shipped_on', shipped_on:'shipped_on',
  next_step:'next_step', next:'next_step',
  blocker_ask:'blocker_ask', blocker:'blocker_ask',
  jira:'jira',
  demand:'demand_n', demand_n:'demand_n',
  requests:'requests',
  original_jp:'jp_original', original:'jp_original', jp_original:'jp_original', background:'jp_original'
};

function norm_(h){ return String(h||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,''); }

function doGet(e){
  var cb = e && e.parameter && e.parameter.callback;
  var json = JSON.stringify({ rows: readRows_() });
  if (cb) return ContentService.createTextOutput(cb + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e){
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'reorder') reorderRows_(body.order || []);
    return ContentService.createTextOutput(JSON.stringify({ ok:true })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok:false, error:String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}

function sheet_(){ var ss=SpreadsheetApp.getActiveSpreadsheet(); return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0]; }

// Find the header row (first row within the first ~12 that has a "code"/"key" cell).
function headerRow_(values){
  for (var i=0; i<Math.min(values.length,12); i++){
    var row = values[i].map(norm_);
    if (row.indexOf('code')>=0 || row.indexOf('key')>=0) return i;
  }
  return 0;
}

function readRows_(){
  var sh = sheet_();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var hi = headerRow_(values);
  var head = values[hi].map(norm_);
  var out = [];
  for (var r=hi+1; r<values.length; r++){
    var row = values[r];
    if (row.every(function(c){ return c===''; })) continue;
    var o = { _row: r+1 };
    head.forEach(function(h,i){ if(!h) return; var k=ALIAS[h]||h; if(o[k]===undefined) o[k]= row[i]===''?'':row[i]; });
    out.push(o);
  }
  return out;
}

// Reorder data rows to match the given order (list of {row}). Rewrites columns B..end,
// leaving column A (the SEQUENCE formula) untouched so it re-numbers automatically.
function reorderRows_(order){
  var sh = sheet_();
  var values = sh.getDataRange().getValues();
  var hi = headerRow_(values);
  var startRow = hi + 2;                 // first data row
  var lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  var n = lastRow - startRow + 1;
  if (n <= 0 || lastCol < 2) return;
  var rng = sh.getRange(startRow, 2, n, lastCol - 1);
  var vals = rng.getValues();
  var byRow = {};
  for (var i=0; i<n; i++) byRow[startRow + i] = vals[i];
  var out = [], used = {};
  order.forEach(function(o){ var r = parseInt(o.row,10); if (byRow[r] && !used[r]){ out.push(byRow[r]); used[r]=true; } });
  for (var j=0; j<n; j++){ var rr = startRow + j; if (!used[rr]) out.push(byRow[rr]); }
  rng.setValues(out);
}
