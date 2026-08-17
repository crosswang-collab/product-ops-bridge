#!/usr/bin/env python3
"""Render the trilingual APPIDEAS roadmap status page from data.json.

Usage:  python3 roadmap/build.py
Output: roadmap/index.html  (self-contained, no external requests)

Weekly refresh flow:
  1. Re-query Jira for the tickets listed in data.json
  2. Update data.json (dates / statuses / new tickets)
  3. Run this script
  4. Commit + push -> Vercel auto-deploys /roadmap
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data.json"
OUT = ROOT / "index.html"

UI = {
    "zh": {
        "html_lang": "zh-Hant",
        "title": "17LIVE 產品開發狀況",
        "subtitle": "APPIDEAS 專案 · 以 Jira 實際狀態為準",
        "stat_total": "需求總數",
        "stat_ticketed": "已開票",
        "stat_dated": "已排定上線日",
        "stat_untracked": "尚未開票",
        "search": "搜尋項目或票號…",
        "th_key": "票號",
        "th_item": "項目",
        "th_date": "上線日",
        "th_status": "狀態",
        "th_owner": "負責人",
        "th_rank": "JP 排序",
        "th_pri": "優先度",
        "untracked_title": "尚未開票的需求",
        "untracked_desc": "以下需求已在 JP Needs 清單中，但尚未建立 Jira 票，因此不在上方的開發時程內。",
        "notes_title": "資料附註",
        "no_result": "找不到符合的項目。",
        "footer_src": "資料來源：Jira APPIDEAS（唯一真實來源）。試算表與 Jira 不一致時，一律以 Jira 為準。",
        "footer_gen": "資料更新於",
        "footer_auto": "每週一自動更新",
        "internal": "內部資料 · 請勿外流",
    },
    "en": {
        "html_lang": "en",
        "title": "17LIVE Product Development Status",
        "subtitle": "APPIDEAS · Jira is the source of truth",
        "stat_total": "Total requests",
        "stat_ticketed": "Ticketed",
        "stat_dated": "With release date",
        "stat_untracked": "Not yet ticketed",
        "search": "Search item or ticket…",
        "th_key": "Ticket",
        "th_item": "Item",
        "th_date": "Release date",
        "th_status": "Status",
        "th_owner": "Owner",
        "th_rank": "JP rank",
        "th_pri": "Priority",
        "untracked_title": "Requests Not Yet Ticketed",
        "untracked_desc": "These requests are on the JP Needs list but have no Jira ticket yet, so they do not appear in the schedule above.",
        "notes_title": "Data Notes",
        "no_result": "No matching items.",
        "footer_src": "Source: Jira APPIDEAS (single source of truth). Where the spreadsheet and Jira disagree, Jira wins.",
        "footer_gen": "Data updated",
        "footer_auto": "Refreshed automatically every Monday",
        "internal": "Internal — do not distribute",
    },
    "ja": {
        "html_lang": "ja",
        "title": "17LIVE プロダクト開発状況",
        "subtitle": "APPIDEAS · Jira の実データを正とする",
        "stat_total": "要望総数",
        "stat_ticketed": "起票済み",
        "stat_dated": "リリース日確定",
        "stat_untracked": "未起票",
        "search": "項目・チケット番号で検索…",
        "th_key": "チケット",
        "th_item": "項目",
        "th_date": "リリース日",
        "th_status": "ステータス",
        "th_owner": "担当",
        "th_rank": "JP順位",
        "th_pri": "優先度",
        "untracked_title": "未起票の要望",
        "untracked_desc": "以下は JP Needs リストに含まれていますが、Jira チケットが未作成のため、上記のスケジュールには含まれていません。",
        "notes_title": "補足事項",
        "no_result": "該当する項目がありません。",
        "footer_src": "出典：Jira APPIDEAS（唯一の正）。スプレッドシートと相違がある場合は Jira を正とします。",
        "footer_gen": "データ更新日",
        "footer_auto": "毎週月曜に自動更新",
        "internal": "社内資料 · 転載禁止",
    },
}

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>17LIVE Product Development Status</title>
<style>
:root{
  --bg:#0b0e14; --s1:#141a24; --s2:#10151f; --bd:#232c3a; --bd2:#2e3949;
  --tx:#e6ebf4; --mut:#8b96a8; --dim:#5a6577; --acc:#5fd3e6;
  --ok:#4ade80; --warn:#fbbf24; --hot:#f87171; --idle:#64748b;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0;min-height:100vh;background:var(--bg);color:var(--tx);
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN","Noto Sans TC","Noto Sans JP",sans-serif;
  font-size:15px;line-height:1.6;
}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 72px}

/* header */
header{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;justify-content:space-between;margin-bottom:8px}
h1{margin:0;font-size:25px;letter-spacing:.01em;font-weight:700}
.sub{color:var(--mut);font-size:13px;margin:4px 0 0}
.badge{display:inline-block;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--warn);
  border:1px solid rgba(251,191,36,.35);background:rgba(251,191,36,.08);border-radius:5px;padding:2px 7px;margin-left:10px;vertical-align:3px}
.langs{display:flex;gap:0;border:1px solid var(--bd2);border-radius:9px;overflow:hidden;flex:0 0 auto}
.langs button{
  appearance:none;border:0;background:var(--s2);color:var(--mut);font:inherit;font-size:13px;font-weight:600;
  padding:8px 15px;cursor:pointer;transition:background .12s,color .12s;white-space:nowrap
}
.langs button+button{border-left:1px solid var(--bd2)}
.langs button:hover{background:#18202c;color:var(--tx)}
.langs button[aria-pressed="true"]{background:var(--acc);color:#06232a}

/* stats */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 26px}
.stat{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:14px 16px}
.stat .n{font-size:27px;font-weight:750;line-height:1.15;font-variant-numeric:tabular-nums}
.stat .l{font-size:11.5px;color:var(--mut);margin-top:3px}
.stat.alert .n{color:var(--hot)}
.stat.good .n{color:var(--ok)}

/* search */
.search{width:100%;background:var(--s2);border:1px solid var(--bd2);border-radius:10px;color:var(--tx);
  font:inherit;font-size:14px;padding:11px 14px;margin-bottom:26px}
.search::placeholder{color:var(--dim)}
.search:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px rgba(95,211,230,.12)}

/* groups */
section{margin-bottom:30px}
h2{font-size:15.5px;margin:0 0 11px;display:flex;align-items:center;gap:9px;font-weight:700}
h2 .ic{font-size:15px}
h2 .ct{font-size:11.5px;color:var(--dim);font-weight:600;background:var(--s2);border:1px solid var(--bd);
  border-radius:20px;padding:1px 9px;font-variant-numeric:tabular-nums}
.tbl{width:100%;border-collapse:separate;border-spacing:0;background:var(--s1);
  border:1px solid var(--bd);border-radius:12px;overflow:hidden}
.tbl th{
  text-align:left;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--dim);
  font-weight:700;padding:9px 14px;background:var(--s2);border-bottom:1px solid var(--bd);white-space:nowrap
}
.tbl td{padding:11px 14px;border-bottom:1px solid rgba(35,44,58,.6);vertical-align:top;font-size:14px}
.tbl tr:last-child td{border-bottom:0}
.tbl tbody tr:hover{background:rgba(95,211,230,.04)}
.tbl a.k{color:var(--acc);text-decoration:none;font-weight:650;font-size:13px;white-space:nowrap;
  font-variant-numeric:tabular-nums}
.tbl a.k:hover{text-decoration:underline}
td.item{font-weight:550;min-width:210px}
td.date{white-space:normal;color:var(--tx);font-size:13.5px;min-width:130px}
tr.hl td.date{color:var(--ok);font-weight:700}
td.own{color:var(--mut);font-size:13px;white-space:nowrap}
.pill{display:inline-block;font-size:11.5px;font-weight:650;border-radius:20px;padding:2px 10px;white-space:nowrap;
  border:1px solid transparent}
.pill.dev{color:var(--acc);background:rgba(95,211,230,.1);border-color:rgba(95,211,230,.3)}
.pill.done{color:var(--ok);background:rgba(74,222,128,.1);border-color:rgba(74,222,128,.3)}
.pill.design{color:var(--warn);background:rgba(251,191,36,.1);border-color:rgba(251,191,36,.3)}
.pill.park{color:var(--idle);background:rgba(100,116,139,.12);border-color:rgba(100,116,139,.32)}
.pri{display:inline-block;font-size:11px;font-weight:750;border-radius:5px;padding:1px 7px;font-variant-numeric:tabular-nums}
.pri.P0{color:#fecaca;background:rgba(248,113,113,.18);border:1px solid rgba(248,113,113,.4)}
.pri.P1{color:#fde68a;background:rgba(251,191,36,.14);border:1px solid rgba(251,191,36,.32)}
.pri.P2{color:#bfdbfe;background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.28)}
.pri.P3{color:#cbd5e1;background:rgba(148,163,184,.12);border:1px solid rgba(148,163,184,.26)}
td.rank{color:var(--dim);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}

/* untracked */
.note-band{background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.22);border-radius:10px;
  padding:11px 14px;font-size:13px;color:#fca5a5;margin-bottom:12px}

/* notes */
.notes{background:var(--s1);border:1px solid var(--bd);border-radius:12px;padding:6px 20px}
.notes li{font-size:13.5px;color:var(--mut);margin:11px 0;line-height:1.65}
.notes li b{color:var(--tx)}
.empty{color:var(--dim);font-size:13.5px;padding:18px 2px}

footer{margin-top:38px;border-top:1px solid var(--bd);padding-top:16px;color:var(--dim);font-size:11.5px;line-height:1.85}
footer .gen{color:var(--mut)}

@media (max-width:820px){
  .stats{grid-template-columns:repeat(2,1fr)}
  h1{font-size:21px}
  .tbl{display:block;overflow-x:auto;white-space:nowrap}
  td.item{white-space:normal}
}
@media print{
  body{background:#fff;color:#000}
  .langs,.search{display:none}
  .tbl,.stat,.notes{border-color:#ccc;background:#fff}
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div>
    <h1 id="t-title"></h1>
    <p class="sub"><span id="t-sub"></span><span class="badge" id="t-internal"></span></p>
  </div>
  <div class="langs" role="group">
    <button data-lang="zh" aria-pressed="true">中文</button>
    <button data-lang="en" aria-pressed="false">EN</button>
    <button data-lang="ja" aria-pressed="false">日本語</button>
  </div>
</header>

<div class="stats" id="stats"></div>

<input class="search" id="q" type="search" autocomplete="off">

<div id="groups"></div>

<section id="untracked-sec">
  <h2><span class="ic">📋</span><span id="t-untracked"></span><span class="ct" id="ct-untracked"></span></h2>
  <div class="note-band" id="t-untracked-desc"></div>
  <table class="tbl">
    <thead><tr>
      <th id="th-rank"></th><th id="th-pri"></th><th id="th-item2"></th>
    </tr></thead>
    <tbody id="untracked-body"></tbody>
  </table>
</section>

<section>
  <h2><span class="ic">⚠️</span><span id="t-notes"></span></h2>
  <div class="notes"><ul id="notes-body"></ul></div>
</section>

<footer>
  <div id="t-src"></div>
  <div class="gen"><span id="t-gen"></span>: __GENERATED__ · <span id="t-auto"></span></div>
</footer>

</div>

<script id="payload" type="application/json">__DATA__</script>
<script id="uistrings" type="application/json">__UI__</script>
<script>
(function(){
  var DATA = JSON.parse(document.getElementById('payload').textContent);
  var UI   = JSON.parse(document.getElementById('uistrings').textContent);
  var lang = localStorage.getItem('roadmap-lang') || 'zh';
  if(!UI[lang]) lang = 'zh';
  var query = '';

  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function pillClass(id){
    return id==='released' ? 'done'
         : id==='august'||id==='sept1'||id==='late' ? 'dev'
         : id==='design' ? 'design' : 'park';
  }

  function matches(item, g){
    if(!query) return true;
    var hay = [item.key||'', item.owner||'',
               (item.title&&item.title[lang])||'', (item.status&&item.status[lang])||'',
               (item.date&&item.date[lang])||'', (g&&g.label&&g.label[lang])||'',
               item.zh||'', item.en||'', item.ja||''].join(' ').toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function render(){
    var t = UI[lang];
    document.documentElement.lang = t.html_lang;
    document.title = t.title;

    ['title','sub','internal','untracked','notes','src','gen','auto'].forEach(function(k){
      var el = document.getElementById('t-'+k);
      if(el) el.textContent = t[({title:'title',sub:'subtitle',internal:'internal',
        untracked:'untracked_title',notes:'notes_title',src:'footer_src',
        gen:'footer_gen',auto:'footer_auto'})[k]];
    });
    document.getElementById('t-untracked-desc').textContent = t.untracked_desc;
    document.getElementById('q').placeholder = t.search;
    document.getElementById('th-rank').textContent = t.th_rank;
    document.getElementById('th-pri').textContent  = t.th_pri;
    document.getElementById('th-item2').textContent= t.th_item;

    // stats
    var s = DATA.stats;
    document.getElementById('stats').innerHTML =
      [['',s.total_requests,t.stat_total],
       ['',s.ticketed,t.stat_ticketed],
       ['good',s.with_release_date,t.stat_dated],
       ['alert',s.untracked,t.stat_untracked]]
      .map(function(r){ return '<div class="stat '+r[0]+'"><div class="n">'+r[1]+
        '</div><div class="l">'+esc(r[2])+'</div></div>'; }).join('');

    // groups
    var out = '', shown = 0;
    DATA.groups.forEach(function(g){
      var rows = g.items.filter(function(it){ return matches(it, g); });
      if(!rows.length) return;
      shown += rows.length;
      out += '<section><h2><span class="ic">'+g.icon+'</span><span>'+esc(g.label[lang])+
             '</span><span class="ct">'+rows.length+'</span></h2><table class="tbl"><thead><tr>'+
             '<th>'+esc(t.th_key)+'</th><th>'+esc(t.th_item)+'</th><th>'+esc(t.th_date)+
             '</th><th>'+esc(t.th_status)+'</th><th>'+esc(t.th_owner)+'</th></tr></thead><tbody>';
      rows.forEach(function(it){
        out += '<tr'+(it.highlight?' class="hl"':'')+'>'+
          '<td><a class="k" href="'+DATA.meta.jira_base+esc(it.key)+'" target="_blank" rel="noopener">'+esc(it.key)+'</a></td>'+
          '<td class="item">'+esc(it.title[lang])+'</td>'+
          '<td class="date">'+esc(it.date[lang])+'</td>'+
          '<td><span class="pill '+pillClass(g.id)+'">'+esc(it.status[lang])+'</span></td>'+
          '<td class="own">'+esc(it.owner||'—')+'</td></tr>';
      });
      out += '</tbody></table></section>';
    });
    document.getElementById('groups').innerHTML =
      out || '<div class="empty">'+esc(t.no_result)+'</div>';

    // untracked
    var ur = DATA.untracked.filter(function(it){ return matches(it, null); });
    document.getElementById('ct-untracked').textContent = ur.length;
    document.getElementById('untracked-body').innerHTML = ur.length
      ? ur.map(function(it){
          return '<tr><td class="rank">#'+it.rank+'</td>'+
                 '<td><span class="pri '+it.p+'">'+it.p+'</span></td>'+
                 '<td class="item">'+esc(it[lang])+'</td></tr>'; }).join('')
      : '<tr><td colspan="3" class="empty">'+esc(t.no_result)+'</td></tr>';
    document.getElementById('untracked-sec').style.display = ur.length ? '' : 'none';

    // notes
    document.getElementById('notes-body').innerHTML =
      DATA.notes.map(function(n){ return '<li>'+n[lang]+'</li>'; }).join('');
  }

  Array.prototype.forEach.call(document.querySelectorAll('.langs button'), function(b){
    b.addEventListener('click', function(){
      lang = b.dataset.lang;
      localStorage.setItem('roadmap-lang', lang);
      Array.prototype.forEach.call(document.querySelectorAll('.langs button'), function(x){
        x.setAttribute('aria-pressed', String(x === b));
      });
      render();
    });
  });
  document.getElementById('q').addEventListener('input', function(e){
    query = e.target.value.trim().toLowerCase(); render();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.langs button'), function(x){
    x.setAttribute('aria-pressed', String(x.dataset.lang === lang));
  });
  render();
})();
</script>
</body>
</html>
"""


def main() -> None:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    html = (
        TEMPLATE
        .replace("__DATA__", json.dumps(data, ensure_ascii=False))
        .replace("__UI__", json.dumps(UI, ensure_ascii=False))
        .replace("__GENERATED__", data["meta"]["generated_at"])
    )
    OUT.write_text(html, encoding="utf-8")
    n = sum(len(g["items"]) for g in data["groups"])
    print(f"wrote {OUT}  ({n} ticketed + {len(data['untracked'])} untracked, {len(html):,} bytes)")


if __name__ == "__main__":
    main()
