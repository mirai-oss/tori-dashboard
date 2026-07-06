/**
 * 飲食店ダッシュボード バックエンド API (Google Apps Script)
 * =============================================================
 * このスクリプトをデータの入っているスプレッドシートに紐付けて
 * 「ウェブアプリ」としてデプロイしてください。
 *
 *  - デプロイ設定: 「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員」
 *    （URLを知っている社内の人だけが使う前提。認証はこのAPI内のID/パスワードで行う）
 *
 * 使用するシート:
 *  - アカウント       … ログインID/パスワード/権限の管理（無ければ初回に自動作成）
 *  - 接続設定         … ダッシュボードに配信するシートの登録（無ければ自動作成）
 *  - データ各シート    … 日別集計 / 媒体別 / 入金 / 口コミ / 広告 など
 *
 * 「DB_」で始まる名前のシートは接続設定に書かなくても自動で配信されます。
 * 例: 「DB_広告」というシートを作れば、ダッシュボード側でキー「広告」として
 *     リアルタイム取得できます。
 */

var TOKEN_HOURS = 12; // ログイントークンの有効時間

// ================== エントリポイント ==================

function doGet(e) {
  return handle(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  var p = {};
  try {
    if (e && e.postData && e.postData.contents) p = JSON.parse(e.postData.contents);
  } catch (err) {}
  // URLパラメータも合成（POST+クエリ両対応）
  if (e && e.parameter) for (var k in e.parameter) if (!(k in p)) p[k] = e.parameter[k];
  return handle(p);
}

function handle(p) {
  var action = p.action || 'data';
  try {
    if (action === 'ping')   return out({ ok: true, ping: 'pong', time: new Date().toISOString() });
    setupIfNeeded();
    if (action === 'login')  return out(login(p));
    if (action === 'logout') return out(logout(p));

    // ここから先はログイン必須
    var session = requireSession(p);
    if (action === 'version')  return out({ ok: true, version: dataVersion() }); // 軽量：変更検知用の署名だけ返す
    if (action === 'data')     return out(getData(p, session));
    if (action === 'accounts') return out(listAccounts(session));
    if (action === 'saveAccount')   return out(saveAccount(p, session));
    if (action === 'deleteAccount') return out(deleteAccount(p, session));
    return out({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================== 初期セットアップ ==================

function setupIfNeeded() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // アカウントシート
  var acc = ss.getSheetByName('アカウント');
  if (!acc) {
    acc = ss.insertSheet('アカウント');
    acc.getRange(1, 1, 1, 7).setValues([[
      'ログインID', 'パスワード', '表示名', '権限', '担当店舗', '有効', 'メモ'
    ]]).setFontWeight('bold').setBackground('#efe9dd');
    acc.getRange(2, 1, 4, 7).setValues([
      ['shacho',  'tori2026',  '社長',            '社長',       '全店', 'TRUE', '全店舗・全機能・アカウント発行'],
      ['honbu',   'torihq',    '本部 経営管理部',  '本部',       '全店', 'TRUE', '全店舗・全機能・アカウント発行'],
      ['yokohama','toriarea',  '横浜エリアMG',     'マネージャー', '鶏武者 新横浜, 鶏武者 川崎店, 黒霧屋 新横浜', 'TRUE', '担当店舗のみ・店舗間比較あり'],
      ['shiba',   'torishiba', '芝の鳥一代',       '店舗',       '芝の鳥一代', 'TRUE', '自店のみ']
    ]);
    acc.setColumnWidths(1, 7, 150);
  }

  // 接続設定シート（既定は実シート名に合わせてある）
  var conf = ss.getSheetByName('接続設定');
  if (!conf) conf = ss.insertSheet('接続設定');

  // 空（データ行なし）なら初期値を書き込む。既存の空タブが放置されていた場合もここで埋まる。
  if (conf.getLastRow() < 2) {
    conf.getRange(1, 1, 1, 4).setValues([[
      'キー', 'シート名', '有効', '説明'
    ]]).setFontWeight('bold').setBackground('#efe9dd');
    conf.getRange(2, 1, 5, 4).setValues([
      ['daily',   '分析_日別店舗',   'TRUE', '日別×店舗の売上・原価・人件費・現金（必須）'],
      ['media',   '分析_媒体別日次', 'TRUE', '媒体別の売上・客数'],
      ['deposit', '入金DB',         'TRUE', '入金の記録'],
      ['review',  '口コミ推移ログ',   'TRUE', 'Google口コミのスナップショット'],
      ['ad',      '広告DB',         'FALSE', '広告費（シートを作ったらTRUEに）']
    ]);
    conf.setColumnWidths(1, 4, 170);
  } else {
    // 旧バージョンで作られた古いシート名を自動修正（該当キーのみ）
    var fix = { media: '分析_媒体別日次', review: '口コミ推移ログ' };
    var oldName = { media: '媒体別DB', review: '口コミログ' };
    var cv = conf.getRange(2, 1, conf.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < cv.length; i++) {
      var key = String(cv[i][0]).trim();
      if (fix[key] && String(cv[i][1]).trim() === oldName[key]) {
        conf.getRange(i + 2, 2).setValue(fix[key]);
      }
    }
  }

  // 広告費入力シート（DB_広告）。無ければテンプレートを自動作成。
  // 入力後「確認」列にチェックを入れた行だけがダッシュボードに反映される。
  var adSh = ss.getSheetByName('DB_広告');
  if (!adSh) {
    adSh = ss.insertSheet('DB_広告');
    adSh.getRange(1, 1, 1, 6).setValues([['日付', '店舗名', '媒体', '広告費', '確認', 'メモ']])
      .setFontWeight('bold').setBackground('#efe9dd');
    adSh.getRange(2, 5, 999, 1).insertCheckboxes();
    adSh.setFrozenRows(1);
    adSh.setColumnWidths(1, 6, 120);
  }
}

// ================== 認証 ==================

function accountRows() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('アカウント');
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  var rows = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (!String(v[0]).trim()) continue;
    rows.push({
      row: i + 2,
      id: String(v[0]).trim(),
      pw: String(v[1]),
      name: String(v[2]).trim(),
      role: String(v[3]).trim(),
      stores: String(v[4]).trim(),
      active: String(v[5]).toUpperCase() !== 'FALSE' && String(v[5]) !== '無効' && String(v[5]) !== '0',
      memo: String(v[6] || '')
    });
  }
  return rows;
}

function login(p) {
  var id = String(p.id || '').trim();
  var pw = String(p.pw || '');
  if (!id || !pw) return { ok: false, error: 'IDとパスワードを入力してください' };

  // 総当たり対策: 同一IDの失敗が10回続いたら10分ロック
  var cache = CacheService.getScriptCache();
  var failKey = 'fail_' + id;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 10) return { ok: false, error: '試行回数が上限を超えました。しばらく待ってから再度お試しください' };

  var rows = accountRows();
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i];
    if (a.id === id && a.pw === pw) {
      if (!a.active) return { ok: false, error: 'このアカウントは無効化されています' };
      var token = Utilities.getUuid();
      var sess = { id: a.id, name: a.name, role: a.role, stores: a.stores };
      cache.put('tok_' + token, JSON.stringify(sess), TOKEN_HOURS * 3600);
      cache.remove(failKey);
      return { ok: true, token: token, account: sess };
    }
  }
  cache.put(failKey, String(fails + 1), 600);
  return { ok: false, error: 'IDまたはパスワードが違います' };
}

