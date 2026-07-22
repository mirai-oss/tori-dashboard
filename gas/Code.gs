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
    if (action === 'ping')   return out({ ok: true, ping: 'pong', ver: 'depcarry-v43', time: new Date().toISOString() });
    if (action === 'bqLoadOrders') return out(bqLoadOrders(p)); // 明細のBQ投入（専用トークン認証・ログイン不要）
    if (action === 'perf') return out(perfDiag(p)); // パフォーマンス計測（専用トークン認証・ログイン不要・数字は返さず時間だけ）
    setupIfNeeded();
    if (action === 'login')  return out(login(p));
    if (action === 'checkInvite')      return out(checkInvite(p));      // 招待リンクの確認（未ログイン）
    if (action === 'registerFromInvite') return out(registerFromInvite(p)); // 招待から自己登録（未ログイン）
    if (action === 'logout') return out(logout(p));
    if (action === 'saveArenaEvents') return out(saveArenaEvents(p)); // イベント自動取得（専用トークン認証・ログイン不要）
    // スマホ等から取込タスクを依頼するキュー（3アクションとも専用トークン認証・ログイン不要）
    if (action === 'queueTask')    return out(queueTask(p));    // スマホ側：タスクを依頼（TASK_QUEUE_TOKEN）
    if (action === 'queueStatus')  return out(queueStatus(p));  // スマホ側：直近の依頼状況（TASK_QUEUE_TOKEN）
    if (action === 'pendingTasks') return out(pendingTasks(p)); // Mac側：未処理を取得して受領済みに（BQ_LOAD_TOKEN）
    if (action === 'ackTask')      return out(ackTask(p));      // Mac側：完了/失敗を報告（BQ_LOAD_TOKEN）

    // ここから先はログイン必須
    var session = requireSession(p);
    if (action === 'version')  return out({ ok: true, version: dataVersion() }); // 軽量：変更検知用の署名だけ返す
    if (action === 'data')     return out(getData(p, session));
    if (action === 'depositCarry') return out(depositCarry(p, session)); // 入金の繰越（開始残高）だけ全期間で計算
    if (action === 'bqDetail') return out(bqDetail(p, session)); // 明細分析：期間・店舗で絞ってBQ集計
    if (action === 'accounts') return out(listAccounts(session));
    if (action === 'saveAccount')   return out(saveAccount(p, session));
    if (action === 'deleteAccount') return out(deleteAccount(p, session));
    if (action === 'saveTargets') return out(saveTargets(p, session)); // 目標（日別売上＋月次）保存
    if (action === 'saveTargetDay') return out(saveTargetDay(p, session)); // 日別売上目標を1日だけ修正
    if (action === 'saveEvent')   return out(saveEvent(p, session));   // イベント保存
    if (action === 'deleteEvent') return out(deleteEvent(p, session)); // イベント削除
    if (action === 'importDeposits') return out(importDeposits(p, session)); // 口座CSVの入金取込（入金管理タブ）
    if (action === 'savePlEntries') return out(savePlEntries(p, session)); // PL経費の手入力（PL管理システム＋DB_PL両反映）
    if (action === 'savePlBulk') return out(savePlBulk(p, session)); // PL経費の期間一括計上（例: 家賃を12ヶ月分）
    if (action === 'saveAdFee') return out(saveAdFee(p, session)); // 広告費の手入力（管理シート💾広告費DBへupsert）
    if (action === 'saveAdSales') return out(saveAdSales(p, session)); // 売上・反響の手入力（管理シート💾売上DBへupsert）
    if (action === 'importReservations') return out(importReservations(p, session)); // 予約CSV取込（管理シート💾予約DBへ追記）
    if (action === 'saveWeekly')   return out(saveWeekly(p, session));   // 週報の提出・更新
    if (action === 'saveFeedback') return out(saveFeedback(p, session)); // 週報へのフィードバック
    if (action === 'createInvite') return out(createInvite(p, session)); // 招待リンク発行（社長・本部）
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
  weeklySheets_();          // 週報・回答・FB・招待
  weeklyTemplateSheet_();   // 週報フォーマット（社長が編集する場所）
  roleDefSheet_();          // 役職・権限ごとの既定（表示タブ・使える機能）

  // アカウントシート
  var acc = ss.getSheetByName('アカウント');
  if (!acc) {
    acc = ss.insertSheet('アカウント');
    acc.getRange(1, 1, 1, 8).setValues([[
      'ログインID', 'パスワード', '表示名', '権限', '担当店舗', '有効', 'メモ', '表示タブ'
    ]]).setFontWeight('bold').setBackground('#efe9dd');
    acc.getRange(2, 1, 4, 7).setValues([
      ['shacho',  'tori2026',  '社長',            '社長',       '全店', 'TRUE', '全店舗・全機能・アカウント発行'],
      ['honbu',   'torihq',    '本部 経営管理部',  '本部',       '全店', 'TRUE', '全店舗・全機能・アカウント発行'],
      ['yokohama','toriarea',  '横浜エリアMG',     'マネージャー', '鶏武者 新横浜, 鶏武者 川崎店, 黒霧屋 新横浜', 'TRUE', '担当店舗のみ・店舗間比較あり'],
      ['shiba',   'torishiba', '芝の鳥一代',       '店舗',       '芝の鳥一代', 'TRUE', '自店のみ']
    ]);
    acc.setColumnWidths(1, 8, 150);
  } else if (String(acc.getRange(1, 8).getValue()) === '') {
    // 既存シートに「表示タブ」列が無ければ見出しを追加（アカウント管理画面から編集できる）
    acc.getRange(1, 8).setValue('表示タブ').setFontWeight('bold').setBackground('#efe9dd');
    acc.getRange(1, 8).setNote('空欄＝権限の既定（店舗はPL・広告管理が非表示）。\n表示したいタブだけをカンマ区切りで指定（例: ダッシュボード,推移分析,口コミ）。\n通常はダッシュボードの「アカウント管理」画面のチェックボックスから設定してください。');
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

  // 目標シート（DB_目標＝日別売上目標／DB_目標月次＝月次目標）。ダッシュボードの目標管理タブから入力される。
  var tgSh = ss.getSheetByName('DB_目標');
  if (!tgSh) {
    tgSh = ss.insertSheet('DB_目標');
    tgSh.getRange(1, 1, 1, 3).setValues([['日付', '店舗名', '売上目標']])
      .setFontWeight('bold').setBackground('#efe9dd');
    tgSh.getRange('A1').setNote('日別の売上目標。通常はダッシュボードの「目標管理」タブ →「✎ 目標を入力」から設定してください（昨年同週同曜日の売上を見ながら入力できます）。');
    tgSh.setFrozenRows(1); tgSh.setColumnWidths(1, 3, 130);
  }
  var tgmSh = ss.getSheetByName('DB_目標月次');
  if (!tgmSh) {
    tgmSh = ss.insertSheet('DB_目標月次');
    tgmSh.getRange(1, 1, 1, 7).setValues([['年月', '店舗名', 'PA人件費率', '社員人件費率', '仕入原価率', 'ダイニー点数', '口コミ件数']])
      .setFontWeight('bold').setBackground('#efe9dd');
    tgmSh.getRange('A1').setNote('月次目標（1行＝年月×店舗）。人件費率・仕入原価率は「売上に対する％」（例 20 = 20%）。口コミ件数は「その月に増やす件数」。ダッシュボードの「目標管理」タブから入力できます。');
    tgmSh.setFrozenRows(1); tgmSh.setColumnWidths(1, 7, 110);
  }
  // イベントシート（DB_イベント）。対象店舗にチェック（カンマ区切りで保存）した店舗の画面にだけ表示される。
  var evSh = ss.getSheetByName('DB_イベント');
  if (!evSh) {
    evSh = ss.insertSheet('DB_イベント');
    evSh.getRange(1, 1, 1, 6).setValues([['ID', '日付', 'イベント名', '会場', '対象店舗', 'メモ']])
      .setFontWeight('bold').setBackground('#efe9dd');
    evSh.getRange('A1').setNote('横浜アリーナ・日産スタジアム等のイベント情報。対象店舗（カンマ区切り）に入っている店舗のダッシュボード・目標管理にだけ表示されます（空欄＝全店向け）。通常はダッシュボードの「目標管理」タブ→「＋イベント追加」から入力してください。');
    evSh.setFrozenRows(1); evSh.setColumnWidths(1, 6, 130); evSh.setColumnWidths(5, 1, 260);
  }
  // 会場→対象店舗の対応表（DB_会場店舗）。自動取得したイベント（横浜アリーナ等）の対象店舗をここから自動付与。
  // 店舗が増えたら、その会場の行の「対象店舗」にカンマ区切りで店舗名を足すだけ（翌朝の自動取得で全イベントに反映）。
  var vsSh = ss.getSheetByName('DB_会場店舗');
  if (!vsSh) {
    vsSh = ss.insertSheet('DB_会場店舗');
    vsSh.getRange(1, 1, 1, 2).setValues([['会場', '対象店舗']]).setFontWeight('bold').setBackground('#efe9dd');
    vsSh.getRange(2, 1, 1, 2).setValues([['横浜アリーナ', '黒霧屋 新横浜, 鶏武者 新横浜, じんべえ 新横浜店']]);
    vsSh.getRange('A1').setNote('自動取得イベント（横浜アリーナ等）の「対象店舗」をこの表から自動で埋めます。\n・会場: 取得元の会場名（例 横浜アリーナ）\n・対象店舗: その会場の近くで影響を受ける店舗名をカンマ区切り（分析_日別店舗と同じ表記）\n※店舗が増えたら、この行に店舗名を足すだけで翌朝の自動取得から全イベントに反映されます。');
    vsSh.setFrozenRows(1); vsSh.setColumnWidths(1, 1, 140); vsSh.setColumnWidths(2, 1, 340);
  }
  // タスクキュー（DB_タスクキュー）。スマホのボタンページ（tasks.html）から依頼されたタスクを、
  // ns-daily-import側のdispatch.jsが定期ポーリングして実行する。
  var tqSh = ss.getSheetByName('DB_タスクキュー');
  if (!tqSh) {
    tqSh = ss.insertSheet('DB_タスクキュー');
    tqSh.getRange(1, 1, 1, 6).setValues([['ID', 'タスク', '依頼日時', '状態', '完了日時', '結果']])
      .setFontWeight('bold').setBackground('#efe9dd');
    tqSh.getRange('A1').setNote('スマホのタスク実行ページ（tasks.html）からの依頼をここに記録します。直接編集は不要。\n状態: pending(未処理)→processing(Mac側が受領)→done/failed(完了)');
    tqSh.setFrozenRows(1); tqSh.setColumnWidths(1, 1, 110); tqSh.setColumnWidths(2, 1, 160); tqSh.setColumnWidths(6, 1, 260);
  }
}

// ================== 認証 ==================

function accountRows() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('アカウント');
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
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
      memo: String(v[6] || ''),
      tabs: String(v[7] || '').trim(),  // 表示タブ（空欄＝権限の既定）
      perms: String(v[8] || '').trim(), // 使える機能（空欄＝権限の既定 / 'なし'＝全部不可）
      position: String(v[9] || '').trim() // 役職（店長/社員 等。週報テンプレートの出し分けに使う）
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

