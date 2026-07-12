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
 *
 * ★管理シート連携（入力の一元化）:
 *   広告費用対効果_管理シート（MGMT_SHEET_ID）の 💾広告費DB／💾売上DB／💾予約DB／⚙単価設定 を
 *   GASが直接読み込んでダッシュボードに配信します。IMPORTRANGEや転記は不要。
 *   管理シートにデータがあればそちらを優先し、無ければローカルのDB_シートを使います。
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
    if (action === 'ping')   return out({ ok: true, ping: 'pong', ver: 'bq-v10', time: new Date().toISOString() });
    if (action === 'bqLoadOrders') return out(bqLoadOrders(p)); // 明細のBQ投入（専用トークン認証・ログイン不要）
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
    var hasDinii = false;
    for (var i = 0; i < cv.length; i++) {
      var key = String(cv[i][0]).trim();
      if (key === 'dinii') hasDinii = true;
      if (fix[key] && String(cv[i][1]).trim() === oldName[key]) {
        conf.getRange(i + 2, 2).setValue(fix[key]);
      }
    }
    // ダイニー来店アンケートの配信行が無ければ自動追加（シートが存在する場合のみ有効化）
    if (!hasDinii) {
      var diniiOn = ss.getSheetByName('ダイニーDB') ? 'TRUE' : 'FALSE';
      conf.getRange(conf.getLastRow() + 1, 1, 1, 4).setValues([
        ['dinii', 'ダイニーDB', diniiOn, 'ダイニー来店アンケート（また来たい点数）']
      ]);
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

  // 広告効果入力シート（DB_広告効果）。無ければテンプレートを自動作成。
  // アクセス数・ネット予約を入れると、ダッシュボード側で CVR・CPA・予想売上・想定ROAS を自動計算。
  var fxSh = ss.getSheetByName('DB_広告効果');
  if (!fxSh) {
    fxSh = ss.insertSheet('DB_広告効果');
    fxSh.getRange(1, 1, 1, 8).setValues([['年月', '店舗名', '媒体', 'アクセス数', 'ネット予約組数', 'ネット予約人数', '電話数', 'メモ']])
      .setFontWeight('bold').setBackground('#efe9dd');
    fxSh.getRange('A1').setNote(
      '1行＝年月×店舗×媒体。\n' +
      '・年月: 2026/07 の形式（2026/07/01でも可）\n' +
      '・通常は管理シート（💾売上DB）に入力すればOK。GASが直接読むためこのシートは予備\n' +
      '・CVR・CPA・予想売上はダッシュボード側で自動計算（入力不要）'
    );
    fxSh.setFrozenRows(1);
    fxSh.setColumnWidths(1, 8, 120);
  }

  // 設定単価シート（DB_単価設定）。無ければテンプレートを自動作成。
  // 予想売上＝ネット予約人数×設定単価。
  var tkSh = ss.getSheetByName('DB_単価設定');
  if (!tkSh) {
    tkSh = ss.insertSheet('DB_単価設定');
    tkSh.getRange(1, 1, 1, 4).setValues([['店舗名', '媒体', '設定単価', 'メモ']])
      .setFontWeight('bold').setBackground('#efe9dd');
    tkSh.getRange('A1').setNote(
      '店舗×媒体ごとの想定客単価（円）。\n' +
      '・店舗名を空欄＝全店共通、媒体を空欄＝その店舗の全媒体に適用\n' +
      '・予想売上＝ネット予約人数×設定単価'
    );
    tkSh.setFrozenRows(1);
    tkSh.setColumnWidths(1, 4, 130);
  }

  // PL経費入力シート（DB_PL）。無ければテンプレートを自動作成。
  // 1行＝年月×店舗×勘定科目。区分: F=仕入れ/L=人件費/A=広告/R=家賃/O=他
  var plSh = ss.getSheetByName('DB_PL');
  if (!plSh) {
    plSh = ss.insertSheet('DB_PL');
    plSh.getRange(1, 1, 1, 6).setValues([['年月', '店舗名', '勘定科目', '区分', '金額', 'メモ']])
      .setFontWeight('bold').setBackground('#efe9dd');
    plSh.getRange('A1').setNote(
      '月次経費を1行ずつ入力してください。\n' +
      '・年月: 2026/07 の形式（2026/07/01でも可）\n' +
      '・店舗名: 分析_日別店舗と同じ表記（空欄＝全社共通経費）\n' +
      '・勘定科目: 家賃／水道光熱費／消耗品費／支払手数料 など自由\n' +
      '・区分: F=仕入れ / L=人件費 / A=広告 / R=家賃 / O=他\n' +
      '・金額: 数値（円）\n' +
      '※売上・仕入・人件費・広告費（DB_広告）は自動連携。ここに入れたF/L/Aは自動分に加算されます。'
    );
    // 区分列にプルダウン（F/L/A/R/O）
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(['F', 'L', 'A', 'R', 'O'], true).setAllowInvalid(true).build();
    plSh.getRange(2, 4, 999, 1).setDataValidation(rule);
    plSh.setFrozenRows(1);
    plSh.setColumnWidths(1, 6, 130);
  }

  // 祝日シート（DB_祝日）。無ければ雛形を作成。
  // ダッシュボードは2027年まで祝日を内蔵済み。2028年以降はこのシートに日付を足すだけで
  // カレンダー表示（曜日の赤字・曜日別比較の「祝」分離）に反映される。
  var holSh = ss.getSheetByName('DB_祝日');
  if (!holSh) {
    holSh = ss.insertSheet('DB_祝日');
    holSh.getRange(1, 1, 1, 2).setValues([['日付', '名称（任意）']])
      .setFontWeight('bold').setBackground('#efe9dd');
    holSh.getRange('A1').setNote(
      '土日以外の祝日をここに1行ずつ入力してください。\n' +
      '・日付: 2028/1/1 の形式（2028-01-01 や 2028年1月1日 でも可）\n' +
      '・名称: 任意（元日・成人の日 など。空欄でも動きます）\n' +
      '※ダッシュボードは2027年まで内蔵済み。2028年以降の分をここに足せば自動で反映されます。\n' +
      '※振替休日・国民の休日も1行として入れてください。'
    );
    holSh.setFrozenRows(1);
    holSh.setColumnWidths(1, 2, 160);
  }

  // 媒体分類シート（DB_媒体分類）。無ければ雛形を作成。
  // ダッシュボードの「媒体別売上」パネルを 入店用途別／営業区分別 に切り替えたときの分類ルール。
  // 未設定の媒体は名前から自動判定（フリー→フリー、外販/テイクアウト→外販、他→予約 ／ ランチ→ランチ、ディナー→ディナー、他→未分類）
  var mcSh = ss.getSheetByName('DB_媒体分類');
  if (!mcSh) {
    mcSh = ss.insertSheet('DB_媒体分類');
    mcSh.getRange(1, 1, 1, 4).setValues([['媒体', '入店用途', '営業区分', 'メモ']])
      .setFontWeight('bold').setBackground('#efe9dd');
    mcSh.getRange(2, 1, 9, 4).setValues([
      ['Live GATE',   '外販',       '', ''],
      ['Peevo',       '外販',       '', ''],
      ['Ring-style',  '外販',       '', ''],
      ['いちご屋',     '外販',       '', ''],
      ['フリー',       'フリー',     '', ''],
      ['リピーター',   'リピーター',  '', ''],
      ['鍋倉',         'リピーター',  '', ''],
      ['キュア鍋',     'リピーター',  '', ''],
      ['本店パス',     '他店パス',    '', '']
    ]);
    mcSh.getRange('A1').setNote(
      '媒体別売上シート（分析_媒体別日次）の媒体名ごとに、入店用途と営業区分を設定します。\n' +
      '・媒体: 分析_媒体別日次の媒体列と同じ表記\n' +
      '・入店用途: 予約／フリー／外販／リピーター／他店パス など自由（載っていない媒体は「予約」）\n' +
      '・営業区分: 空欄なら自動判定（媒体名に「ランチ」→ランチ、他→ディナー）。固定したい時だけ入力\n' +
      '※行を足す・直すだけで分類を変えられます。'
    );
    mcSh.setFrozenRows(1);
    mcSh.setColumnWidths(1, 4, 150);
  }

  // 店舗ID対応シート（DB_店舗ID対応）。無ければ雛形を作成。
  // BigQueryの明細（Dinii）は店舗が「店舗ID(長い文字列)」で入っているため、店舗名に変換する対応表。
  var sidSh = ss.getSheetByName('DB_店舗ID対応');
  if (!sidSh) {
    sidSh = ss.insertSheet('DB_店舗ID対応');
    sidSh.getRange(1, 1, 1, 2).setValues([['店舗ID', '店舗名']])
      .setFontWeight('bold').setBackground('#efe9dd');
    // いま入っている1店舗ぶんのIDを先頭に入れておく（店舗名は入力してください）
    sidSh.getRange(2, 1, 1, 2).setValues([['f50fda5d-ac82-4ae4-ac35-fbb67fd7ca43', '']]);
    sidSh.getRange('A1').setNote(
      'BigQueryの明細（Dinii出数）の店舗IDと、表示用の店舗名の対応表です。\n' +
      '・店舗ID: Diniiの生データに入っている長い文字列（例 f50fda5d-...）\n' +
      '・店舗名: 分析_日別店舗と同じ表記（例 芝の鳥一代）\n' +
      '※店舗を追加するたびに1行足せば、明細分析タブに店舗名で表示されます。'
    );
    sidSh.setFrozenRows(1);
    sidSh.setColumnWidths(1, 1, 320); sidSh.setColumnWidths(2, 1, 160);
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

// === セッション保存（消えない場所=ScriptProperties に保存）===
function sessionStore(){ return PropertiesService.getScriptProperties(); }
function sessionPut(token, sess){
  var exp = new Date().getTime() + TOKEN_HOURS * 3600 * 1000;
  sessionStore().setProperty('tok_' + token, JSON.stringify({ sess: sess, exp: exp }));
}
function sessionGet(token){
  var store = sessionStore();
  var raw = store.getProperty('tok_' + token);
  if (!raw) return null;
  var obj; try { obj = JSON.parse(raw); } catch (e) { return null; }
  if (!obj.exp || new Date().getTime() > obj.exp) { store.deleteProperty('tok_' + token); return null; }
  obj.exp = new Date().getTime() + TOKEN_HOURS * 3600 * 1000; // 使うたびに期限を延長
  store.setProperty('tok_' + token, JSON.stringify(obj));
  return obj.sess;
}
function sessionDel(token){ sessionStore().deleteProperty('tok_' + token); }
function sessionCleanup(){ // 期限切れの古いトークンを掃除
  var store = sessionStore(), all = store.getProperties(), now = new Date().getTime();
  for (var k in all) {
    if (k.indexOf('tok_') === 0) {
      try { var o = JSON.parse(all[k]); if (!o.exp || now > o.exp) store.deleteProperty(k); }
      catch (e) { store.deleteProperty(k); }
    }
  }
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
      sessionCleanup();
      var token = Utilities.getUuid();
      var sess = { id: a.id, name: a.name, role: a.role, stores: a.stores };
      sessionPut(token, sess);
      cache.remove(failKey);
      return { ok: true, token: token, account: sess };
    }
  }
  cache.put(failKey, String(fails + 1), 600);
  return { ok: false, error: 'IDまたはパスワードが違います' };
}