function logout(p) {
  if (p.token) CacheService.getScriptCache().remove('tok_' + p.token);
  return { ok: true };
}

function requireSession(p) {
  var token = String(p.token || '');
  if (!token) throw new Error('unauthorized');
  var cache = CacheService.getScriptCache();
  var raw = cache.get('tok_' + token);
  if (!raw) throw new Error('unauthorized');
  // 利用のたびに有効期限を延長
  cache.put('tok_' + token, raw, TOKEN_HOURS * 3600);
  return JSON.parse(raw);
}

function isAdmin(session) {
  return session.role === '社長' || session.role === '本部';
}

// ================== データ配信 ==================

// 配信対象のシート（キー→シート名）を接続設定るDB_接頭辞から解決
function configuredSheets(ss) {
  var list = [];
  var conf = ss.getSheetByName('接続設定');
  if (conf && conf.getLastRow() > 1) {
    var rows = conf.getRange(2, 1, conf.getLastRow() - 1, 3).getValues();
    for (var i = 0; i < rows.length; i++) {
      var key = String(rows[i][0]).trim();
      var name = String(rows[i][1]).trim();
      var on = String(rows[i][2]).toUpperCase() !== 'FALSE' && String(rows[i][2]) !== '0' && String(rows[i][2]) !== '';
      if (key && name && on) list.push({ key: key, name: name });
    }
  }
  var all = ss.getSheets();
  for (var j = 0; j < all.length; j++) {
    var nm = all[j].getName();
    if (nm.indexOf('DB_') === 0) {
      var k = nm.substring(3);
      if (!list.some(function (x) { return x.key === k; })) list.push({ key: k, name: nm });
    }
  }
  return list;
}