// ================== パスワードの保護 ==================
// スプレッドシートに平文で置かないため、SHA-256＋アカウントごとのランダムsaltで保存する。
// 保存形式: 'sha256$<salt>$<hex>'。旧データ（平文）はログイン成功時に自動でこの形式へ移行する。
function pwHash_(salt, plain) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + '|' + String(plain), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < raw.length; i++) {
    var b = (raw[i] < 0 ? raw[i] + 256 : raw[i]).toString(16);
    hex += (b.length === 1 ? '0' : '') + b;
  }
  return hex;
}
function pwEncode_(plain) {
  var salt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  return 'sha256$' + salt + '$' + pwHash_(salt, plain);
}
function pwIsHashed_(stored) { return /^sha256\$/.test(String(stored || '')); }
// 照合。平文で保存されている旧アカウントも受け付ける（呼び出し側で移行する）
function pwVerify_(stored, plain) {
  stored = String(stored == null ? '' : stored);
  if (!pwIsHashed_(stored)) return stored !== '' && stored === String(plain);
  var parts = stored.split('$');
  if (parts.length !== 3) return false;
  return parts[2] === pwHash_(parts[1], plain);
}
// 平文のまま残っている行を、ログイン成功時にその場でハッシュへ差し替える
function pwUpgradeRow_(row, plain) {
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('アカウント');
    if (sh && row > 1) sh.getRange(row, 2).setValue(pwEncode_(plain));
  } catch (e) {}
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
    if (a.id === id && pwVerify_(a.pw, pw)) {
      if (!a.active) return { ok: false, error: 'このアカウントは無効化されています' };
      if (!pwIsHashed_(a.pw)) pwUpgradeRow_(a.row, pw);   // 旧平文 → ハッシュへ自動移行
      sessionCleanup();
      var token = Utilities.getUuid();
      var sess = { id: a.id, name: a.name, role: a.role, stores: a.stores, tabs: a.tabs, perms: a.perms, position: a.position };
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
  { key: '予約',     re: /予約DB|予約明細|予約一覧/ },  // 💾予約DB → 曜日別・当日予約の時刻分析
  { key: '媒体マスタ',   re: /媒体マスタ/ },    // ⚙️媒体マスタ → 広告費入力モーダルの媒体プルダウン
  { key: 'プランマスタ', re: /プランマスタ/ },  // ⚙️プランマスタ → プランプルダウン（標準料金付き）
  { key: '広告店舗マスタ', re: /店舗マスタ/ }   // ⚙️店舗マスタ → 広告費・売上入力の店舗プルダウン（広告側の店舗名）
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
  daily:   ['日付', '営業日', '店舗名', '店舗', '純売上', '総売上', '売上', '総客数', '客数', '組数', '客組数', '会計組数', '会計数', 'アルバイト人件費', '社員人件費', '人件費合計', '仕入', '原価', '現金'],
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
// 1回のgetValuesで「必要列だけ・期間内だけ・日付を文字列化」までまとめて行う（Sheets API往復は1回）。
// ※範囲を分割して読む最適化は、往復回数が増えてこのデータでは逆に遅くなったため採用しない。
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
  var hrow = []; for (var m0 = 0; m0 < keepIdx.length; m0++) hrow.push(header[keepIdx[m0]]);
  out.push(hrow);
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r];
    if (ct !== null) {                    // 期間外は捨てる
      var dv = row[di], t;
      if (dv instanceof Date) t = new Date(dv.getFullYear(), dv.getMonth(), dv.getDate()).getTime();
      else { var mm2 = String(dv).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/); t = mm2 ? new Date(+mm2[1], +mm2[2] - 1, +mm2[3]).getTime() : NaN; }
      if (!isNaN(t) && t < ct) continue;
    }
    var o = [];
    for (var m = 0; m < keepIdx.length; m++) {
      var v = row[keepIdx[m]];
      if (v instanceof Date) v = (v.getFullYear() > 1970) ? Utilities.formatDate(v, tz, 'yyyy/MM/dd') : Utilities.formatDate(v, tz, 'HH:mm');
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

// ================== 入金の繰越（開始残高）だけを全期間で計算して返す ==================
// クライアントは取得期間を13/24ヶ月に絞ると、それより前の現金売上・入金が読み込まれず
// 「累計残（繰越）」が0リセットされてズレる。ここでは全期間をサーバー側で読み、
// 店舗ごとの「指定日より前の 現金売上−入金」だけ（=数十個の数字）を軽く返す。
function depCarryNum_(v) {
  if (typeof v === 'number') return v;
  var n = parseFloat(String(v == null ? '' : v).replace(/[,\s¥￥円]/g, ''));
  return isNaN(n) ? 0 : n;
}
function depCarryDay_(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate()).getTime();
  var m = String(v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
}
function depCarryCol_(H, kws) {
  for (var k = 0; k < kws.length; k++) for (var c = 0; c < H.length; c++) {
    if (String(H[c]).indexOf(kws[k]) >= 0) return c;
  }
  return -1;
}
function depositCarry(p, session) {
  var before = depCarryDay_(p.before);
  if (isNaN(before)) return { ok: false, error: 'before日付が不正です（YYYY-MM-DD）' };
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var list = configuredSheets(ss);
  var dailyName = null, depName = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].key === 'daily') dailyName = list[i].name;
    if (list[i].key === 'deposit') depName = list[i].name;
  }

  // ① 入金（全期間）→ 店舗ごとの「before より前の入金合計」＋ 全体の記録開始日
  var depStart = Infinity, depByStore = {};
  var depSh = depName ? ss.getSheetByName(depName) : null;
  if (depSh) {
    var dr = readSheet(depSh, 0, 'deposit'), dH = dr[0] || [];
    var dS = depCarryCol_(dH, ['店舗名', '店舗']), dD = depCarryCol_(dH, ['日付', '営業日', '入金日']), dA = depCarryCol_(dH, ['入金額', '入金合計', '入金']);
    for (var r = 1; r < dr.length; r++) {
      var t = depCarryDay_(dr[r][dD]); if (isNaN(t)) continue;
      if (t < depStart) depStart = t;
      if (t < before) { var st = String(dr[r][dS] || ''); depByStore[st] = (depByStore[st] || 0) + depCarryNum_(dr[r][dA]); }
    }
  }

  // ② 現金売上（全期間）→ 店舗ごとの「記録開始日以降〜before より前」の現金合計
  var cashByStore = {};
  var daySh = dailyName ? ss.getSheetByName(dailyName) : null;
  if (daySh) {
    var yr = readSheet(daySh, 0, 'daily'), yH = yr[0] || [];
    var yS = depCarryCol_(yH, ['店舗名', '店舗']), yD = depCarryCol_(yH, ['日付', '営業日', '勤務日', '年月日']), yC = depCarryCol_(yH, ['現金']);
    for (var r2 = 1; r2 < yr.length; r2++) {
      var t2 = depCarryDay_(yr[r2][yD]); if (isNaN(t2)) continue;
      if (t2 >= depStart && t2 < before) { var st2 = String(yr[r2][yS] || ''); cashByStore[st2] = (cashByStore[st2] || 0) + depCarryNum_(yr[r2][yC]); }
    }
  }

  // ③ 店舗ごとに [店舗名, 現金合計, 入金合計] で返す（正規化・スコープ絞りはクライアント側）
  var seen = {}, rows = [];
  for (var k in cashByStore) seen[k] = 1;
  for (var k2 in depByStore) seen[k2] = 1;
  for (var s in seen) rows.push([s, cashByStore[s] || 0, depByStore[s] || 0]);
  return { ok: true, before: p.before, depStart: isFinite(depStart) ? depStart : null, carry: rows };
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
    '明細店舗':   'SELECT store_id, SUM(sales_incl) AS sales, SUM(price_excl*qty) AS sales_excl, COUNT(DISTINCT check_id) AS checks FROM ' + BQ_TABLE + ' GROUP BY store_id ORDER BY sales DESC',
    // 取込カバレッジ（月ごとの店舗数・日数・行数）。薄い月＝取りこぼし/導入前を発見して再取得依頼に使う。
    '明細カバレッジ': "SELECT FORMAT_DATE('%Y-%m', business_date) AS month, COUNT(DISTINCT store_id) AS stores, COUNT(DISTINCT business_date) AS days, COUNT(*) AS rows FROM " + BQ_TABLE + ' GROUP BY month ORDER BY month'
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

