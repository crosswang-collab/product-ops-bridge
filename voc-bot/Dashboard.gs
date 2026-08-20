/**
 * VoC Console —— VoC Daily Bot 的閱讀介面（Apps Script 網頁應用程式）
 *
 * 為什麼有這支檔案：bot 每天把結果寫進 5 個 Google Sheet 分頁，資料是對的，
 * 但「一堆日文欄位攤在試算表裡」沒有閱讀動線。這支檔案不產生任何新資料，
 * 只是把既有分頁重新組織成一個 90 秒就能讀完的介面。
 *
 * 部署見 voc-bot/RUNBOOK-console.md（5 步）。
 *
 * === 這支檔案只讀不寫 ===
 * 讀：VIP Feedback Sharing Sheet 的 VoC_Raw_Log / VoC_New_Candidates
 *     Japan VoC roadmap workbook（透過 Code.gs 的 loadRoadmap_，本來就是唯讀）
 * 寫：只有 testDashboard() 會往 VoC_Bot_Log 寫一列驗證紀錄。其餘完全不動任何儲存格。
 *
 * === 相依 Code.gs（同一個 Apps Script 專案，必須兩支都在）===
 * 常數：TARGET_SHEET_ID / TAB_RAW / TAB_NEW / TAB_LOG / RAW_HEADERS / RECENT_DAYS
 *       V_MATCH / V_MATCH_REVIEW / V_RULE / V_NEW / V_PENDING / V_NOISE / ANTHROPIC_API_KEY
 * 函式：openTarget_() / loadRoadmap_() / loadCandidates_() / collapse_() / toYmd_()
 *       nowStr_() / logRow_()
 *
 * === 計數的唯一真相是 VoC_Raw_Log ===
 * 介面上每一個數字都是前端從 raw 逐列算出來的，不是讀 VoC_Pain_Points 的彙總欄。
 * 這樣做的代價是要把 raw 整份送到瀏覽器；換來的是「任何一個數字都點得下去、
 * 一定看得到構成它的那幾列原始聲音」，也不會出現彙總欄與 raw 對不起來的情況。
 */

// ===========================================================================
// CONFIG
// ===========================================================================

var DASH_TITLE = 'VoC Console';

/** 每次 apiRaw() 回傳幾列。壓在千位數是因為 google.script.run 的回傳要序列化，
 *  一次塞太多列在網路慢的時候會整包逾時重來。分頁失敗只損失一頁，會自動重試。 */
var DASH_PAGE = 1200;

/** 單次載入的硬上限。超過會在介面上誠實標示「只載入最新 N 列」，不會靜默截斷。 */
var DASH_RAW_HARD_MAX = 30000;

/** 傳到前端的文字截斷長度。完整原文由 apiDetail() 按需求單筆取回。 */
var DASH_BODY_MAX = 420;
var DASH_WHY_MAX = 240;

