// 旧入金DB（売上DBの「入金DB」6列）と、DB_入金備考を、そのまま読んで返す【読み取り専用】の専用処理。
// 銀行入金の正本化（Supabase一本化）の段階3（旧シートの移行）で使う。社長指示（2026-11-28）: 旧シートの取得は専用の読み取り処理を追加する（案B）。
//
// 守ること:
//   ・既存の処理は変更しない（この関数を呼ぶ道を 1 行足すだけ）。
//   ・シートへ書き込まない・行を並べ替えない・書式を変えない・シートを新しく作らない（getSheetByName だけ。depNoteSheet_ は作成してしまうので使わない）。
//   ・社長・本部のログインだけ（取引の摘要・登録日時を含むため）。
//   ・返す値は、6 列をそのまま（日付・登録日時は文字列に直す）。行番号（シート上の行）も付ける。
//   ・転送の取りこぼしを見つけるため、行ごとの文字列から計算した指紋（fingerprint）を一緒に返す（受け取り側が同じ計算をして一致を確かめる）。
//
// 使い方（ログイン後）: action=legacyDepositExport  [source=salesdb|dashboard]  [offset=0] [limit=0（0＝全部）]
//   応答: { ok, source, sheet_rows, rows:[{row_no,store,date,amount,desc,token,registered_at}], notes:[{date,store,note,updated_by,updated_at}], fingerprint, notes_fingerprint, exported_at }
function legacyDepositExport(p, session) {
  if (!isAdmin(session)) return { ok: false, error: '旧入金DBの取り出しは社長・本部のみです' };
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var which = String(p && p.source || 'salesdb');
  var sh = null, label = '';
  try {
    if (which === 'dashboard') { sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('入金DB'); label = 'dashboard'; }
    else { sh = SpreadsheetApp.openById(SALES_DB_ID).getSheetByName('入金DB'); label = 'salesdb'; }
  } catch (e) { return { ok: false, error: '入金DBを開けません: ' + String(e && e.message || e) }; }
  if (!sh) return { ok: false, error: '入金DBシートが見つかりません（' + which + '）' };
  var head = depositHeaderRow_(sh);
  if (head < 0) return { ok: false, error: '入金DBのヘッダー行が見つかりません' };
  var last = sh.getLastRow();
  var offset = Math.max(0, Number(p && p.offset) || 0), limit = Math.max(0, Number(p && p.limit) || 0);
  var rows = [], lines = [];
  var total = Math.max(0, last - head);
  if (total > 0) {
    var from = head + 1 + offset, n = (limit > 0 ? Math.min(limit, total - offset) : total - offset);
    if (n > 0) {
      var v = sh.getRange(from, 1, n, 6).getValues();
      for (var i = 0; i < v.length; i++) {
        var r = v[i];
        if (String(r[0]).trim() === '') continue;   // 空行は返さない（行番号は飛ぶ＝シート上の位置が分かる）
        var o = {
          row_no: from + i,
          store: String(r[0]).trim(),
          date: ymdCell_(r[1], tz),
          amount: Number(String(r[2]).replace(/[,¥\s]/g, '')) || 0,
          desc: String(r[3] == null ? '' : r[3]),
          token: tokenCell_(r[4], tz),
          registered_at: tsCell_(r[5], tz)
        };
        rows.push(o);
        lines.push([o.row_no, o.store, o.date, o.amount, o.desc, o.token, o.registered_at].join('|'));
      }
    }
  }
  // 備考（ダッシュボード側のスプレッドシート。シートが無ければ空。作らない）
  var notes = [], nlines = [];
  var nsh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_入金備考');
  if (nsh && nsh.getLastRow() >= 2 && (!p || !Number(p.offset))) {
    var nv = nsh.getRange(2, 1, nsh.getLastRow() - 1, 5).getValues();
    for (var k = 0; k < nv.length; k++) {
      var x = nv[k];
      if (!x[0] || String(x[1]).trim() === '') continue;
      var no = { date: ymdCell_(x[0], tz), store: String(x[1]).trim(), note: String(x[2] == null ? '' : x[2]), updated_by: String(x[3] == null ? '' : x[3]), updated_at: tsCell_(x[4], tz) };
      notes.push(no);
      nlines.push([no.date, no.store, no.note, no.updated_by, no.updated_at].join('|'));
    }
  }
  return {
    ok: true, source: label, sheet_rows: total, offset: offset, count: rows.length,
    rows: rows, notes: notes,
    fingerprint: legacyDigest_(lines), notes_fingerprint: legacyDigest_(nlines),
    exported_at: new Date().toISOString()
  };
}
function ymdCell_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var m = String(v == null ? '' : v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : String(v == null ? '' : v);
}
function tokenCell_(v, tz) {   // 取引時刻（E列は文字列固定のはずだが、時刻型に化けた行も、そのままの見た目で返す）
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'HH:mm:ss');
  return String(v == null ? '' : v).trim();
}
function tsCell_(v, tz) {      // 登録日時（Date → 秒までの日時＋時差。空は空）
  if (v instanceof Date) return Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
  return String(v == null ? '' : v).trim();
}
function legacyDigest_(lines) {   // 行ごとの文字列を改行でつないだものの SHA-256（16進）
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, lines.join('\n'), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var h = (b < 0 ? b + 256 : b).toString(16); return h.length === 1 ? '0' + h : h; }).join('');
}