// 店舗名→店舗ID（DB_店舗ID対応の逆引き）
function reverseStoreId_(name) { var m = bqStoreMap_(); for (var id in m) { if (m[id] === name) return id; } return null; }
// 文字列をMD5(16進32字)に短縮。CacheServiceのキー上限(250字)超えを防ぐ用。
function md5Hex_(s) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8);
  var h = ''; for (var i = 0; i < b.length; i++) { h += ('0' + (b[i] & 0xFF).toString(16)).slice(-2); }
  return h;
}
// 明細分析（対話的）：期間 from〜to・店舗で絞り、時間帯別/商品別/店舗別を集計して返す。
// guests=客数はお通し数ベースの推定（お通し=1人1品の慣習）。checks=会計数(組)。
function bqDetail(p, session) {
  var from = String(p.from || '').slice(0, 10), to = String(p.to || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { ok: false, error: 'bad date range' };
  var where = "WHERE business_date BETWEEN DATE('" + from + "') AND DATE('" + to + "')";
  // 権限：全店でないアカウント（店舗・担当店舗のみ）は、必ず担当店舗に限定する（明細の全店閲覧を防ぐ）
  var sessStores = String(session && session.stores || '').trim();
  var restricted = sessStores && sessStores !== '全店';
  var scopeKey = 'all';
  if (restricted) {
    var allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var mm = bqStoreMap_(), allowIds = [];
    for (var idk in mm) if (allowNames.indexOf(mm[idk]) >= 0) allowIds.push(idk);
    if (!allowIds.length) return { ok: true, hour: [], item: [], store: [], hourItem: [], note: '権限内の店舗なし' };
    scopeKey = allowIds.slice().sort().join('.');
    if (p.store && p.store !== 'all' && allowNames.indexOf(p.store) >= 0) {
      var one = reverseStoreId_(p.store);
      where += " AND store_id = '" + String(one).replace(/'/g, '') + "'";
    } else {
      where += " AND store_id IN ('" + allowIds.join("','") + "')"; // 担当店舗すべて（全店要求は拒否してここに落とす）
    }
  } else if (p.store && p.store !== 'all') {
    var id = reverseStoreId_(p.store);
    if (id) where += " AND store_id = '" + String(id).replace(/'/g, '') + "'";
    else return { ok: true, hour: [], item: [], store: [], note: 'store_id未対応' };
  }
  // 集計基準: checkout=会計時(既定) / order=オーダー時(各明細) / arrival=来店時(伝票の最初のオーダー)
  var basis = (p.basis === 'order' || p.basis === 'arrival') ? p.basis : 'checkout';
  // キャッシュ（同じ条件は再クエリしない・15分）。scopeKeyを含め、権限の違うユーザー間でキャッシュが混ざらないようにする。
  var cache = CacheService.getScriptCache();
  // 担当店舗が多いとscopeKey(店舗IDの連結)が長くなりキー上限250字を超える→MD5で短縮する
  var ckRaw = 'det_' + from + '_' + to + '_' + (p.store || 'all') + '_' + basis + '_' + scopeKey;
  var ck = ckRaw.length > 200 ? 'det_' + md5Hex_(ckRaw) : ckRaw;
  var hit = cache.get(ck);
  if (hit) { try { var o = JSON.parse(hit); o.cached = true; return o; } catch (e2) {} }
  var T = BQ_TABLE, G = "SUM(IF(menu LIKE '%お通し%', qty, 0)) AS guests";
  // 売上区分（税別）: コース=1800/人をドリンク・残りフード / サービス料=50%ずつ / カラオケ=全額 / 単品はキーワードでドリンク・他フード
  var L = 'price_excl*qty';
  var CAT = "CONCAT(IFNULL(category,''),'|',IFNULL(menu,''))";
  var IS_KARA = "menu LIKE '%カラオケ%'";
  var IS_SVC = "menu LIKE '%サービス料%'";
  var IS_COURSE = "(category LIKE '%コース%' OR category LIKE '%プラン%' OR menu LIKE '%コース%')";
  var DRINK_RE = "r'ビール|サワー|ハイボール|酎ハイ|チューハイ|ソフトドリンク|ドリンク|ワイン|日本酒|焼酎|カクテル|ウイスキー|ウィスキー|梅酒|レモン|ホッピー|果実酒|スパークリング|シャンパン|ノンアル|茶割|ハイ|飲み放題|飲放|生ビール|瓶ビール|グラス|ボトル|日本酒|酒'";
  var IS_DRINK = "REGEXP_CONTAINS(" + CAT + ", " + DRINK_RE + ")";
  var KARA = "SUM(CASE WHEN " + IS_KARA + " THEN " + L + " ELSE 0 END) AS karaoke";
  var DRINK = "SUM(CASE WHEN " + IS_KARA + " THEN 0 WHEN " + IS_SVC + " THEN (" + L + ")*0.5 WHEN " + IS_COURSE + " THEN LEAST(1800,price_excl)*qty WHEN " + IS_DRINK + " THEN " + L + " ELSE 0 END) AS drink";
  var FOOD = "SUM(CASE WHEN " + IS_KARA + " THEN 0 WHEN " + IS_SVC + " THEN (" + L + ")*0.5 WHEN " + IS_COURSE + " THEN GREATEST(price_excl-1800,0)*qty WHEN " + IS_DRINK + " THEN 0 ELSE " + L + " END) AS food";
  // 会計数（明細ベース・傾向把握用）。※ダッシュボードの「組数」はレジ準拠の日別売上シートを使用。
  var VCHK = "COUNT(DISTINCT check_id) AS checks";
  // 時間帯の集計元: 会計時=checkout_at / オーダー時=order_at / 来店時=伝票ごとのMIN(order_at)
  var hourFrom, hourCol;
  if (basis === 'arrival') {
    hourCol = 'arr';
    hourFrom = "(SELECT *, MIN(order_at) OVER (PARTITION BY store_id, business_date, check_id) AS arr FROM " + T + " " + where + ")";
  } else {
    hourCol = (basis === 'order') ? 'order_at' : 'checkout_at';
    hourFrom = T + " " + where;
  }
  // 時間帯×商品の出数（0円商品も含む）。出数上位40商品に絞って、時間帯ごとの出数・売上を返す。
  var topMenuSql = "SELECT menu FROM " + T + " " + where + " GROUP BY menu ORDER BY SUM(qty) DESC LIMIT 40";
  var hiFrom, hiWhere;
  if (basis === 'arrival') {
    hiFrom = hourFrom; // arr入りサブクエリ（where適用済み）
    hiWhere = "WHERE menu IN (" + topMenuSql + ")";
  } else {
    hiFrom = T;
    hiWhere = where + " AND menu IN (" + topMenuSql + ")";
  }
  try {
    var hour = bqRows_("SELECT EXTRACT(HOUR FROM " + hourCol + ") AS hour, SUM(sales_incl) AS sales, SUM(price_excl*qty) AS sales_excl, " + VCHK + ", " + G + ", SUM(qty) AS qty FROM " + hourFrom + " GROUP BY hour ORDER BY hour");
    var item = bqRows_("SELECT menu, SUM(sales_incl) AS sales, SUM(price_excl*qty) AS sales_excl, SUM(qty) AS qty FROM " + T + " " + where + " GROUP BY menu ORDER BY sales DESC LIMIT 2000"); // 500だと全店・月間で商品数が超過し0円商品などが丸ごと欠落する
    var st = bqRows_("SELECT store_id, SUM(sales_incl) AS sales, SUM(price_excl*qty) AS sales_excl, " + VCHK + ", " + G + ", " + DRINK + ", " + KARA + ", " + FOOD + " FROM " + T + " " + where + " GROUP BY store_id ORDER BY sales DESC");
    if (st) { var m = bqStoreMap_(); for (var r = 1; r < st.length; r++) st[r][0] = m[st[r][0]] || st[r][0]; if (st[0]) st[0][0] = '店舗'; }
    var hourItem = bqRows_("SELECT EXTRACT(HOUR FROM " + hourCol + ") AS hour, menu, SUM(qty) AS qty, SUM(sales_incl) AS sales FROM " + hiFrom + " " + hiWhere + " GROUP BY hour, menu");
    var res = { ok: true, hour: hour || [], item: item || [], store: st || [], hourItem: hourItem || [], basis: basis };
    try { cache.put(ck, JSON.stringify(res), 900); } catch (e3) { /* 100KB超はキャッシュしない */ }
    return res;
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
// 明細テーブルを日付パーティション＋店舗クラスタで作り直す（初回1回・スキャン量を激減させる）。
// ※BigQueryコンソールで下記SQLを1回実行するのと同じ。GASのタイムアウトを避けるなら手動SQL推奨。
function bqPartitionOrders() {
  return bqRows_("CREATE OR REPLACE TABLE `" + BQ_PROJECT + ".dinii.orders` PARTITION BY business_date CLUSTER BY store_id AS SELECT * FROM `" + BQ_PROJECT + ".dinii.orders`");
}

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
      maxBadRecords: 0, schema: { fields: BQ_ORDERS_SCHEMA } // 0=不正行があれば失敗させる（黙って捨てると出数が欠落する。数値は取込側で正規化済み）
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

// パフォーマンス計測：getData と同じ処理を段階ごとに時間計測して返す（データ本体は返さない）。
// 認証はBQ投入と同じ専用トークン。ログイン不要なので外部からも計測できる。
function perfDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String(p.token) !== tk) return { ok: false, error: 'unauthorized' };
  var months = Number(p.months) || 13;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var now = function () { return new Date().getTime(); };
  var T = { months: months }, t0 = now();
  // 1) 初期セットアップ（毎回handleで走る。存在チェックの束）
  var s = now(); setupIfNeeded(); T.setupIfNeeded = now() - s;
  // 2) 配信対象シートの解決
  s = now(); var list = configuredSheets(ss); T.configuredSheets = now() - s;
  // 3) ローカル各シートの読み込み（キーごとの内訳＋行数）
  var perSheet = {}; s = now();
  for (var i = 0; i < list.length; i++) {
    var s2 = now(); var sh = ss.getSheetByName(list[i].name);
    var rows = sh ? sh.getLastRow() : 0;
    if (sh) readSheet(sh, months, list[i].key);
    perSheet[list[i].key] = { ms: now() - s2, rows: rows };
  }
  T.localSheetsTotal = now() - s; T.perSheet = perSheet;
  // 4) 管理シート（別スプレッド24を openById で開く＋整備）
  s = now(); var mss = mgmtOpen(); T.mgmtOpen = now() - s;
  s = now(); if (mss) { try { mgmtEnsure(mss); } catch (e) {} } T.mgmtEnsure = now() - s;
  // 5) 管理シートの各タブ読み込み
  var perMgmt = {}; s = now();
  if (mss) for (var t = 0; t < MGMT_TABS.length; t++) {
    var s3 = now(); var msh = mgmtFindTab(mss, MGMT_TABS[t].re);
    var mr = (msh && msh.getLastRow() > 1) ? msh.getLastRow() : 0;
    if (mr) readSheet(msh, months, MGMT_TABS[t].key);
    perMgmt[MGMT_TABS[t].key] = { ms: now() - s3, rows: mr };
  }
  T.mgmtSheetsTotal = now() - s; T.perMgmt = perMgmt;
  // 6) BigQuery明細集計（キャッシュ有効。cache=falseで毎回実行）
  s = now(); bqDetailSheets_(null, null); T.bqDetailSheets = now() - s;
  // 7) dataVersion（Drive API 2回＝更新検知。version アクションで別途毎回呼ばれる）
  s = now(); dataVersion(); T.dataVersion = now() - s;
  T.grandTotal = now() - t0;
  return { ok: true, timing_ms: T, note: 'setupIfNeeded+configuredSheets+localSheets+mgmt+bq がdataアクション相当。dataVersionはversionアクションで毎回別途。' };
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
    return { id: a.id, name: a.name, role: a.role, stores: a.stores, active: a.active, memo: a.memo, tabs: a.tabs, perms: a.perms, position: a.position, hasPw: a.pw !== '' };
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
    (String(p.pw || '') ? pwEncode_(String(p.pw)) : (target ? target.pw : '')),   // 新パスワードは必ずハッシュ化
    String(p.name || (target ? target.name : id)),
    role,
    String(p.stores || (target ? target.stores : '全店')),
    (String(p.active || 'TRUE').toUpperCase() === 'FALSE') ? 'FALSE' : 'TRUE',
    String(p.memo || (target ? target.memo : '')),
    String(p.tabs != null ? p.tabs : (target ? target.tabs : '')),  // 表示タブ（空欄＝権限の既定）
    String(p.perms != null ? p.perms : (target ? target.perms : '')),  // 使える機能（空欄＝権限の既定）
    String(p.position != null ? p.position : (target ? target.position : ''))  // 役職
  ];
  if (!values[1]) return { ok: false, error: '新規アカウントにはパスワードが必要です' };

  if (target) sh.getRange(target.row, 1, 1, 10).setValues([values]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, 10).setValues([values]);
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

// ================== 目標（予実管理）とイベント ==================
// 権限：全店でないアカウントは担当店舗のみ編集可
function scopeAllows_(session, store) {
  var s = String(session && session.stores || '').trim();
  if (!s || s === '全店') return true;
  return s.split(/[,、]/).map(function (x) { return x.trim(); }).indexOf(store) >= 0;
}
// 目標保存：日別売上目標（DB_目標）＋月次目標（DB_目標月次）。対象月×店舗の行を差し替え（他は保持）
function saveTargets(p, session) {
  var store = String(p.store || '').trim();
  var month = String(p.month || '').trim();  // YYYY-MM
  if (!store || !/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'store/monthが不正です' };
  if (!scopeAllows_(session, store)) return { ok: false, error: 'この店舗の目標を編集する権限がありません' };
  var daily; try { daily = JSON.parse(p.daily || '[]'); } catch (e) { daily = []; }
  var y = Number(month.slice(0, 4)), mo = Number(month.slice(5, 7));
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // DB_目標（日別）
  var sh = ss.getSheetByName('DB_目標');
  var last = sh.getLastRow(), keep = [];
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
    if (r[0] === '') return;
    var d = (r[0] instanceof Date) ? r[0] : new Date(r[0]);
    var same = String(r[1]).trim() === store && d.getFullYear() === y && (d.getMonth() + 1) === mo;
    if (!same) keep.push(r);
  });
  var rows = [];
  daily.forEach(function (a) {
    var d = Number(a[0]), v = a[1];
    if (v === '' || v == null) return; v = Number(v);
    if (!(v > 0)) return;
    rows.push([new Date(y, mo - 1, d), store, v]);
  });
  var out = keep.concat(rows);
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).clearContent();
  if (out.length) { sh.getRange(2, 1, out.length, 3).setValues(out); sh.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d'); }
  // DB_目標月次
  var sm = ss.getSheetByName('DB_目標月次');
  var l2 = sm.getLastRow(), keep2 = [];
  if (l2 >= 2) sm.getRange(2, 1, l2 - 1, 7).getValues().forEach(function (r) {
    if (r[0] === '') return;
    var d = (r[0] instanceof Date) ? r[0] : new Date(r[0]);
    var same = String(r[1]).trim() === store && d.getFullYear() === y && (d.getMonth() + 1) === mo;
    if (!same) keep2.push(r);
  });
  var mvals = [p.pa, p.emp, p.cost, p.dinii, p.review].map(function (v) { v = String(v == null ? '' : v).trim(); return v === '' ? 0 : (Number(v) || 0); });
  var hasM = mvals.some(function (v) { return v > 0; });
  var out2 = keep2.slice();
  if (hasM) out2.push([new Date(y, mo - 1, 1), store, mvals[0], mvals[1], mvals[2], mvals[3], mvals[4]]);
  if (l2 >= 2) sm.getRange(2, 1, l2 - 1, 7).clearContent();
  if (out2.length) { sm.getRange(2, 1, out2.length, 7).setValues(out2); sm.getRange(2, 1, out2.length, 1).setNumberFormat('yyyy/m/d'); }
  return { ok: true, dailyRows: rows.length, monthly: hasM };
}
// 日別売上目標を1日だけ更新（日別予実テーブルの「編集」から）。月次目標や他日には触れない。
// goalが空/0なら該当日の行を削除、正数なら更新（無ければ追加）。
function saveTargetDay(p, session) {
  var store = String(p.store || '').trim();
  var date = String(p.date || '').trim();  // YYYY-MM-DD
  if (!store || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'store/dateが不正です' };
  if (!scopeAllows_(session, store)) return { ok: false, error: 'この店舗の目標を編集する権限がありません' };
  var gv = String(p.goal == null ? '' : p.goal).trim();
  var goal = gv === '' ? 0 : (Number(gv) || 0);
  var parts = date.split('-'), y = Number(parts[0]), mo = Number(parts[1]), da = Number(parts[2]);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('DB_目標');
  if (!sh) return { ok: false, error: 'DB_目標シートがありません' };
  var last = sh.getLastRow(), foundRow = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < vals.length; i++) {
      var r = vals[i]; if (r[0] === '') continue;
      var d = (r[0] instanceof Date) ? r[0] : new Date(r[0]);
      if (String(r[1]).trim() === store && d.getFullYear() === y && (d.getMonth() + 1) === mo && d.getDate() === da) { foundRow = 2 + i; break; }
    }
  }
  if (goal > 0) {
    if (foundRow > 0) { sh.getRange(foundRow, 3).setValue(goal); }
    else { var nr = sh.getLastRow() + 1; sh.getRange(nr, 1, 1, 3).setValues([[new Date(y, mo - 1, da), store, goal]]); sh.getRange(nr, 1).setNumberFormat('yyyy/m/d'); }
  } else if (foundRow > 0) {
    sh.deleteRow(foundRow);
  }
  return { ok: true, goal: goal };
}
// イベント保存（ID一致なら更新・無ければ追加）。対象店舗はカンマ区切りで保存し、その店舗の画面にだけ表示される。
function saveEvent(p, session) {
  var date = String(p.date || '').trim(), name = String(p.name || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !name) return { ok: false, error: '日付とイベント名が必要です' };
  var id = String(p.id || '').trim() || Utilities.getUuid().slice(0, 8);
  var venue = String(p.venue || '').trim(), stores = String(p.stores || '').trim(), memo = String(p.memo || '').trim();
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_イベント');
  var d = date.split('-');
  var row = [id, new Date(Number(d[0]), Number(d[1]) - 1, Number(d[2])), name, venue, stores, memo];
  var last = sh.getLastRow(), found = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === id) { found = i + 2; break; }
  }
  var target = found > 0 ? found : last + 1;
  sh.getRange(target, 1, 1, 6).setValues([row]);
  sh.getRange(target, 2).setNumberFormat('yyyy/m/d');
  return { ok: true, id: id };
}
function deleteEvent(p, session) {
  var id = String(p.id || '').trim(); if (!id) return { ok: false, error: 'idが必要です' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_イベント');
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === id) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: false, error: '該当イベントが見つかりません' };
}