function logout(p) {
  if (p.token) sessionDel(p.token);
  return { ok: true };
}

function requireSession(p) {
  var token = String(p.token || '');
  if (!token) throw new Error('unauthorized');
  var sess = sessionGet(token);
  if (!sess) throw new Error('unauthorized');
  return sess;
}

function isAdmin(session) {
  return session.role === '社長' || session.role === '本部';
}

// ================== 管理シート連携 ==================
// 広告費用対効果_管理シート。ここに入力すれば転記・IMPORTRANGE不要でダッシュボードに自動反映。
var MGMT_SHEET_ID = '1y-Lb5ynzJ-5tRDKgQAapoxmpqkfO1o5gNWcPR2WLxCI';
// 管理シートのタブ → 配信キー（タブ名は部分一致。絵文字付きでもOK）
var MGMT_TABS = [
  { key: '広告',     re: /広告費DB/ },        // 💾広告費DB → 広告費
  { key: '広告効果', re: /売上DB|広告効果/ },  // 💾売上DB → アクセス数・ネット予約・電話数
  { key: '単価設定', re: /単価設定/ },         // ⚙単価設定 → 想定客単価
  { key: '予約',     re: /予約DB|予約明細|予約一覧/ }  // 💾予約DB → 曜日別・当日予約の時刻分析
];