// ダッシュボードが使う列だけを送る（部分一致・不要列は間引いて軽くする）
var KEEP_COLUMNS = {
  daily:   ['日付', '営業日', '店舗名', '店舗', '純売上', '総売上', '売上', '総客数', '客数', 'アルバイト人件費', '社員人件費', '人件費合計', '仕入', '原価', '現金'],
  media:   ['店舗名', '店舗', '営業日', '日付', '媒体', '人数', '客数', '純売上', '総売上', '売上'],
  deposit: ['店舗名', '店舗', '日付', '営業日', '入金日', '入金額', '入金合計', '入金'],
  review:  ['取得日', '日付', '店舗名', '店舗', '累計', '件数', '平均星', '星', '評価', '前回比']
};
// 残す列のインデックスを求める（見つからなければ全列）
function keepColumnIdx(header, key) {
  var keep = KEEP_COLUMNS[key];
  if (!keep) { var all = []; for (var c = 0; c < header.length; c++) all.push(c); return all; }
  var idx = [];
  for (var c2 = 0; c2 < header.length; c2++) {
    var h = String(header[c2]);
    for (var j = 0; j < keep.length; j++) { if (h.indexOf(keep[j]) >= 0) { idx.push(c2); break; } }
  }
  if (idx.length === 0) { var all2 = []; for (var c3 = 0; c3 < header.length; c3++) all2.push(c3); return all2; }
  return idx;
}

// 【高速版】1回の読み込みで「必要列だけ・期間内だけ・日付を文字列化」までまとめて行う。
// 以前は sheetValues→filterRecent→pruneColumns と全データを3回なめていたのを1回に集約。
function readSheet(sh, months, key) {
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 1 || lc < 1) return [];
  var vals = sh.getRange(1, 1, lr, lc).getValues();
  var header = vals[0];
  var keepIdx = keepColumnIdx(header, key);
  // 日付列（絞り込み用）
  var di = -1, dkeys = ['日付', '営業日', '取得日', '勤務日', '入金日', '年月日'];
  for (var c = 0; c < lc && di < 0; c++) {
    for (var k = 0; k < dkeys.length; k++) { if (String(header[c]).indexOf(dkeys[k]) >= 0) { di = c; break; } }
  }
  var ct = null;
  if (months && months > 0 && di >= 0) { var co = new Date(); co.setMonth(co.getMonth() - months); ct = co.getTime(); }
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var out = [];
  // ヘッダー行
  var hrow = []; for (var m0 = 0; m0 < keepIdx.length; m0++) hrow.push(header[keepIdx[m0]]);
  out.push(hrow);
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    if (ct !== null) {                    // 期間外は捨てる
      var dv = row[di], t;
      if (dv instanceof Date) t = new Date(dv.getFullYear(), dv.getMonth(), dv.getDate()).getTime();
      else { var pp = String(dv).replace(/-/g, '/').split('/'); t = (pp.length >= 3) ? new Date(+pp[0], +pp[1] - 1, +pp[2]).getTime() : NaN; }
      if (!isNaN(t) && t < ct) continue;
    }
    var o = [];
    for (var m = 0; m < keepIdx.length; m++) {
      var v = row[keepIdx[m]];
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy/MM/dd');
      o.push(v);
    }
    out.push(o);
  }
  return out;
}