// ================== 入金取込（口座CSV → 入金DB） ==================
// 売上DBスプレッドシート（CSV取込_入金 の親）。ダッシュボードから取り込んだ入金は
// ここにも書き込んで、既存の「CSV取込_入金に貼り付け」運用と同じ状態を保つ。
var SALES_DB_ID = '1z_22yVxPRo7cpL9A4nluYzXbQ9FH_zFk9Mb5gHiOF3E';
// 入金DBシートのヘッダー行（1列目が「店舗」の行）を探す。売上DB側は1行目がタイトル・2行目が見出し。
function depositHeaderRow_(sh) {
  var scan = Math.min(sh.getLastRow(), 5);
  if (scan < 1) return -1;
  var v = sh.getRange(1, 1, scan, 1).getValues();
  for (var r = 0; r < scan; r++) { if (String(v[r][0]).trim() === '店舗') return r + 1; }
  return -1;
}
// 店舗名の正規化（売上DB側の既存スクリプト _normStoreName と同一ルール）。
// スペース違いを吸収し、登録した店舗だけ正解表記に統一。登録外はトリムのみ。
var STORE_CANONICAL_BY_NOSPACE_ = {
  '横濱ホルモン会館エース本厚木店': '横濱ホルモン会館　エース　本厚木店',
  'うお蔵新横浜店': '黒霧屋 新横浜'
};
function normStoreName_(s) {
  var t = String(s == null ? '' : s).trim();
  var nospace = t.replace(/[\s　]/g, '');
  return STORE_CANONICAL_BY_NOSPACE_[nospace] || t;
}
// 広告側の店舗名（⚙️店舗マスタの「匠味（新横浜）」等）を、売上側の店舗名へ解決する。
// DB_店舗名対応（別表記→正式名）→ DB_店舗親子（子ブランド→親店舗）の順に引く。
// 解決できなければ元の名前を返す。※権限チェックのために使う。
function resolveAdStore_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cur = String(name == null ? '' : name).trim();
  if (!cur) return '';
  function lookup(sheetName) {
    var sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return null;
    var v = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
    var key = storeKey_(cur);
    for (var i = 0; i < v.length; i++) {
      var a = String(v[i][0]).trim(), b = String(v[i][1]).trim();
      if (!a || !b) continue;
      if (storeKey_(a) === key && storeKey_(b) !== key) return b;   // 左＝別表記/子 → 右＝正式/親
    }
    return null;
  }
  var mapped = lookup('DB_店舗名対応');
  if (mapped) cur = mapped;
  var parent = lookup('DB_店舗親子');
  if (parent) cur = parent;
  return cur;
}
// 広告関連（広告費・売上）の権限判定。広告側の店舗名でも、解決後の売上店舗で担当かどうかを見る。
function adScopeAllows_(session, name) {
  if (scopeAllows_(session, name)) return true;
  var resolved = resolveAdStore_(name);
  return resolved && resolved !== name ? scopeAllows_(session, resolved) : false;
}
// 入金管理タブの「口座CSVを取込」から呼ばれる。rows=[[YYYY-MM-DD, 入金額, 摘要, 識別トークン],...]
// 識別トークン＝入金DBのE列（取引時刻）。フロント(depTokenize)が 取引時刻／残高{n}／#出現順 の順で決定済み。
// 売上DB側の既存スクリプト(importBankDepositCSV)と完全に同じ 6列構成・同じ重複キーで追記する：
//   入金DB列: A店舗 B日付 C入金額 D摘要 E取引時刻 F取込日時
//   重複キー: 店舗__日付__取引時刻(トークン)__金額  ← 既存スクリプトと一致するので相互に重複しない
function importDeposits(p, session) {
  var store = normStoreName_(p.store);
  if (!store) return { ok: false, error: '店舗が未指定です' };
  if (!scopeAllows_(session, p.store)) return { ok: false, error: 'この店舗の入金を取り込む権限がありません' };
  var rows; try { rows = JSON.parse(p.rows || '[]'); } catch (e) { rows = []; }
  if (!rows.length) return { ok: false, error: '取込対象の行がありません' };
  if (rows.length > 3000) return { ok: false, error: '一度に取り込めるのは3000行までです' };
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  var now = new Date();
  // 取込先: ①売上DB（既存運用の本体） ②このスプレッドシート（ダッシュボードの配信元）。
  // ②がIMPORTRANGE等の数式（＝売上DBから自動同期）なら追記しない（数式を壊さない）。
  var targets = [];
  try {
    var src = SpreadsheetApp.openById(SALES_DB_ID).getSheetByName('入金DB');
    if (src) targets.push({ label: '売上DB', sh: src });
  } catch (e) { /* 権限が無い場合はダッシュボード側のみ */ }
  var dst = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('入金DB');
  if (dst && !String(dst.getRange(1, 1).getFormula() || '')) targets.push({ label: 'ダッシュボード', sh: dst });
  if (!targets.length) return { ok: false, error: '入金DBシートが見つかりません' };
  // 既存セル値の正規化（Date/数値/文字列が混在し得るため、キー化して重複判定する）
  function dKey(v) {
    if (v instanceof Date) return v.getFullYear() + '/' + (v.getMonth() + 1) + '/' + v.getDate();
    var m = String(v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m ? (+m[1]) + '/' + (+m[2]) + '/' + (+m[3]) : String(v);
  }
  function tKey(v) {   // 既存スクリプト _normTime と同じ（時刻型に化けても文字列比較を一致させる）
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'HH:mm:ss');
    return String(v == null ? '' : v).trim();
  }
  function aKey(v) { return String(Number(String(v).replace(/[,¥\s]/g, '')) || 0); }
  var added = 0, dup = 0, detail = {};
  targets.forEach(function (t, ti) {
    var sh = t.sh;
    var head = depositHeaderRow_(sh);
    if (head < 0) { detail[t.label] = 'ヘッダー行なし'; return; }
    var last = sh.getLastRow();
    var exist = {};
    if (last > head) {
      var v = sh.getRange(head + 1, 1, last - head, 6).getValues();
      for (var i = 0; i < v.length; i++) {
        if (String(v[i][0]).trim() === '') continue;
        // 既存スクリプトと同じキー: 店舗+日付+取引時刻+金額
        exist[normStoreName_(v[i][0]) + '__' + dKey(v[i][1]) + '__' + tKey(v[i][4]) + '__' + aKey(v[i][2])] = 1;
      }
    }
    var out = [], skipped = 0;
    rows.forEach(function (a) {
      var m = String(a[0]).match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return;
      var amt = Number(a[1]) || 0; if (!(amt > 0)) return;
      var desc = String(a[2] || '').slice(0, 100), tok = String(a[3] == null ? '' : a[3]).trim();
      var key = store + '__' + ((+m[1]) + '/' + (+m[2]) + '/' + (+m[3])) + '__' + tok + '__' + amt;
      if (exist[key]) { skipped++; return; }
      exist[key] = 1;
      out.push([store, new Date(+m[1], +m[2] - 1, +m[3]), amt, desc, tok, now]);
    });
    if (out.length) {
      var r0 = sh.getLastRow() + 1;
      sh.getRange(r0, 5, out.length, 1).setNumberFormat('@'); // E列(取引時刻)は文字列固定（時刻型変換による重複バグ防止）
      sh.getRange(r0, 1, out.length, 6).setValues(out);
      sh.getRange(r0, 2, out.length, 1).setNumberFormat('yyyy/m/d');
      sh.getRange(r0, 3, out.length, 1).setNumberFormat('#,##0');
      sh.getRange(r0, 6, out.length, 1).setNumberFormat('yyyy/m/d HH:mm');
    }
    detail[t.label] = out.length + '件追加' + (skipped ? '（重複' + skipped + '件スキップ）' : '');
    if (ti === 0) { added = out.length; dup = skipped; }
  });
  return { ok: true, added: added, dup: dup, detail: detail };
}