function mgmtOpen() {
  if (!MGMT_SHEET_ID) return null;
  try { return SpreadsheetApp.openById(MGMT_SHEET_ID); } catch (e) { return null; }
}
function mgmtFindTab(mss, re) {
  var shs = mss.getSheets();
  for (var i = 0; i < shs.length; i++) if (re.test(shs[i].getName())) return shs[i];
  return null;
}
// 管理シート側の不足を自動で整える（何度呼んでも安全）
function mgmtEnsure(mss) {
  try {
    // ⚙単価設定タブが無ければ作成
    if (!mgmtFindTab(mss, /単価設定/)) {
      var tk = mss.insertSheet('⚙単価設定');
      tk.getRange(1, 1, 1, 6).setValues([['店舗名', '媒体', '設定単価', '平均1組人数', '電話CV', 'メモ']])
        .setFontWeight('bold').setBackground('#efe9dd');
      tk.getRange('A1').setNote(
        '店舗×媒体ごとの想定客単価（円）。入力するとダッシュボードに自動反映。\n' +
        '・店舗名を空欄＝全店共通、媒体を空欄＝その店舗の全媒体に適用\n' +
        '・予想売上＝ネット予約人数×設定単価 ＋ 電話数×電話CV×平均1組人数×設定単価\n' +
        '・電話CVは 30% でも 0.3 でもOK（例：電話100件×CV30%×平均5名×単価4,000円＝60万円）'
      );
      tk.setFrozenRows(1);
      tk.setColumnWidths(1, 6, 130);
    }
    // 既存の⚙単価設定に「平均1組人数」「電話CV」列が無ければ末尾に追加
    var tkEx = mgmtFindTab(mss, /単価設定/);
    if (tkEx && tkEx.getLastColumn() >= 1) {
      var th = tkEx.getRange(1, 1, 1, tkEx.getLastColumn()).getValues()[0];
      var hasAvg = false, hasCv = false;
      for (var k = 0; k < th.length; k++) {
        var hv = String(th[k]);
        if (hv.indexOf('組人数') >= 0) hasAvg = true;
        if (hv.indexOf('電話CV') >= 0 || hv.indexOf('電話ＣＶ') >= 0) hasCv = true;
      }
      if (!hasAvg) tkEx.getRange(1, tkEx.getLastColumn() + 1).setValue('平均1組人数').setFontWeight('bold').setBackground('#efe9dd');
      if (!hasCv) tkEx.getRange(1, tkEx.getLastColumn() + 1).setValue('電話CV').setFontWeight('bold').setBackground('#efe9dd');
    }
    // 💾予約DB タブ（予約一覧CSVの貼り付け先）が無ければ自動作成
    if (!mgmtFindTab(mss, /予約DB|予約明細|予約一覧/)) {
      var tr = mss.insertSheet('💾予約DB');
      tr.getRange(1, 1, 1, 9).setValues([['店舗名', '予約No', '来店日', '来店時間', '人数', 'ステータス', '受付窓口', '作成日', '作成時間']]).setFontWeight('bold').setBackground('#efe9dd');
      tr.getRange('A1').setNote('予約一覧CSV（食べログ等の管理画面からエクスポート）をそのまま貼り付けてOK（ヘッダー行ごと・列の並びは自由。列名で自動判定します）。\n・複数店舗ぶんを貼る場合は「店舗名」列を追加してください（1店舗なら不要）\n・曜日別の予約傾向と当日予約の申込時刻分布がダッシュボードに自動反映されます');
      tr.setFrozenRows(1);
      tr.setColumnWidths(1, 9, 110);
    }
    // 💾売上DB のヘッダー行（「アクセス」を含む行）に「電話数」列が無ければ末尾に追加
    var up = mgmtFindTab(mss, /売上DB/);
    if (up && up.getLastRow() >= 1 && up.getLastColumn() >= 1) {
      var scanR = Math.min(up.getLastRow(), 12), scanC = up.getLastColumn();
      var grid = up.getRange(1, 1, scanR, scanC).getValues();
      var hr = -1;
      for (var r = 0; r < grid.length; r++) {
        if (grid[r].join(',').indexOf('アクセス') >= 0) { hr = r; break; }
      }
      if (hr >= 0) {
        var has = false, lastFilled = 0;
        for (var i = 0; i < grid[hr].length; i++) {
          if (String(grid[hr][i]).indexOf('電話') >= 0) has = true;
          if (String(grid[hr][i]) !== '') lastFilled = i + 1;
        }
        if (!has) up.getRange(hr + 1, lastFilled + 1).setValue('電話数').setFontWeight('bold').setBackground('#efe9dd');
        // 旧仕様で1行目に付いた迷子の「電話数」を掃除
        if (hr !== 0) {
          for (var j = 0; j < grid[0].length; j++) {
            if (String(grid[0][j]).replace(/\s/g, '') === '電話数') up.getRange(1, j + 1).clearContent().setBackground(null);
          }
        }
      }
    }
  } catch (e) {}
}