// ===========================================================================
// 網頁進入點
// ===========================================================================

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle(DASH_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ===========================================================================
// API 1：骨架 —— roadmap 痛點清單 + 新痛點候選清單 + 環境狀態
// ===========================================================================

/**
 * 前端開場第一支。刻意做成「就算 roadmap 讀不到也要回得來」：
 * roadmap 掛掉時 problems 會帶訊息，介面照常顯示 raw，只是「是否已在 roadmap」標成未知。
 */
function apiCore() {
  var out = {
    ok: true,
    generatedAt: nowStr_(),
    recentDays: RECENT_DAYS,
    degraded: !ANTHROPIC_API_KEY,
    roadmapTab: '',
    roadmap: [],
    candidates: [],
    rawCount: 0,
    pageSize: DASH_PAGE,
    hardMax: DASH_RAW_HARD_MAX,
    /* generatedAt 是「你打開網頁的時間」，不是「資料的時間」。
       資料的時間在 lastRun.at —— bot 最後一次成功寫入的時刻。兩者可能差好幾週，
       所以介面上這兩個絕對不能混講。 */
    lastRun: { at: '', result: '', ageDays: -1, aborts: 0, detail: '', known: false },
    problems: [],
    verdicts: {
      match: V_MATCH, review: V_MATCH_REVIEW, rule: V_RULE,
      cand: V_NEW, pending: V_PENDING, noise: V_NOISE
    }
  };

  var ss;
  try {
    ss = openTarget_();
  } catch (e) {
    out.ok = false;
    out.problems.push('開不了資料試算表（' + TARGET_SHEET_ID + '）：' + e.message +
                      '　→ 確認你的 Google 帳號對這份表至少有檢視權。');
    return out;
  }

  try {
    var rm = loadRoadmap_();
    out.roadmapTab = rm.tabName;
    for (var i = 0; i < rm.items.length; i++) {
      var it = rm.items[i];
      out.roadmap.push({
        code: it.code,
        title: it.title,
        area: it.area,
        priority: it.priority,
        rank: it.rank || '',
        status: it.status,
        resolved: !!it.resolved,
        requests: it.requests,
        note: it.note,
        sourceType: it.sourceType,
        submitDate: it.submitDate || '',
        codeAuto: !!it.codeAuto,
        row: it.rowNum
      });
    }
  } catch (e) {
    out.problems.push('讀不到 VoC Roadmap：' + e.message +
                      '　→「是否已在 roadmap」這欄會全部顯示為「未知」，其他功能不受影響。');
  }

  try {
    var box = loadCandidates_(ss);
    for (var c = 0; c < box.list.length; c++) {
      var b = box.list[c];
      out.candidates.push({
        code: b.id, title: b.titleJp, titleEn: b.titleEn,
        area: b.area, priority: b.priority
      });
    }
  } catch (e) {
    out.problems.push('讀不到 ' + TAB_NEW + '：' + e.message +
                      '　→ 新痛點候選的標題會缺，件數仍會照算。');
  }

  try {
    out.lastRun = dashLastRun_(ss);
    if (!out.lastRun.known) {
      out.problems.push('讀不到 ' + TAB_LOG + ' 的執行紀錄　→ 畫面無法判斷 bot 上次成功是什麼時候，' +
                        '「資料截至」會顯示為未知。');
    }
  } catch (e) {
    out.problems.push('讀不到 ' + TAB_LOG + '：' + e.message + '　→ 無法判斷 bot 的健康狀態。');
  }

  try {
    var sh = ss.getSheetByName(TAB_RAW);
    if (!sh) {
      out.problems.push('找不到 ' + TAB_RAW + ' 分頁　→ 請先在 Apps Script 執行一次 runDailyDigest。');
    } else {
      out.rawCount = Math.max(0, sh.getLastRow() - 1);
      if (out.rawCount === 0) {
        out.problems.push(TAB_RAW + ' 目前是空的　→ 請先在 Apps Script 執行一次 runDailyDigest。');
      }
    }
  } catch (e) {
    out.problems.push('讀不到 ' + TAB_RAW + '：' + e.message);
  }

  return out;
}

// ===========================================================================
// API 2：原始聲音（分頁）—— 介面上所有數字的來源
// ===========================================================================

/**
 * 回傳 VoC_Raw_Log 的第 offset 列起算 DASH_PAGE 列。
 * 刻意回「陣列的陣列」而不是物件陣列：同樣的資料，JSON 體積少四成左右，
 * 在 3000 列以上差別很有感。欄位對照見下面 DASH_WIRE 註解。
 *
 * DASH_WIRE（前端 R.* 常數與這裡一一對應，改這裡就要改 Dashboard.html）：
 *   0 id        ハッシュ（唯一鍵，drill-down 用）
 *   1 ing       取込日（bot 抓到的日子，yyyy/MM/dd）
 *   2 occ       発生日（用戶實際說話的日子，yyyy/MM/dd）
 *   3 origin    出所（Slack / 各表單名稱）
 *   4 originDet 出所詳細
 *   5 kind      種類（バグ / 要望 / 不満…＝小類別）
 *   6 theme     テーマ（＝大類別）
 *   7 summary   要約
 *   8 body      本文（截斷至 DASH_BODY_MAX）
 *   9 owner     起票者（誰說的）
 *  10 link      リンク（原始來源連結）
 *  11 verdict   判定
 *  12 code      VoCコード（S2.7 / CAND-003…）
 *  13 topic     VoC論点
 *  14 conf      信頼度
 *  15 why       判定根拠（截斷至 DASH_WHY_MAX）
 *  16 split     分割（1/3 這種）
 */
function apiRaw(offset) {
  var start = Math.max(0, Math.floor(Number(offset) || 0));
  var res = { ok: true, offset: start, rows: [], total: 0, done: true, capped: false };

  var sh;
  try {
    sh = openTarget_().getSheetByName(TAB_RAW);
  } catch (e) {
    res.ok = false;
    res.error = '開不了資料試算表：' + e.message;
    return res;
  }
  if (!sh) {
    res.ok = false;
    res.error = '找不到 ' + TAB_RAW + ' 分頁。請先執行 runDailyDigest。';
    return res;
  }

  var total = Math.max(0, sh.getLastRow() - 1);
  res.total = total;
  if (total > DASH_RAW_HARD_MAX) {
    res.total = DASH_RAW_HARD_MAX;
    res.capped = true;
  }
  if (res.total === 0 || start >= res.total) return res;

  var n = Math.min(DASH_PAGE, res.total - start);
  // capped 時只讀最新的 DASH_RAW_HARD_MAX 列（舊的先不載），才不會愈跑愈慢
  var skip = res.capped ? (total - DASH_RAW_HARD_MAX) : 0;
  var vals;
  try {
    vals = sh.getRange(2 + skip + start, 1, n, RAW_HEADERS.length).getValues();
  } catch (e) {
    res.ok = false;
    res.error = '讀取第 ' + start + ' 列起的資料失敗：' + e.message;
    return res;
  }

  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    res.rows.push([
      String(r[0] || ''),
      toYmd_(r[2]),
      toYmd_(r[3]),
      collapse_(r[4]),
      collapse_(r[5]),
      collapse_(r[6]),
      collapse_(r[7]),
      collapse_(r[8]),
      dashTrunc_(r[9], DASH_BODY_MAX),
      collapse_(r[10]),
      String(r[12] || ''),
      collapse_(r[13]),
      collapse_(r[14]),
      collapse_(r[15]),
      (r[16] === '' || r[16] === null || r[16] === undefined) ? '' : String(r[16]),
      dashTrunc_(r[17], DASH_WHY_MAX),
      collapse_(r[18])
    ]);
  }

  res.done = (start + n) >= res.total;
  return res;
}