// ================== 手入力の反映（PL経費・広告費・予約CSV） ==================
// PL管理システム（✍販管費入力＝手入力経費の本体）。ダッシュボードからの経費入力はここにも書いて、
// PL側の「DB_PLへ転記」を後で実行しても消えない状態を保つ。
var PL_SYSTEM_ID = '1ZJ5a3ZgsRGfJHVhIXo2b-OK-2gZMvUAHl7J9WFms7dQ';
var PL_INPUT_SHEET = '✍ 販管費入力';
var PL_AUTO_MEMO = '媒体販促費（自動計上）';   // PL側トリガーが管理する自動行のマーカー（触らない）
// 年月の正規化（Date/『2026/7』/『2026-07』→ 'YYYY/MM'）
function ymOf_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy/MM');
  var m = String(v).match(/(\d{4})[\/\-年\.]\s*(\d{1,2})/);
  return m ? m[1] + '/' + ('0' + m[2]).slice(-2) : String(v);
}
// 店舗名の照合キー（スペース・括弧などの記号を全部除去）。管理シートの「黒霧屋（新横浜）」と
// ダッシュボードの「黒霧屋 新横浜」のような表記違いを吸収する。
function storeKey_(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/[^0-9A-Za-z぀-ヿ㐀-鿿豈-﫿]/g, '').toLowerCase();
}
// ダッシュボードの店舗名 → 管理シート（⚙️店舗マスタ）の表記へ変換。一致が無ければそのまま返す。
function mgmtStoreName_(mss, dashName) {
  try {
    var sh = mgmtFindTab(mss, /店舗マスタ/);
    if (sh && sh.getLastRow() > 1) {
      var v = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues(); // B列=店舗名
      var key = storeKey_(dashName);
      for (var i = 0; i < v.length; i++) { var nm = String(v[i][0]).trim(); if (nm && storeKey_(nm) === key) return nm; }
    }
  } catch (e) {}
  return dashName;
}

// PL経費の保存：対象月×店舗の手入力行を丸ごと差し替え。entries=[[科目,区分,金額,メモ],...]
// 反映先: ①このスプレッドシートのDB_PL（ダッシュボード表示用・AUTO行は保持）
//        ②PL管理システムの「✍ 販管費入力」（手入力の本体。D列の区分式は触らない）
// store='__common__' は全社共通（DB_PLでは店舗空欄／PL側では『本社・共通』）。社長・本部のみ。
function savePlEntries(p, session) {
  var ym = String(p.ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: '対象月が不正です' };
  var isCommon = String(p.store) === '__common__';
  if (isCommon && !isAdmin(session)) return { ok: false, error: '全社共通経費は社長・本部のみ入力できます' };
  var store = isCommon ? '' : String(p.store || '').trim();
  if (!isCommon) {
    if (!store) return { ok: false, error: '店舗が未指定です' };
    if (!scopeAllows_(session, store)) return { ok: false, error: 'この店舗の経費を編集する権限がありません' };
  }
  var entries; try { entries = JSON.parse(p.entries || '[]'); } catch (e) { entries = []; }
  var clean = [];
  entries.forEach(function (a) {
    var item = String(a[0] || '').trim().slice(0, 60);
    var cat = String(a[1] || 'O').trim().toUpperCase();
    if (['S', 'F', 'L', 'A', 'R', 'O', 'X'].indexOf(cat) < 0) cat = 'O';
    var amt = Number(a[2]) || 0;
    var memo = String(a[3] || '').trim().slice(0, 100);
    if (item && amt > 0) clean.push([item, cat, amt, memo]);
  });
  if (clean.length > 300) return { ok: false, error: '一度に保存できるのは300行までです' };
  var y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);
  // ① DB_PL（対象月×店舗の行を差し替え。媒体販促費（自動計上）は保持）
  var dp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!dp) return { ok: false, error: 'DB_PLシートがありません' };
  var dlast = dp.getLastRow(), keep = [];
  if (dlast >= 2) {
    dp.getRange(2, 1, dlast - 1, 6).getValues().forEach(function (r) {
      if (r[0] === '' && r[1] === '' && r[2] === '') return;
      var same = ymOf_(r[0]) === ymSlash && String(r[1]).trim() === store;
      if (same && String(r[5]) !== PL_AUTO_MEMO) return;   // 差し替え対象は捨てる
      keep.push(r);
    });
  }
  var out = keep.concat(clean.map(function (a) { return [new Date(y, mo - 1, 1), store, a[0], a[1], a[2], a[3]]; }));
  if (dlast >= 2) dp.getRange(2, 1, dlast - 1, 6).clearContent();
  if (out.length) { dp.getRange(2, 1, out.length, 6).setValues(out); dp.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d'); }
  // ② PL管理システム ✍販管費入力（A年月/B店舗/C科目/E金額/Fメモ。D列の式は触らない）
  var plsys = '';
  try {
    var psh = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (psh) {
      var plStore = isCommon ? '本社・共通' : store;
      var lastR = psh.getLastRow(), n = Math.max(lastR - 2, 0);   // データは3行目から（D列の式で行数は伸びている）
      var A = n > 0 ? psh.getRange(3, 1, n, 3).getValues() : [];
      var E = n > 0 ? psh.getRange(3, 5, n, 2).getValues() : [];
      var keepP = [];
      for (var i = 0; i < n; i++) {
        if (String(A[i][0]) === '' && String(A[i][2]) === '') continue;                 // 空行
        if (ymOf_(A[i][0]) === ymSlash && String(A[i][1]).trim() === plStore) continue; // 差し替え対象
        keepP.push([A[i][0], A[i][1], A[i][2], E[i][0], E[i][1]]);
      }
      clean.forEach(function (a) { keepP.push([ymSlash, plStore, a[0], a[2], a[3] || 'ダッシュボードから入力']); });
      if (n > 0) { psh.getRange(3, 1, n, 3).clearContent(); psh.getRange(3, 5, n, 2).clearContent(); }
      if (keepP.length) {
        psh.getRange(3, 1, keepP.length, 3).setValues(keepP.map(function (r) { return [r[0], r[1], r[2]]; }));
        psh.getRange(3, 5, keepP.length, 2).setValues(keepP.map(function (r) { return [r[3], r[4]]; }));
      }
      plsys = 'PL管理システムにも反映しました';
    } else plsys = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (e) { plsys = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(e && e.message || e); }
  return { ok: true, saved: clean.length, plsys: plsys };
}

// 広告費の保存：管理シートの💾広告費DBへ upsert（キー=年月×店舗×媒体×プラン・同一キー上書き）。
// 金額が空/0なら該当行を削除。列構成は既存のまま（年月|店舗|媒体|プラン|広告費|入力日|更新日|備考|キー）。
// ダッシュボードの広告データは💾広告費DB由来（getDataで管理シート優先）なので、これだけで両方に反映される。
function saveAdFee(p, session) {
  var ym = String(p.ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: '対象月が不正です' };
  var dashStore = String(p.store || '').trim();
  if (!dashStore) return { ok: false, error: '店舗が未指定です' };
  if (!adScopeAllows_(session, dashStore)) return { ok: false, error: 'この店舗の広告費を編集する権限がありません' };
  var media = String(p.media || '').trim().slice(0, 40);
  if (!media) return { ok: false, error: '媒体を入力してください' };
  var plan = String(p.plan || '').trim().slice(0, 40) || '一式';
  var costRaw = String(p.cost == null ? '' : p.cost).trim();
  var cost = costRaw === '' ? 0 : (Number(costRaw.replace(/[,¥\s]/g, '')) || 0);
  var memo = String(p.memo || '').trim().slice(0, 100);
  var mss = mgmtOpen();
  if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  var sh = mgmtFindTab(mss, /広告費DB/);
  if (!sh) return { ok: false, error: '管理シートに💾広告費DBタブが見つかりません' };
  // ヘッダー行と「年月」列の位置を検出（A列が空でB列始まりのレイアウトに対応）
  var scan = sh.getRange(1, 1, Math.min(sh.getLastRow(), 6), Math.min(sh.getLastColumn(), 12)).getValues();
  var hr = -1, c0 = -1;
  for (var r = 0; r < scan.length && hr < 0; r++) {
    for (var c = 0; c < scan[r].length; c++) {
      if (String(scan[r][c]).trim() === '年月') { hr = r + 1; c0 = c + 1; break; }
    }
  }
  if (hr < 0) return { ok: false, error: '💾広告費DBの見出し行（年月）が見つかりません' };
  // 対象月リスト（ymTo指定で期間一括。例 2026-01〜2026-12 → 12ヶ月分を同条件でupsert）
  var ymTo = String(p.ymTo || '').trim();
  var mlist = [];
  {
    var y1 = +ym.slice(0, 4), m1 = +ym.slice(5, 7);
    var y2 = y1, m2 = m1;
    if (ymTo) {
      if (!/^\d{4}-\d{2}$/.test(ymTo)) return { ok: false, error: '終了月が不正です' };
      y2 = +ymTo.slice(0, 4); m2 = +ymTo.slice(5, 7);
    }
    var nMon = (y2 - y1) * 12 + (m2 - m1) + 1;
    if (nMon < 1) return { ok: false, error: '終了月が開始月より前です' };
    if (nMon > 36) return { ok: false, error: '期間一括は36ヶ月までです' };
    for (var mi = 0; mi < nMon; mi++) { var yy = y1 + Math.floor((m1 - 1 + mi) / 12), mm = (m1 - 1 + mi) % 12 + 1; mlist.push(yy + '/' + ('0' + mm).slice(-2)); }
  }
  var store = mgmtStoreName_(mss, dashStore);   // 管理シートの店舗マスタ表記へ変換
  var now = new Date();
  var last = sh.getLastRow();
  var v = last > hr ? sh.getRange(hr + 1, c0, last - hr, 4).getValues() : [];  // 年月|店舗|媒体|プラン
  var foundBy = {};   // ymSlash → 行番号
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]) === '' && String(v[i][1]) === '') continue;
    if (storeKey_(v[i][1]) === storeKey_(store) && String(v[i][2]).trim() === media && String(v[i][3]).trim() === plan) {
      foundBy[ymOf_(v[i][0])] = hr + 1 + i;
    }
  }
  if (cost <= 0) {   // 削除（該当月の行を下から順に削除）
    var delRows = mlist.map(function (ms) { return foundBy[ms]; }).filter(function (r) { return r > 0; });
    if (!delRows.length) return { ok: false, error: '削除対象（' + store + '×' + media + '×' + plan + '）が見つかりません' };
    delRows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
    return { ok: true, deleted: true, months: delRows.length };
  }
  var appendRows = [];
  mlist.forEach(function (ms) {
    var key = ms + '_' + store + '_' + media + '_' + plan;
    var fr = foundBy[ms];
    if (fr > 0) {   // 上書き（広告費・更新日・備考・キー）
      sh.getRange(fr, c0 + 4).setValue(cost).setNumberFormat('#,##0');
      sh.getRange(fr, c0 + 6).setValue(now).setNumberFormat('yyyy/mm/dd');
      sh.getRange(fr, c0 + 7).setValue(memo);
      sh.getRange(fr, c0 + 8).setValue(key);
    } else {
      appendRows.push([ms, store, media, plan, cost, now, now, memo, key]);
    }
  });
  if (appendRows.length) {
    var nr = sh.getLastRow() + 1;
    sh.getRange(nr, c0, appendRows.length, 9).setValues(appendRows);
    sh.getRange(nr, c0 + 4, appendRows.length, 1).setNumberFormat('#,##0');
    sh.getRange(nr, c0 + 5, appendRows.length, 2).setNumberFormat('yyyy/mm/dd');
  }
  return { ok: true, months: mlist.length, added: appendRows.length, updated: mlist.length - appendRows.length };
}