// ================== データ配信 ==================

// 配信対象のシート（キー→シート名）を接続設定＋DB_接頭辞から解決
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
  // dinii は列フィルタしない（コメント等の自由記述列もそのまま配信するため、KEEP_COLUMNSに載せない）
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
  var di = -1, dkeys = ['日付', '営業日', '取得日', '勤務日', '入金日', '年月日', '来店日', 'タイムスタンプ'];
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
      else { var mm2 = String(dv).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/); t = mm2 ? new Date(+mm2[1], +mm2[2] - 1, +mm2[3]).getTime() : NaN; }  // "2026/07/01 12:34"形式も対応
      if (!isNaN(t) && t < ct) continue;
    }
    var o = [];
    for (var m = 0; m < keepIdx.length; m++) {
      var v = row[keepIdx[m]];
      if (v instanceof Date) v = (v.getFullYear() > 1970) ? Utilities.formatDate(v, tz, 'yyyy/MM/dd') : Utilities.formatDate(v, tz, 'HH:mm');  // 時刻だけのセル（1899年基点）はHH:mm
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
  // ① 管理シート（入力の一元化）を最優先で読む。タブにデータがあればローカルDB_シートより優先。
  var mss = null;
  for (var t = 0; t < MGMT_TABS.length; t++) {
    var mt = MGMT_TABS[t];
    if (only && only.indexOf(mt.key) < 0) continue;
    if (except && except.indexOf(mt.key) >= 0) continue;
    if (mss === null) { mss = mgmtOpen() || false; if (mss) mgmtEnsure(mss); }
    if (!mss) break;
    var msh = mgmtFindTab(mss, mt.re);
    if (msh && msh.getLastRow() > 1) sheets[mt.key] = readSheet(msh, months, mt.key);
  }
  // ② ローカル（このスプレッドシート）のシート。管理シートから取得済みのキーはスキップ。
  for (var i = 0; i < list.length; i++) {
    var key = list[i].key;
    if (sheets[key]) continue;
    if (only && only.indexOf(key) < 0) continue;
    if (except && except.indexOf(key) >= 0) continue;
    var sh = ss.getSheetByName(list[i].name);
    if (sh) sheets[key] = readSheet(sh, months, key);
  }
  // ③ BigQuery（明細分析：時間帯別・商品別）。スプレッドシートを経由せず、集計済みの小さい結果だけ受け取る。
  //    BQ未設定・権限エラーでもダッシュボードは通常どおり動く（try/catch内）。
  var bq = bqDetailSheets_(only, except);
  for (var bk in bq) sheets[bk] = bq[bk];

  // version は重い Drive 呼び出しを含むので data では返さない（クライアントは version アクションで別途取得）
  return {
    ok: true,
    updated: new Date().toISOString(),
    account: session,
    sheets: sheets
  };
}