// ===========================================================================
// API 3：單筆完整原文（drill-down 到底層時才呼叫）
// ===========================================================================

/** 用 TextFinder 直接定位那一列，不整份掃。找不到就誠實回 ok:false。 */
function apiDetail(id) {
  var key = String(id || '').trim();
  var res = { ok: false, id: key, body: '', origin: '', link: '', why: '' };
  if (!key) { res.error = '沒有指定要查哪一筆'; return res; }

  var sh;
  try {
    sh = openTarget_().getSheetByName(TAB_RAW);
  } catch (e) {
    res.error = '開不了資料試算表：' + e.message;
    return res;
  }
  if (!sh) { res.error = '找不到 ' + TAB_RAW + ' 分頁'; return res; }

  var cell;
  try {
    cell = sh.createTextFinder(key).matchEntireCell(true).findNext();
  } catch (e) {
    res.error = '搜尋失敗：' + e.message;
    return res;
  }
  if (!cell || cell.getColumn() !== 1) {
    res.error = '這筆已經不在 ' + TAB_RAW + ' 裡（可能被 resetRawLogAndRebuild 清掉了）';
    return res;
  }

  var row = sh.getRange(cell.getRow(), 1, 1, RAW_HEADERS.length).getValues()[0];
  res.ok = true;
  res.body = String(row[9] || '');
  res.original = String(row[19] || '');   // 原文＝切分前的整則訊息
  res.origin = collapse_(row[4]) + (collapse_(row[5]) ? '／' + collapse_(row[5]) : '');
  res.owner = collapse_(row[10]);
  res.link = String(row[12] || '');
  res.why = String(row[17] || '');
  res.split = collapse_(row[18]);
  res.sheetRow = cell.getRow();
  return res;
}

// ===========================================================================
// 驗證函式 —— 部署前手動跑這支，結果寫進 VoC_Bot_Log
// ===========================================================================

/**
 * 不需要開網頁就能確認介面拿得到資料。每一行都要是 OK 才去部署。
 * 這支是唯一會寫入的函式（只寫 VoC_Bot_Log）。
 */