// PL経費の期間一括計上：開始月〜終了月の各月に 店舗×科目 の行を作成（既存の同科目行は差し替え）。
// 金額が空/0なら期間内のその科目の行を削除。DB_PLとPL管理システム（✍販管費入力）の両方に反映。
function savePlBulk(p, session) {
  var ym1 = String(p.ym1 || '').trim(), ym2 = String(p.ym2 || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym1) || !/^\d{4}-\d{2}$/.test(ym2)) return { ok: false, error: '開始月・終了月が不正です' };
  var isCommon = String(p.store) === '__common__';
  if (isCommon && !isAdmin(session)) return { ok: false, error: '全社共通経費は社長・本部のみ入力できます' };
  var store = isCommon ? '' : String(p.store || '').trim();
  if (!isCommon) {
    if (!store) return { ok: false, error: '店舗が未指定です' };
    if (!scopeAllows_(session, store)) return { ok: false, error: 'この店舗の経費を編集する権限がありません' };
  }
  var item = String(p.item || '').trim().slice(0, 60);
  if (!item) return { ok: false, error: '勘定科目が未指定です' };
  var cat = String(p.cat || 'O').trim().toUpperCase();
  if (['S', 'F', 'L', 'A', 'R', 'O', 'X'].indexOf(cat) < 0) cat = 'O';
  var amtRaw = String(p.amount == null ? '' : p.amount).trim();
  var amount = amtRaw === '' ? 0 : (Number(amtRaw.replace(/[,¥\s]/g, '')) || 0);
  var memo = String(p.memo || '').trim().slice(0, 100);
  var y1 = +ym1.slice(0, 4), m1 = +ym1.slice(5, 7), y2 = +ym2.slice(0, 4), m2 = +ym2.slice(5, 7);
  var n = (y2 - y1) * 12 + (m2 - m1) + 1;
  if (n < 1) return { ok: false, error: '終了月が開始月より前です' };
  if (n > 36) return { ok: false, error: '一括計上できるのは36ヶ月までです' };
  var months = {}, list = [];
  for (var i = 0; i < n; i++) { var yy = y1 + Math.floor((m1 - 1 + i) / 12), mm = (m1 - 1 + i) % 12 + 1; var ms = yy + '/' + ('0' + mm).slice(-2); months[ms] = 1; list.push([yy, mm, ms]); }
  // ① DB_PL：期間内の 店舗×科目 行（AUTO以外）を除去 → 金額>0なら各月分を追加
  var dp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!dp) return { ok: false, error: 'DB_PLシートがありません' };
  var dlast = dp.getLastRow(), keep = [];
  if (dlast >= 2) {
    dp.getRange(2, 1, dlast - 1, 6).getValues().forEach(function (r) {
      if (r[0] === '' && r[1] === '' && r[2] === '') return;
      if (months[ymOf_(r[0])] && String(r[1]).trim() === store && String(r[2]).trim() === item && String(r[5]) !== PL_AUTO_MEMO) return;
      keep.push(r);
    });
  }
  var out = keep.slice();
  if (amount > 0) list.forEach(function (mo) { out.push([new Date(mo[0], mo[1] - 1, 1), store, item, cat, amount, memo]); });
  if (dlast >= 2) dp.getRange(2, 1, dlast - 1, 6).clearContent();
  if (out.length) { dp.getRange(2, 1, out.length, 6).setValues(out); dp.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d'); }
  // ② PL管理システム ✍販管費入力：同じ差し替え（D列の区分式は触らない）
  var plsys = '';
  try {
    var psh = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (psh) {
      var plStore = isCommon ? '本社・共通' : store;
      var lastR = psh.getLastRow(), nR = Math.max(lastR - 2, 0);
      var A = nR > 0 ? psh.getRange(3, 1, nR, 3).getValues() : [];
      var E = nR > 0 ? psh.getRange(3, 5, nR, 2).getValues() : [];
      var keepP = [];
      for (var i2 = 0; i2 < nR; i2++) {
        if (String(A[i2][0]) === '' && String(A[i2][2]) === '') continue;
        if (months[ymOf_(A[i2][0])] && String(A[i2][1]).trim() === plStore && String(A[i2][2]).trim() === item) continue;
        keepP.push([A[i2][0], A[i2][1], A[i2][2], E[i2][0], E[i2][1]]);
      }
      if (amount > 0) list.forEach(function (mo) { keepP.push([mo[2], plStore, item, amount, memo || 'ダッシュボードから一括計上']); });
      if (nR > 0) { psh.getRange(3, 1, nR, 3).clearContent(); psh.getRange(3, 5, nR, 2).clearContent(); }
      if (keepP.length) {
        psh.getRange(3, 1, keepP.length, 3).setValues(keepP.map(function (r) { return [r[0], r[1], r[2]]; }));
        psh.getRange(3, 5, keepP.length, 2).setValues(keepP.map(function (r) { return [r[3], r[4]]; }));
      }
      plsys = 'PL管理システムにも反映しました';
    } else plsys = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (e) { plsys = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(e && e.message || e); }
  return { ok: true, months: n, deleted: amount <= 0, plsys: plsys };
}

// 売上・反響の保存：管理シートの💾売上DBへ upsert（キー＝年月×店舗×媒体・同一キーは上書き）。
// 列は既存のまま（年月|店舗|媒体|集客手数料|アクセス数|NET件数|NET人数|TEL件数|TEL人数|総組数|総人数|総売上（円）|入力日|更新日|備考|キー|電話数）。
// ダッシュボードは「電話数」列を電話件数として読むため、TEL件数と同じ値を電話数列にも書いて整合させる。
// ※ダッシュボードの表示項目・予想売上の計算式は変更しない（この関数はシートに値を書くだけ）。
function saveAdSales(p, session) {
  var ym = String(p.ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: '対象月が不正です' };
  var dashStore = String(p.store || '').trim();
  if (!dashStore) return { ok: false, error: '店舗が未指定です' };
  if (!adScopeAllows_(session, dashStore)) return { ok: false, error: 'この店舗の売上を編集する権限がありません' };
  var media = String(p.media || '').trim().slice(0, 40);
  if (!media) return { ok: false, error: '媒体を選択してください' };
  var vals; try { vals = JSON.parse(p.values || '{}'); } catch (e) { vals = {}; }
  function n_(k) { var s = String(vals[k] == null ? '' : vals[k]).replace(/[,¥\s]/g, '').trim(); return s === '' ? 0 : (Number(s) || 0); }
  var mss = mgmtOpen();
  if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  mgmtEnsure(mss);   // 電話数列などが無ければ整える
  var sh = mgmtFindTab(mss, /売上DB/);
  if (!sh) return { ok: false, error: '管理シートに💾売上DBタブが見つかりません' };
  // 見出し行を検出し、列位置を名前で解決（A列が空でB列始まりのレイアウトに対応）
  var scanR = Math.min(sh.getLastRow(), 8), scanC = Math.max(sh.getLastColumn(), 18);
  var grid = sh.getRange(1, 1, scanR, scanC).getValues();
  var hr = -1;
  for (var r = 0; r < grid.length; r++) { if (grid[r].join(',').indexOf('アクセス') >= 0) { hr = r + 1; break; } }
  if (hr < 0) return { ok: false, error: '💾売上DBの見出し行（アクセス数）が見つかりません' };
  var H = grid[hr - 1].map(function (h) { return String(h).trim(); });
  function ci(names) {
    for (var i = 0; i < names.length; i++) { var e = H.indexOf(names[i]); if (e >= 0) return e + 1; }
    for (var j = 0; j < names.length; j++) { for (var c = 0; c < H.length; c++) { if (H[c].indexOf(names[j]) >= 0) return c + 1; } }
    return -1;
  }
  var col = {
    ym: ci(['年月']), store: ci(['店舗']), media: ci(['媒体']), fee: ci(['集客手数料']),
    access: ci(['アクセス数', 'アクセス']), netGrp: ci(['NET件数']), netPpl: ci(['NET人数']),
    telCnt: ci(['TEL件数']), telPpl: ci(['TEL人数']), totGrp: ci(['総組数']), totPpl: ci(['総人数']),
    totSales: ci(['総売上（円）', '総売上']), inDate: ci(['入力日']), upDate: ci(['更新日']),
    memo: ci(['備考']), key: ci(['キー']), tel2: ci(['電話数'])
  };
  if (col.ym < 0 || col.store < 0 || col.media < 0) return { ok: false, error: '💾売上DBの列（年月・店舗・媒体）が見つかりません' };
  var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);
  var store = mgmtStoreName_(mss, dashStore);
  var last = sh.getLastRow(), found = -1;
  if (last > hr) {
    var v = sh.getRange(hr + 1, 1, last - hr, sh.getLastColumn()).getValues();
    for (var i = 0; i < v.length; i++) {
      var rr = v[i];
      if (String(rr[col.ym - 1]) === '' && String(rr[col.store - 1]) === '') continue;
      if (ymOf_(rr[col.ym - 1]) === ymSlash && storeKey_(rr[col.store - 1]) === storeKey_(store) &&
          String(rr[col.media - 1]).trim() === media) { found = hr + 1 + i; break; }
    }
  }
  var now = new Date();
  var key = ymSlash + '_' + store + '_' + media;
  var telCnt = n_('telCnt');
  // 書き込む値（列が存在するものだけ）
  var put = [
    [col.fee, n_('fee'), '#,##0'], [col.access, n_('access'), '#,##0'],
    [col.netGrp, n_('netGrp'), '#,##0'], [col.netPpl, n_('netPpl'), '#,##0'],
    [col.telCnt, telCnt, '#,##0'], [col.telPpl, n_('telPpl'), '#,##0'],
    [col.totGrp, n_('totGrp'), '#,##0'], [col.totPpl, n_('totPpl'), '#,##0'],
    [col.totSales, n_('totSales'), '#,##0'], [col.tel2, telCnt, '#,##0'],
    [col.upDate, now, 'yyyy/mm/dd'], [col.key, key, null]
  ];
  var row = found;
  if (row < 0) {   // 新規追加：まずキー列を書いてから各値
    row = sh.getLastRow() + 1;
    sh.getRange(row, col.ym).setValue(ymSlash);
    sh.getRange(row, col.store).setValue(store);
    sh.getRange(row, col.media).setValue(media);
    if (col.inDate > 0) sh.getRange(row, col.inDate).setValue(now).setNumberFormat('yyyy/mm/dd');
  }
  put.forEach(function (a) {
    if (a[0] > 0) { var rg = sh.getRange(row, a[0]); rg.setValue(a[1]); if (a[2]) rg.setNumberFormat(a[2]); }
  });
  return { ok: true, updated: found > 0, row: row, store: store, media: media };
}