function getData(p, session) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = {};
  var months = Number(p.months) || 0;                       // 0 = 全期間
  var only = p.keys ? String(p.keys).split(',') : null;     // このキーだけ返す
  var except = p.exclude ? String(p.exclude).split(',') : null; // このキーは除外
  var list = configuredSheets(ss);
  for (var i = 0; i < list.length; i++) {
    var key = list[i].key;
    if (only && only.indexOf(key) < 0) continue;
    if (except && except.indexOf(key) >= 0) continue;
    var sh = ss.getSheetByName(list[i].name);
    if (sh) sheets[key] = readSheet(sh, months, key);
  }
  // version は重い Drive 呼び出しを含むので data では返さない（クライアントは version アクションで別途取得）
  return {
    ok: true,
    updated: new Date().toISOString(),
    account: session,
    sheets: sheets
  };
}

// 変更検知用の軽量な署名（全データを読まずに作る）
function dataVersion() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var list = configuredSheets(ss), parts = [];
  for (var i = 0; i < list.length; i++) {
    var sh = ss.getSheetByName(list[i].name);
    if (sh) parts.push(list[i].key + ':' + sh.getLastRow()); // getLastRow は全読込より圧倒的に速い
  }
  var v = parts.join('|');
  try { v += '@' + DriveApp.getFileById(ss.getId()).getLastUpdated().getTime(); } catch (e) {} // 既存行の編集も検知（Drive権限があれば）
  return v;
}

// ================== アカウント管理（社長・本部のみ） ==================

function listAccounts(session) {
  if (!isAdmin(session)) return { ok: false, error: 'アカウント管理の権限がありません' };
  var rows = accountRows().map(function (a) {
    return { id: a.id, name: a.name, role: a.role, stores: a.stores, active: a.active, memo: a.memo, hasPw: a.pw !== '' };
  });
  return { ok: true, accounts: rows };
}

function saveAccount(p, session) {
  if (!isAdmin(session)) return { ok: false, error: 'アカウント管理の権限がありません' };
  var id = String(p.accountId || '').trim();
  if (!id) return { ok: false, error: 'ログインIDが未指定です' };
  var role = String(p.role || '店舗');
  if (['社長', '本部', 'マネージャー', '店舗'].indexOf(role) < 0) return { ok: false, error: '権限は 社長/本部/マネージャー/店舗 のいずれかです' };

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('アカウント');
  var rows = accountRows();
  var target = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) { target = rows[i]; break; }

  var values = [
    id,
    String(p.pw || (target ? target.pw : '')),
    String(p.name || (target ? target.name : id)),
    role,
    String(p.stores || (target ? target.stores : '全店')),
    (String(p.active || 'TRUE').toUpperCase() === 'FALSE') ? 'FALSE' : 'TRUE',
    String(p.memo || (target ? target.memo : ''))
  ];
  if (!values[1]) return { ok: false, error: '新規アカウントにはパスワードが必要です' };

  if (target) sh.getRange(target.row, 1, 1, 7).setValues([values]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, 7).setValues([values]);
  return { ok: true };
}

function deleteAccount(p, session) {
  if (!isAdmin(session)) return { ok: false, error: 'アカウント管理の権限がありません' };
  var id = String(p.accountId || '').trim();
  if (id === session.id) return { ok: false, error: '自分自身のアカウントは削除できません' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('アカウント');
  var rows = accountRows();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === id) { sh.deleteRow(rows[i].row); return { ok: true }; }
  }
  return { ok: false, error: '該当アカウントが見つかりません' };
}