function testDashboard() {
  var ss = null;
  try { ss = openTarget_(); } catch (e) { /* 下面 logRow_ 會被跳過，改丟例外 */ }

  var core = apiCore();
  if (ss) {
    logRow_(ss, 'CONSOLE', core.ok ? 'OK' : 'FAIL',
      'apiCore：roadmap ' + core.roadmap.length + ' 件／候選 ' + core.candidates.length +
      ' 件／raw ' + core.rawCount + ' 列' +
      (core.roadmapTab ? '／roadmap 分頁「' + core.roadmapTab + '」' : ''));
    for (var p = 0; p < core.problems.length; p++) {
      logRow_(ss, 'CONSOLE', 'WARN', core.problems[p]);
    }
    if (core.lastRun.result === 'NEVER') {
      logRow_(ss, 'CONSOLE', 'WARN',
        '在 ' + TAB_LOG + ' 最後 400 列裡找不到任何成功的 RUN 紀錄 → 介面會顯示「bot 尚未成功執行過」。');
    } else if (core.lastRun.known) {
      logRow_(ss, 'CONSOLE', core.lastRun.aborts >= 3 ? 'FAIL' : (core.lastRun.ageDays > 1 ? 'WARN' : 'OK'),
        'bot 最後成功執行：' + core.lastRun.at + '（' + core.lastRun.ageDays + ' 天前）／' +
        '之後連續 ABORT ' + core.lastRun.aborts + ' 次' +
        (core.lastRun.aborts >= 3 ? '　→ 已連續失敗 3 次以上，先去修資料源再看數字。' : ''));
    }
    if (core.degraded) {
      logRow_(ss, 'CONSOLE', 'WARN',
        'ANTHROPIC_API_KEY 未設定 → 判定是規則式的，介面會把這些列標成「規則式(精度低)」。');
    }
  }
  if (!core.ok) throw new Error('apiCore 失敗，詳見 ' + TAB_LOG + '：' + core.problems.join(' / '));

  var first = apiRaw(0);
  if (!first.ok) {
    if (ss) logRow_(ss, 'CONSOLE', 'FAIL', 'apiRaw：' + first.error);
    throw new Error('apiRaw 失敗：' + first.error);
  }
  if (ss) {
    logRow_(ss, 'CONSOLE', 'OK',
      'apiRaw：第一頁 ' + first.rows.length + ' 列／總計 ' + first.total + ' 列／需要 ' +
      Math.max(1, Math.ceil(first.total / DASH_PAGE)) + ' 次載入' +
      (first.capped ? '（已達 ' + DASH_RAW_HARD_MAX + ' 列上限，只載最新的部分）' : ''));
  }

  // 抽第一列做一次 drill-down，確認 apiDetail 真的找得到
  if (first.rows.length > 0 && ss) {
    var d = apiDetail(first.rows[0][0]);
    logRow_(ss, 'CONSOLE', d.ok ? 'OK' : 'FAIL',
      'apiDetail：' + (d.ok ? '第 ' + d.sheetRow + ' 列取回成功' : d.error));
  }

  // 判定值分布 —— 讓你在部署前就知道有多少列還沒判定
  if (first.rows.length > 0 && ss) {
    var dist = {};
    for (var i = 0; i < first.rows.length; i++) {
      var v = first.rows[i][11] || '(空白)';
      dist[v] = (dist[v] || 0) + 1;
    }
    var parts = [];
    for (var k in dist) parts.push(k + ' ' + dist[k]);
    logRow_(ss, 'CONSOLE', 'OK', '第一頁判定分布：' + parts.join('／'));
  }

  SpreadsheetApp.flush();
  return '完成。打開 ' + TAB_LOG + ' 看結果，每一列都是 OK 才去部署。';
}

// ===========================================================================
// 小工具（一律 dash 前綴，避免跟 Code.gs 撞名）
// ===========================================================================

/**
 * 從 VoC_Bot_Log 倒著找 bot 的執行紀錄，回答兩個問題：
 *   1. 最後一次「成功寫入」是什麼時候（DONE / DONE_WITH_WARNINGS）
 *   2. 從那次之後，連續有幾次 ABORT（＝資料源掛掉、本次沒寫入）
 *
 * 為什麼需要這支：bot 是每天 08:10 自己醒來的無人化排程，掛掉的時候沒有人會被通知，
 * 它只會安靜地往 VoC_Bot_Log 寫一列 ABORT。如果介面不把這件事講出來，
 * 畫面上會顯示一組「看起來很正常但其實是三週前」的數字。
 *
 * 只讀最後 400 列（一天約 10～30 列，夠涵蓋兩週以上）。
 */
function dashLastRun_(ss) {
  var res = { at: '', result: '', ageDays: -1, aborts: 0, detail: '', known: false };

  var sh = ss.getSheetByName(TAB_LOG);
  if (!sh) return res;
  var last = sh.getLastRow();
  if (last < 2) return res;

  var n = Math.min(last - 1, 400);
  var vals = sh.getRange(last - n + 1, 1, n, LOG_HEADERS.length).getValues();

  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][1]) !== 'RUN') continue;
    var result = String(vals[i][2] || '');
    if (result === 'START') continue;                 // START 不代表結果
    if (result === 'ABORT') { res.aborts++; continue; }  // 還沒遇到成功，繼續往上找
    // 遇到 DONE / DONE_WITH_WARNINGS ＝ 最後一次成功
    res.known = true;
    res.result = result;
    res.detail = String(vals[i][3] || '').substring(0, 300);
    var raw = vals[i][0];
    var d = (raw instanceof Date) ? raw : new Date(String(raw).replace(/-/g, '/'));
    if (!isNaN(d.getTime())) {
      res.at = Utilities.formatDate(d, TZ, 'yyyy/MM/dd HH:mm');
      res.ageDays = Math.floor((new Date().getTime() - d.getTime()) / 86400000);
    } else {
      res.at = String(raw);
    }
    return res;
  }

  // 掃完 400 列都沒有成功紀錄：可能從沒跑成功過，也可能成功紀錄已經被擠出視窗
  res.known = true;
  res.result = 'NEVER';
  return res;
}

function dashTrunc_(v, max) {
  var s = collapse_(v);
  return s.length > max ? s.substring(0, max - 1) + '…' : s;
}