// 予約CSVの取込：管理シートの💾予約DBへ追記。rows=[[予約No,来店日,来店時間,人数,ステータス,受付窓口,作成日,作成時間],...]
// 重複判定＝店舗＋来店日＋来店時間＋人数＋受付窓口＋作成日＋作成時間の全一致（同じCSVを2回取り込んでも安全）。
function importReservations(p, session) {
  var dashStore = String(p.store || '').trim();
  if (!dashStore) return { ok: false, error: '店舗が未指定です' };
  if (!scopeAllows_(session, dashStore)) return { ok: false, error: 'この店舗の予約を取り込む権限がありません' };
  var rows; try { rows = JSON.parse(p.rows || '[]'); } catch (e) { rows = []; }
  if (!rows.length) return { ok: false, error: '取込対象の行がありません' };
  if (rows.length > 5000) return { ok: false, error: '一度に取り込めるのは5000行までです' };
  var mss = mgmtOpen();
  if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  if (mss) mgmtEnsure(mss);   // 💾予約DBが無ければ雛形を自動作成
  var sh = mgmtFindTab(mss, /予約DB|予約明細|予約一覧/);
  if (!sh) return { ok: false, error: '管理シートに💾予約DBタブが見つかりません' };
  // ヘッダー行と列位置を名前で解決
  var scan = sh.getRange(1, 1, Math.min(sh.getLastRow(), 6), Math.max(sh.getLastColumn(), 9)).getValues();
  var hr = -1;
  for (var r = 0; r < scan.length; r++) { if (scan[r].join(',').indexOf('来店日') >= 0) { hr = r + 1; break; } }
  if (hr < 0) return { ok: false, error: '💾予約DBの見出し行（来店日）が見つかりません' };
  var H = sh.getRange(hr, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  function ci(kws) { for (var k = 0; k < kws.length; k++) { var i2 = H.indexOf(kws[k]); if (i2 >= 0) return i2 + 1; } for (var k2 = 0; k2 < kws.length; k2++) { for (var c = 0; c < H.length; c++) { if (H[c].indexOf(kws[k2]) >= 0) return c + 1; } } return -1; }
  var col = { st: ci(['店舗名', '店舗']), no: ci(['予約No', '予約番号']), d: ci(['来店日']), tm: ci(['来店時間']), n: ci(['人数']), stat: ci(['ステータス']), win: ci(['受付窓口', '経路', '媒体']), cd: ci(['作成日']), ct: ci(['作成時間', '作成時刻']) };
  if (col.st < 0 || col.d < 0) return { ok: false, error: '💾予約DBの列（店舗名・来店日）が見つかりません' };
  var store = mgmtStoreName_(mss, dashStore);
  var tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  function dstr(v) {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    var m = String(v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : String(v).trim();
  }
  function tstr(v) { if (v instanceof Date) return Utilities.formatDate(v, tz, 'H:mm'); var m = String(v).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) + ':' + m[2] : String(v).trim(); }
  // 既存キー（店舗＋来店日＋来店時間＋人数＋受付窓口＋作成日＋作成時間）
  var last = sh.getLastRow(), exist = {};
  if (last > hr) {
    var vAll = sh.getRange(hr + 1, 1, last - hr, sh.getLastColumn()).getValues();
    for (var i = 0; i < vAll.length; i++) {
      var rr = vAll[i]; if (String(rr[col.st - 1]) === '' && String(rr[col.d - 1]) === '') continue;
      exist[storeKey_(rr[col.st - 1]) + '|' + dstr(rr[col.d - 1]) + '|' + tstr(rr[col.tm - 1]) + '|' + (Number(rr[col.n - 1]) || 0) + '|' + String(rr[col.win - 1] || '').trim() + '|' + dstr(rr[col.cd - 1]) + '|' + tstr(rr[col.ct - 1])] = 1;
    }
  }
  var width = sh.getLastColumn(), outRows = [], dup = 0;
  rows.forEach(function (a) {
    var d = String(a[1] || '').trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    var tm = String(a[2] || '').trim(), n = Number(a[3]) || 0, stat = String(a[4] || '').trim();
    var win = String(a[5] || '').trim(), cd = String(a[6] || '').trim(), ct = String(a[7] || '').trim();
    var key = storeKey_(store) + '|' + d + '|' + tstr(tm) + '|' + n + '|' + win + '|' + dstr(cd) + '|' + tstr(ct);
    if (exist[key]) { dup++; return; }
    exist[key] = 1;
    var row = []; for (var c = 0; c < width; c++) row.push('');
    row[col.st - 1] = store;
    if (col.no > 0) row[col.no - 1] = String(a[0] || '').trim();
    row[col.d - 1] = d;
    if (col.tm > 0) row[col.tm - 1] = tm;
    if (col.n > 0) row[col.n - 1] = n;
    if (col.stat > 0) row[col.stat - 1] = stat;
    if (col.win > 0) row[col.win - 1] = win;
    if (col.cd > 0) row[col.cd - 1] = cd;
    if (col.ct > 0) row[col.ct - 1] = ct;
    outRows.push(row);
  });
  if (outRows.length) sh.getRange(sh.getLastRow() + 1, 1, outRows.length, width).setValues(outRows);
  return { ok: true, added: outRows.length, dup: dup, store: store };
}

// ================== イベント自動取得（横浜アリーナ等） ==================
// 会場名→対象店舗（DB_会場店舗）を引く。無ければ空文字（＝全店向け扱い）。
function venueStores_(ss, venue) {
  var sh = ss.getSheetByName('DB_会場店舗');
  if (!sh || sh.getLastRow() < 2) return '';
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]).trim() === String(venue).trim()) return String(v[i][1] || '').trim();
  }
  return '';
}
// ns-daily-import の arena-events タスクから呼ばれる。会場・取得月・イベント配列を受け取り、
// DB_会場店舗で対象店舗を自動付与して DB_イベント を差し替える（自動行=ya_接頭辞。手動行は保持）。
function saveArenaEvents(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String(p.token) !== tk) return { ok: false, error: 'unauthorized' };
  setupIfNeeded(); // DB_イベント / DB_会場店舗 の存在を保証
  var venue = String(p.venue || '').trim() || '横浜アリーナ';
  var months, events;
  try { months = JSON.parse(p.months || '[]'); events = JSON.parse(p.events || '[]'); }
  catch (e) { return { ok: false, error: 'bad json' }; }
  var monthSet = {}; months.forEach(function (m) { monthSet[m] = 1; });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var stores = venueStores_(ss, venue);
  var PFX = 'ya_';
  // 新イベント行（IDは日付+名前ハッシュで安定＝毎回同じ→冪等）
  var newIds = {}, rows = events.map(function (e) {
    var dt = String(e.date).split('-');
    var id = PFX + dt.join('') + '_' + md5Hex_(String(e.name)).slice(0, 6);
    newIds[id] = 1;
    return [id, new Date(+dt[0], +dt[1] - 1, +dt[2]), String(e.name), venue, stores, '自動取得'];
  });
  var ev = ss.getSheetByName('DB_イベント');
  var last = ev.getLastRow(), keep = [], removed = 0;
  if (last >= 2) ev.getRange(2, 1, last - 1, 6).getValues().forEach(function (r) {
    if (r[0] === '') return;
    var id = String(r[0]);
    if (id.indexOf(PFX) !== 0) { keep.push(r); return; }        // 手動イベントは常に保持
    var d = (r[1] instanceof Date) ? r[1] : new Date(r[1]);
    var ym = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    if (!monthSet[ym]) { keep.push(r); return; }                // 取得範囲外の自動行は歴史として保持
    if (!newIds[id]) removed++;                                 // 取得範囲内だが今回無い＝掲載終了→削除
  });
  var out = keep.concat(rows);
  if (last >= 2) ev.getRange(2, 1, last - 1, 6).clearContent();
  if (out.length) { ev.getRange(2, 1, out.length, 6).setValues(out); ev.getRange(2, 2, out.length, 1).setNumberFormat('yyyy/m/d'); }
  return { ok: true, upserted: rows.length, removed: removed, stores: stores ? stores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean) : [] };
}

// ================== タスクキュー（スマホ→Mac側の取込タスク依頼） ==================
// ns-daily-import側で実行できるタスクの許可リスト（config.js/lark-listener.jsの一覧と合わせる。
// 新タスクを追加したら、あちら側と一緒にここにも追記すること）
var QUEUE_TASKS = [
  { key: 'smaregi-payroll',      label: 'スマレジ人件費' },
  { key: 'zeroregi-akihabara',   label: 'ZeroRegi売上(秋葉原)' },
  { key: 'infomart-siire',       label: 'インフォマート仕入れ' },
  { key: 'dinii-media',          label: 'Dinii媒体別' },
  { key: 'dinii-orders',         label: 'Dinii注文明細' },
  { key: 'dinii-questionnaire',  label: 'Diniiアンケート' },
  { key: 'dinii-payment-ns',     label: 'Dinii支払い(NS)' },
  { key: 'dinii-payment-nstyle', label: 'Dinii支払い(N-Style)' },
  { key: 'arena-events',         label: '横浜アリーナ イベント' },
];
function queueTaskLabel_(key) { for (var i = 0; i < QUEUE_TASKS.length; i++) if (QUEUE_TASKS[i].key === key) return QUEUE_TASKS[i].label; return key; }

// スマホ側：タスクを依頼（TASK_QUEUE_TOKEN認証）。許可リスト外のタスク名は拒否。
function queueTask(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('TASK_QUEUE_TOKEN');
  if (!tk || String(p.token) !== tk) return { ok: false, error: 'unauthorized' };
  var key = String(p.task || '').trim();
  var allowed = QUEUE_TASKS.some(function (t) { return t.key === key; });
  if (!allowed) return { ok: false, error: '不明なタスク: ' + key };
  setupIfNeeded(); // DB_タスクキューの存在を保証
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_タスクキュー');
  var id = Utilities.getUuid().slice(0, 8);
  sh.appendRow([id, key, new Date(), 'pending', '', '']);
  var r = sh.getLastRow();
  sh.getRange(r, 3).setNumberFormat('yyyy/m/d h:mm:ss');
  return { ok: true, id: id, label: queueTaskLabel_(key) };
}
// スマホ側：直近の依頼状況を返す（結果画面用）。最新10件。
function queueStatus(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('TASK_QUEUE_TOKEN');
  if (!tk || String(p.token) !== tk) return { ok: false, error: 'unauthorized' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_タスクキュー');
  if (!sh || sh.getLastRow() < 2) return { ok: true, items: [] };
  var last = sh.getLastRow();
  var n = Math.min(10, last - 1);
  var vals = sh.getRange(last - n + 1, 1, n, 6).getValues();
  var items = vals.map(function (r) {
    return { id: r[0], task: r[1], label: queueTaskLabel_(r[1]), at: r[2] instanceof Date ? r[2].toISOString() : String(r[2]), status: r[3], doneAt: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || ''), result: String(r[5] || '') };
  }).reverse();
  return { ok: true, items: items };
}
// Mac側：未処理(pending)を受領してprocessingに変え、そのリストを返す（BQ_LOAD_TOKEN認証）。
// 受領と同時に状態を変えるので、同じ依頼を二重に拾うことはない。
function pendingTasks(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String(p.token) !== tk) return { ok: false, error: 'unauthorized' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_タスクキュー');
  if (!sh || sh.getLastRow() < 2) return { ok: true, tasks: [] };
  var last = sh.getLastRow();
  var vals = sh.getRange(2, 1, last - 1, 6).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][3]) !== 'pending') continue;
    sh.getRange(i + 2, 4).setValue('processing');
    out.push({ id: vals[i][0], task: vals[i][1] });
  }
  return { ok: true, tasks: out };
}
// Mac側：実行結果を報告（BQ_LOAD_TOKEN認証）
function ackTask(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String(p.token) !== tk) return { ok: false, error: 'unauthorized' };
  var id = String(p.id || '').trim(); if (!id) return { ok: false, error: 'idが必要です' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_タスクキュー');
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === id) {
        var row = i + 2;
        sh.getRange(row, 4).setValue(String(p.status === 'failed' ? 'failed' : 'done'));
        sh.getRange(row, 5).setValue(new Date());
        sh.getRange(row, 5).setNumberFormat('yyyy/m/d h:mm:ss');
        sh.getRange(row, 6).setValue(String(p.summary || '').slice(0, 500));
        return { ok: true };
      }
    }
  }
  return { ok: false, error: '該当タスクが見つかりません' };
}