// ================== BigQuery（明細分析：Dinii出数） ==================
var BQ_PROJECT = 'tori-analytics';                    // 課金・実行に使うプロジェクトID
var BQ_TABLE   = '`tori-analytics.dinii.orders`';     // 明細テーブル
// ダッシュボードに返す集計SQL（小さい結果＝スキャン最小・無料枠内）
function bqSqls_() {
  // sales=税込(販売金額税込) / sales_excl=税別(売価税抜×数量)。ダッシュボードで税込/税別を切替表示。
  return {
    '明細時間帯': 'SELECT EXTRACT(HOUR FROM checkout_at) AS hour, SUM(sales_incl) AS sales, SUM(price_excl*qty) AS sales_excl, COUNT(DISTINCT check_id) AS checks FROM ' + BQ_TABLE + ' GROUP BY hour ORDER BY hour',
    '明細商品':   'SELECT menu, SUM(sales_incl) AS sales, SUM(price_excl*qty) AS sales_excl, SUM(qty) AS qty FROM ' + BQ_TABLE + ' GROUP BY menu ORDER BY sales DESC LIMIT 100',
    '明細店舗':   'SELECT store_id, SUM(sales_incl) AS sales, SUM(price_excl*qty) AS sales_excl, COUNT(DISTINCT check_id) AS checks FROM ' + BQ_TABLE + ' GROUP BY store_id ORDER BY sales DESC'
  };
}
// 店舗ID→店舗名の対応（DB_店舗ID対応シート）。無ければ空。
function bqStoreMap_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_店舗ID対応');
  var map = {};
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < v.length; i++) { var id = String(v[i][0]).trim(), nm = String(v[i][1]).trim(); if (id && nm) map[id] = nm; }
  }
  return map;
}
// BQクエリを実行して [[見出し...],[行...]] を返す。失敗時は null。
function bqRows_(sql) {
  var res = BigQuery.Jobs.query({ query: sql, useLegacySql: false, timeoutMs: 30000 }, BQ_PROJECT);
  if (!res || !res.jobComplete) return null;
  var fields = (res.schema && res.schema.fields) || [];
  var out = [fields.map(function (f) { return f.name; })];
  var rows = res.rows || [];
  for (var i = 0; i < rows.length; i++) out.push(rows[i].f.map(function (c) { return c.v; }));
  return out;
}
// キャッシュ付きでBQ明細集計を取得（10分キャッシュ＝再表示で再クエリしない）
function bqDetailSheets_(only, except) {
  var sqls = bqSqls_(), cache = CacheService.getScriptCache(), out = {};
  for (var key in sqls) {
    if (only && only.indexOf(key) < 0) continue;
    if (except && except.indexOf(key) >= 0) continue;
    try {
      var ck = 'bq_' + key, cached = cache.get(ck);
      if (cached) { out[key] = JSON.parse(cached); continue; }
      var rows = bqRows_(sqls[key]);
      if (rows && key === '明細店舗') {   // 店舗IDを店舗名に置換
        var m = bqStoreMap_();
        for (var r = 1; r < rows.length; r++) rows[r][0] = m[rows[r][0]] || rows[r][0];
        if (rows[0]) rows[0][0] = '店舗';
      }
      if (rows) { out[key] = rows; cache.put(ck, JSON.stringify(rows), 600); }
    } catch (e) { /* BQ未有効・権限エラー等でもダッシュボードは動かす */ }
  }
  return out;
}
// 手動テスト用：エディタから実行して結果をログ確認
function testBQ() { Logger.log(JSON.stringify(bqRows_(bqSqls_()['明細時間帯']))); }