// ================== 週報（提出・フィードバック・招待） ==================
// 週の区切りは「火曜〜翌月曜」。分析用の月内ブロック週（1-7日…）とは別物なので混同しないこと。
// 締切: 提出＝週明け火曜16:00 ／ フィードバック＝水曜16:00
var WEEKLY_DUE_HOUR = 16;

// 任意の日付を含む「火曜始まりの週」の火曜日を返す
function weekStartTue_(d) {
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var diff = (x.getDay() - 2 + 7) % 7;   // 火曜=2
  x.setDate(x.getDate() - diff);
  return x;
}
function ymd_(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function parseYmd_(s) {
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function sheetOrCreate_(name, headers, note) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#efe9dd');
    if (note) sh.getRange('A1').setNote(note);
    sh.setFrozenRows(1); sh.setColumnWidths(1, headers.length, 140);
  }
  return sh;
}
function weeklySheets_() {
  return {
    rep: sheetOrCreate_('DB_週報', ['ID', '週開始日(火)', '投稿者ID', '投稿者名', '店舗', '役職', '提出日時', '更新日時'],
      '週報の提出記録（1行=1提出）。ダッシュボードの「週報」タブから投稿されます。手で編集しないでください。'),
    ans: sheetOrCreate_('DB_週報回答', ['週報ID', '表示順', '項目名', '回答'],
      '週報の各項目の回答（縦持ち）。フォーマットを変えたい場合は DB_週報テンプレート を編集してください。'),
    fb: sheetOrCreate_('DB_週報FB', ['ID', '週報ID', '投稿者ID', '投稿者名', '本文', '日時'],
      '週報へのフィードバック。1つの週報に複数人が書けます。'),
    inv: sheetOrCreate_('DB_招待', ['トークン', '権限', '役職', '担当店舗', '発行者', '発行日時', '有効期限', '使用済み', '使用者ID'],
      'アカウント招待リンク。発行はダッシュボードのアカウント管理から。使用済み=TRUE の行は再利用できません。')
  };
}
// テンプレート（社長が自由に編集する場所）。無ければ初期サンプルを入れて作る。
// 役職・権限ごとの「表示タブ / 使える機能」の既定を置く場所。
// ここを編集すれば、コードを変えずに全員へ反映される（アカウント個別の上書きより弱い）。
function roleDefSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('DB_権限定義');
  if (!sh) {
    sh = ss.insertSheet('DB_権限定義');
    sh.getRange(1, 1, 1, 4).setValues([['区分', '名称', '表示するタブ', '使える機能']])
      .setFontWeight('bold').setBackground('#efe9dd');
    var T = 'ダッシュボード,目標管理,推移分析,明細分析,PL（損益）,入金管理,広告管理,口コミ,週報,週報管理,AI検索';
    var ALL = '口座CSVを取込,経費を入力,広告費を入力,売上を入力,予約CSVを取込';
    sh.getRange(2, 1, 6, 4).setValues([
      ['権限', '社長',        T + ',アカウント管理', ALL],
      ['権限', '本部',        T + ',アカウント管理', ALL],
      ['権限', 'マネージャー', T,                    'なし'],
      ['権限', '店舗',        'ダッシュボード,目標管理,推移分析,明細分析,入金管理,口コミ,週報,AI検索', 'なし'],
      ['役職', '店長',        '', ''],
      ['役職', '社員',        '', ''],
    ]);
    sh.getRange('A1').setNote(
      '役職・権限ごとの既定値。空欄の行は上の「権限」の既定に従います。\n' +
      '・区分=権限（社長/本部/マネージャー/店舗）または 役職（店長/社員 など任意）\n' +
      '・役職の行を書くと、その役職の人は権限より優先してこの設定になります\n' +
      '・使える機能に「なし」と書くと1つも使えません（空欄＝上位の既定に従う）\n' +
      '・アカウント個別に設定した内容は、このシートより優先されます');
    sh.setFrozenRows(1); sh.setColumnWidths(1, 2, 110); sh.setColumnWidth(3, 380); sh.setColumnWidth(4, 300);
  }
  return sh;
}
function weeklyTemplateSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('DB_週報テンプレート');
  if (!sh) {
    sh = ss.insertSheet('DB_週報テンプレート');
    sh.getRange(1, 1, 1, 5).setValues([['役職', '表示順', '項目名', '入力形式', '必須']])
      .setFontWeight('bold').setBackground('#efe9dd');
    sh.getRange(2, 1, 7, 5).setValues([
      ['店長', 1, '今週の振り返り（できたこと）', '長文', 'TRUE'],
      ['店長', 2, '課題・うまくいかなかったこと', '長文', 'TRUE'],
      ['店長', 3, '来週の重点KPI', '短文', 'TRUE'],
      ['店長', 4, '来週やること（タスク）', '長文', 'TRUE'],
      ['社員', 1, '今週やったこと', '長文', 'TRUE'],
      ['社員', 2, '来週やること', '長文', 'TRUE'],
      ['社員', 3, '困っていること・相談したいこと', '長文', 'FALSE'],
    ]);
    sh.getRange('A1').setNote('週報のフォーマット。行を足す/消す/並べ替えるだけでダッシュボードの入力欄が変わります（再デプロイ不要）。役職はアカウントの「役職」と一致させてください。入力形式は 長文/短文/数値。');
    sh.setFrozenRows(1); sh.setColumnWidths(1, 5, 150); sh.setColumnWidth(3, 260);
  }
  return sh;
}

// 週報を保存（同じ人・同じ週なら上書き）
function saveWeekly(p, session) {
  var week = String(p.week || '').trim();
  if (!parseYmd_(week)) return { ok: false, error: '週の指定が不正です' };
  var answers = p.answers;
  if (typeof answers === 'string') { try { answers = JSON.parse(answers); } catch (e) { answers = null; } }
  if (!answers || !answers.length) return { ok: false, error: '回答がありません' };

  var sh = weeklySheets_();
  var now = new Date();
  var last = sh.rep.getLastRow();
  var id = '', row = -1, submittedAt = now;
  if (last >= 2) {
    var vals = sh.rep.getRange(2, 1, last - 1, 3).getValues();
    for (var i = 0; i < vals.length; i++) {
      // 同じ投稿者＆同じ週の行があれば更新（二重投稿を防ぐ）
      if (String(vals[i][2]).trim() === session.id && ymd_(new Date(vals[i][1])) === week) {
        id = String(vals[i][0]).trim(); row = i + 2;
        submittedAt = sh.rep.getRange(row, 7).getValue() || now;
        break;
      }
    }
  }
  if (!id) id = Utilities.getUuid().slice(0, 12);
  var rec = [id, parseYmd_(week), session.id, session.name || session.id,
             String(p.store || session.stores || ''), String(p.position || session.position || ''), submittedAt, now];
  var target = row > 0 ? row : sh.rep.getLastRow() + 1;
  sh.rep.getRange(target, 1, 1, 8).setValues([rec]);
  sh.rep.getRange(target, 2).setNumberFormat('yyyy/m/d');

  // 回答は入れ替え（この週報IDの既存行を消してから書き直す）
  var aLast = sh.ans.getLastRow();
  if (aLast >= 2) {
    var aVals = sh.ans.getRange(2, 1, aLast - 1, 1).getValues();
    for (var j = aVals.length - 1; j >= 0; j--) if (String(aVals[j][0]).trim() === id) sh.ans.deleteRow(j + 2);
  }
  var rows = answers.map(function (a, idx) {
    return [id, Number(a.order || idx + 1), String(a.label || ''), String(a.value == null ? '' : a.value)];
  });
  if (rows.length) sh.ans.getRange(sh.ans.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  return { ok: true, id: id };
}

// フィードバックを追加
function saveFeedback(p, session) {
  var reportId = String(p.reportId || '').trim();
  var body = String(p.body || '').trim();
  if (!reportId || !body) return { ok: false, error: '対象の週報と本文が必要です' };
  var sh = weeklySheets_();
  sh.fb.appendRow([Utilities.getUuid().slice(0, 12), reportId, session.id, session.name || session.id, body, new Date()]);
  return { ok: true };
}

// ---- 招待リンク ----
function createInvite(p, session) {
  if (!isAdmin(session)) return { ok: false, error: '招待リンクの発行権限がありません' };
  var role = String(p.role || '').trim();
  if (['社長', '本部', 'マネージャー', '店舗'].indexOf(role) < 0) return { ok: false, error: '権限の指定が不正です' };
  var days = Number(p.days || 7); if (!(days > 0 && days <= 60)) days = 7;
  // 1リンク＝1人しか登録できないため、同じ条件で複数人ぶん欲しい場合は count でまとめて発行する
  var count = Number(p.count || 1); if (!(count >= 1 && count <= 20)) count = 1;
  var exp = new Date(); exp.setDate(exp.getDate() + days);
  var sh = weeklySheets_();
  var now = new Date(), tokens = [], rows = [];
  for (var i = 0; i < count; i++) {
    var token = Utilities.getUuid().replace(/-/g, '');   // 32桁・推測不可
    tokens.push(token);
    rows.push([token, role, String(p.position || ''), String(p.stores || ''), session.id, now, exp, 'FALSE', '']);
  }
  sh.inv.getRange(sh.inv.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
  return { ok: true, tokens: tokens, token: tokens[0], expires: ymd_(exp) };
}
// トークンの中身を返す（未ログインで呼ばれる。権限・役職・店舗だけ返し、他の情報は一切返さない）
function checkInvite(p) {
  var token = String(p.token || '').trim();
  if (!token) return { ok: false, error: 'リンクが不正です' };
  var sh = weeklySheets_();
  var last = sh.inv.getLastRow(); if (last < 2) return { ok: false, error: 'リンクが無効です' };
  var vals = sh.inv.getRange(2, 1, last - 1, 9).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() !== token) continue;
    if (String(vals[i][7]).toUpperCase() === 'TRUE') return { ok: false, error: 'このリンクは既に使用されています' };
    if (vals[i][6] && new Date(vals[i][6]) < new Date()) return { ok: false, error: 'このリンクは期限切れです' };
    return { ok: true, role: String(vals[i][1]), position: String(vals[i][2]), stores: String(vals[i][3]) };
  }
  return { ok: false, error: 'リンクが無効です' };
}
// 招待リンクから従業員が自分でアカウントを作る（未ログインで呼ばれる）
function registerFromInvite(p) {
  var token = String(p.token || '').trim();
  var chk = checkInvite({ token: token });
  if (!chk.ok) return chk;
  var id = String(p.id || '').trim();
  var pw = String(p.pw || '');
  var name = String(p.name || '').trim() || id;
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(id)) return { ok: false, error: 'ログインIDは半角英数字3〜32文字で入力してください' };
  if (pw.length < 8) return { ok: false, error: 'パスワードは8文字以上にしてください' };

  var rows = accountRows();
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return { ok: false, error: 'このログインIDは既に使われています' };

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('アカウント');
  sh.getRange(sh.getLastRow() + 1, 1, 1, 10).setValues([[
    id, pwEncode_(pw), name, chk.role, chk.stores, 'TRUE', '招待リンクから登録', '', '', chk.position
  ]]);
  // トークンを使用済みにする（1回きり）
  var ish = weeklySheets_().inv;
  var last = ish.getLastRow();
  var vals = ish.getRange(2, 1, last - 1, 1).getValues();
  for (var j = 0; j < vals.length; j++) {
    if (String(vals[j][0]).trim() === token) { ish.getRange(j + 2, 8).setValue('TRUE'); ish.getRange(j + 2, 9).setValue(id); break; }
  }
  return { ok: true };
}