// ===== 明細(Dinii注文)のBigQuery投入 =====
// dinii.orders の列定義（整形済みCSVと一致）
var BQ_ORDERS_SCHEMA = [
  { name: 'store_id', type: 'STRING' }, { name: 'business_date', type: 'DATE' },
  { name: 'checkout_at', type: 'DATETIME' }, { name: 'order_at', type: 'DATETIME' },
  { name: 'check_id', type: 'STRING' }, { name: 'category_id', type: 'STRING' },
  { name: 'category', type: 'STRING' }, { name: 'menu_id', type: 'STRING' },
  { name: 'menu', type: 'STRING' }, { name: 'main_sub', type: 'STRING' },
  { name: 'price_incl', type: 'NUMERIC' }, { name: 'price_excl', type: 'NUMERIC' },
  { name: 'cost_incl', type: 'NUMERIC' }, { name: 'cost_excl', type: 'NUMERIC' },
  { name: 'qty', type: 'NUMERIC' }, { name: 'sales_incl', type: 'NUMERIC' },
  { name: 'discount', type: 'NUMERIC' }, { name: 'parent_menu_id', type: 'STRING' },
  { name: 'parent_menu', type: 'STRING' }, { name: 'tax_rate', type: 'STRING' }
];
// 明細CSVをBQに投入。p.date（YYYY-MM-DD）を渡すと「その日を削除→追加」で冪等。
// p.truncate=true なら全テーブル置換（初回バックフィルの1回目用）。
function bqLoadOrders(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String(p.token) !== tk) return { ok: false, error: 'unauthorized' };
  var csv = p.csv || ''; if (!csv) return { ok: false, error: 'csv empty' };
  try {
    // 冪等化：同じ営業日の既存行を削除してから追加（再実行しても重複しない）
    if (p.date && !p.truncate) {
      bqRows_("DELETE FROM `" + BQ_PROJECT + ".dinii.orders` WHERE business_date = DATE('" + String(p.date).slice(0, 10) + "')");
    }
    var job = { configuration: { load: {
      destinationTable: { projectId: BQ_PROJECT, datasetId: 'dinii', tableId: 'orders' },
      sourceFormat: 'CSV', skipLeadingRows: 1, allowQuotedNewlines: true,
      writeDisposition: p.truncate ? 'WRITE_TRUNCATE' : 'WRITE_APPEND',
      maxBadRecords: 200, schema: { fields: BQ_ORDERS_SCHEMA }
    }}};
    var blob = Utilities.newBlob(csv, 'application/octet-stream', 'orders.csv');
    var ins = BigQuery.Jobs.insert(job, BQ_PROJECT, blob);
    var jobId = ins.jobReference.jobId;
    var loc = (ins.jobReference && ins.jobReference.location) || 'asia-northeast1'; // 東京リージョンのジョブは要location
    var st = null;
    for (var i = 0; i < 90; i++) { st = BigQuery.Jobs.get(BQ_PROJECT, jobId, { location: loc }); if (st.status && st.status.state === 'DONE') break; Utilities.sleep(2000); }
    if (st && st.status && st.status.errorResult) return { ok: false, error: st.status.errorResult.message };
    var loaded = (st && st.statistics && st.statistics.load) ? st.statistics.load.outputRows : null;
    try { CacheService.getScriptCache().removeAll(['bq_明細時間帯', 'bq_明細商品', 'bq_明細店舗']); } catch (e) {}
    return { ok: true, rows: Number(loaded || 0), date: p.date || null };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
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
  try { v += '@M' + DriveApp.getFileById(MGMT_SHEET_ID).getLastUpdated().getTime(); } catch (e) {} // 管理シートの編集も検知
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
