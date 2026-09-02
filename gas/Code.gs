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

// ログイントークンの有効時間。使うたびにこの時間ぶん延長される（sessionGet参照）ので、
// 実質「最後にアクセスしてからこの時間操作が無いとログアウトされる」の意味。
// 2026-08-26: ユーザー報告「定期的にログアウトされる」を受けて12→336時間（14日）に延長
// （内部の業務用ツールでID/PW認証もあるため、利便性を優先。セキュリティ上の懸念があれば
// 短縮を検討）。
var TOKEN_HOURS = 336;

// 統合アカウント（N-Styleポータル / 日報Supabase）でのログイン用。
// キーは公開用publishableキー（秘密情報ではない）。トークン検証はSupabase側で行う。
var SSO_SUPA_URL = 'https://uuvsxzhpxtghojoubjcc.supabase.co';
var SSO_SUPA_KEY = 'sb_publishable_MrwPJAx_Ws_fdRutprKCiQ_dg3wCiTr';

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
    if (action === 'ping')   return out({ ok: true, ping: 'pong', ver: 'token-336h-v1-a6p2', time: new Date().toISOString() }); // a6p2=運営委託費二重計上修正+A-6Phase2（キャンセル分析・お客様名・媒体手数料設定）追加（2026-08-31）のデプロイ確認用に更新
    if (action === 'plSeisanDiag') return out(plSeisanDiag(p)); // 運営委託費の二重計上診断（専用トークン認証・読み取り専用・一時的）
    if (action === 'depositDupDiag') return out(depositDupDiag_(p)); // 一時テスト用（2026-09-02・使用後削除予定）: 入金二重計上調査
    if (action === 'storeMapDiag') return out(storeMapDiag(p)); // DB_店舗ID対応とfact_daily_storeの店舗名突合診断（専用トークン認証・読み取り専用・一時的）
    if (action === 'roleDefDiag') return out(roleDefDiag(p)); // DB_権限定義シートの内容を返す（専用トークン認証・読み取り専用。2026-09-02追加）
    if (action === 'storeNameAudit') return out(storeNameAudit(p)); // BQミラー全8テーブルの店舗名をstore_aliasesと突合し未登録表記を洗い出す（専用トークン認証・読み取り専用。2026-08-28追加）
    if (action === 'detailVsDailyDiag') return out(detailVsDailyDiag(p)); // 明細分析とダッシュボードの売上・客数・組数の差を実測で突合（専用トークン認証・読み取り専用・一時的）
    if (action === 'bqPerfDiag') return out(bqPerfDiag(p)); // BQモード各アクションの所要時間計測（専用トークン認証・読み取り専用・一時的）
    if (action === 'dataKeysDiag') return out(dataKeysDiag(p)); // getData()が実際にどのキーを返すか確認（専用トークン認証・読み取り専用・一時的）
    if (action === 'mediaDateRangeDiag') return out(mediaDateRangeDiag(p)); // stg_media（媒体別日次）の最古/最新日付を確認（担当D依頼の前年比調査用・専用トークン認証・読み取り専用・一時的）
    if (action === 'rsvDateRangeDiag') return out(rsvDateRangeDiag_(p)); // stg_reservation（予約）の店舗別最新日付・件数を確認（専用トークン認証・読み取り専用。2026-08-31追加）
    if (action === 'syncSeisanFeeToPl') return out(syncSeisanFeeToPl(p)); // 運営委託費のPL自動連携（専用トークン認証・ログイン不要。2026-08-23追加）
    if (action === 'syncSeisanCategoriesToPl') return out(syncSeisanCategoriesToPl(p)); // 精算書の勘定科目→PL自動連携（専用トークン認証・ログイン不要。2026-08-31追加・A-9）
    if (action === 'syncSpotLaborToPl') return out(syncSpotLaborToPl(p)); // スポット人件費の月次PL自動連携（専用トークン認証・ログイン不要。2026-08-23追加）
    if (action === 'syncBankLoanToPl') return out(syncBankLoanToPl(p)); // 銀行借入 利息・元金のPL自動連携（専用トークン認証・ログイン不要。2026-08-26追加・A-5）
    if (action === 'bqLoadOrders') return out(bqLoadOrders(p)); // 明細のBQ投入（専用トークン認証・ログイン不要）
    if (action === 'bqSetupSalesDataset') return out(bqSetupSalesDataset(p)); // salesデータセット作成（初回のみ・専用トークン認証）
    if (action === 'bqSyncSales') return out(bqSyncAllSales(p)); // 分析_日別店舗ほかのBQミラー（専用トークン認証・ログイン不要）
    if (action === 'bqDailyStoreForSync') return out(bqDailyStoreForSync(p)); // dash-sync用の軽量BQ問い合わせ（専用トークン認証・ログイン不要・スプレッドシート不使用）
    if (action === 'reportDataBQ') return out(reportDataBQ(p)); // Lark/Chatwork自動配信用の軽量レポート数値（専用トークン認証・ログイン不要・スプレッドシート不使用。2026-08-23追加）
    if (action === 'bqReconcileSales') return out(bqReconcileSales(p)); // BQとシートの突合（専用トークン認証・ログイン不要）
    if (action === 'bqSyncPL') return out(bqSyncPL(p)); // PL経費(DB_PL)のBQミラー同期（専用トークン認証・ログイン不要）
    if (action === 'writeAdCost') return out(writeAdCost(p)); // A-8: 広告費書き込み（invoices側ad-cost-reflectから・AD_COST_WRITE_TOKEN認証・ログイン不要。2026-08-31追加）
    if (action === 'writePlFee') return out(writePlFee(p)); // A-8拡張: 勘定科目汎用のPL自動計上（invoices側pl-fee-reflectから・AD_COST_WRITE_TOKEN認証・ログイン不要。2026-09-01追加・設計書§5）
    if (action === 'bqSyncAdCost') return out(bqSyncAdCost(p)); // 💾広告費DBのBQミラー同期（専用トークン認証・ログイン不要。writeAdCostから毎回自動で呼ばれるほか単独でも可。2026-08-31追加・A-8）
    if (action === 'bqSyncReservation') return out(bqSyncReservation(p)); // 予約(stg_reservation)のBQミラー同期（専用トークン認証・ログイン不要。2026-08-28追加・A-6）
    if (action === 'perf') return out(perfDiag(p)); // パフォーマンス計測（専用トークン認証・ログイン不要・数字は返さず時間だけ）
    setupIfNeeded();
    if (action === 'login')  return out(login(p));
    if (action === 'supalogin') return out(supaLogin(p)); // 統合アカウント（Supabaseトークン）でログイン
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
    if (action === 'bqDailyStore') return out(bqDailyStore(p, session)); // 推移分析：分析_日別店舗のBQミラーを読む（データソース切替フラグ用）
    if (action === 'bqGetPL') return out(bqGetPL(p, session)); // PLタブ：DB_PLのBQミラーを読む（データソース切替フラグ用）
    if (action === 'bqGetSpot') return out(bqGetSpot(p, session)); // スポット人件費：DB_スポット人件費のBQミラーを読む（2026-08-23追加）
    if (action === 'bqGetLoanPrincipal') return out(bqGetLoanPrincipal(p, session)); // 簡易キャッシュフロー：DB_借入返済元金のBQミラーを読む（2026-08-26追加・A-5）
    if (action === 'saveSpotEntry') return out(saveSpotEntry(p, session)); // スポット人件費の保存（ID一致なら更新・無ければ追加）
    if (action === 'deleteSpotEntry') return out(deleteSpotEntry(p, session)); // スポット人件費の削除
    if (action === 'refreshSpotPl') return out(refreshSpotPl(p, session)); // スポット人件費→月次PLへ今すぐ反映（画面の更新ボタン用）
    if (action === 'bqGetDeposit') return out(bqGetDeposit(p, session)); // 入金管理タブ：入金DBのBQミラーを読む（データソース切替フラグ用）
    if (action === 'bqGetMedia') return out(bqGetMedia(p, session)); // 媒体別日次：媒体別DBのBQミラーを読む（ログイン直後の同期エラー対策・2026-08-23追加）
    if (action === 'bqGetReservation') return out(bqGetReservation(p, session)); // 予約タブ：stg_reservationのBQミラーを読む（2026-08-28追加・A-6）
    if (action === 'bqGetReservationNames') return out(bqGetReservationNames(p, session)); // 予約詳細：お客様名を都度Supabaseから取得（ログイン必須・店舗スコープ制限。2026-08-31追加・A-6 Phase2）
    if (action === 'bqGetSeatMaster') return out(bqGetSeatMaster(p, session)); // 予約タブ：店舗ごとの卓一覧（DB_席マスタ）を読む（2026-08-28追加・A-6）
    if (action === 'dataFreshness') return out(dataFreshness(p, session)); // データ最新日・BQ同期時刻の表示用（実装指示書_ダッシュボード高速化タスク1・2026-08-23追加）
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
    if (action === 'mfConfirmImport') return out(mfConfirmImport(p, session)); // MF取込：プレビューで確定した行をDB_PLへ反映
    if (action === 'saveAdFee') return out(saveAdFee(p, session)); // 広告費の手入力（管理シート💾広告費DBへupsert）
    if (action === 'saveAdSales') return out(saveAdSales(p, session)); // 売上・反響の手入力（管理シート💾売上DBへupsert）
    if (action === 'importReservations') return out(importReservations(p, session)); // 予約CSV取込（管理シート💾予約DBへ追記）
    if (action === 'saveTanka')   return out(saveTanka(p, session));   // 単価設定の保存（管理シート⚙単価設定へupsert。2026-08-30追加）
    if (action === 'deleteTanka') return out(deleteTanka(p, session)); // 単価設定の削除（2026-08-30追加）
    if (action === 'saveMediaFee')   return out(saveMediaFee(p, session));   // 媒体手数料設定の保存（管理シート⚙媒体手数料設定へupsert。A-6 Phase2・2026-08-31追加）
    if (action === 'deleteMediaFee') return out(deleteMediaFee(p, session)); // 媒体手数料設定の削除（A-6 Phase2・2026-08-31追加）
    if (action === 'saveDepNote') return out(saveDepNote(p, session)); // 入金備考の保存（社長・本部のみ）
    if (action === 'setPlTaxRate') return out(setPlTaxRate(p, session)); // 簡易キャッシュフローの法人税率設定（社長・本部のみ。2026-08-26追加・A-5）
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
  depNoteSheet_();          // 入金備考
  seatMasterSheet_();       // 予約タブ：店舗ごとの卓（テーブル）一覧（2026-08-28追加・A-6）
  storeHoursSheet_();       // 予約タブ：店舗ごとの営業時間（2026-08-28追加・A-6）

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
  // K列「メール」（統合アカウントのメールアドレス。SSOログインの突き合わせに使う）
  if (acc && String(acc.getRange(1, 11).getValue()) === '') {
    acc.getRange(1, 11).setValue('メール').setFontWeight('bold').setBackground('#efe9dd');
    acc.getRange(1, 11).setNote('統合アカウント（ポータル/日報）のメールアドレス。\nここに入れると「統合アカウントでログイン」でこの行の権限が使えます。\n空欄＝統合ログイン不可（従来のID/PWのみ）。');
  }
  // L列「担当媒体」（権限「外販」のアカウントに、見せてよい媒体名を入れる）
  if (acc && String(acc.getRange(1, 12).getValue()) === '') {
    acc.getRange(1, 12).setValue('担当媒体').setFontWeight('bold').setBackground('#efe9dd');
    acc.getRange(1, 12).setNote('権限が「外販」のアカウントで使います。\n分析_媒体別日次シートの媒体名をそのまま入れてください（例: Ring-style）。\n複数ある場合はカンマ区切り（例: Ring-style, いちご屋）。');
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
  // 1行＝年月×店舗×勘定科目×補助科目。区分: F=仕入れ/L=人件費/A=広告/R=家賃/O=他
  // 補助科目（G列）は2026-08-23追加。既存行は空欄=補助科目なし（一意キーは年月×店舗×勘定科目×補助科目）。
  var plSh = ss.getSheetByName('DB_PL');
  if (!plSh) {
    plSh = ss.insertSheet('DB_PL');
    plSh.getRange(1, 1, 1, 7).setValues([['年月', '店舗名', '勘定科目', '区分', '金額', 'メモ', '補助科目']])
      .setFontWeight('bold').setBackground('#efe9dd');
    plSh.getRange('A1').setNote(
      '月次経費を1行ずつ入力してください。\n' +
      '・年月: 2026/07 の形式（2026/07/01でも可）\n' +
      '・店舗名: 分析_日別店舗と同じ表記（空欄＝全社共通経費）\n' +
      '・勘定科目: 家賃／水道光熱費／消耗品費／支払手数料 など自由\n' +
      '・区分: F=仕入れ / L=人件費 / A=広告 / R=家賃 / O=他\n' +
      '・金額: 数値（円）\n' +
      '・補助科目（任意）: 勘定科目の内訳。空欄なら補助科目なし扱い\n' +
      '※売上・仕入・人件費・広告費（DB_広告）は自動連携。ここに入れたF/L/Aは自動分に加算されます。'
    );
    // 区分列にプルダウン（F/L/A/R/O）
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(['F', 'L', 'A', 'R', 'O'], true).setAllowInvalid(true).build();
    plSh.getRange(2, 4, 999, 1).setDataValidation(rule);
    plSh.setFrozenRows(1);
    plSh.setColumnWidths(1, 7, 130);
  } else if (plSh.getRange('G1').getValue() === '') {
    // 既存の本番シート向けの一回きりの移行: G列（補助科目）ヘッダーだけ追加する。
    // データ行は一切触らない（既存行はG列が空欄のまま＝補助科目なし、という約束を壊さない）。
    plSh.getRange('G1').setValue('補助科目').setFontWeight('bold').setBackground('#efe9dd');
    plSh.setColumnWidth(7, 130);
  }

  // スポット人件費（DB_スポット人件費）。無ければ雛形を自動作成（2026-08-23追加）。
  // 列: 日付／店舗名／区分／金額／人数／メモ／入力者／入力日時／ID。
  // I列（ID）はBigQueryミラー対象外（saveSpotEntry/deleteSpotEntryの検索キーとしてのみ使う）。
  var spotSh = ss.getSheetByName('DB_スポット人件費');
  if (!spotSh) {
    spotSh = ss.insertSheet('DB_スポット人件費');
    spotSh.getRange(1, 1, 1, 9).setValues([['日付', '店舗名', '区分', '金額', '人数', 'メモ', '入力者', '入力日時', 'ID']])
      .setFontWeight('bold').setBackground('#efe9dd');
    spotSh.getRange('A1').setNote(
      'タイミー等の単発人件費を1行ずつ記録します（ダッシュボードのPLタブ「＋スポット人件費」から自動で追記されます）。\n' +
      '・日付: 勤務日\n・店舗名: 分析_日別店舗と同じ表記\n・区分: タイミー／その他\n・金額: 数値（円）\n' +
      '・人数: 任意\n・入力者/入力日時/ID: 画面から保存すると自動で入る（手で消さないこと）'
    );
    spotSh.setFrozenRows(1);
    spotSh.setColumnWidths(1, 9, 120);
  }

  // 借入返済元金（DB_借入返済元金）。無ければ雛形を自動作成（2026-08-26追加・A-5）。
  // ns-info-system（F-8）の返済データビューから毎日自動同期される（syncBankLoanToPl_）。
  // 手入力欄ではない（画面から編集する機能は無い・DB_PLへは書かず、簡易キャッシュフロー
  // セクションの表示計算だけに使う。元金をPL費用に含めない設計のため専用シートに分離）。
  var loanSh = ss.getSheetByName('DB_借入返済元金');
  if (!loanSh) {
    loanSh = ss.insertSheet('DB_借入返済元金');
    loanSh.getRange(1, 1, 1, 5).setValues([['年月', '店舗', '法人', '元金額', 'メモ']])
      .setFontWeight('bold').setBackground('#efe9dd');
    loanSh.getRange('A1').setNote(
      '銀行借入の返済元金を年月×店舗で記録します（ns-info-systemの返済データから毎日自動同期・手入力不可）。\n' +
      '・年月: YYYY-MM形式\n・店舗: 空欄=全社共通\n・法人: 借入している法人名\n・元金額: 数値（円）'
    );
    loanSh.setFrozenRows(1);
    loanSh.setColumnWidths(1, 5, 130);
  }

  // 補助科目マスタ（DB_補助科目）。無ければ雛形を自動作成（2026-08-23追加）。
  // 列: 勘定科目／補助科目／表示順／有効。入力画面の「＋新しい補助科目を追加」でも自動的に行が増える
  // （ensureSubItemMaster_参照）。ここでは空の雛形だけ作る（初期の種は運用しながら育てる）。
  var subSh = ss.getSheetByName('DB_補助科目');
  if (!subSh) {
    subSh = ss.insertSheet('DB_補助科目');
    subSh.getRange(1, 1, 1, 4).setValues([['勘定科目', '補助科目', '表示順', '有効']])
      .setFontWeight('bold').setBackground('#efe9dd');
    subSh.getRange('A1').setNote(
      '勘定科目ごとの補助科目（内訳）のマスタです。\n' +
      '・勘定科目: DB_PLで使っている勘定科目名と同じ表記\n' +
      '・補助科目: 例）水道光熱費 → 電気料金／ガス料金／水道料金\n' +
      '・表示順: 数値（空欄可・小さい順に表示）\n' +
      '・有効: FALSE にするとプルダウンの候補から外れる（行は消さない）\n' +
      '※PL入力画面で新しい補助科目をその場入力すると、この一覧に自動で追加されます。'
    );
    subSh.setFrozenRows(1);
    subSh.setColumnWidths(1, 4, 150);
  }

  // MF科目対応マスタ（DB_科目対応）。無ければ雛形を自動作成（2026-08-24追加・MF取込用）。
  // 列: MF勘定科目／MF補助科目／内部勘定科目／内部補助科目／区分／取込対象外。
  // MF補助科目が空欄の行＝その勘定科目の「その他一括（内訳を追わない）」の既定マッピング。
  // MF取込プレビューで未対応科目を解決すると、この一覧に自動で追加される（mfConfirmImport参照）。
  var mfCatSh = ss.getSheetByName('DB_科目対応');
  if (!mfCatSh) {
    mfCatSh = ss.insertSheet('DB_科目対応');
    mfCatSh.getRange(1, 1, 1, 6).setValues([['MF勘定科目', 'MF補助科目', '内部勘定科目', '内部補助科目', '区分', '取込対象外']])
      .setFontWeight('bold').setBackground('#efe9dd');
    mfCatSh.getRange('A1').setNote(
      'マネーフォワード試算表CSV取込（📥 MF取込）が科目名を解決するためのマスタです。\n' +
      '・MF勘定科目／MF補助科目: CSVそのままの表記（MF補助科目が空欄＝取引先名や部門コード等を無視して勘定科目に一括計上する既定行）\n' +
      '・内部勘定科目／内部補助科目: ダッシュボードのDB_PLに書き込む科目名\n' +
      '・区分: F=仕入れ / L=人件費 / A=広告 / R=家賃 / O=他\n' +
      '・取込対象外: TRUEにすると、この科目は取込時に無視されます（人件費・売上等、既に自動連携済みの科目に使用）\n' +
      '※取込プレビュー画面で未対応科目を解決すると、この一覧に自動で追加されます。'
    );
    mfCatSh.setFrozenRows(1);
    mfCatSh.setColumnWidths(1, 6, 150);
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
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues();  // L列（担当媒体）まで読む
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
      position: String(v[9] || '').trim(), // 役職（店長/社員 等。週報テンプレートの出し分けに使う）
      email: String(v[10] || '').trim().toLowerCase(), // 統合アカウントのメール（SSO突き合わせ用）
      media: String(v[11] || '').trim()                // 担当媒体（権限「外販」のときに使う。カンマ区切りで複数可）
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
      var sess = { id: a.id, name: a.name, role: a.role, stores: a.stores, tabs: a.tabs, perms: a.perms, position: a.position, media: a.media };
      sessionPut(token, sess);
      cache.remove(failKey);
      return { ok: true, token: token, account: sess };
    }
  }
  cache.put(failKey, String(fails + 1), 600);
  return { ok: false, error: 'IDまたはパスワードが違います' };
}

// 統合アカウント（ポータル/日報のSupabase）でログイン。
// ブラウザ側がSupabaseにメール+PWでログインして得た access_token を受け取り、
// Supabaseの /auth/v1/user で検証（＝パスワードはGASを通らない）。
// 検証OKならメールをアカウントシートK列「メール」と突き合わせ、通常と同じセッションを発行する。
function supaLogin(p) {
  var stoken = String(p.stoken || '');
  if (!stoken) return { ok: false, error: '統合アカウントのトークンがありません' };
  var res;
  try {
    res = UrlFetchApp.fetch(SSO_SUPA_URL + '/auth/v1/user', {
      headers: { apikey: SSO_SUPA_KEY, Authorization: 'Bearer ' + stoken },
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, error: '統合アカウントの確認に失敗しました: ' + e.message };
  }
  if (res.getResponseCode() !== 200) return { ok: false, error: '統合アカウントの認証が無効です。もう一度ログインしてください' };
  var email = '';
  try { email = String(JSON.parse(res.getContentText()).email || '').trim().toLowerCase(); } catch (e) {}
  if (!email) return { ok: false, error: '統合アカウントのメールアドレスを取得できませんでした' };

  var rows = accountRows();
  for (var i = 0; i < rows.length; i++) {
    var a = rows[i];
    if (a.email && a.email === email) {
      if (!a.active) return { ok: false, error: 'このアカウントは無効化されています' };
      sessionCleanup();
      var token = Utilities.getUuid();
      var sess = { id: a.id, name: a.name, role: a.role, stores: a.stores, tabs: a.tabs, perms: a.perms, position: a.position, media: a.media };  // v2.6: 外販の担当媒体も持ち回る
      sessionPut(token, sess);
      return { ok: true, token: token, account: sess };
    }
  }
  return { ok: false, error: 'このメール（' + email + '）に対応するダッシュボードアカウントがありません。アカウント管理の「メール」欄に登録してください' };
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
  { key: '広告店舗マスタ', re: /店舗マスタ/ },  // ⚙️店舗マスタ → 広告費・売上入力の店舗プルダウン（広告側の店舗名）
  { key: '媒体手数料設定', re: /媒体手数料設定/ }  // ⚙媒体手数料設定 → 予約分析タブの媒体別推定手数料（A-6 Phase2・2026-08-31追加）
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
    // ⚙媒体手数料設定タブが無ければ作成（A-6 Phase2・2026-08-31追加）
    if (!mgmtFindTab(mss, /媒体手数料設定/)) {
      var fee = mss.insertSheet('⚙媒体手数料設定');
      fee.getRange(1, 1, 1, 6).setValues([['媒体', '計算方式', '手数料率／単価', '対象店舗', 'プラン', 'メモ']])
        .setFontWeight('bold').setBackground('#efe9dd');
      fee.getRange('A1').setNote(
        '媒体ごとの集客手数料の計算式。予約分析タブの媒体別テーブルに推定手数料として表示される。\n' +
        '・計算方式は「予約売上×手数料率」「予約人数×単価」「予約件数×単価」「固定費」のいずれか\n' +
        '・手数料率は 4.0% のように%表記、単価/固定費は円額をそのまま数字で入力\n' +
        '・対象店舗を空欄にすると全店舗に適用（同じ媒体で店舗別の行を追加すればその店舗だけ上書きできる）\n' +
        '・実際の広告費請求額（💾広告費DB・A-8で自動反映）と並べて表示するので、乖離があれば料率を見直す目安になる'
      );
      fee.setFrozenRows(1);
      fee.setColumnWidths(1, 6, 130);
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
  // 先頭に空行が挿入されてもヘッダーを見失わないように、最初の非空行をヘッダーにする（最大5行スキャン）。
  // 実際に2026-08で入金DBの1行目に空行が入り、配信ヘッダーが空になって繰越計算が壊れた事故対策。
  var h0 = 0;
  while (h0 < Math.min(5, vals.length) && String(vals[h0].join('')).trim() === '') h0++;
  if (h0 >= vals.length) return [];
  if (h0 > 0) vals = vals.slice(h0);
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
    sheets: sheets,
    stores: fetchStoreDirectory_(), // Day6②: Supabase店舗マスタ（表示順・看板・別名・天気地点等）。取得失敗時はnull＝フロントが現行定数にフォールバック
    taxRate: plTaxRate_() // 簡易キャッシュフロー用の法人税率（既定0.34・PLタブから変更可。2026-08-26追加・A-5）
  };
}

// ================== 店舗マスタ（Day6②: Supabase直読み） ==================
// 正本はSupabase（nippo店舗管理画面で編集）。anonキーで読める匿名読み取り専用VIEW
// store_directory_v を10分キャッシュで読む。取得できない間はnullを返し、
// 呼び出し側（getData・resolveAdStore_）はこれまでどおりのハードコード値／シートに
// フォールバックして処理を止めない（決定1: docs/実装指示書_Day6_店舗マスタ1箇所化②③.md）。
var STORE_DIRECTORY_URL_ = 'https://uuvsxzhpxtghojoubjcc.supabase.co/rest/v1/store_directory_v?select=*';
var STORE_DIRECTORY_ANON_KEY_ = 'sb_publishable_MrwPJAx_Ws_fdRutprKCiQ_dg3wCiTr';
function fetchStoreDirectory_() {
  var cache = CacheService.getScriptCache();
  var ck = 'store_directory_v1';
  var cached = cache.get(ck);
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  try {
    var res = UrlFetchApp.fetch(STORE_DIRECTORY_URL_, {
      headers: { apikey: STORE_DIRECTORY_ANON_KEY_, Authorization: 'Bearer ' + STORE_DIRECTORY_ANON_KEY_ },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) throw new Error('store_directory_v http ' + res.getResponseCode());
    var rows = JSON.parse(res.getContentText());
    if (!rows || !rows.length) throw new Error('store_directory_v empty');
    var missingWx = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].is_active && (rows[i].weather_lat == null || rows[i].weather_lon == null)) missingWx.push(rows[i].name);
    }
    if (missingWx.length) Logger.log('天気地点 未設定店舗（地域デフォルトにフォールバック）: ' + missingWx.join(', '));
    cache.put(ck, JSON.stringify(rows), 600);
    return rows;
  } catch (e) {
    Logger.log('fetchStoreDirectory_ フォールバック: ' + e);
    return null;
  }
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

  // ① 入金（全期間）→ 店舗ごとの「before より前の入金合計」
  var depByStore = {};
  var depSh = depName ? ss.getSheetByName(depName) : null;
  if (depSh) {
    var dr = readSheet(depSh, 0, 'deposit'), dH = dr[0] || [];
    var dS = depCarryCol_(dH, ['店舗名', '店舗']), dD = depCarryCol_(dH, ['日付', '営業日', '入金日']), dA = depCarryCol_(dH, ['入金額', '入金合計', '入金']);
    for (var r = 1; r < dr.length; r++) {
      var t = depCarryDay_(dr[r][dD]); if (isNaN(t)) continue;
      if (t < before) { var st = String(dr[r][dS] || ''); depByStore[st] = (depByStore[st] || 0) + depCarryNum_(dr[r][dA]); }
    }
  }

  // ② 現金売上（全期間）→ 店舗ごとの「before より前」の現金合計（日別表と同じく全期間を未入金として累計）
  var cashByStore = {};
  var daySh = dailyName ? ss.getSheetByName(dailyName) : null;
  if (daySh) {
    var yr = readSheet(daySh, 0, 'daily'), yH = yr[0] || [];
    var yS = depCarryCol_(yH, ['店舗名', '店舗']), yD = depCarryCol_(yH, ['日付', '営業日', '勤務日', '年月日']), yC = depCarryCol_(yH, ['現金']);
    for (var r2 = 1; r2 < yr.length; r2++) {
      var t2 = depCarryDay_(yr[r2][yD]); if (isNaN(t2)) continue;
      if (t2 < before) { var st2 = String(yr[r2][yS] || ''); cashByStore[st2] = (cashByStore[st2] || 0) + depCarryNum_(yr[r2][yC]); }
    }
  }

  // ③ 店舗ごとに [店舗名, 現金合計, 入金合計] で返す（正規化・スコープ絞りはクライアント側）
  var seen = {}, rows = [];
  for (var k in cashByStore) seen[k] = 1;
  for (var k2 in depByStore) seen[k2] = 1;
  for (var s in seen) rows.push([s, cashByStore[s] || 0, depByStore[s] || 0]);
  return { ok: true, before: p.before, carry: rows };
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
// 2026-09-02修正（重大バグ）: BigQuery.Jobs.query()は1回の呼び出しでは結果の「1ページ目」しか
// 返さない（応答サイズの上限に達すると、まだ行が残っていてもpageTokenを付けて打ち切る）。
// 今まではres.rowsをそのまま使っており、行数が多いテーブル（予約等、データが積み上がって
// 大きくなったテーブル）ではORDER BYの先頭側（古い日付）だけが返り、直近・未来分がごっそり
// 欠落するという実害が出ていた（ユーザー報告「予約帳・予約分析が急に空になった」の根本原因。
// stg_reservationの行数が増えたタイミングで顕在化したとみられる）。pageTokenが無くなるまで
// Jobs.getQueryResults()でページを取り切るよう修正。
function bqRows_(sql) {
  var res = BigQuery.Jobs.query({ query: sql, useLegacySql: false, timeoutMs: 30000 }, BQ_PROJECT);
  if (!res || !res.jobComplete) return null;
  var fields = (res.schema && res.schema.fields) || [];
  var out = [fields.map(function (f) { return f.name; })];
  var rows = res.rows || [];
  for (var i = 0; i < rows.length; i++) out.push(rows[i].f.map(function (c) { return c.v; }));
  var jobId = res.jobReference && res.jobReference.jobId;
  // 2026-09-02追加修正: ジョブが東京リージョン(asia-northeast1)で実行されている場合、
  // Jobs.getQueryResults()にlocationを渡さないと「Not found: Job」で失敗する（既存の
  // Jobs.get()呼び出し箇所と同じ注意点）。res.jobReference.locationを優先し、無ければ
  // このデータセットの既定リージョンにフォールバックする。
  var loc = (res.jobReference && res.jobReference.location) || 'asia-northeast1';
  var pageToken = res.pageToken;
  var guard = 0; // 無限ループ対策（1ページ最低数千行は返る想定のため、これで十分な上限）
  while (pageToken && jobId && guard < 500) {
    guard++;
    var page = BigQuery.Jobs.getQueryResults(BQ_PROJECT, jobId, { pageToken: pageToken, location: loc });
    var prows = page.rows || [];
    for (var j = 0; j < prows.length; j++) out.push(prows[j].f.map(function (c) { return c.v; }));
    pageToken = page.pageToken;
  }
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
// BQモード各アクション(bqDailyStore/bqGetPL/bqGetDeposit/bqGetMedia)共通のキャッシュ（10分・
// 実装指示書_ダッシュボード高速化タスク3）。bqDetailの既存キャッシュと同じ考え方をヘルパー化した。
// キーは呼び出し元ごとに条件（months・店舗権限スコープ等）を含めた文字列をそのままMD5短縮する
// （CacheServiceのキー上限250字対策。担当店舗が多いアカウントだと素の文字列で超えうる）。
function bqCacheKey_(prefix, parts) {
  var raw = prefix + '_' + parts.join('_');
  return raw.length > 200 ? prefix + '_' + md5Hex_(raw) : raw;
}
// PL（stg_pl）は他と違い、書き込み直後に画面に反映されないと「入力したのに消えた」ように見える
// （bqSyncPLで直接同期する設計のため）。世代番号をキャッシュキーに混ぜ、bqSyncPL成功のたびに
// 世代を進めることで、店舗権限スコープごとに何通りもあるキャッシュキーを個別に消さなくても
// 一括で無効化できるようにする（2026-08-23追加）。
function bqCacheGen_(kind) {
  try { return PropertiesService.getScriptProperties().getProperty('BQ_CACHE_GEN_' + kind) || '0'; } catch (e) { return '0'; }
}
function bqCacheGenBump_(kind) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('BQ_CACHE_GEN_' + kind, String((Number(props.getProperty('BQ_CACHE_GEN_' + kind)) || 0) + 1));
  } catch (e) {}
}
// CacheServiceは1キーあたり100KBまでのため、bqDailyStore/bqGetMedia等の全期間・全店舗結果は
// 素の1キーだと簡単に超えてしまい、キャッシュがずっと無効なまま気づかない（実測で発覚・2026-08-23）。
// 長い文字列を複数キーに分割して保存し、読むときに結合する（チャンク数はkey+'_n'に記録）。
function bqCacheGet_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var n = Number(cache.get(key + '_n'));
    if (!n) return null;
    var parts = [];
    for (var i = 0; i < n; i++) {
      var part = cache.get(key + '_' + i);
      if (part == null) return null; // どれか1チャンクでも欠けていたら（TTL境界等）諦めて再取得させる
      parts.push(part);
    }
    var o = JSON.parse(parts.join('')); o.cached = true; return o;
  } catch (e) { return null; }
}
function bqCachePut_(key, obj) {
  try {
    var s = JSON.stringify(obj);
    var CHUNK = 90000; // 日本語（UTF-8で1文字最大3バイト）混在でも100KB/キーに収まる保守的な文字数
    var n = Math.max(1, Math.ceil(s.length / CHUNK));
    if (n > 20) return; // 20チャンク(=文字数ベースで最大180万字)を超える巨大結果はキャッシュ自体を諦める
    var puts = {}; for (var i = 0; i < n; i++) puts[key + '_' + i] = s.slice(i * CHUNK, (i + 1) * CHUNK);
    puts[key + '_n'] = String(n);
    CacheService.getScriptCache().putAll(puts, 600);
  } catch (e) { /* キャッシュに失敗してもBQモード自体は動き続ける */ }
}
// 明細分析のランチ/ディナー絞り込み（2026-08-30追加）用。dinii明細CSVには「営業区分」に相当する列が
// 無い（分類名称・メニュー名等はメニューの種類であって時間帯区分ではない）ため、時刻で判定する。
// 新しくデータ源を増やさず、予約タブの営業時間設定（DB_営業時間・店舗×曜日区分×営業区分×開店/閉店
// 時刻。§storeHoursSheet_）を流用する： 店舗ごとに「営業区分」に"昼"を含む行の閉店時刻の最大値を
// 「その店のランチ→ディナーの境目」とみなす（曜日ごとの違いは無視する簡略化。明細分析は月単位等
// まとまった期間の集計であり、曜日別に厳密に分けると複雑になりすぎるため）。設定が無い店舗は
// 呼び出し側が既定値（16時）にフォールバックする。
// 2026-08-30改良（ユーザー指摘）: 当初は店舗ごとに「昼の部」閉店時刻を1つだけ採用する簡略版だったが、
// 「土日は13時開店でも夜の部（＝ランチにはならない）」という指摘を受け、app.jsのresolveStoreHoursPeriods_
// と同じ優先順位（個別曜日名 > 平日/土日/土日祝 > 空欄既定）で店舗×曜日(0=日〜6=土)ごとに判定するよう
// 変更。その曜日に当てはまる営業時間の中に「昼の部」が無ければ（例:土日が夜の部のみの店）、その曜日は
// 一日中ランチ扱いにしない。祝日の特別営業は今回は対象外（祝トークンは常に非該当として扱う。通常の
// 曜日ルールにフォールバックする＝土日祝は土日と同じ扱いになる）。
function lunchCutoffMatrix_() {
  var sh = storeHoursSheet_();
  var last = sh.getLastRow();
  var byStore = {};
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 6).getValues(); // 店舗,曜日区分,営業区分,開店時刻,閉店時刻,メモ
    for (var i = 0; i < vals.length; i++) {
      var store = String(vals[i][0] || '').trim();
      if (!store) continue;
      var spec = String(vals[i][1] || '').trim();
      var seg = String(vals[i][2] || '').trim();
      var cm = String(rsvTimeCell_(vals[i][4]) || '').match(/(\d{1,2}):(\d{2})/);
      if (!cm) continue; // 閉店時刻が読めない行はスキップ
      (byStore[store] = byStore[store] || []).push({ spec: spec, isLunch: seg.indexOf('昼') >= 0, close: (+cm[1]) + (+cm[2]) / 60 });
    }
  }
  var dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  var out = {};
  for (var store2 in byStore) {
    var rows = byStore[store2];
    var days = [];
    for (var dow = 0; dow <= 6; dow++) {
      var best = -1, group = [];
      for (var ri = 0; ri < rows.length; ri++) {
        var r = rows[ri], score = -1;
        if (!r.spec) score = 0;
        else {
          var tokens = r.spec.split(/[,、\/\s]+/).map(function (t) { return t.trim(); }).filter(Boolean);
          for (var ti = 0; ti < tokens.length; ti++) {
            var t = tokens[ti];
            if (t === '平日') { if (dow >= 1 && dow <= 5) score = Math.max(score, 2); }
            else if (t === '土日' || t === '週末') { if (dow === 0 || dow === 6) score = Math.max(score, 2); }
            else if (t === '土日祝') { if (dow === 0 || dow === 6) score = Math.max(score, 2); } // 祝判定は今回対象外
            else if (t === '祝') { /* 祝日判定は今回対象外のため常に非該当 */ }
            else if (dayNames.indexOf(t) >= 0) { if (dayNames[dow] === t) score = Math.max(score, 3); }
          }
        }
        if (score > best) { best = score; group = [r]; }
        else if (score === best && score >= 0) group.push(r);
      }
      if (best < 0) { days.push(null); continue; } // この曜日に当てはまる営業時間設定が無い
      var lunchRows = group.filter(function (rr) { return rr.isLunch; });
      days.push(lunchRows.length ? { lunchOk: true, cutoff: Math.max.apply(null, lunchRows.map(function (rr) { return rr.close; })) } : { lunchOk: false });
    }
    out[store2] = days;
  }
  return out; // {店舗名: [dow0(日)〜dow6(土)の {lunchOk,cutoff}|{lunchOk:false}|null]}（未設定店舗はキー無し）
}
// 2026-09-02追加（担当D調査・調査レポート_ユーザー報告3件_2026-09-02.md③追記）: 経営ダッシュボードの
// 「営業区分別売上」パネル(app.js segSplit())が使っている分類ロジックのサーバー側移植。DB_媒体分類
// シート（媒体名→入店用途・営業区分の対応表）を読み、app.jsのmediaClassOf()と同じ規則（シート優先・
// 無ければ「ランチ|昼」を含む媒体名だけランチ、それ以外はディナー）で分類する。
// この一覧を変更した場合はapp.jsのmediaClassOf()も合わせて直すこと（DB_媒体分類という同じシートを
// 読んでいるのでロジックの意味は共通・正規表現の実体だけ2箇所に複製している）。
function bqMediaClassMap_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_媒体分類');
  var map = {};
  if (!sh) return map;
  var last = sh.getLastRow();
  if (last < 2) return map;
  var vals = sh.getRange(2, 1, last - 1, 3).getValues();
  for (var i = 0; i < vals.length; i++) {
    var media = String(vals[i][0] || '').trim();
    if (!media) continue;
    map[media] = { use: String(vals[i][1] || '').trim(), seg: String(vals[i][2] || '').trim() };
  }
  return map;
}
function bqMediaSegOf_(map, media) {
  var s = String(media == null ? '' : media).trim();
  var hit = map[s];
  if (hit && hit.seg) return hit.seg;
  return /ランチ|昼/.test(s) ? 'ランチ' : 'ディナー';
}
// bqDetail()の集計ロジックのバージョン。キャッシュキーに含める（2026-09-02追加・担当D提案）。
// 計算式・分類ロジック等、返す数字が変わりうる変更をしたら1つ増やすこと（デプロイ直後に古い
// キャッシュ結果が最大15分残ってしまう混乱を防ぐ）。v2=TK-38（stg_mediaベースの営業区分集計へ変更）。
var BQ_DETAIL_LOGIC_VER = 2;
// 明細分析（対話的）：期間 from〜to・店舗で絞り、時間帯別/商品別/店舗別を集計して返す。
// guests=客数・checks=組数は、店舗別(st)の集計だけレジ実績(fact_daily_store)の実数に差し替える
// （2026-08-23〜。2026-08-30に部分差し替えへ変更）。実績が期間の一部までしか揃っていない場合は、
// 揃っている範囲だけ実績値・残りはdinii明細からの推定を足し合わせる（「今月」表示は既定でtoが
// 月末固定のため、月の途中は必ず一部未来分が推定になる。以前は全期間揃うまで丸ごと推定のままだった）。
// 時間帯別(hour)は日次粒度の実績と紐づけられないため、引き続きお通し数ベースの推定
// （お通し=1人1品の慣習）・明細ベースの会計数のまま。
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
  // 営業区分（ランチ/ディナー）絞り込み（2026-08-30追加・曜日ごとの判定に改良）。dinii明細にはこの
  // 区分の列が無いため、予約タブの営業時間設定（DB_営業時間・§lunchCutoffMatrix_）を店舗×曜日
  // （0=日〜6=土）で流用する。会計時刻(checkout_at)の曜日ごとに「昼の部」があるかどうかを見るため、
  // 「土日は夜の部のみ（13時開店でもランチにならない）」というケースにも対応する。
  var segment = (p.segment === 'lunch' || p.segment === 'dinner') ? p.segment : '';
  if (segment) {
    var defaultCutoff = 16; // 店舗が丸ごと未設定の時だけ使う既定値（曜日を問わず適用）
    var matrix = lunchCutoffMatrix_();
    var sidMap = bqStoreMap_();
    var hourDecExpr = "(EXTRACT(HOUR FROM checkout_at) + EXTRACT(MINUTE FROM checkout_at)/60.0)";
    var dowExpr = "EXTRACT(DAYOFWEEK FROM business_date)"; // BigQuery: 1=日〜7=土
    var storeParts = [];
    for (var sid in sidMap) {
      var snm = sidMap[sid];
      var days = matrix[snm]; // [dow0(日)〜dow6(土)] or undefined（店舗丸ごと未設定）
      var dowExprForStore;
      if (!days) {
        dowExprForStore = hourDecExpr + " < " + defaultCutoff; // 店舗が丸ごと未設定＝曜日を問わず既定値
      } else {
        var dowParts = [];
        for (var dow = 0; dow <= 6; dow++) {
          var info = days[dow];
          var lunchCond = (info && info.lunchOk) ? (hourDecExpr + " < " + info.cutoff) : 'FALSE';
          dowParts.push("WHEN " + (dow + 1) + " THEN " + lunchCond); // BQのDAYOFWEEKは1=日始まり
        }
        dowExprForStore = "(CASE " + dowExpr + " " + dowParts.join(' ') + " ELSE FALSE END)";
      }
      storeParts.push("WHEN store_id='" + String(sid).replace(/'/g, "''") + "' THEN " + dowExprForStore);
    }
    var isLunchExpr = storeParts.length ? "(CASE " + storeParts.join(' ') + " ELSE " + hourDecExpr + " < " + defaultCutoff + " END)" : (hourDecExpr + " < " + defaultCutoff);
    var whereBase = where; // segment条件を付ける前のwhere（客数・組数の按分比の分母クエリで再利用する）
    where += " AND " + (segment === 'lunch' ? isLunchExpr : ("NOT " + isLunchExpr));
  }
  // 集計基準: checkout=会計時(既定) / order=オーダー時(各明細) / arrival=来店時(伝票の最初のオーダー)
  var basis = (p.basis === 'order' || p.basis === 'arrival') ? p.basis : 'checkout';
  // キャッシュ（同じ条件は再クエリしない・15分）。scopeKeyを含め、権限の違うユーザー間でキャッシュが混ざらないようにする。
  var cache = CacheService.getScriptCache();
  // 担当店舗が多いとscopeKey(店舗IDの連結)が長くなりキー上限250字を超える→MD5で短縮する
  // BQ_DETAIL_LOGIC_VERをキーに含める（2026-09-02追加・担当D提案）: TK-38のように計算式自体を
  // 変えるデプロイをした直後、既存の「全店・ディナー」等のキャッシュが最大15分古い計算結果の
  // まま残り、店舗を個別選択したときだけ直って見える、という混乱が実際に起きた。今後、bqDetail()
  // の集計ロジックを変える変更をする時はこの定数を手で1つ増やすこと（デプロイのたびにキャッシュが
  // 自動的に無効化される）。
  var ckRaw = 'det_v' + BQ_DETAIL_LOGIC_VER + '_' + from + '_' + to + '_' + (p.store || 'all') + '_' + basis + '_' + (segment || 'all') + '_' + scopeKey;
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
    if (st) {
      var m = bqStoreMap_();
      // 2026-08-30追加（担当D指摘）: dinii側店舗名(DB_店舗ID対応経由)とfact_daily_store側店舗名
      // (store_aliases正規化済み)の突合が完全一致頼みだった。表記ゆれがあると下のrealMap/tailMapの
      // 突合が静かに外れ（PL画面のresolveStore()と同種のバグ）、その店舗だけ実績への差し替えが
      // 発火しなくなる。既存のbqStoreNameIndex_()/bqResolveStoreName_()（他のBQミラーで実績あり・
      // 取得失敗時は無害にスキップされる設計）で正準化してから使う。
      var snIdx = bqStoreNameIndex_();
      for (var r = 1; r < st.length; r++) { st[r][0] = m[st[r][0]] || st[r][0]; st[r][0] = bqResolveStoreName_(snIdx, st[r][0]); }
      if (st[0]) st[0][0] = '店舗';
      // 客数・組数は、dinii明細の「お通し」注文数からの推定ではなく、レジ実績(fact_daily_store)の
      // 実数に差し替える（2026-08-23変更・ユーザー指摘。Day4のBigQueryミラーで実績が取得できる
      // ようになったため）。店舗名で突合。時間帯別(hour)は日次粒度の実績と紐づけられないため、
      // 引き続きお通し数からの推定のまま。
      try {
        // fact_daily_storeは日次バッチ同期（Mac mini・毎日11時頃）のミラーのため、直近1日以上遅れることがある
        // （同期ホストの再起動等で更に遅れる場合も）。
        // ※単純にMAX(date)を取ると、月末まで日付欄だけ先に埋まっているテンプレート行（実績はまだ0件）を
        //   拾ってしまい、常に「揃っている」と誤判定してガードが機能しなくなる（2026-08-23発覚・reportDataBQと
        //   同じ「実績が入っている行に限定」の対策を流用）。
        var maxRow = bqRows_("SELECT MAX(date) AS d FROM `" + BQ_PROJECT + "." + BQ_SALES_DATASET + ".fact_daily_store` WHERE net_sales > 0 OR guests_total > 0");
        var maxDate = (maxRow && maxRow[1] && maxRow[1][0]) ? String(maxRow[1][0]) : '';
        // 2026-08-30修正（担当D報告・原因: app.js detailRange()の既定「今月」表示はtoを月末固定で
        // 送ってくる＝月の途中は必ずmaxDate<toになる）。従来は「toまで完全に揃っている場合のみ全置換」の
        // all-or-nothingガードだったため、「今月」表示中は実績が1件もあってもほぼ常に発火せず、月全体・
        // 全店が丸ごと推定値のまま表示され続けていた（実害：ダッシュボードと数字が食い違う）。
        // 揃っている範囲[from, min(to,maxDate)]だけ実績値に差し替え、揃っていない残り(maxDate, to]は
        // 従来どおりdinii明細からの推定を足し合わせる部分差し替えに変更（realTo>=fromの時だけ実施。
        // maxDateがfromより前＝その期間はまだ実績が1件も無いなら、従来どおり全体を推定値のままにする）。
        var realTo = (maxDate && maxDate < to) ? maxDate : to;
        // 2026-08-30追加・改良: 当初は営業区分（segment）で絞り込んでいる時はレジ実績への差し替え
        // 自体を行わず明細(dinii)推定のみを返していたが、ユーザーから「全体だと合っているのにディナー
        // だけにすると数字がまたズレる」と指摘され、実績を活かせるよう変更。fact_daily_storeは日次合計
        // のみでランチ/ディナー別を持たないため、①まずこのブロックでフルデイ（営業区分を問わない）の
        // 実績＋推定の合計（day*）を出し、②segmentがある時だけ、明細(dinii)から算出した「その区分の
        // 構成比」（絞り込み後の推定÷フルデイの推定）をday*に掛けて按分する（下のfor文内）。
        if (maxDate && realTo >= from) {
          var realWhere = "WHERE date BETWEEN DATE('" + from + "') AND DATE('" + realTo + "')";
          if (restricted) {
            realWhere += " AND store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "')";
          } else if (p.store && p.store !== 'all') {
            realWhere += " AND store_name = '" + String(p.store).replace(/'/g, "''") + "'";
          }
          // 純売上(net_sales)は税抜(PLのFL比計算等で使われているのと同じ前提)。税込は概算(×1.1)で埋める。
          var real = bqRows_("SELECT store_name, SUM(guests_total) guests, SUM(parties_total) checks, SUM(net_sales) sales_excl FROM `" + BQ_PROJECT + "." + BQ_SALES_DATASET + ".fact_daily_store` " + realWhere + " GROUP BY store_name");
          // realTo<to（＝実績が期間の終端まで揃っていない）の場合、揃っていない残り(realTo, to]分だけ
          // dinii明細から同じ推定ロジックで計算し、実績に足し合わせる（store_idの明細をstore_name突合するため
          // bqStoreMap_()で変換）。realTo>=to（全期間揃っている）ならtailは空のままでよい。
          var tailMap = {};
          if (realTo < to) {
            var tailWhere = "WHERE business_date > DATE('" + realTo + "') AND business_date <= DATE('" + to + "')";
            if (restricted) {
              tailWhere += " AND store_id IN ('" + allowIds.join("','") + "')";
            } else if (p.store && p.store !== 'all') {
              var tid = reverseStoreId_(p.store);
              if (tid) tailWhere += " AND store_id = '" + String(tid).replace(/'/g, '') + "'";
            }
            var tail = bqRows_("SELECT store_id, SUM(price_excl*qty) AS sales_excl, " + VCHK + ", " + G + " FROM " + T + " " + tailWhere + " GROUP BY store_id");
            if (tail) {
              var sm = bqStoreMap_();
              for (var ti = 1; ti < tail.length; ti++) {
                var tname = sm[tail[ti][0]] || tail[ti][0];
                tailMap[tname] = { sales_excl: Number(tail[ti][1] || 0), checks: Number(tail[ti][2] || 0), guests: Number(tail[ti][3] || 0) };
              }
            }
          }
          // segmentがある時だけ、按分の分母（その店舗・期間の営業区分を問わないdinii推定合計）を
          // 追加で取得する（whereBase＝segment条件を付ける前のwhere）。stg_media側で実データが
          // 取れる店舗ではこの按分自体を使わなくなる（下のmediaSegMap参照）が、stg_mediaに data が
          // 無い店舗・期間向けのフォールバックとして残す。
          var stFullMap = {};
          if (segment) {
            var stFull = bqRows_("SELECT store_id, SUM(price_excl*qty) AS sales_excl, " + VCHK + ", " + G + " FROM " + T + " " + whereBase + " GROUP BY store_id");
            if (stFull) {
              var m2 = bqStoreMap_(), snIdx2 = bqStoreNameIndex_();
              for (var fi = 1; fi < stFull.length; fi++) {
                var fname = bqResolveStoreName_(snIdx2, m2[stFull[fi][0]] || stFull[fi][0]);
                stFullMap[fname] = { sales_excl: Number(stFull[fi][1] || 0), checks: Number(stFull[fi][2] || 0), guests: Number(stFull[fi][3] || 0) };
              }
            }
          }
          // 2026-09-02追加（担当D調査③追記・経営ダッシュボードと数字が一致しない件への根本対応）:
          // 経営ダッシュボードの「営業区分別売上」パネルはstg_media（媒体ごとの実客数・実売上）を
          // DB_媒体分類で分類して集計しており、上のdinii明細按分（お通し/VCHKベースの推定）とは全く
          // 別のデータ源。segmentがある時は、可能な限りこちらの実データを直接使い、ダッシュボードと
          // 原理的に一致する数字を返す（stg_mediaに対象店舗・期間のデータが無い場合だけ、上の按分に
          // フォールバックする）。
          var mediaSegMap = {};
          if (segment) {
            var mWhere = "WHERE date BETWEEN DATE('" + from + "') AND DATE('" + to + "')";
            if (restricted) {
              mWhere += " AND store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "')";
            } else if (p.store && p.store !== 'all') {
              mWhere += " AND store_name = '" + String(p.store).replace(/'/g, "''") + "'";
            }
            var mRows = bqRows_("SELECT store_name, media_name, SUM(guests) g, SUM(parties) p, SUM(net_sales) s FROM `" +
              BQ_PROJECT + "." + BQ_SALES_DATASET + ".stg_media` " + mWhere + " GROUP BY store_name, media_name");
            if (mRows) {
              var mcMap = bqMediaClassMap_();
              var wantSeg = segment === 'lunch' ? 'ランチ' : 'ディナー';
              for (var mi = 1; mi < mRows.length; mi++) {
                var mr = mRows[mi];
                if (bqMediaSegOf_(mcMap, mr[1]) !== wantSeg) continue;
                var mStore = String(mr[0] || '').trim();
                var acc = mediaSegMap[mStore] || { guests: 0, checks: 0, sales_excl: 0 };
                acc.guests += Number(mr[2] || 0); acc.checks += Number(mr[3] || 0); acc.sales_excl += Number(mr[4] || 0);
                mediaSegMap[mStore] = acc;
              }
            }
          }
          if (real) {
            var realMap = {};
            for (var ri = 1; ri < real.length; ri++) realMap[real[ri][0]] = { guests: Number(real[ri][1] || 0), checks: Number(real[ri][2] || 0), sales_excl: Number(real[ri][3] || 0) };
            for (var si = 1; si < st.length; si++) {
              var rm = realMap[st[si][0]];
              if (!rm) continue; // その店舗の実績行が1件も無い（新規店舗等）ならこれまでどおり全期間推定のまま
              var tm = tailMap[st[si][0]] || { guests: 0, checks: 0, sales_excl: 0 };
              // フルデイ（営業区分を問わない）の「揃っている範囲は実績値・揃っていない残りはdinii明細
              // からの推定」を合算
              var dayChecks = rm.checks + tm.checks;
              var dayGuests = rm.guests + tm.guests;
              var daySalesExcl = rm.sales_excl + tm.sales_excl;
              // segChecks0/oldExclは「絞り込み後（segment適用済み）」のdinii明細推定・按分前の値
              // （2026-09-02修正でsegGuests0=お通しベースの絞り込み後客数推定は未使用になったため削除）
              var segChecks0 = Number(st[si][3]) || 0;
              var oldExcl = Number(st[si][2]) || 0;
              var finalChecks, finalGuests, finalSalesExcl;
              if (segment) {
                var msm = mediaSegMap[st[si][0]];
                if (msm && (msm.guests > 0 || msm.sales_excl > 0)) {
                  // 2026-09-02修正（担当D調査③追記・経営ダッシュボードと数字が一致しない件）: dinii明細
                  // からの按分ではなく、stg_media（経営ダッシュボードのsegSplit()と同じ実データ源）を
                  // 直接使う。按分ではなく実測値そのものなので、原理的にダッシュボードと一致する。
                  finalChecks = msm.checks; finalGuests = msm.guests; finalSalesExcl = msm.sales_excl;
                } else {
                  // stg_mediaにこの店舗・期間のデータが無い場合だけ、従来のdinii明細按分にフォールバック。
                  var full = stFullMap[st[si][0]];
                  if (!full || !(full.checks > 0) || !(full.sales_excl > 0)) continue; // 按分の材料も無ければこの店舗はdinii推定のまま触らない
                  // 客数・組数・売上のいずれも「絞り込み後の推定 ÷ フルデイの推定」＝その区分の構成比を
                  // フルデイの実績（dayChecks等）に掛けて按分する。客数按分は会計数（VCHK）ベースの
                  // 構成比を使う（お通し数ベースだとランチが常に0になっていたため。2026-09-02修正）。
                  finalChecks = dayChecks * (segChecks0 / full.checks);
                  finalGuests = dayGuests * (segChecks0 / full.checks);
                  finalSalesExcl = daySalesExcl * (oldExcl / full.sales_excl);
                }
              } else {
                finalChecks = dayChecks; finalGuests = dayGuests; finalSalesExcl = daySalesExcl;
              }
              st[si][3] = Math.round(finalChecks); st[si][4] = Math.round(finalGuests);
              // 売上も同様に按分・合算。明細(dinii)は一部の売上しか拾えておらず店舗によっては実績の
              // 6〜7割程度しか積み上がらないと判明済み（2026-08-23）のため、ドリンク/フード/カラオケの
              // 内訳は明細からしか出せない前提で、内訳どうしの構成比は維持したまま合計が上の
              // finalSalesExclに一致するよう比例配分し直す（oldExclは絞り込み後のdinii推定の元の合計）。
              var scale = oldExcl > 0 ? (finalSalesExcl / oldExcl) : 1;
              st[si][5] = Math.round((Number(st[si][5]) || 0) * scale); // ドリンク
              st[si][6] = Math.round((Number(st[si][6]) || 0) * scale); // カラオケ
              st[si][7] = Math.round((Number(st[si][7]) || 0) * scale); // フード
              st[si][2] = Math.round(finalSalesExcl);                   // 売上（税別）
              st[si][1] = Math.round(finalSalesExcl * 1.1);             // 売上（税込・概算＝税別×1.1）
            }
          }
        }
      } catch (eReal) { /* 実績が取れなければ従来の推定値のまま（BQエラー等で明細分析自体を止めない） */ }
    }
    var hourItem = bqRows_("SELECT EXTRACT(HOUR FROM " + hourCol + ") AS hour, menu, SUM(qty) AS qty, SUM(sales_incl) AS sales FROM " + hiFrom + " " + hiWhere + " GROUP BY hour, menu");
    var res = { ok: true, hour: hour || [], item: item || [], store: st || [], hourItem: hourItem || [], basis: basis, segment: segment || '' };
    try { cache.put(ck, JSON.stringify(res), 900); } catch (e3) { /* 100KB超はキャッシュしない */ }
    return res;
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// ===== 推移分析タブ用: 分析_日別店舗のBigQueryミラー(fact_daily_store)から読む =====
// 2026-08-22 データ基盤ロードマップ Phase4「切替」。タブ単位のデータソース切替の第一弾。
// bqDetailと同じ方針（ログイン必須・session.storesで店舗スコープ制限）。
// 既存の`action:'data'`が返す sheets.daily と同じ形（ヘッダー行＋データ行の2次元配列、
// ヘッダーはingestDaily()がキーワードで検出する日本語ラベル）で返すことで、
// クライアント側のingestSheets()/ingestDaily()/viewAnalysis()を一切変更せずに済む設計。
var BQ_DAILY_STORE_HEADER = ['日付', '店舗名', '純売上', '総客数', 'アルバイト人件費', '社員人件費', '人件費合計', '仕入', '現金', '社員給与賞与', '法定福利費', '通勤手当', '組数'];
function bqDailyStore(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var where = '';
    if (restricted) {
      var allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!allowNames.length) return { ok: true, sheets: { daily: [BQ_DAILY_STORE_HEADER] } };
      where = "WHERE store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "')";
    }
    var months = Number(p.months) || 0;
    if (months > 0) {
      var cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
      var cutoffStr = Utilities.formatDate(cutoff, 'Asia/Tokyo', 'yyyy-MM-dd');
      where += (where ? ' AND ' : 'WHERE ') + "date >= DATE('" + cutoffStr + "')";
    }
    var ck = bqCacheKey_('dailystore', [months, restricted ? allowNames.slice().sort().join('.') : 'all']);
    var cached = bqCacheGet_(ck);
    if (cached) return cached;
    var sql = 'SELECT date, store_name, net_sales, guests_total, parttime_labor_cost, fulltime_labor_cost, ' +
      'labor_cost_total, cogs, cash, employee_salary_bonus, statutory_welfare, commute_allowance, parties_total ' +
      'FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store` ' + where + ' ORDER BY date';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var out = [BQ_DAILY_STORE_HEADER];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      out.push([
        String(r[0]).replace(/-/g, '/'), // DATE型は'YYYY-MM-DD'文字列で返るため、シート版と同じ'YYYY/MM/DD'に変換
        r[1],
        Number(r[2] || 0), Number(r[3] || 0), Number(r[4] || 0), Number(r[5] || 0),
        Number(r[6] || 0), Number(r[7] || 0), Number(r[8] || 0),
        Number(r[9] || 0), Number(r[10] || 0), Number(r[11] || 0), Number(r[12] || 0)
      ]);
    }
    var res = { ok: true, sheets: { daily: out } };
    bqCachePut_(ck, res);
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
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

// ===== 売上サマリ(分析_日別店舗ほか)のBigQueryミラー =====
// 2026-08-22 追加（データ基盤ロードマップ Phase 3「売上」）。
// 「売上DB」プロジェクト(コード.gs/取込WebApp.gs/分析集計.gs)は一切変更しない。
// 既にSALES_DB_ID(下記)でクロス参照している「売上DB」スプレッドシートの4DBシートと、
// このプロジェクトがローカルに持つ「分析_日別店舗」(=最終集計値・実質的な正本)を、
// そのままBigQueryへミラーする（12個の取込ジョブ自体・GAS集計ロジックには一切手を入れない）。
// 「社員人件費DB」はレイアウトが非標準(データがrow25から始まる等)のためミラー対象外
// （その集計結果は分析_日別店舗の「社員給与賞与/法定福利費/通勤手当」列に反映済みのため）。
var BQ_SALES_DATASET = 'sales';

var BQ_FACT_DAILY_STORE_SCHEMA = [
  { name: 'date', type: 'DATE' }, { name: 'year_month', type: 'STRING' },
  { name: 'year', type: 'INTEGER' }, { name: 'month', type: 'INTEGER' },
  { name: 'week_start', type: 'DATE' }, { name: 'week_key', type: 'STRING' },
  { name: 'weekday', type: 'STRING' },
  { name: 'prev_year_same_day', type: 'DATE' }, { name: 'prev_year_same_week_day', type: 'DATE' },
  { name: 'store_name', type: 'STRING' }, { name: 'sort_order', type: 'INTEGER' },
  { name: 'guests_in', type: 'INTEGER' }, { name: 'parties_in', type: 'INTEGER' },
  { name: 'guests_out', type: 'INTEGER' }, { name: 'parties_out', type: 'INTEGER' },
  { name: 'guests_total', type: 'INTEGER' }, { name: 'parties_total', type: 'INTEGER' },
  { name: 'net_sales', type: 'NUMERIC' }, { name: 'payment_total', type: 'NUMERIC' },
  { name: 'cash', type: 'NUMERIC' }, { name: 'points', type: 'NUMERIC' },
  { name: 'credit', type: 'NUMERIC' }, { name: 'other_payment', type: 'NUMERIC' },
  { name: 'parttime_labor_cost', type: 'NUMERIC' }, { name: 'fulltime_labor_cost', type: 'NUMERIC' },
  { name: 'labor_cost_total', type: 'NUMERIC' }, { name: 'cogs', type: 'NUMERIC' },
  { name: 'labor_cost_ratio', type: 'FLOAT64' }, { name: 'cogs_ratio', type: 'FLOAT64' },
  { name: 'fl_ratio', type: 'FLOAT64' },
  { name: 'sales_per_guest', type: 'NUMERIC' }, { name: 'sales_per_party', type: 'NUMERIC' },
  { name: 'employee_salary_bonus', type: 'NUMERIC' }, { name: 'statutory_welfare', type: 'NUMERIC' },
  { name: 'commute_allowance', type: 'NUMERIC' }
];
var BQ_STG_PAYMENT_SCHEMA = [
  { name: 'store_name', type: 'STRING' }, { name: 'business_date', type: 'DATE' },
  { name: 'guests_in', type: 'INTEGER' }, { name: 'parties_in', type: 'INTEGER' },
  { name: 'guests_out', type: 'INTEGER' }, { name: 'parties_out', type: 'INTEGER' },
  { name: 'net_sales', type: 'NUMERIC' }, { name: 'payment_total', type: 'NUMERIC' },
  { name: 'cash', type: 'NUMERIC' }, { name: 'points', type: 'NUMERIC' },
  { name: 'credit', type: 'NUMERIC' }, { name: 'emoney', type: 'NUMERIC' },
  { name: 'credit_sale', type: 'NUMERIC' }, { name: 'gift_cert', type: 'NUMERIC' },
  { name: 'qr_payment', type: 'NUMERIC' }, { name: 'mobile_payment', type: 'NUMERIC' },
  { name: 'campaign', type: 'NUMERIC' }, { name: 'other', type: 'NUMERIC' }
];
var BQ_STG_MEDIA_SCHEMA = [
  { name: 'store_name', type: 'STRING' }, { name: 'date', type: 'DATE' },
  { name: 'media_name', type: 'STRING' }, { name: 'guests', type: 'INTEGER' },
  { name: 'parties', type: 'INTEGER' }, { name: 'net_sales', type: 'NUMERIC' },
  { name: 'gross_sales', type: 'NUMERIC' }, { name: 'unit_price', type: 'NUMERIC' }
];
var BQ_STG_SIIRE_SCHEMA = [
  { name: 'store_name', type: 'STRING' }, { name: 'date', type: 'DATE' },
  { name: 'amount', type: 'NUMERIC' }, { name: 'year_month', type: 'STRING' }
];
var BQ_STG_JINKEN_SCHEMA = [
  { name: 'store_name', type: 'STRING' }, { name: 'work_date', type: 'DATE' },
  { name: 'employee_name', type: 'STRING' }, { name: 'worked_hours', type: 'FLOAT64' },
  { name: 'wage_total', type: 'NUMERIC' }, { name: 'transport_allowance', type: 'NUMERIC' },
  { name: 'total_amount', type: 'NUMERIC' }
];
// 2026-08-22 追加（Day5「入金管理タブの切替」）。入金DBはこのプロジェクトのローカルシートだが、
// readSheet()のコメントにある「1行目に空行が入った」事故の影響が残っており、
// 2行目が本当のヘッダー・3行目からがデータ（実際にstartRow:2でCSVロードしエラーになり判明）。
// A店舗 B日付 C入金額 D摘要 E取引時刻 F取込日時のうち表示に使うA〜Dだけをミラー
// （E/F取込管理用の列はCSV取込機能側がシートを直接読むため対象外）。
var BQ_STG_DEPOSIT_SCHEMA = [
  { name: 'store_name', type: 'STRING' }, { name: 'date', type: 'DATE' },
  { name: 'amount', type: 'NUMERIC' }, { name: 'memo', type: 'STRING' }
];
// スポット人件費（2026-08-23追加）。DB_スポット人件費のA〜H列と1対1対応（I列のIDはミラー対象外＝
// schema.length=8列だけを先頭から読むbqSheetToCsv_の仕様上、ID列はスキーマに含めないことで自動的に除外される）。
var BQ_STG_SPOT_SCHEMA = [
  { name: 'work_date', type: 'DATE' }, { name: 'store_name', type: 'STRING' },
  { name: 'kind', type: 'STRING' }, { name: 'amount', type: 'NUMERIC' },
  { name: 'headcount', type: 'NUMERIC' }, { name: 'memo', type: 'STRING' },
  { name: 'entered_by', type: 'STRING' }, { name: 'entered_at', type: 'STRING' },
  { name: 'id', type: 'STRING' }   // I列。2026-08-24追加: BQモードで編集・削除するのに必須（元は含めておらずIDが取れない不具合があった）
];
// 銀行借入 返済元金（簡易キャッシュフロー用。2026-08-26追加・A-5）。DB_借入返済元金のA〜E列と1対1対応。
var BQ_STG_LOAN_SCHEMA = [
  { name: 'year_month', type: 'STRING' }, { name: 'store_name', type: 'STRING' },
  { name: 'corp_name', type: 'STRING' }, { name: 'principal_amount', type: 'NUMERIC' },
  { name: 'memo', type: 'STRING' }
];

// ================== 予約（stg_reservation。2026-08-28追加・A-6） ==================
// I-1（レーンI・担当D兼任・ns-daily-import）が食べログノート/ダイニー予約台帳から日次で
// Supabase「rsv_reservations」へ書き込み済み（Sync4宣言済み・WORKLOG 2026-08-28参照）。
// ここではそれをBigQueryへミラーする。他のsales系ミラーと同じ「毎回WRITE_TRUNCATE全置換」方針だが、
// データ源がこのプロジェクトのスプレッドシートではなくSupabase（外部REST API）のため、
// bqSheetToCsv_の代わりにUrlFetchAppで取得してからCSV化する点が異なる。
// 個人情報（予約メモ・お客様名・お客様名フリガナ）はBQに入れない（設計書§8.4の方針。Supabase側限定）。
var BQ_RESERVATION_SCHEMA = [
  { name: 'reservation_key', type: 'STRING' }, { name: 'store_id', type: 'STRING' },
  { name: 'source', type: 'STRING' }, { name: 'store_account', type: 'STRING' },
  { name: 'source_month', type: 'DATE' }, { name: 'visit_date', type: 'DATE' },
  { name: 'visit_time', type: 'STRING' }, { name: 'stay_duration_min', type: 'INTEGER' },
  { name: 'party_size', type: 'INTEGER' }, { name: 'child_count', type: 'INTEGER' },
  { name: 'status_raw', type: 'STRING' }, { name: 'status_normalized', type: 'STRING' },
  { name: 'channel_raw', type: 'STRING' }, { name: 'channel_normalized', type: 'STRING' },
  { name: 'table_no', type: 'STRING' }, { name: 'course', type: 'STRING' },
  { name: 'menu', type: 'STRING' }, { name: 'attribute', type: 'STRING' },
  { name: 'tag', type: 'STRING' }, { name: 'customer_no', type: 'STRING' },
  { name: 'vpoint', type: 'STRING' }, { name: 'created_at_source', type: 'TIMESTAMP' },
  { name: 'cancel_at', type: 'TIMESTAMP' }, { name: 'first_imported_at', type: 'TIMESTAMP' },
  { name: 'cancel_detected_at', type: 'TIMESTAMP' }, { name: 'imported_at', type: 'TIMESTAMP' }
];
// bqCsvCell_はSTRING/DATE/INTEGER/NUMERIC/FLOAT64のみ対応でTIMESTAMPを扱えないため専用に用意。
function bqReservationCsvCell_(v, type) {
  if (v === '' || v === null || v === undefined) return '';
  if (type === 'STRING') return '"' + String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  if (type === 'DATE') return String(v).slice(0, 10);
  if (type === 'TIMESTAMP') {
    // 2026-08-30 ユーザー報告で発覚したバグの修正（再調査で原因を訂正）: ns-daily-import側
    // （食べログノート/ダイニー両方のtoIsoDate系ヘルパー）は「作成日+作成時間」等をタイムゾーン
    // 情報の無いISO文字列（例:"2026-08-28T16:08:00"。これは日本時間の壁時計表記そのもの）として
    // Supabaseへ書き込んでいる。Supabaseのtimestamptz列は、オフセット無しの文字列を保存時に
    // UTCとして解釈するため、実際は日本時間16:08の値が「UTCの16:08」として保存されてしまい、
    // REST APIで読み出すと"...T16:08:00+00:00"のように**桁は元のまま・タグだけ（誤って）UTC**という
    // 形で返ってくる（診断用の一時アクションでSupabaseの生値を直接確認して特定。当初は「タイムゾーン
    // タグが無ければ+09:00を付与」という修正を入れたが、この+00:00タグが既に付いているケースを
    // 見逃しており効果が無かった）。そのままBigQueryへ渡すと、BigQueryは"+00:00"を素直に信用して
    // 正しくUTCの16:08として保存し、表示時にFORMAT_TIMESTAMP(...,'Asia/Tokyo')で更に+9時間され、
    // 実質+9時間ズレる（21時以降作成の予約は「作成日」が翌日になる）。
    // 対策: 既存のタイムゾーン表記が何であれ取り除き、日付・時刻の桁（＝日本時間の壁時計表記）は
    // そのまま、タグだけ常に日本時間（+09:00）に付け直してからBigQueryへ渡す。
    var ts = String(v).trim();
    if (!ts) return '';
    var m = ts.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
    if (!m) return ts; // 想定外の形式はそのまま渡す（パースできない値をここで握りつぶさない）
    return m[1] + 'T' + m[2] + '+09:00';
  }
  var n = Number(v);
  if (!isFinite(n)) return '';
  return type === 'INTEGER' ? String(Math.round(n)) : n.toFixed(6);
}
// Supabase rsv_reservationsを全件取得（1000件ずつRangeヘッダーでページング）。
// 認証情報はGASのScript Properties（SUPABASE_URL/SUPABASE_SERVICE_KEY）に別途登録が必要
// （コードには書かない。値はns-daily-importの.envと同じものを使えばよい）。
function bqFetchReservationRows_() {
  var supaUrl = PropertiesService.getScriptProperties().getProperty('SUPABASE_URL');
  var supaKey = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY');
  if (!supaUrl || !supaKey) throw new Error('Script PropertiesにSUPABASE_URL/SUPABASE_SERVICE_KEYが未設定です');
  var cols = BQ_RESERVATION_SCHEMA.map(function (f) { return f.name; }).join(',');
  var pageSize = 1000, offset = 0, all = [];
  while (true) {
    var res = UrlFetchApp.fetch(
      supaUrl + '/rest/v1/rsv_reservations?select=' + encodeURIComponent(cols) +
      '&order=source_month.asc,store_account.asc,reservation_key.asc',
      { headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey, Range: offset + '-' + (offset + pageSize - 1) },
        muteHttpExceptions: true }
    );
    var code = res.getResponseCode();
    if (code !== 200 && code !== 206) throw new Error('Supabase取得失敗[' + code + ']: ' + res.getContentText().slice(0, 300));
    var rows = JSON.parse(res.getContentText() || '[]');
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
// 予約のstore_idはSupabase `stores`テーブル（id/name列）の物理店舗UUID（設計書§8.4・I-1実装済み）。
// dinii.orders用の`bqStoreMap_()`（GASのDB_店舗ID対応シート）とは別のID体系のため流用できない
// （2026-08-28 ユーザー報告「店舗を選ぶとカレンダーに何も出ない」で発覚・混同していたバグを修正）。
// サブブランド（うお蔵→黒霧屋新横浜等）はstoresテーブル側で既に物理店舗に解決済みのため、
// ここでの店舗名対応表への追加対応は不要。
function rsvStoreMap_() {
  var map = {};
  var supaUrl = PropertiesService.getScriptProperties().getProperty('SUPABASE_URL');
  var supaKey = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY');
  if (!supaUrl || !supaKey) return map;
  try {
    var res = UrlFetchApp.fetch(supaUrl + '/rest/v1/stores?select=id,name', {
      headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey }, muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      var rows = JSON.parse(res.getContentText() || '[]');
      rows.forEach(function (r) { map[r.id] = r.name; });
    }
  } catch (e) { /* 取得失敗時はstore_idをそのまま表示（bqGetReservation側のフォールバック） */ }
  return map;
}
// 書き込み: token認証・ログイン不要（bqSyncSales等と同じ）。ns-daily-import側の日次スケジュールから
// 予約取込の後に呼んでもらう想定（担当Dへの依頼。WORKLOG該当エントリ参照）。
function bqSyncReservation(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  try {
    var rows = bqFetchReservationRows_();
    var lines = rows.map(function (r) {
      return BQ_RESERVATION_SCHEMA.map(function (f) { return bqReservationCsvCell_(r[f.name], f.type); }).join(',');
    });
    var res = bqLoadSheetToTable_(lines.join('\n'), 'stg_reservation', BQ_RESERVATION_SCHEMA);
    if (res && res.ok) bqCacheGenBump_('reservation');
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
// 読み取り: ログイン必須・店舗スコープ制限。stg_reservationのstore_idはSupabase `stores`テーブルのUUID
// のため、rsvStoreMap_()（Supabase直参照）で店舗名に変換する（bqStoreMap_ではない。上部コメント参照）。
// 既定はキャンセル系ステータス(status_normalizedがcancelled_*)を除外（p.includeCancelled='true'で分析用に全件）。
function bqGetReservation(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var storeMap = rsvStoreMap_();
    var allowIds = [];
    if (restricted) {
      var allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      for (var id in storeMap) { if (allowNames.indexOf(storeMap[id]) >= 0) allowIds.push(id); }
    }
    var includeCancelled = String(p.includeCancelled) === 'true';
    var HEADERS = ['予約No', '店舗ID', '店舗', '取込元', '来店日', '来店時間', '滞在時間', '人数', 'お子様人数',
      'ステータス', 'ステータス正規化', '受付窓口', '受付窓口正規化', '卓', 'コース', 'メニュー', '予約属性', 'タグ',
      '顧客No', '作成日時', 'キャンセル日時'];
    // キーは'予約'にしない: 既存isRsvKey()が完全一致'予約'をヒットさせ、旧シート取込ingestRsv()が
    // 誤ってこのBQデータを解釈してD.rsv（手動CSV取込側）を上書きしてしまう（設計書§8.9の並行稼働・
    // 比較確認の方針に反する）。新タブ専用の別データとして明確に分離する。
    if (restricted && !allowIds.length) return { ok: true, sheets: { reservationBq: [HEADERS] } };

    var ck = bqCacheKey_('reservation', [bqCacheGen_('reservation'), includeCancelled ? 'all' : 'active',
      restricted ? allowIds.slice().sort().join('.') : 'all']);
    var cached = bqCacheGet_(ck);
    if (cached) return cached;

    var cols = ['reservation_key', 'store_id', 'source', 'visit_date', 'visit_time', 'stay_duration_min',
      'party_size', 'child_count', 'status_raw', 'status_normalized', 'channel_raw', 'channel_normalized',
      'table_no', 'course', 'menu', 'attribute', 'tag', 'customer_no', 'created_at_source', 'cancel_at'];
    var where = [];
    if (restricted) where.push("store_id IN ('" + allowIds.map(function (id) { return String(id).replace(/'/g, "''"); }).join("','") + "')");
    if (!includeCancelled) where.push("status_normalized NOT LIKE 'cancelled%'");
    // 一時的な措置（2026-08-28・ユーザー確認済み）: 別々に取得したデータが同じ物理店舗（store_id）へ
    // 合算される構造のため、同一予約が両方に記録されている可能性がある（設計書§8.8 R1「初回突合必須」
    // がまだ未実施）。突合が済むまでは予約帳の運用上メインの表記（匠味川崎/匠味新横浜/うお蔵新横浜）
    // 側を残し、鶏武者川崎店/鶏武者新横浜/黒霧屋新横浜側を除外する（2026-08-28ユーザー訂正: 当初逆に
    // 実装していた）。突合完了後はこの制限を外し、必要ならp.includeSubBrand='true'で一時的に含める
    // 切替を追加する想定。
    var EXCLUDE_ACCOUNTS = ['鶏武者 川崎店', '鶏武者 新横浜', '黒霧屋 新横浜'];
    if (String(p.includeSubBrand) !== 'true') {
      where.push("store_account NOT IN ('" + EXCLUDE_ACCOUNTS.map(function (n) { return n.replace(/'/g, "''"); }).join("','") + "')");
    }
    var whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // created_at_source/cancel_atはTIMESTAMP型のため、素のままSELECTするとBigQuery REST APIが
    // エポック秒の数値文字列（例:"1774607400"）を返してしまい、クライアント側の日付解析が全く
    // 効かない（2026-08-28 ユーザー報告「当日予約が常に0」の原因＝当日判定が一度も成立しなかった）。
    // FORMAT_TIMESTAMPで明示的に読める日時文字列に変換してから返す。
    var selectCols = cols.map(function (c) {
      if (c === 'created_at_source' || c === 'cancel_at') {
        return "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', " + c + ", 'Asia/Tokyo') AS " + c;
      }
      return c;
    });
    var sql = 'SELECT ' + selectCols.join(', ') + ' FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_reservation` ' +
      whereSql + ' ORDER BY visit_date, visit_time';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };

    var out = [HEADERS];
    for (var i = 1; i < rows.length; i++) {
      var rec = {};
      cols.forEach(function (c, idx) { rec[c] = rows[i][idx]; });
      out.push([
        rec.reservation_key, rec.store_id, storeMap[rec.store_id] || rec.store_id, rec.source,
        rec.visit_date, rec.visit_time,
        rec.stay_duration_min == null ? '' : Number(rec.stay_duration_min),
        rec.party_size == null ? '' : Number(rec.party_size),
        rec.child_count == null ? '' : Number(rec.child_count),
        rec.status_raw, rec.status_normalized, rec.channel_raw, rec.channel_normalized,
        rec.table_no, rec.course, rec.menu, rec.attribute, rec.tag, rec.customer_no,
        rec.created_at_source, rec.cancel_at
      ]);
    }
    var res = { ok: true, sheets: { reservationBq: out } };
    bqCachePut_(ck, res);
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// A-6 Phase2: お客様名の取得（2026-08-31追加）。ログイン必須・店舗スコープ制限
// （bqGetReservationと全く同じ絞り込み方式を使う＝閲覧できる範囲は予約データ本体と同じ）。
// 個人情報（customer_name/customer_name_kana）はBigQueryミラーに一切入れていない
// （設計書§8.4・§8.7）ため、都度Supabase rsv_reservationsへ直接・必要な予約IDぶんだけ問い合わせる。
// ダイニー予約台帳（source='dinii'）以外は元データに名前列が無いため常に空を返す。
// p.keys: カンマ区切りのreservation_key（最大200件・詳細モーダルで1件ずつ呼ぶ想定だが複数もOK）。
function bqGetReservationNames(p, session) {
  var keys = String((p || {}).keys || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 200);
  if (!keys.length) return { ok: true, names: {} };
  var sessStores = String(session && session.stores || '').trim();
  var restricted = sessStores && sessStores !== '全店';
  var allowIds = [];
  if (restricted) {
    var storeMap = rsvStoreMap_();
    var allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
    for (var id in storeMap) { if (allowNames.indexOf(storeMap[id]) >= 0) allowIds.push(id); }
    if (!allowIds.length) return { ok: true, names: {} };
  }
  var supaUrl = PropertiesService.getScriptProperties().getProperty('SUPABASE_URL');
  var supaKey = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY');
  if (!supaUrl || !supaKey) return { ok: false, error: 'Script PropertiesにSUPABASE_URL/SUPABASE_SERVICE_KEYが未設定です' };
  try {
    var keyList = keys.map(function (k) { return '"' + String(k).replace(/"/g, '').replace(/,/g, '') + '"'; }).join(',');
    var qs = 'select=reservation_key,customer_name,customer_name_kana,store_id&source=eq.dinii&reservation_key=in.(' + keyList + ')';
    if (restricted) qs += '&store_id=in.(' + allowIds.join(',') + ')';
    var res = UrlFetchApp.fetch(supaUrl + '/rest/v1/rsv_reservations?' + qs, {
      headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey }, muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'Supabase取得失敗[' + res.getResponseCode() + ']: ' + res.getContentText().slice(0, 200) };
    var rows = JSON.parse(res.getContentText() || '[]');
    var names = {};
    rows.forEach(function (r) { names[r.reservation_key] = { name: r.customer_name || '', kana: r.customer_name_kana || '' }; });
    return { ok: true, names: names };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 予約タブの日別タイムライン用: 店舗ごとの卓（テーブル）一覧（2026-08-28追加・A-6）。
// rsv_reservations/stg_reservationには「その日実際に使われた卓番号」しか無く、空席（その日
// 予約が無い卓）を含めた店舗の卓構成そのものはどこにも無いため、ユーザーが直接入力するシートを新設。
function seatMasterSheet_() {
  var sh = sheetOrCreate_('DB_席マスタ', ['店舗', '卓番号', '席数', 'エリア', '表示順', '属性', '配置X', '配置Y'],
    '予約タブの日別タイムラインに、その日予約が無い卓（空席）も含めて表示するための一覧です。1行=1卓。\n' +
    '「店舗」はダッシュボードの店舗名と完全に一致させてください（例: 鶏武者 新横浜）。\n' +
    '「エリア」「表示順」「属性」「配置X」「配置Y」は空欄でも構いません（表示順が空の行は卓番号順で並びます）。\n' +
    '「属性」は個室・禁煙・喫煙・座敷・テラス等をカンマ区切りで（例: 個室,禁煙）。バッジとして表示されます。\n' +
    '「配置X」「配置Y」は店舗の「配置図」タブに卓を並べる位置（左から何列目・上から何行目。1,2,3...の\n' +
    '整数）。両方とも空欄の卓は、配置図の中で自動的に余ったマスに並びます。');
  // 2026-08-28/29追記: 既に運用中のシートに列が無ければ末尾に追加（新規作成時は上のsheetOrCreate_で入っている）
  var lastCol = sh.getLastColumn();
  if (lastCol >= 1) {
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v); });
    ['属性', '配置X', '配置Y'].forEach(function (col) {
      var lc = sh.getLastColumn();
      var hs = sh.getRange(1, 1, 1, lc).getValues()[0].map(function (v) { return String(v); });
      if (hs.indexOf(col) < 0) {
        sh.getRange(1, lc + 1).setValue(col).setFontWeight('bold').setBackground('#efe9dd');
        sh.setColumnWidth(lc + 1, col === '属性' ? 160 : 70);
      }
    });
  }
  return sh;
}
// 店舗ごとの営業時間（2026-08-28追加・A-6）。予約タブのタイムライン表示範囲を店舗ごとに変える。
function storeHoursSheet_() {
  var sh = sheetOrCreate_('DB_営業時間', ['店舗', '曜日区分', '営業区分', '開店時刻', '閉店時刻', 'メモ'],
    '予約タブの日別タイムラインで、店舗ごとに表示する時間帯を設定します。同じ店舗で曜日によって\n' +
    '時間が違う場合は、行を分けて入力してください（1行=1パターン）。\n' +
    '「曜日区分」は 平日／土日／土日祝／祝／月・火・水・木・金・土・日 のいずれか（空欄=他のどの行にも\n' +
    '当てはまらない日の既定値）。カンマ区切りで複数指定も可（例: 土,日）。祝日は内蔵の祝日カレンダーで\n' +
    '自動判定するので個別入力は不要です。複数の行が同じ日に当てはまる場合は、より具体的な指定\n' +
    '（個別の曜日や祝＞平日/土日祝＞空欄の順）が優先されます。\n' +
    '「営業区分」は昼夜2部制などランチ・ディナーを分けたいときに「昼の部」「夜の部」のように入力\n' +
    '（空欄可）。同じ曜日区分で営業区分が違う行が複数あると、タイムラインに絞り込みプルダウンが\n' +
    '出て、営業区分ごとに表示を切り替えられます。\n' +
    '「開店時刻」「閉店時刻」は「17:00」のように24時間表記で入力してください。\n' +
    '閉店が日をまたぐ場合は24を超える数字で（例: 翌2:00なら「26:00」）。\n' +
    'この店舗の行が無ければ既定の「10:00〜24:00」で表示されます。');
  // 2026-08-28追記: 旧レイアウトで運用中のシートに列が無ければ挿入して移行する
  // （新規作成時は上のsheetOrCreate_で最初から入っている）。
  var lastCol = sh.getLastColumn();
  if (lastCol >= 1) {
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v); });
    if (headers.indexOf('曜日区分') < 0) {
      sh.insertColumnAfter(1);
      sh.getRange(1, 2).setValue('曜日区分').setFontWeight('bold').setBackground('#efe9dd');
      sh.setColumnWidth(2, 110);
      headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (v) { return String(v); });
    }
    if (headers.indexOf('営業区分') < 0) {
      sh.insertColumnAfter(2);
      sh.getRange(1, 3).setValue('営業区分').setFontWeight('bold').setBackground('#efe9dd');
      sh.setColumnWidth(3, 110);
    }
  }
  return sh;
}
// 開店/閉店時刻セルの読み取り用。「11:30」のように入力すると、Googleスプレッドシートが自動で
// 「時刻」型（内部的には1899-12-30基準の日付オブジェクト）に変換してしまい、素の String(v) では
// "Sat Dec 30 1899 11:30:00 GMT+0900"のような形になって呼び出し側の正規表現でも不安定だった
// （2026-08-28 ユーザー報告「営業区分プルダウンが出ない」の原因）。GAS実行環境のタイムゾーン
// （スプレッドシートに合わせてAsia/Tokyo）でgetDate/getHours/getMinutesを読み、日付が基準の30日
// より進んでいたら（=日をまたぐ時刻）その日数分だけ24時間を加算した「HH:mm」文字列にする。
function rsvTimeCell_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var extraDays = Math.max(0, v.getDate() - 30);
    var hh = v.getHours() + extraDays * 24;
    var mm = v.getMinutes();
    return hh + ':' + (mm < 10 ? '0' + mm : String(mm));
  }
  return String(v);
}
// ログイン必須・店舗スコープ制限（bqGetReservationと同じ方針）。BQを使わずシートを直接読むだけなので軽量。
// 席マスタと営業時間の両方をまとめて返す（同じタイミングで使うため1リクエストにまとめている）。
function bqGetSeatMaster(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var allowNames = restricted ? sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean) : null;

    var sh = seatMasterSheet_();
    var lastRow = sh.getLastRow();
    var seats = [['店舗', '卓番号', '席数', 'エリア', '表示順', '属性', '配置X', '配置Y']];
    if (lastRow >= 2) {
      var values = sh.getRange(2, 1, lastRow - 1, 8).getValues();
      for (var i = 0; i < values.length; i++) {
        var store = String(values[i][0] || '').trim();
        var tableNo = String(values[i][1] || '').trim();
        if (!store || !tableNo) continue;
        if (allowNames && allowNames.indexOf(store) < 0) continue;
        seats.push([store, tableNo, values[i][2] === '' ? '' : Number(values[i][2]), String(values[i][3] || ''), values[i][4] === '' ? '' : Number(values[i][4]), String(values[i][5] || ''),
          values[i][6] === '' ? '' : Number(values[i][6]), values[i][7] === '' ? '' : Number(values[i][7])]);
      }
    }

    var hSh = storeHoursSheet_();
    var hLastRow = hSh.getLastRow();
    var hours = [['店舗', '曜日区分', '営業区分', '開店時刻', '閉店時刻']];
    if (hLastRow >= 2) {
      var hValues = hSh.getRange(2, 1, hLastRow - 1, 5).getValues();
      for (var j = 0; j < hValues.length; j++) {
        var hStore = String(hValues[j][0] || '').trim();
        if (!hStore) continue;
        if (allowNames && allowNames.indexOf(hStore) < 0) continue;
        hours.push([hStore, String(hValues[j][1] || ''), String(hValues[j][2] || ''), rsvTimeCell_(hValues[j][3]), rsvTimeCell_(hValues[j][4])]);
      }
    }

    return { ok: true, sheets: { rsvSeatMaster: seats, rsvStoreHours: hours } };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ===== PL人件費のAPI切替（2026-08-31・ラウンド5①。担当B依頼・ユーザー承認済み） =====
// fact_daily_storeの社員人件費(fulltime_labor_cost)・アルバイト人件費(parttime_labor_cost)は、
// 従来スプレッドシート「社員人件費DB」の店舗×月合計を暦日割りしたもの（分析_日別店舗経由でミラー
// されるだけ・計算自体はこのプロジェクトの外）だった。担当Bが構築したAPI連携（sf_payroll_sync・
// sf_payroll_allocations・labor_cost_daily）の方が正確なため、**2026年9月分から**そちらに切り替える
// （2026-08-31 ユーザー指示で当初の8月から9月に変更。それより前の月はスマレジタイムカード未導入の
// 場合があり、無理に混ぜない）。
// 法定福利費(statutory_welfare)はAPI側に直接のデータが無いため、（基本給+インセンティブ+賞与）×15%
// で自動計算する（2026-09-02追加・担当Bからの依頼。PL管理システム側の既存ロジックと同じ係数）。
var API_LABOR_COST_FROM_YM_ = '2026-09';
// 汎用: Supabaseの任意テーブル/ビューをページング付きで全件取得（bqFetchReservationRows_を一般化）。
// filterQSはPostgRESTのクエリ文字列（例:'work_date=gte.2026-08-01'）。空文字なら絞り込み無し。
function bqFetchSupabaseRows_(table, selectCols, filterQS) {
  var supaUrl = PropertiesService.getScriptProperties().getProperty('SUPABASE_URL');
  var supaKey = PropertiesService.getScriptProperties().getProperty('SUPABASE_SERVICE_KEY');
  if (!supaUrl || !supaKey) throw new Error('Script PropertiesにSUPABASE_URL/SUPABASE_SERVICE_KEYが未設定です');
  var qs = 'select=' + encodeURIComponent(selectCols) + (filterQS ? '&' + filterQS : '');
  var pageSize = 1000, offset = 0, all = [];
  while (true) {
    var res = UrlFetchApp.fetch(
      supaUrl + '/rest/v1/' + table + '?' + qs,
      { headers: { apikey: supaKey, Authorization: 'Bearer ' + supaKey, Range: offset + '-' + (offset + pageSize - 1) },
        muteHttpExceptions: true }
    );
    var code = res.getResponseCode();
    if (code !== 200 && code !== 206) throw new Error('Supabase取得失敗[' + table + ' ' + code + ']: ' + res.getContentText().slice(0, 300));
    var rows = JSON.parse(res.getContentText() || '[]');
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
// 店舗×日のアルバイト人件費実績＋店舗×月の社員人件費（給与賞与・通勤手当）を、
// Supabase(sf_payroll_sync/sf_payroll_allocations/labor_cost_daily)から集計する。
// 取得・計算に失敗した場合は空マップを返す（＝呼び出し側はどの行も従来のシート値のまま扱う。
// 安全側に倒し、他の同期対象・fact_daily_store自体の同期を止めない）。
function bqBuildApiLaborCostMap_() {
  var empty = { ptDaily: {}, ptCoveredMonth: {}, empMonthly: {} };
  try {
    var storeMap = rsvStoreMap_(); // { store_id(uuid): store_name }（Supabase stores。予約タブと共用）
    if (!Object.keys(storeMap).length) return empty; // 店舗マスタが取れなければ従来値のまま
    var users = bqFetchSupabaseRows_('users', 'id,role', 'is_active=eq.true');
    var roleMap = {}; users.forEach(function (u) { roleMap[u.id] = u.role; });
    var isShain = function (uid) { var r = roleMap[uid]; return r === 'SHAIN' || r === 'TENCHO'; };

    // ---- アルバイト人件費: SHAIN/TENCHOを除く全員の実績をそのまま店舗×日で使う（暦日割り不要） ----
    var lcd = bqFetchSupabaseRows_('labor_cost_daily', 'user_id,store_id,work_date,computed_cost,smaregi_estimate_cost',
      'work_date=gte.' + API_LABOR_COST_FROM_YM_ + '-01');
    var ptDaily = {}, ptCoveredMonth = {};
    // SHAIN/TENCHOの「その月どの店舗で何日働いたか」（sf_payroll_syncの店舗按分に使う。最多店舗を採用）
    var shainDayCount = {}; // userId|ym -> { storeId: dayCount }
    lcd.forEach(function (r) {
      var ym = String(r.work_date || '').slice(0, 7);
      if (!ym || ym < API_LABOR_COST_FROM_YM_) return;
      if (isShain(r.user_id)) {
        var key = r.user_id + '|' + ym;
        var d = shainDayCount[key] = shainDayCount[key] || {};
        d[r.store_id] = (d[r.store_id] || 0) + 1;
        return; // SHAIN/TENCHOの打刻はアルバイト人件費の合算には含めない
      }
      var sName = storeMap[r.store_id]; if (!sName) return;
      var dateStr = String(r.work_date).slice(0, 10);
      var cost = (r.computed_cost != null) ? Number(r.computed_cost) : Number(r.smaregi_estimate_cost || 0);
      ptDaily[sName] = ptDaily[sName] || {};
      ptDaily[sName][dateStr] = (ptDaily[sName][dateStr] || 0) + cost;
      ptCoveredMonth[sName] = ptCoveredMonth[sName] || {};
      ptCoveredMonth[sName][ym] = true; // この店舗×月はAPIで実績を追えている＝日ごとの0件も0円として信用してよい
    });

    // ---- 社員人件費①: sf_payroll_allocations（店舗×半月×人・マスター手動）を最優先 ----
    var alloc = bqFetchSupabaseRows_('sf_payroll_allocations', 'user_id,store_id,period_key,kind,amount',
      'period_key=gte.' + API_LABOR_COST_FROM_YM_);
    var salBonus = {}, commute = {}; // storeId|ym -> sum
    var allocatedUserYm = {}; // userId|ym -> true（sf_payroll_syncフォールバック対象から除外）
    alloc.forEach(function (r) {
      var ym = String(r.period_key || '').slice(0, 7);
      if (!ym) return;
      allocatedUserYm[r.user_id + '|' + ym] = true;
      var k = r.store_id + '|' + ym, amt = Number(r.amount || 0);
      if (r.kind === 'commute') commute[k] = (commute[k] || 0) + amt;
      else salBonus[k] = (salBonus[k] || 0) + amt; // base/incentive/bonusはまとめて「社員給与賞与」
    });

    // ---- 社員人件費②: sf_payroll_sync（人×月・店舗の概念なし）を、①未入力の人だけ、
    //      labor_cost_dailyで判定した「その月最も多く働いた店舗」に計上 ----
    var sync = bqFetchSupabaseRows_('sf_payroll_sync', 'user_id,year_month,fixed_salary_amount,commute_allowance',
      'year_month=gte.' + API_LABOR_COST_FROM_YM_);
    sync.forEach(function (r) {
      var ym = String(r.year_month || '');
      if (!ym || allocatedUserYm[r.user_id + '|' + ym]) return; // ①が優先
      var days = shainDayCount[r.user_id + '|' + ym];
      if (!days) return; // その月の勤務実績が無く店舗が特定できない→計上しない（既知の制約。掛け持ち者は最多店舗のみに計上）
      var bestStore = null, bestCount = -1;
      for (var sid in days) { if (days[sid] > bestCount) { bestCount = days[sid]; bestStore = sid; } }
      if (!bestStore) return;
      var k = bestStore + '|' + ym;
      salBonus[k] = (salBonus[k] || 0) + Number(r.fixed_salary_amount || 0);
      commute[k] = (commute[k] || 0) + Number(r.commute_allowance || 0);
    });
    var empMonthly = {}, mergedKeys = {};
    for (var kk in salBonus) mergedKeys[kk] = 1;
    for (var kk2 in commute) mergedKeys[kk2] = 1;
    for (var k3 in mergedKeys) {
      var p3 = k3.split('|'), sName3 = storeMap[p3[0]]; if (!sName3) continue;
      empMonthly[sName3] = empMonthly[sName3] || {};
      empMonthly[sName3][p3[1]] = { fulltimeBase: salBonus[k3] || 0, commute: commute[k3] || 0 };
    }
    return { ptDaily: ptDaily, ptCoveredMonth: ptCoveredMonth, empMonthly: empMonthly };
  } catch (e) {
    return empty;
  }
}
// fact_daily_store 1行（BQ_FACT_DAILY_STORE_SCHEMA順の配列）を、上のマップにデータがあれば差し替える。
// 列インデックスはBQ_FACT_DAILY_STORE_SCHEMAの並び順に対応（date=0,year_month=1,year=2,month=3,…
// store_name=9,…parttime_labor_cost=23,fulltime_labor_cost=24,labor_cost_total=25,…
// employee_salary_bonus=32,statutory_welfare=33,commute_allowance=34）。
function bqApplyApiLaborCostRow_(row, laborData, storeIdx) {
  // 2026-08-31修正: シートの「年月」列は見た目こそ"2026-08"だが、スプレッドシート側でDATE型セルに
  // 自動変換されており、GASでStringify すると"Sat Aug 01 2026 00:00:00 GMT+0900..."のような文字列に
  // なってしまう（診断用アクションで実データを直接確認して判明。年月比較が常に不成立になり、
  // このAPI切替が一切発火しない状態だった）。年(row[2])・月(row[3])はINTEGER型で素直な数値のため、
  // そちらから"YYYY-MM"を組み立てる。
  var year0 = Number(row[2]), month0 = Number(row[3]);
  var ym = (year0 && month0) ? (year0 + '-' + String(month0).padStart(2, '0')) : '';
  if (!ym || ym < API_LABOR_COST_FROM_YM_) return row;
  var storeName = bqResolveStoreName_(storeIdx, row[9]);
  var dateStr = (row[0] instanceof Date) ? Utilities.formatDate(row[0], 'Asia/Tokyo', 'yyyy-MM-dd') : String(row[0]).slice(0, 10);
  var changed = false;
  var pt = Number(row[23]) || 0;
  if (laborData.ptCoveredMonth[storeName] && laborData.ptCoveredMonth[storeName][ym]) {
    var d = laborData.ptDaily[storeName]; pt = (d && d[dateStr] != null) ? d[dateStr] : 0; // 実績0円の日も信用する
    changed = true;
  }
  var salBonus = Number(row[32]) || 0, commute = Number(row[34]) || 0, statutory = Number(row[33]) || 0;
  var em = laborData.empMonthly[storeName] && laborData.empMonthly[storeName][ym];
  if (em) {
    var daysInMonth = new Date(year0, month0, 0).getDate();
    salBonus = em.fulltimeBase / daysInMonth; // 月合計を暦日割り（社員人件費DBと同じ考え方）
    commute = em.commute / daysInMonth;
    // 2026-09-02追加（担当Bからの依頼・ユーザー報告「社員人件費に法定福利費が入っていない」）:
    // 法定福利費はsf_payroll_sync/sf_payroll_allocations側に直接のデータが無いため、
    // （基本給+インセンティブ+賞与）×15%（＝salBonus。交通費は対象外）で自動計算する。
    // 15%はPL管理システム側の既存ロジック（L04法定福利費の自動化）と同じ、社内で確立済みの係数
    // （ユーザー提示の計算式・担当Bの調査で裏付け済み）。
    statutory = salBonus * 0.15;
    changed = true;
  }
  if (!changed) return row;
  var out = row.slice();
  out[23] = pt; out[32] = salBonus; out[33] = statutory; out[34] = commute;
  out[24] = salBonus + statutory + commute; // fulltime_labor_cost
  out[25] = pt + out[24];                   // labor_cost_total
  return out;
}

// ミラー対象一覧（src='local'はこのプロジェクトの自分のスプレッドシート。それ以外はopenByIdで開く）
function bqSalesTargets_() {
  return [
    // startRow: データが実際に始まる行。分析_日別店舗は1行目がヘッダーなので2行目から。
    // 支払いDB等の4シートは1行目がシート説明の見出し・2行目が本当のヘッダーのため3行目から
    // （2026-08-22 bqDebugPeekで実データを確認して判明。分析_日別店舗との構造差異に注意）。
    { src: 'local',     sheet: '分析_日別店舗', table: 'fact_daily_store', schema: BQ_FACT_DAILY_STORE_SCHEMA, startRow: 2 },
    { src: SALES_DB_ID, sheet: '支払いDB',      table: 'stg_payment',      schema: BQ_STG_PAYMENT_SCHEMA,      startRow: 3 },
    { src: SALES_DB_ID, sheet: '媒体別DB',      table: 'stg_media',        schema: BQ_STG_MEDIA_SCHEMA,        startRow: 3 },
    { src: SALES_DB_ID, sheet: '仕入れDB',      table: 'stg_siire',        schema: BQ_STG_SIIRE_SCHEMA,        startRow: 3 },
    { src: SALES_DB_ID, sheet: '人件費DB',      table: 'stg_jinken',       schema: BQ_STG_JINKEN_SCHEMA,       startRow: 3 },
    // 入金DBはstartRow:3（2026-08-22 実データで確認。readSheet()内のコメントにある「1行目に
    // 空行が入った」事故の影響が残っており、2行目が本当のヘッダー・3行目からがデータのため）
    { src: 'local',     sheet: '入金DB',        table: 'stg_deposit',      schema: BQ_STG_DEPOSIT_SCHEMA,      startRow: 3 },
    // スポット人件費はこのプロジェクトのローカルシート・1行目がヘッダーなので2行目から（分析_日別店舗と同じ構造）
    { src: 'local',     sheet: 'DB_スポット人件費', table: 'stg_spot',    schema: BQ_STG_SPOT_SCHEMA,        startRow: 2 },
    // 借入返済元金も同じくローカルシート・1行目ヘッダーなので2行目から（2026-08-26追加・A-5）
    { src: 'local',     sheet: 'DB_借入返済元金', table: 'stg_loan_principal', schema: BQ_STG_LOAN_SCHEMA, startRow: 2 }
  ];
}
// 店舗名の表記ゆれをBQミラーへ書く直前に正規化する（2026-08-28追加）。
// 「じんべえ 新横浜店」「横濱ホルモン会館　エース　本厚木店」等の売上シート生表記のまま
// fact_daily_store（BQ）へ入り、正式名（じんべぇ 新横浜／エース 本厚木等）で検索する
// Chatwork/Lark配信・store_aliasesベースの各種照合から見つからなくなっていた不具合の対応
// （担当D実機調査で判明。3店舗とも既にSupabase store_aliasesにkind='name'source='売上シート'で
// 登録済みだった＝resolveAdStore_と同じ仕組みでそのまま解決できる）。
// fetchStoreDirectory_()は10分キャッシュ済みなので、索引は同期1回につき1回だけ作れば十分速い。
function bqStoreNameIndex_() {
  var dir = fetchStoreDirectory_();
  if (!dir) return null; // 取得失敗時は正規化をスキップ（今までどおり生表記のまま。既存動作より悪化はしない）
  var idx = {};
  for (var i = 0; i < dir.length; i++) {
    var aliases = dir[i].aliases || [];
    for (var j = 0; j < aliases.length; j++) {
      var k = storeKey_(aliases[j].alias);
      if (k) idx[k] = dir[i].name; // 正準名も自分自身のエイリアス(source:'正準')として登録済みなので、
    }                              // 既に正しい表記の行はキー一致→同じ名前が返り無害（冪等）
  }
  return idx;
}
function bqResolveStoreName_(idx, name) {
  var cur = String(name == null ? '' : name).trim();
  if (!idx || !cur) return cur;
  var hit = idx[storeKey_(cur)];
  return hit || cur; // 未登録の表記はこれまでどおりトリムのみ（無理に推測して誤爆させない）
}
// シートのstartRow行目以降(schemaの列数分)をCSV文字列に変換。
// storeIndex（bqStoreNameIndex_の戻り値）を渡すと、schema中の'store_name'列だけ正規化してから書き出す。
// rowOverride（省略可）は1行ごとに呼ばれ、書き出す前に行の値を差し替えられる（2026-08-31追加・
// PL人件費のAPI切替用。fact_daily_store以外のターゲットには渡さないため既存動作に影響なし）。
function bqSheetToCsv_(sheet, schema, startRow, storeIndex, rowOverride) {
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) return '';
  var values = sheet.getRange(startRow, 1, lastRow - startRow + 1, schema.length).getValues();
  var storeCol = -1;
  if (storeIndex) { for (var k = 0; k < schema.length; k++) if (schema[k].name === 'store_name') { storeCol = k; break; } }
  var lines = [];
  for (var r = 0; r < values.length; r++) {
    var row = rowOverride ? (rowOverride(values[r]) || values[r]) : values[r];
    var cells = [];
    for (var c = 0; c < schema.length; c++) {
      var v = (c === storeCol) ? bqResolveStoreName_(storeIndex, row[c]) : row[c];
      cells.push(bqCsvCell_(v, schema[c].type));
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}
function bqCsvCell_(v, type) {
  if (v === '' || v === null || v === undefined) return '';
  if (type === 'DATE') {
    if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
    return String(v);
  }
  if (type === 'STRING') return '"' + String(v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  // NUMERIC/INTEGER/FLOAT64: 0除算等でNaN/InfinityになっているセルはNULL扱いにする。
  // NUMERICは小数点以下9桁までの制約があり、GAS側の割り算の丸め誤差でそれを超えることがあるため6桁に丸める
  // （dinii-orders.jsのnormNumと同じ対策。過去にこれが原因で行が静かに拒否される事故があった）。
  var n = Number(v);
  if (!isFinite(n)) return '';
  if (type === 'INTEGER') return String(Math.round(n));
  return n.toFixed(6);
}
// 1シート分をLoad Job投入（毎回WRITE_TRUNCATE=全置換。シート自体が毎回全件洗い替えのため、
// これが最も単純で安全＝初回実行がそのまま全履歴バックフィルを兼ねる）
function bqLoadSheetToTable_(csv, table, schema) {
  // 2026-08-26修正（担当F実機報告→担当A調査）: 以前はcsvが空（シートのデータ行が0件）のとき
  // ここで即returnしてBigQuery側を一切更新せずスキップしていた。そのため「シートの最後の1件を
  // 削除して0件にした」場合、WRITE_TRUNCATEが一度も走らずBQ側にだけ削除済みのはずの古い行が
  // 残り続けるバグになっていた（スポット人件費の削除がダッシュボードに反映されない不具合の
  // 真因の一つと判明）。空でもロードジョブ自体は実行してテーブルを実際に空にする
  // （schemaを明示しているため空データでも正常にテーブル作成/空化できる）。
  var job = { configuration: { load: {
    destinationTable: { projectId: BQ_PROJECT, datasetId: BQ_SALES_DATASET, tableId: table },
    sourceFormat: 'CSV', skipLeadingRows: 0, allowQuotedNewlines: true,
    writeDisposition: 'WRITE_TRUNCATE', maxBadRecords: 0, schema: { fields: schema }
  }}};
  var blob = Utilities.newBlob(csv || '', 'application/octet-stream', table + '.csv');
  var ins = BigQuery.Jobs.insert(job, BQ_PROJECT, blob);
  var jobId = ins.jobReference.jobId;
  var loc = (ins.jobReference && ins.jobReference.location) || 'asia-northeast1';
  var st = null;
  for (var i = 0; i < 90; i++) { st = BigQuery.Jobs.get(BQ_PROJECT, jobId, { location: loc }); if (st.status && st.status.state === 'DONE') break; Utilities.sleep(2000); }
  if (st && st.status && st.status.errorResult) {
    var detail = (st.status.errors || []).slice(0, 5).map(function (e) { return e.message; });
    return { ok: false, table: table, error: st.status.errorResult.message, detail: detail };
  }
  var loaded = (st && st.statistics && st.statistics.load) ? st.statistics.load.outputRows : null;
  return { ok: true, table: table, rows: Number(loaded || 0) };
}
// 一度だけ実行: salesデータセットが無ければ作成
function bqSetupSalesDataset(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  try {
    BigQuery.Datasets.insert({ datasetReference: { projectId: BQ_PROJECT, datasetId: BQ_SALES_DATASET }, location: 'asia-northeast1' }, BQ_PROJECT);
    return { ok: true, created: true };
  } catch (e) {
    if (String(e).indexOf('Already Exists') >= 0) return { ok: true, created: false, note: 'already exists' };
    return { ok: false, error: String(e && e.message || e) };
  }
}
// 5テーブル全部を同期（専用トークン認証・ログイン不要。bqLoadOrdersと同じ方針）
function bqSyncAllSales(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var targets = bqSalesTargets_(), results = [];
  var storeIdx = bqStoreNameIndex_(); // 全ターゲット共通の店舗名索引（1回だけ作る。2026-08-28追加）
  var laborData = null; // PL人件費API切替（2026-08-31）。fact_daily_storeの時だけ遅延構築する
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    try {
      var sh = (t.src === 'local') ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(t.sheet)
                                    : SpreadsheetApp.openById(t.src).getSheetByName(t.sheet);
      if (!sh) { results.push({ ok: false, table: t.table, error: 'シートが見つかりません: ' + t.sheet }); continue; }
      var rowOverride = null;
      if (t.table === 'fact_daily_store') {
        if (!laborData) laborData = bqBuildApiLaborCostMap_();
        rowOverride = (function (ld, sIdx) { return function (row) { return bqApplyApiLaborCostRow_(row, ld, sIdx); }; })(laborData, storeIdx);
      }
      var csv = bqSheetToCsv_(sh, t.schema, t.startRow, storeIdx, rowOverride);
      var loadRes = bqLoadSheetToTable_(csv, t.table, t.schema);
      results.push(loadRes);
      // stg_spotが更新できたらbqGetSpotの応答キャッシュ(10分)を無効化する。
      // これが漏れていると、手動同期でBigQuery側は最新でも、アプリ側は古いキャッシュ応答
      // （IDが無い旧スキーマ時代のもの等）を最大10分間返し続けてしまう（2026-08-24実地判明）。
      if (loadRes && loadRes.ok && t.table === 'stg_spot') bqCacheGenBump_('spot');
      if (loadRes && loadRes.ok && t.table === 'stg_loan_principal') bqCacheGenBump_('loan');
    } catch (e) {
      results.push({ ok: false, table: t.table, error: String(e && e.message || e) });
    }
  }
  var allOk = results.every(function (r) { return r.ok; });
  // 鮮度表示（dataFreshness・2026-08-23追加）用に、最後に成功したBQ同期の時刻をScript Propertiesへ記録。
  // 既存の戻り値・動作は変えない（呼び出し元のbq-sales-reconcileタスクはtimeを見ていないため無影響）。
  try { PropertiesService.getScriptProperties().setProperty('BQ_SYNC_LAST_OK', JSON.stringify({ time: new Date().toISOString(), ok: allOk })); } catch (eProp) {}
  return { ok: allOk, results: results, time: new Date().toISOString() };
}

// 画面に「データがいつまで揃っているか」を表示するための軽量アクション（2026-08-23追加・
// 実装指示書_ダッシュボード高速化）。ログイン必須（他の軽量トークン系と違い、担当店舗の権限は
// 問わない全社共通の情報のため、単にログイン済みかどうかだけ見る）。
function dataFreshness(p, session) {
  var out = { ok: true };
  try {
    var maxRow = bqRows_('SELECT MAX(date) AS d FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store` WHERE net_sales > 0 OR guests_total > 0');
    out.bqMaxDate = (maxRow && maxRow[1] && maxRow[1][0]) ? String(maxRow[1][0]) : null;
  } catch (eBq) { out.bqMaxDate = null; out.bqError = String(eBq && eBq.message || eBq); }
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('分析_日別店舗');
    out.sheetMaxDate = null;
    if (sh) {
      var lr = sh.getLastRow();
      if (lr >= 2) {
        // 全件走査は重い（実測4秒超・7000行超）ため、末尾側だけ見る。ただし月末まで日付欄だけ
        // 先に埋まっている実績0件のテンプレート行があるため（fix-v72で判明した問題と同根）、
        // 単に最後の行の日付を見ると未来日を「最新」と誤判定する。A列(日付)に加えP列(客数合計)・
        // R列(純売上)も読み、実績が入っている行に限定して最大日付を取る。店舗数×残り日数ぶんの
        // テンプレート行を跨げるよう300行分見る（12店舗×20日超を想定した余裕）。
        var scanFrom = Math.max(2, lr - 300);
        var vals = sh.getRange(scanFrom, 1, lr - scanFrom + 1, 18).getValues(); // A:R（date〜net_sales）
        var maxD = null;
        for (var i = 0; i < vals.length; i++) {
          var v = vals[i][0], guests = Number(vals[i][15] || 0), sales = Number(vals[i][17] || 0);
          if (v instanceof Date && (guests > 0 || sales > 0) && (!maxD || v.getTime() > maxD.getTime())) maxD = v;
        }
        if (maxD) out.sheetMaxDate = Utilities.formatDate(maxD, 'Asia/Tokyo', 'yyyy-MM-dd');
      }
    }
  } catch (eSheet) { out.sheetMaxDate = null; }
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('BQ_SYNC_LAST_OK');
    if (raw) { var j = JSON.parse(raw); out.bqSyncedAt = j.time || null; out.bqSyncedOk = !!j.ok; }
  } catch (eProp2) {}
  return out;
}

// 2026-08-22 追加（dash-syncのGAS往復簡略化）。ns-portal側のdash-syncがこれまで
// 「ログイン→スプレッドシート全読み」で取っていた実績データを、ログイン不要・BQ_LOAD_TOKEN認証のみで
// BigQueryから直接返す軽量アクション（GCPサービスアカウント鍵が組織ポリシーで作れなかったため、
// 代わりにGAS側の既存BigQueryアクセス権をそのまま使う方式）。スプレッドシートは一切読まない。
function bqDailyStoreForSync(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var months = Number(p.months) || 2;
  var cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
  var cutoffStr = Utilities.formatDate(cutoff, 'Asia/Tokyo', 'yyyy-MM-dd');
  var sql = 'SELECT date, store_name, net_sales, cogs, labor_cost_total FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store` WHERE date >= DATE(\'' + cutoffStr + '\') ORDER BY date';
  var rows = bqRows_(sql);
  if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
  var out = [['日付', '店舗名', '純売上', '仕入', '人件費合計']];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    out.push([String(r[0]).replace(/-/g, '/'), r[1], Number(r[2] || 0), Number(r[3] || 0), Number(r[4] || 0)]);
  }
  return { ok: true, sheets: { daily: out } };
}

// ===== PL経費(DB_PL)のBigQueryミラー・読み出し =====
// 2026-08-22 追加（PLタブのデータソース切替。ユーザー指摘によりDB_PLのみ対応・入金DBは対象外）。
// DB_PLは「ダッシュボード」自身のスプレッドシートに同居するローカルシート
// （PL管理システム本体とは別。savePlEntries/savePlBulkがDB_PLとPL管理システムの両方に書く設計。
//  1615行目付近のコメント参照）。年月列は文字列'yyyy/MM'または日付セルどちらもあり得るため、
//  汎用のbqSheetToCsv_ではなく専用の変換にする。
var BQ_STG_PL_SCHEMA = [
  { name: 'year_month', type: 'STRING' }, { name: 'store_name', type: 'STRING' },
  { name: 'item', type: 'STRING' }, { name: 'category', type: 'STRING' },
  { name: 'amount', type: 'NUMERIC' }, { name: 'memo', type: 'STRING' },
  { name: 'sub_item', type: 'STRING' }   // 補助科目（2026-08-23追加。DB_PLのG列と対応）
];
function bqPlYm_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy/MM');
  return String(v || '').trim();
}
function bqCsvStr_(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
function bqSyncPL(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!sh) return { ok: false, error: 'DB_PLシートがありません' };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { bqCacheGenBump_('pl'); return { ok: true, rows: 0, note: 'データ行がありません' }; }
  var lastCol = Math.max(sh.getLastColumn(), 7);   // G列（補助科目）が無い旧シートでも6列で読めるようにする
  var values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var lines = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (!String(r[2] || '').trim()) continue; // 勘定科目が空の行はスキップ（テンプレートの空行対策）
    var amt = Number(r[4]);
    lines.push([
      bqCsvStr_(bqPlYm_(r[0])), bqCsvStr_(r[1]), bqCsvStr_(r[2]), bqCsvStr_(r[3]),
      isFinite(amt) ? amt.toFixed(6) : '0', bqCsvStr_(r[5]), bqCsvStr_(r[6])
    ].join(','));
  }
  var csv = lines.join('\n');
  var plSyncRes = bqLoadSheetToTable_(csv, 'stg_pl', BQ_STG_PL_SCHEMA);
  // PL画面のキャッシュ（bqGetPL・実装指示書_ダッシュボード高速化タスク3）を無効化。
  // 同期直後にキャッシュが古いままだと「入力したのに反映されない」に見えるため。
  if (plSyncRes && plSyncRes.ok) bqCacheGenBump_('pl');
  return plSyncRes;
}
// PLタブ用: DB_PLのBQミラーを読む。bqDailyStoreと同じ方針（ログイン必須・店舗スコープ制限）で、
// 既存のingestPL()がそのまま解釈できる形（{sheets:{PL:[[年月,店舗名,勘定科目,区分,金額,メモ,補助科目],...]}}）で返す。
// 全社共通経費（店舗名が空欄）は店舗スコープに関わらず常に含める（plAgg側で選択状況に応じて除外される）。
function bqGetPL(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var where = '';
    if (restricted) {
      var allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (allowNames.length) {
        where = "WHERE (store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "') OR store_name = '')";
      }
    }
    var ck = bqCacheKey_('pl', [bqCacheGen_('pl'), restricted && allowNames.length ? allowNames.slice().sort().join('.') : 'all']);
    var cached = bqCacheGet_(ck);
    if (cached) return cached;
    var sql = 'SELECT year_month, store_name, item, category, amount, memo, sub_item FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_pl` ' + where + ' ORDER BY year_month';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var out = [['年月', '店舗名', '勘定科目', '区分', '金額', 'メモ', '補助科目']];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      out.push([r[0], r[1], r[2], r[3], Number(r[4] || 0), r[5], r[6]]);
    }
    var res = { ok: true, sheets: { PL: out } };
    bqCachePut_(ck, res);
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ================== スポット人件費（2026-08-23追加） ==================
// タイミー等の単発人件費。DB_スポット人件費に1行ずつ記録し、①日別の人件費率（PA＋社員＋スポット、
// フロントのstat()で合算・分析_日別店舗/fact_daily_storeは一切触らない）②月次PL（自動｜スポット人件費、
// L区分でDB_PLへ集計upsert）の2系統に反映する。

// 保存済みの内容をすぐBQへミラー（savePlEntries等と同じ理由：翌朝の定期同期まで待たせない）。
// 失敗してもシート側の保存・削除自体は成功として扱う（シートが正・戻り値でok/errorを返し、
// 呼び出し元(saveSpotEntry/deleteSpotEntry)が画面へ警告表示できるようにする。2026-08-26修正:
// 以前はここで例外を握りつぶし呼び出し元へ一切伝えていなかったため、「削除しました」と表示された
// のにBigQuery側（BQモードで見ている社長・本部の画面）には古いデータが残り続ける不具合があった
// （担当Fが実機報告から原因調査・担当Aへ依頼）。次のbqSyncSales定期同期でも追いつくが、それまでの
// 間「反映が遅れている可能性」をユーザーに知らせられるようにする）。
function bqSyncSpotNow_() {
  try {
    var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
    if (!tk) return { ok: false, error: 'BQ_LOAD_TOKEN未設定' };
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_スポット人件費');
    if (!sh) return { ok: false, error: 'シートが見つかりません' };
    var csv = bqSheetToCsv_(sh, BQ_STG_SPOT_SCHEMA, 2, bqStoreNameIndex_());
    var res = bqLoadSheetToTable_(csv, 'stg_spot', BQ_STG_SPOT_SCHEMA);
    if (res && res.ok) bqCacheGenBump_('spot');
    return res;
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
// ダッシュボード初期表示（BQモード）用: stg_spotを店舗権限フィルタ付きで読む。bqGetPLと同じ方針。
function bqGetSpot(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var allowNames = [], where = '';
    if (restricted) {
      allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (allowNames.length) {
        where = "WHERE store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "')";
      }
    }
    var ck = bqCacheKey_('spot', [bqCacheGen_('spot'), restricted && allowNames.length ? allowNames.slice().sort().join('.') : 'all']);
    var cached = bqCacheGet_(ck);
    if (cached) return cached;
    var sql = 'SELECT work_date, store_name, kind, amount, headcount, memo, entered_by, entered_at, id FROM `' +
      BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_spot` ' + where + ' ORDER BY work_date';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var out = [['日付', '店舗名', '区分', '金額', '人数', 'メモ', '入力者', '入力日時', 'ID']];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      out.push([r[0], r[1], r[2], Number(r[3] || 0), r[4] == null ? '' : Number(r[4]), r[5], r[6], r[7], r[8]]);
    }
    var res = { ok: true, sheets: { 'スポット人件費': out } };
    bqCachePut_(ck, res);
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ================== 借入返済元金（2026-08-26追加・A-5） ==================
// bqSyncSpotNow_/bqGetSpotと同じ考え方。syncBankLoanToPl_の保存直後に呼んで翌朝の定期同期を待たせない。
function bqSyncLoanNow_() {
  try {
    var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
    if (!tk) return;
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_借入返済元金');
    if (!sh) return;
    var csv = bqSheetToCsv_(sh, BQ_STG_LOAN_SCHEMA, 2, bqStoreNameIndex_());
    var res = bqLoadSheetToTable_(csv, 'stg_loan_principal', BQ_STG_LOAN_SCHEMA);
    if (res && res.ok) bqCacheGenBump_('loan');
  } catch (e) { /* 即時同期失敗は無視（次回定期同期で追いつく） */ }
}
// 簡易キャッシュフロー（PLタブ）用: stg_loan_principalを店舗権限フィルタ付きで読む。bqGetSpotと同じ方針。
// 全社共通行（store_name=''）は店舗が絞られていても常に含める（bqGetPLの空欄店舗の扱いと同じ）。
function bqGetLoanPrincipal(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var allowNames = [], where = '';
    if (restricted) {
      allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (allowNames.length) {
        where = "WHERE (store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "') OR store_name = '')";
      }
    }
    var ck = bqCacheKey_('loan', [bqCacheGen_('loan'), restricted && allowNames.length ? allowNames.slice().sort().join('.') : 'all']);
    var cached = bqCacheGet_(ck);
    if (cached) return cached;
    var sql = 'SELECT year_month, store_name, corp_name, principal_amount, memo FROM `' +
      BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_loan_principal` ' + where + ' ORDER BY year_month';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var out = [['年月', '店舗', '法人', '元金額', 'メモ']];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      out.push([r[0], r[1], r[2], Number(r[3] || 0), r[4]]);
    }
    var res = { ok: true, sheets: { '借入返済元金': out } };
    bqCachePut_(ck, res);
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
// スポット人件費の保存（ID一致なら更新・無ければ追加。saveEventと同じ型）。
function saveSpotEntry(p, session) {
  var store = String(p.store || '').trim();
  if (!store) return { ok: false, error: '店舗が未指定です' };
  if (!scopeAllows_(session, store)) return { ok: false, error: 'この店舗の入力権限がありません' };
  var date = String(p.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: '日付が不正です' };
  var kind = String(p.kind || 'タイミー').trim().slice(0, 20) || 'タイミー';
  var amount = Number(p.amount) || 0;
  if (amount <= 0) return { ok: false, error: '金額を入力してください' };
  var headcountRaw = String(p.headcount == null ? '' : p.headcount).trim();
  var headcount = headcountRaw === '' ? '' : (Number(headcountRaw) || 0);
  var memo = String(p.memo || '').trim().slice(0, 200);
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_スポット人件費');
  if (!sh) return { ok: false, error: 'DB_スポット人件費シートがありません' };
  var id = String(p.id || '').trim() || Utilities.getUuid().slice(0, 8);
  var last = sh.getLastRow(), found = -1;
  if (last >= 2) {
    var ids = sh.getRange(2, 9, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === id) { found = i + 2; break; }
  }
  // 既存行の更新なら、元の店舗（変更前）にも編集権限が必要（担当外店舗の記録を書き換えられないようにする）
  if (found > 0) {
    var prevStore = String(sh.getRange(found, 2).getValue()).trim();
    if (prevStore && !scopeAllows_(session, prevStore)) return { ok: false, error: '元の店舗の編集権限がありません' };
  }
  var d = date.split('-');
  var who = (session && (session.name || session.id)) || '不明';
  var whenStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var row = [new Date(Number(d[0]), Number(d[1]) - 1, Number(d[2])), store, kind, amount, headcount, memo, who, whenStr, id];
  var target = found > 0 ? found : last + 1;
  sh.getRange(target, 1, 1, 9).setValues([row]);
  sh.getRange(target, 1).setNumberFormat('yyyy/m/d');
  var bqRes = bqSyncSpotNow_();
  var out = { ok: true, id: id };
  if (!bqRes || !bqRes.ok) out.bqWarn = 'BigQueryへの反映に失敗した可能性があります（' + ((bqRes && bqRes.error) || '不明') + '）。数分後にもう一度確認してください';
  return out;
}
function deleteSpotEntry(p, session) {
  var id = String(p.id || '').trim(); if (!id) return { ok: false, error: 'idが必要です' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_スポット人件費');
  if (!sh) return { ok: false, error: 'DB_スポット人件費シートがありません' };
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 9).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][8]).trim() === id) {
        var store = String(vals[i][1]).trim();
        if (store && !scopeAllows_(session, store)) return { ok: false, error: 'この店舗の削除権限がありません' };
        sh.deleteRow(i + 2);
        var bqRes = bqSyncSpotNow_();
        var out = { ok: true };
        if (!bqRes || !bqRes.ok) out.bqWarn = 'BigQueryへの反映に失敗した可能性があります（' + ((bqRes && bqRes.error) || '不明') + '）。数分後にもう一度確認してください';
        return out;
      }
    }
  }
  return { ok: false, error: '該当データが見つかりません' };
}
// 月次PLへの自動計上：DB_スポット人件費を年月×店舗で合計し、DB_PLへ「自動｜スポット人件費」（L区分）として
// upsert（syncSeisanFeeToPlと同じ「対象月×このメモの行だけ差し替え」方式）。
// 対象月＝今回データがある月 ∪ 既存の自動計上行がある月（入力を全部消した月の掃除漏れを防ぐ）。
var PL_SPOT_MEMO = '自動｜スポット人件費';
// 専用トークン認証版（GitHub Actionsの毎日バッチ用）。実処理はsyncSpotLaborToPl_()に分離し、
// 画面のボタンから叩く refreshSpotPl（ログインセッション認証）と共有する（2026-08-24追加）。
function syncSpotLaborToPl(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  return syncSpotLaborToPl_(tk);
}
// 画面の「🔄 スポット人件費をPLへ反映」ボタン用。ログインしていれば誰でも実行できる
// （全店舗・全月を対象に再計算するだけの読み書きで、対象月×自動計上メモの行を差し替えるのみ・
//  何度実行しても安全な設計のため、店舗スコープでの絞り込みは行わない）。
function refreshSpotPl(p, session) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk) return { ok: false, error: 'サーバー側の設定が不足しています（BQ_LOAD_TOKEN未設定）' };
  return syncSpotLaborToPl_(tk);
}
function syncSpotLaborToPl_(tk) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_スポット人件費');
  var totals = {};   // 'yyyy/MM\t店舗' -> 金額合計
  if (sh) {
    var lastS = sh.getLastRow();
    if (lastS >= 2) {
      sh.getRange(2, 1, lastS - 1, 4).getValues().forEach(function (r) {   // A日付 B店舗名 C区分 D金額
        var d = r[0], store = String(r[1] || '').trim(), amt = Number(r[3]) || 0;
        if (!store || !amt || !(d instanceof Date)) return;
        var ym = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM');
        var k = ym + '\t' + store;
        totals[k] = (totals[k] || 0) + amt;
      });
    }
  }
  var dp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!dp) return { ok: false, error: 'DB_PLシートがありません' };
  var dlast = dp.getLastRow();
  var dlastCol = Math.max(dp.getLastColumn(), 7);
  var allRows = dlast >= 2 ? dp.getRange(2, 1, dlast - 1, dlastCol).getValues() : [];
  var months = {};
  Object.keys(totals).forEach(function (k) { months[k.split('\t')[0]] = true; });
  allRows.forEach(function (r) { if (String(r[5]) === PL_SPOT_MEMO) months[ymOf_(r[0])] = true; });
  var keep = [];
  allRows.forEach(function (r) {
    if (r[0] === '' && r[1] === '' && r[2] === '') return;
    var ym = ymOf_(r[0]);
    if (months[ym] && String(r[5]) === PL_SPOT_MEMO) return;   // 差し替え対象は捨てる
    keep.push(r);
  });
  Object.keys(totals).forEach(function (k) {
    var parts = k.split('\t'), ym = parts[0], store = parts[1];
    var y = +ym.slice(0, 4), mo = +ym.slice(5, 7);
    keep.push([new Date(y, mo - 1, 1), store, 'スポット人件費', 'L', totals[k], PL_SPOT_MEMO, '']);
  });
  if (dlast >= 2) dp.getRange(2, 1, dlast - 1, dlastCol).clearContent();
  if (keep.length) { dp.getRange(2, 1, keep.length, 7).setValues(keep); dp.getRange(2, 1, keep.length, 1).setNumberFormat('yyyy/m/d'); }

  // ② PL管理システム ✍販管費入力：DB_PLと同じキー（年月×店舗×スポット人件費）で差し替える。
  // syncSeisanFeeToPlと同じ理由で抜けていた（2026-08-24発覚・対応）。
  var plsysSpot = '';
  try {
    var pshSp = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (pshSp) {
      var lastRSp = pshSp.getLastRow(), nRSp = Math.max(lastRSp - 2, 0);
      var ASp = nRSp > 0 ? pshSp.getRange(3, 1, nRSp, 3).getValues() : [];
      var ESp = nRSp > 0 ? pshSp.getRange(3, 5, nRSp, 2).getValues() : [];
      var GSp = nRSp > 0 ? pshSp.getRange(3, 7, nRSp, 1).getValues() : [];
      var monthsSp = {};
      Object.keys(totals).forEach(function (k) { monthsSp[k.split('\t')[0]] = true; });
      for (var iSp0 = 0; iSp0 < nRSp; iSp0++) { if (String(ESp[iSp0][1]) === PL_SPOT_MEMO) monthsSp[bqPlYm_(ASp[iSp0][0])] = true; }
      var keepPSp = [];
      for (var iSp = 0; iSp < nRSp; iSp++) {
        if (String(ASp[iSp][0]) === '' && String(ASp[iSp][2]) === '') continue;
        if (monthsSp[bqPlYm_(ASp[iSp][0])] && String(ESp[iSp][1]) === PL_SPOT_MEMO) continue;   // 差し替え対象は捨てる
        keepPSp.push([ASp[iSp][0], ASp[iSp][1], ASp[iSp][2], ESp[iSp][0], ESp[iSp][1], GSp[iSp][0]]);
      }
      Object.keys(totals).forEach(function (k) {
        var partsSp = k.split('\t'), ymSp = partsSp[0], storeSp = partsSp[1];
        keepPSp.push([ymSp, storeSp, 'スポット人件費', totals[k], PL_SPOT_MEMO, '']);
      });
      if (nRSp > 0) { pshSp.getRange(3, 1, nRSp, 3).clearContent(); pshSp.getRange(3, 5, nRSp, 2).clearContent(); pshSp.getRange(3, 7, nRSp, 1).clearContent(); }
      if (keepPSp.length) {
        pshSp.getRange(3, 1, keepPSp.length, 3).setValues(keepPSp.map(function (r) { return [r[0], r[1], r[2]]; }));
        pshSp.getRange(3, 5, keepPSp.length, 2).setValues(keepPSp.map(function (r) { return [r[3], r[4]]; }));
        pshSp.getRange(3, 7, keepPSp.length, 1).setValues(keepPSp.map(function (r) { return [r[5]]; }));
      }
      plsysSpot = 'PL管理システムにも反映しました';
    } else plsysSpot = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (eSp) { plsysSpot = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(eSp && eSp.message || eSp); }

  var bqSync = bqSyncPL({ token: tk });
  return { ok: true, months: Object.keys(months).length, stores: Object.keys(totals).length, plsys: plsysSpot, bqSync: bqSync };
}

// ================== 運営委託費のPL自動連携（2026-08-23追加） ==================
// 業務委託（精算対象）の店舗について、精算ダッシュボード（別GASプロジェクト）が計算済みの
// 「業務委託費（税抜）」を毎月取得し、DB_PLへ自動計上する。既存の広告費自動連携
// （PL_AUTO_MEMO='媒体販促費（自動計上）'）と同じ考え方で、専用メモでマークした行だけを
// 差し替える（手入力行・他の自動行には触らない）。対象店舗はnippo店舗管理画面の
// 「💰精算対象」フラグ（Supabase stores.seisan_target）が正——ここで店舗を追加/除外すれば
// 次回の同期から自動的に反映される。黒霧屋は元々このフラグがOFFのため自動的に対象外になる。
var PL_SEISAN_MEMO = '運営委託費（自動計上）';
function syncSeisanFeeToPl(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var seisanUrl = PropertiesService.getScriptProperties().getProperty('SEISAN_WEBAPP_URL');
  var plSyncToken = PropertiesService.getScriptProperties().getProperty('PL_SYNC_TOKEN');
  if (!seisanUrl || !plSyncToken) return { ok: false, error: 'SEISAN_WEBAPP_URL または PL_SYNC_TOKEN が未設定です（スクリプトプロパティ）' };

  // 対象月: 指定が無ければ先月（精算書は通常、翌月に発行されるため）
  var ym = String((p || {}).ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    var d0 = new Date(); d0.setMonth(d0.getMonth() - 1);
    ym = Utilities.formatDate(d0, 'Asia/Tokyo', 'yyyy-MM');
  }

  // 対象店舗: Supabase store_directory_v から精算対象(seisan_target=true)の店舗一覧。
  // seisan_store_name（精算システム側の表記が違う場合の別名。2026-08-23追加）があれば
  // 精算システムへの問い合わせにはそちらを使い、PLへの書き込みは常にstores.name（正本）を使う。
  var storeRes = UrlFetchApp.fetch(
    'https://uuvsxzhpxtghojoubjcc.supabase.co/rest/v1/store_directory_v?select=name,seisan_target,seisan_store_name,aliases',
    { headers: { apikey: STORE_DIRECTORY_ANON_KEY_, Authorization: 'Bearer ' + STORE_DIRECTORY_ANON_KEY_ }, muteHttpExceptions: true }
  );
  if (storeRes.getResponseCode() !== 200) return { ok: false, error: '店舗一覧の取得に失敗しました' };
  // is_activeでは絞らない：業務委託店舗はnippo/シフト管理の対象外という意味でis_active=falseに
  // なっているだけで、精算・PL上は稼働中（2026-08-23の実地テストで判明）。seisan_targetのみで判定。
  var allStoreRows = JSON.parse(storeRes.getContentText());
  var stores = allStoreRows
    .filter(function (s) { return s.seisan_target; })
    .map(function (s) { return { name: s.name, seisanName: s.seisan_store_name || s.name }; });
  if (!stores.length) return { ok: true, ym: ym, synced: 0, note: '精算対象の店舗がありません' };
  var storeNames = stores.map(function (s) { return s.name; });
  // 自動化前に人が手入力していた「運営委託費」の古い行（表記ゆれの店舗名・別メモで残っている場合が
  // ある）も掃除の対象にするため、対象店舗のkind='name'別名も含めた名前セットを作る
  // （2026-08-23追加。5月分でMostFun/FumDiningというメモの旧手入力行と二重計上になっていたのを発覚・対応）。
  var cleanupNames = {};
  allStoreRows.forEach(function (s) {
    if (storeNames.indexOf(s.name) < 0) return;
    cleanupNames[s.name] = true;
    (s.aliases || []).forEach(function (a) { if (a.kind === 'name') cleanupNames[a.alias] = true; });
  });

  var results = [], errors = [];
  var byStore = {};
  stores.forEach(function (s) {
    var store = s.name;
    try {
      var res = UrlFetchApp.fetch(seisanUrl, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ fn: 'sd_apiTransferEx', args: [plSyncToken, s.seisanName, ym] })
      });
      var j = JSON.parse(res.getContentText());
      if (!j.ok) { errors.push(store + ': ' + (j.error || 'unknown')); return; }
      var r = j.result;
      // paid===false: 精算はあるが未振込（未確定）。確定額ではないのでPLに反映しない
      // （2026-08-24追加。振込前の金額を毎回反映すると、修正が入るたびPLの数字がブレるため）。
      if (!r || !r.found || !r.hasSales || r.paid === false) {
        var extra = (r && r.masterNames) ? '／精算システム側の店舗名一覧: ' + r.masterNames.join('、') : '';
        results.push(store + '（精算システム側の名前: ' + s.seisanName + '）: データ無し（スキップ）／理由: ' + (r && r.reason || '不明') + extra);
        return;
      }
      byStore[store] = Math.round(r.transferEx);
      results.push(store + ': ¥' + Math.round(r.transferEx).toLocaleString('ja-JP'));
    } catch (e) {
      errors.push(store + ': ' + String(e && e.message || e));
    }
  });

  // DB_PLへ反映: 対象月×対象店舗×このメモの既存行を削除し、取得できた分だけ入れ直す
  // ※G列（補助科目）を含めて読み書きすること。6列だけ読み書きすると、他の行のG列の値が
  // 元の行位置に取り残されたまま行の中身（A〜F）だけ入れ替わり、値がズレる（2026-08-23判明・対策済み）。
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!sh) return { ok: false, error: 'DB_PLシートがありません' };
  var lastRow = sh.getLastRow();
  var lastColSeisan = Math.max(sh.getLastColumn(), 7);
  var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);
  var keep = [];
  if (lastRow >= 2) {
    sh.getRange(2, 1, lastRow - 1, lastColSeisan).getValues().forEach(function (r) {
      if (r[0] === '' && r[1] === '' && r[2] === '') return;
      var sameMonth = bqPlYm_(r[0]) === ymSlash;
      // 2026-08-31修正（ユーザー報告「運営委託費が2倍になっている」で発覚）: 以前はstoreNames
      // （今回のstores.nameそのもの）としか一致判定しておらず、店舗名の表記が過去に変わった
      // （エイリアス統合等）場合、旧い表記で書き込まれた自動計上行がstoreNamesに含まれず
      // 一致せず、削除されずに残り続けていた（じんべぇ川崎／じんべえ川崎店 のように新旧の表記で
      // 同額が二重に計上される不具合）。isOldManualと同じcleanupNames（正準名＋全別名）で
      // 判定するよう修正し、どの表記で書かれていても確実に一掃されるようにする。
      var isMyAuto = String(r[5]) === PL_SEISAN_MEMO && cleanupNames[String(r[1]).trim()];
      // 自動化前の手入力「運営委託費」行（表記ゆれの店舗名・別メモ）も対象店舗なら一緒に差し替える
      // （メモが自分のものでなくても、勘定科目が運営委託費で対象店舗なら旧手入力とみなす）
      var isOldManual = String(r[2]).trim() === '運営委託費' && String(r[5]) !== PL_SEISAN_MEMO && cleanupNames[String(r[1]).trim()];
      if (sameMonth && (isMyAuto || isOldManual)) return; // 差し替え対象は捨てる（今回取れなかった店舗の古い行も一掃）
      keep.push(r);
    });
  }
  var y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  Object.keys(byStore).forEach(function (store) {
    keep.push([new Date(y, mo - 1, 1), store, '運営委託費', 'O', byStore[store], PL_SEISAN_MEMO, '']);
  });
  if (lastRow >= 2) sh.getRange(2, 1, lastRow - 1, lastColSeisan).clearContent();
  if (keep.length) { sh.getRange(2, 1, keep.length, 7).setValues(keep); sh.getRange(2, 1, keep.length, 1).setNumberFormat('yyyy/m/d'); }

  // ② PL管理システム ✍販管費入力：DB_PLと同じキー（年月×対象店舗×運営委託費）で差し替える。
  // 今まではDB_PL・BigQueryだけ更新しており、PL管理システム側の「月次PL」画面には一切
  // 反映されていなかった（ダッシュボードとPL管理システムで運営委託費の数字が食い違う不具合。
  // 2026-08-24発覚・対応。他の自動連携＝savePlEntries/savePlBulk/mfConfirmImportは元から
  // 両方へ書いていたが、このsyncSeisanFeeToPlだけDB_PL側の反映のみで抜けていた）。
  var plsysSeisan = '';
  try {
    var pshS = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (pshS) {
      var lastRS = pshS.getLastRow(), nRS = Math.max(lastRS - 2, 0);
      var AS = nRS > 0 ? pshS.getRange(3, 1, nRS, 3).getValues() : [];
      var ES = nRS > 0 ? pshS.getRange(3, 5, nRS, 2).getValues() : [];
      var GS = nRS > 0 ? pshS.getRange(3, 7, nRS, 1).getValues() : [];
      var keepPS = [];
      for (var iS = 0; iS < nRS; iS++) {
        if (String(AS[iS][0]) === '' && String(AS[iS][2]) === '') continue;
        var sameMonthS = bqPlYm_(AS[iS][0]) === ymSlash;
        var isMyAutoS = String(ES[iS][1]) === PL_SEISAN_MEMO && cleanupNames[String(AS[iS][1]).trim()]; // 2026-08-31修正（上のDB_PL側と同じ理由。storeNames単独一致だと旧表記の行が一掃されない）
        var isOldManualS = String(AS[iS][2]).trim() === '運営委託費' && String(ES[iS][1]) !== PL_SEISAN_MEMO && cleanupNames[String(AS[iS][1]).trim()];
        if (sameMonthS && (isMyAutoS || isOldManualS)) continue;
        keepPS.push([AS[iS][0], AS[iS][1], AS[iS][2], ES[iS][0], ES[iS][1], GS[iS][0]]);
      }
      Object.keys(byStore).forEach(function (store) {
        keepPS.push([ymSlash, store, '運営委託費', byStore[store], PL_SEISAN_MEMO, '']);
      });
      if (nRS > 0) { pshS.getRange(3, 1, nRS, 3).clearContent(); pshS.getRange(3, 5, nRS, 2).clearContent(); pshS.getRange(3, 7, nRS, 1).clearContent(); }
      if (keepPS.length) {
        pshS.getRange(3, 1, keepPS.length, 3).setValues(keepPS.map(function (r) { return [r[0], r[1], r[2]]; }));
        pshS.getRange(3, 5, keepPS.length, 2).setValues(keepPS.map(function (r) { return [r[3], r[4]]; }));
        pshS.getRange(3, 7, keepPS.length, 1).setValues(keepPS.map(function (r) { return [r[5]]; }));
      }
      plsysSeisan = 'PL管理システムにも反映しました';
    } else plsysSeisan = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (eS) { plsysSeisan = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(eS && eS.message || eS); }

  // DB_PL（シート）を更新しただけではPLタブのBigQueryモードに反映されない
  // （bqSyncPLで別途ミラーする設計のため）。書き忘れると「反映されない」に見えるので、
  // ここで自動的にBQミラーも同期する（2026-08-23発覚・修正）。
  var bqSync = bqSyncPL({ token: tk });

  return { ok: true, ym: ym, synced: Object.keys(byStore).length, detail: results, errors: errors, plsys: plsysSeisan, bqSync: bqSync };
}

// ================== A-9: 精算書の勘定科目・補助科目→PL自動連携（2026-08-31追加） ==================
// ns-portal/docs/設計書_広告費自動連携と精算書PL科目連携_2026-08-31.md §2・§4。
// 精算ダッシュボード側（SeisanDashboard.gs）で明細に勘定科目・補助科目を付けられるようになった
// （A-9・sd_apiCategorizedLines）。ここではその明細を店舗×年月×勘定科目×補助科目でDB_PLへ
// 「自動｜精算書」として計上する。既存のsyncSeisanFeeToPl（運営委託費）とは別メモで完全に独立
// （SeisanDashboard側が「対象外」「運営委託費」を除外して送ってくるため、こちらは受け取った行を
// そのまま計上するだけで二重計上にはならない）。
var PL_SEISAN_CAT_MEMO = '自動｜精算書';
// 勘定科目名→区分(S/F/L/A/R/O/X)。tori-dashboard/app.jsのPL_ITEM_CATと同じ24科目
// （SeisanDashboard.gsのSD_ACCOUNT_LISTとも同じ名前で揃えてある）。
// フロントJS(app.js)からは直接参照できない別ファイルのため、区分判定にだけ使う最小限を複製している。
// この一覧を変更した場合はapp.jsのPL_ITEM_CAT・SeisanDashboard.gsのSD_ACCOUNT_LISTも合わせて直すこと
// （変更頻度が低い固定リストのため、3箇所を自動同期する仕組みまでは作らない＝過剰実装を避ける）。
var PL_SEISAN_ACCOUNT_CAT_ = {
  '役員報酬': 'L', '法定福利費': 'L', '通勤手当': 'L', '旅費交通費': 'L', '賞与積立': 'L', '退職金等': 'L',
  '家賃': 'R', 'リース料': 'R', '家賃更新按分': 'R', '広告宣伝費': 'A', '販売促進費': 'A',
  '水道光熱費': 'O', '通信費': 'O', '消耗品・備品費': 'O', '修繕費': 'O', '衛生管理費': 'O', 'カード手数料': 'O',
  '支払手数料': 'O', '支払報酬料': 'O', '採用教育費': 'O', '接待交際費': 'O', '会議費': 'O', '慶弔見舞費': 'O',
  '保険料': 'O', '租税公課': 'O', '減価償却費': 'O', '福利厚生費': 'O', '諸会費': 'O', '雑費': 'O', '本部経費（按分）': 'O',
  'その他売上': 'S', '銀行返済': 'X', '仕入（食材・飲料）': 'F', '運営委託費': 'O'
};
function plSeisanGuessCat_(name) {
  if (PL_SEISAN_ACCOUNT_CAT_[name]) return PL_SEISAN_ACCOUNT_CAT_[name];
  if (/給料|雑給|人件費|法定福利|通勤/.test(name)) return 'L';
  if (/広告|販促/.test(name)) return 'A';
  if (/家賃|賃料/.test(name)) return 'R';
  if (/仕入/.test(name)) return 'F';
  if (/売上/.test(name)) return 'S';
  return 'O';
}
// ym単月、またはymFrom〜ymTo（さかのぼり一括同期用）のどちらかを指定する。
function syncSeisanCategoriesToPl(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var seisanUrl = PropertiesService.getScriptProperties().getProperty('SEISAN_WEBAPP_URL');
  var plSyncToken = PropertiesService.getScriptProperties().getProperty('PL_SYNC_TOKEN');
  if (!seisanUrl || !plSyncToken) return { ok: false, error: 'SEISAN_WEBAPP_URL または PL_SYNC_TOKEN が未設定です（スクリプトプロパティ）' };

  var months = [];
  var ymFrom = String((p || {}).ymFrom || '').trim(), ymTo = String((p || {}).ymTo || '').trim();
  if (ymFrom && ymTo) {
    if (!/^\d{4}-\d{2}$/.test(ymFrom) || !/^\d{4}-\d{2}$/.test(ymTo)) return { ok: false, error: '対象期間が不正です' };
    var y1 = +ymFrom.slice(0, 4), m1 = +ymFrom.slice(5, 7), y2 = +ymTo.slice(0, 4), m2 = +ymTo.slice(5, 7);
    var n = (y2 - y1) * 12 + (m2 - m1) + 1;
    if (n < 1) return { ok: false, error: '終了月が開始月より前です' };
    if (n > 36) return { ok: false, error: 'さかのぼりは36ヶ月までです（分割して実行してください）' };
    for (var i = 0; i < n; i++) { var yy = y1 + Math.floor((m1 - 1 + i) / 12), mm = (m1 - 1 + i) % 12 + 1; months.push(yy + '-' + ('0' + mm).slice(-2)); }
  } else {
    var ym = String((p || {}).ym || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      var d0 = new Date(); d0.setMonth(d0.getMonth() - 1);
      ym = Utilities.formatDate(d0, 'Asia/Tokyo', 'yyyy-MM');
    }
    months = [ym];
  }

  var storeRes = UrlFetchApp.fetch(
    'https://uuvsxzhpxtghojoubjcc.supabase.co/rest/v1/store_directory_v?select=name,seisan_target,seisan_store_name,aliases',
    { headers: { apikey: STORE_DIRECTORY_ANON_KEY_, Authorization: 'Bearer ' + STORE_DIRECTORY_ANON_KEY_ }, muteHttpExceptions: true }
  );
  if (storeRes.getResponseCode() !== 200) return { ok: false, error: '店舗一覧の取得に失敗しました' };
  var allStoreRows = JSON.parse(storeRes.getContentText());
  var stores = allStoreRows.filter(function (s) { return s.seisan_target; })
    .map(function (s) { return { name: s.name, seisanName: s.seisan_store_name || s.name }; });
  if (!stores.length) return { ok: true, months: months, synced: 0, note: '精算対象の店舗がありません' };
  var storeNames = stores.map(function (s) { return s.name; });
  // syncSeisanFeeToPlの2026-08-31修正と同じ理由: 店舗名の表記が過去に変わった場合でも
  // 自分が書いた行を確実に一掃できるよう、正準名＋全別名（kind='name'）のセットで判定する
  // （storeNames単独一致だと、旧い表記で書かれた行が削除されず二重計上になる）。
  var cleanupNames = {};
  allStoreRows.forEach(function (s) {
    if (storeNames.indexOf(s.name) < 0) return;
    cleanupNames[s.name] = true;
    (s.aliases || []).forEach(function (a) { if (a.kind === 'name') cleanupNames[a.alias] = true; });
  });

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!sh) return { ok: false, error: 'DB_PLシートがありません' };
  var pshS = null;
  try { pshS = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET); } catch (eOpen) {}

  var monthResults = [], errors = [], subPairs = [];
  months.forEach(function (ym) {
    var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);
    var y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
    var newRows = []; // [store, account, sub, amountEx]
    stores.forEach(function (s) {
      try {
        var res = UrlFetchApp.fetch(seisanUrl, {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ fn: 'sd_apiCategorizedLines', args: [plSyncToken, s.seisanName, ym] })
        });
        var j = JSON.parse(res.getContentText());
        if (!j.ok) { errors.push(ym + ' ' + s.name + ': ' + (j.error || 'unknown')); return; }
        var r = j.result;
        if (!r || !r.found || !r.hasSales || r.paid === false || !r.lines) return; // 未確定・データ無しはスキップ（syncSeisanFeeToPlと同じ方針）
        r.lines.forEach(function (line) {
          newRows.push([s.name, line.account, line.subAccount || '', line.amountEx]);
          subPairs.push([line.account, line.subAccount || '']);
        });
      } catch (e) { errors.push(ym + ' ' + s.name + ': ' + String(e && e.message || e)); }
    });

    // DB_PL: この月×対象店舗×自分のメモの行を差し替え
    var lastRow = sh.getLastRow();
    var lastCol = Math.max(sh.getLastColumn(), 7);
    var keep = [];
    if (lastRow >= 2) {
      sh.getRange(2, 1, lastRow - 1, lastCol).getValues().forEach(function (r2) {
        if (r2[0] === '' && r2[1] === '' && r2[2] === '') return;
        var sameMonth = bqPlYm_(r2[0]) === ymSlash;
        var isMine = String(r2[5]) === PL_SEISAN_CAT_MEMO && cleanupNames[String(r2[1]).trim()];
        if (sameMonth && isMine) return;
        keep.push(r2);
      });
      newRows.forEach(function (nr) { keep.push([new Date(y, mo - 1, 1), nr[0], nr[1], plSeisanGuessCat_(nr[1]), nr[3], PL_SEISAN_CAT_MEMO, nr[2]]); });
      sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
      if (keep.length) { sh.getRange(2, 1, keep.length, 7).setValues(keep); sh.getRange(2, 1, keep.length, 1).setNumberFormat('yyyy/m/d'); }
    } else if (newRows.length) {
      var out = newRows.map(function (nr) { return [new Date(y, mo - 1, 1), nr[0], nr[1], plSeisanGuessCat_(nr[1]), nr[3], PL_SEISAN_CAT_MEMO, nr[2]]; });
      sh.getRange(2, 1, out.length, 7).setValues(out); sh.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d');
    }

    // PL管理システム ✍販管費入力にも同じキーで反映（syncSeisanFeeToPlと同じ二重反映パターン）
    if (pshS) {
      try {
        var lastRS = pshS.getLastRow(), nRS = Math.max(lastRS - 2, 0);
        var AS = nRS > 0 ? pshS.getRange(3, 1, nRS, 3).getValues() : [];
        var ES = nRS > 0 ? pshS.getRange(3, 5, nRS, 2).getValues() : [];
        var GS = nRS > 0 ? pshS.getRange(3, 7, nRS, 1).getValues() : [];
        var keepPS = [];
        for (var iS = 0; iS < nRS; iS++) {
          if (String(AS[iS][0]) === '' && String(AS[iS][2]) === '') continue;
          var sameMonthS = bqPlYm_(AS[iS][0]) === ymSlash;
          var isMineS = String(ES[iS][1]) === PL_SEISAN_CAT_MEMO && cleanupNames[String(AS[iS][1]).trim()];
          if (sameMonthS && isMineS) continue;
          keepPS.push([AS[iS][0], AS[iS][1], AS[iS][2], ES[iS][0], ES[iS][1], GS[iS][0]]);
        }
        newRows.forEach(function (nr) { keepPS.push([ymSlash, nr[0], nr[1], nr[3], PL_SEISAN_CAT_MEMO, nr[2]]); });
        if (nRS > 0) { pshS.getRange(3, 1, nRS, 3).clearContent(); pshS.getRange(3, 5, nRS, 2).clearContent(); pshS.getRange(3, 7, nRS, 1).clearContent(); }
        if (keepPS.length) {
          pshS.getRange(3, 1, keepPS.length, 3).setValues(keepPS.map(function (r3) { return [r3[0], r3[1], r3[2]]; }));
          pshS.getRange(3, 5, keepPS.length, 2).setValues(keepPS.map(function (r3) { return [r3[3], r3[4]]; }));
          pshS.getRange(3, 7, keepPS.length, 1).setValues(keepPS.map(function (r3) { return [r3[5]]; }));
        }
      } catch (eS) { errors.push(ym + ' PL管理システム反映エラー: ' + String(eS && eS.message || eS)); }
    }
    monthResults.push(ym + ': ' + newRows.length + '件');
  });

  if (subPairs.length) ensureSubItemMaster_(subPairs); // 新しい補助科目をDB_補助科目マスタへ学習させる
  var bqSync = bqSyncPL({ token: tk });
  return { ok: true, months: months, detail: monthResults, errors: errors, plsysUpdated: !!pshS, bqSync: bqSync };
}

// ================== 銀行借入 利息・元金のPL自動連携（2026-08-26追加・A-5） ==================
// ns-portal/docs/実装指示書_ラウンド3_2026-08-26.md A-5（ユーザー確定版）:
// ①支払利息＝DB_PLへ「自動｜支払利息」（O区分）として店舗按分どおりに費用計上
// ②返済元金＝DB_PLには入れず（勘定科目区分Xは「PL外（財務CF）」の意味で既に予約済み。
//   フロント側のplCatOf()/plAgg()はF/L/A/R以外を一律Oへ丸めてしまうため、Xのつもりで
//   書いてもO区分の費用として販管費計・営業利益に混ざってしまう＝書いてはいけない）、
//   専用シートDB_借入返済元金に集計して置くだけにする。PLタブの「簡易キャッシュフロー」
//   セクションが営業利益からこの元金を差し引いて表示する（app.js側）。
// データ源: ns-info-system（F-8）の返済データ共有ビューAPI（トークン認証・GET）。
var LOAN_INTEREST_MEMO = '自動｜支払利息';
function syncBankLoanToPl(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  return syncBankLoanToPl_(tk);
}
function syncBankLoanToPl_(tk) {
  var feedToken = PropertiesService.getScriptProperties().getProperty('LOAN_REPAYMENT_FEED_TOKEN');
  if (!feedToken) return { ok: false, error: 'LOAN_REPAYMENT_FEED_TOKEN が未設定です（スクリプトプロパティ。ns-info-systemの返済データAPI用トークン）' };

  var feedRes = UrlFetchApp.fetch('https://ns-info-system.vercel.app/api/loan-repayment-feed', {
    headers: { Authorization: 'Bearer ' + feedToken }, muteHttpExceptions: true
  });
  if (feedRes.getResponseCode() !== 200) return { ok: false, error: '返済データ取得に失敗しました（HTTP ' + feedRes.getResponseCode() + '）' };
  var feed = JSON.parse(feedRes.getContentText());
  var feedRows = feed.rows || [];

  // 店舗名解決: F-8のstoreName（ns-info-system info.stores由来）→ このダッシュボードの内部店舗名。
  // 2システム間の店舗マスタが完全には一致していない既知の問題があるため（2026-08-26調査レポート参照）、
  // 完全一致→store_directory_vの別名(kind='name')→どちらも不一致なら「全社共通」（空欄）に
  // フォールバックする（黙って捨てない・数値自体は必ずどこかの行に残す設計）。
  var nameSet = {}, aliasMap = {};
  try {
    var storeRes = UrlFetchApp.fetch(STORE_DIRECTORY_URL_, {
      headers: { apikey: STORE_DIRECTORY_ANON_KEY_, Authorization: 'Bearer ' + STORE_DIRECTORY_ANON_KEY_ }, muteHttpExceptions: true
    });
    if (storeRes.getResponseCode() === 200) {
      JSON.parse(storeRes.getContentText()).forEach(function (s) {
        nameSet[s.name] = true;
        (s.aliases || []).forEach(function (a) { if (a.kind === 'name') aliasMap[a.alias] = s.name; });
      });
    }
  } catch (eDir) { /* 店舗マスタ取得失敗時は全件「全社共通」寄りになるが致命的ではないので続行 */ }
  function resolveLoanStore_(name) {
    if (!name) return '';
    if (nameSet[name]) return name;
    if (aliasMap[name]) return aliasMap[name];
    return ''; // 不一致は全社共通行として扱う（数値を捨てない）
  }

  // 年月×店舗で集計（利息・元金は別々の行き先に反映するので個別に合計する）
  var interestByYmStore = {}, principalRows = [];
  feedRows.forEach(function (r) {
    var ym = String(r.yearMonth || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(ym)) return;
    var store = resolveLoanStore_(r.storeName);
    var interest = Math.round(Number(r.interestAmount || 0));
    var principal = Math.round(Number(r.principalAmount || 0));
    if (interest) {
      // キーはymOf_()と同じ'yyyy/MM'（スラッシュ）形式にする。ym('yyyy-MM')のままだと
      // 下の「対象月×メモの行だけ差し替え」判定（ymOf_(r[0])で作るmonths）と形式が食い違い、
      // 既存の自動計上行が二度と「今回の対象月」と認識されず、実行のたびに重複が積み上がる
      // （syncSpotLaborToPl_のtotalsキーがyyyy/MM形式なのはこのため。自己レビューで発見・修正）。
      var ik = ym.replace('-', '/') + '\t' + store;
      interestByYmStore[ik] = (interestByYmStore[ik] || 0) + interest;
    }
    if (principal) {
      principalRows.push([ym, store, String(r.corporationName || ''), principal, '']);
    }
  });

  // ① 支払利息 → DB_PL（自動｜支払利息, O区分）。syncSpotLaborToPl_と同じ「対象月×このメモの行だけ差し替え」方式。
  var dp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!dp) return { ok: false, error: 'DB_PLシートがありません' };
  var dlast = dp.getLastRow();
  var dlastCol = Math.max(dp.getLastColumn(), 7);
  var allRows = dlast >= 2 ? dp.getRange(2, 1, dlast - 1, dlastCol).getValues() : [];
  var months = {};
  Object.keys(interestByYmStore).forEach(function (k) { months[k.split('\t')[0]] = true; });
  allRows.forEach(function (r) { if (String(r[5]) === LOAN_INTEREST_MEMO) months[ymOf_(r[0])] = true; });
  var keep = [];
  allRows.forEach(function (r) {
    if (r[0] === '' && r[1] === '' && r[2] === '') return;
    var ym = ymOf_(r[0]);
    if (months[ym] && String(r[5]) === LOAN_INTEREST_MEMO) return;   // 差し替え対象は捨てる
    keep.push(r);
  });
  Object.keys(interestByYmStore).forEach(function (k) {
    var parts = k.split('\t'), ym = parts[0], store = parts[1];
    var y = +ym.slice(0, 4), mo = +ym.slice(5, 7);
    keep.push([new Date(y, mo - 1, 1), store, '支払利息', 'O', interestByYmStore[k], LOAN_INTEREST_MEMO, '']);
  });
  if (dlast >= 2) dp.getRange(2, 1, dlast - 1, dlastCol).clearContent();
  if (keep.length) { dp.getRange(2, 1, keep.length, 7).setValues(keep); dp.getRange(2, 1, keep.length, 1).setNumberFormat('yyyy/m/d'); }

  // ② PL管理システム ✍販管費入力：DB_PLと同じキー（年月×店舗×支払利息）で差し替える
  // （syncSeisanFeeToPl/syncSpotLaborToPl_と同じ理由。ここを忘れるとダッシュボードとPL管理システムの数字が食い違う）。
  var plsysLoan = '';
  try {
    var pshL = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (pshL) {
      var lastRL = pshL.getLastRow(), nRL = Math.max(lastRL - 2, 0);
      var AL = nRL > 0 ? pshL.getRange(3, 1, nRL, 3).getValues() : [];
      var EL = nRL > 0 ? pshL.getRange(3, 5, nRL, 2).getValues() : [];
      var GL = nRL > 0 ? pshL.getRange(3, 7, nRL, 1).getValues() : [];
      var monthsL = {};
      Object.keys(interestByYmStore).forEach(function (k) { monthsL[k.split('\t')[0]] = true; });
      for (var iL0 = 0; iL0 < nRL; iL0++) { if (String(EL[iL0][1]) === LOAN_INTEREST_MEMO) monthsL[bqPlYm_(AL[iL0][0])] = true; }
      var keepPL = [];
      for (var iL = 0; iL < nRL; iL++) {
        if (String(AL[iL][0]) === '' && String(AL[iL][2]) === '') continue;
        if (monthsL[bqPlYm_(AL[iL][0])] && String(EL[iL][1]) === LOAN_INTEREST_MEMO) continue;   // 差し替え対象は捨てる
        keepPL.push([AL[iL][0], AL[iL][1], AL[iL][2], EL[iL][0], EL[iL][1], GL[iL][0]]);
      }
      Object.keys(interestByYmStore).forEach(function (k) {
        var partsL = k.split('\t'), ymL = partsL[0], storeL = partsL[1];
        keepPL.push([ymL, storeL, '支払利息', interestByYmStore[k], LOAN_INTEREST_MEMO, '']);
      });
      if (nRL > 0) { pshL.getRange(3, 1, nRL, 3).clearContent(); pshL.getRange(3, 5, nRL, 2).clearContent(); pshL.getRange(3, 7, nRL, 1).clearContent(); }
      if (keepPL.length) {
        pshL.getRange(3, 1, keepPL.length, 3).setValues(keepPL.map(function (r) { return [r[0], r[1], r[2]]; }));
        pshL.getRange(3, 5, keepPL.length, 2).setValues(keepPL.map(function (r) { return [r[3], r[4]]; }));
        pshL.getRange(3, 7, keepPL.length, 1).setValues(keepPL.map(function (r) { return [r[5]]; }));
      }
      plsysLoan = 'PL管理システムにも反映しました';
    } else plsysLoan = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (eL) { plsysLoan = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(eL && eL.message || eL); }

  // ③ 返済元金 → DB_借入返済元金（毎回全件差し替え。このシートは他の入力と混在しないため単純上書きでよい）
  var loanSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_借入返済元金');
  if (!loanSh) {
    loanSh = SpreadsheetApp.getActiveSpreadsheet().insertSheet('DB_借入返済元金');
    loanSh.getRange(1, 1, 1, 5).setValues([['年月', '店舗', '法人', '元金額', 'メモ']]).setFontWeight('bold').setBackground('#efe9dd');
    loanSh.setFrozenRows(1);
  }
  var loanLast = loanSh.getLastRow();
  if (loanLast >= 2) loanSh.getRange(2, 1, loanLast - 1, 5).clearContent();
  if (principalRows.length) loanSh.getRange(2, 1, principalRows.length, 5).setValues(principalRows);

  // BQミラー（両方とも即時反映。翌朝の定期同期を待たせない）
  var bqSyncLoan = bqSyncPL({ token: tk });
  bqSyncLoanNow_();

  return {
    ok: true, generatedAt: feed.generatedAt, interestMonths: Object.keys(months).length,
    interestStores: Object.keys(interestByYmStore).length, principalRows: principalRows.length,
    plsys: plsysLoan, bqSync: bqSyncLoan
  };
}

// 簡易キャッシュフローの法人税率設定（既定34%・PL_TAX_RATEスクリプトプロパティ。2026-08-26追加・A-5）。
function plTaxRate_() {
  var v = Number(PropertiesService.getScriptProperties().getProperty('PL_TAX_RATE'));
  return (v > 0 && v < 1) ? v : 0.34;
}
function setPlTaxRate(p, session) {
  if (!(session.role === '社長' || session.role === '本部')) return { ok: false, error: '権限がありません' };
  var v = Number(p.rate);
  if (!(v >= 0 && v < 1)) return { ok: false, error: '税率は0〜1の範囲で指定してください（例: 0.34 = 34%）' };
  PropertiesService.getScriptProperties().setProperty('PL_TAX_RATE', String(v));
  return { ok: true, rate: v };
}

// 既存のingestDeposit()がそのまま解釈できる形（{sheets:{deposit:[[店舗名,日付,入金額,メモ],...]}}）で返す。
// 繰越（開始残高）計算のdepositCarry()はこのBQミラーを経由せず、常にローカルシートを直接読む
// （全期間の累計が必要なため。ここで切り替わるのは「今月の明細」を表示する部分だけ）。
function bqGetDeposit(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var where = '';
    if (restricted) {
      var allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (allowNames.length) {
        where = "WHERE store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "')";
      }
    }
    var ck = bqCacheKey_('deposit', [restricted && allowNames.length ? allowNames.slice().sort().join('.') : 'all']);
    var cached = bqCacheGet_(ck);
    if (cached) return cached;
    var sql = 'SELECT store_name, date, amount, memo FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_deposit` ' + where + ' ORDER BY date';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var out = [['店舗名', '日付', '入金額', 'メモ']];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      // DATE型は'YYYY-MM-DD'文字列で返るため、bqDailyStoreと同じくシート版と揃えて'YYYY/MM/DD'に変換
      out.push([r[0], String(r[1]).replace(/-/g, '/'), Number(r[2] || 0), r[3]]);
    }
    var res = { ok: true, sheets: { deposit: out } };
    bqCachePut_(ck, res);
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 媒体別日次タブ用: 媒体別DBのBQミラー(stg_media)を読む。bqGetDepositと同じ方針。
// 2026-08-23追加: 媒体別日次シートが21,000件超まで育ち、ログイン直後・更新(⌘R)時の
// 生シート読込がGAS側でタイムアウトし「同期エラー」になる不具合（前日のLark配信と同根の
// 問題。あちらは自動配信のみ対応し、ダッシュボード本体のログイン処理は未対応だった）への対応。
function bqGetMedia(p, session) {
  try {
    var sessStores = String(session && session.stores || '').trim();
    var restricted = sessStores && sessStores !== '全店';
    var where = '';
    if (restricted) {
      var allowNames = sessStores.split(/[,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (allowNames.length) {
        where = "WHERE store_name IN ('" + allowNames.map(function (n) { return String(n).replace(/'/g, "''"); }).join("','") + "')";
      }
    }
    // 全期間(2万件超)を毎回まるごと返すと、BQ結果をApps Script側で1行ずつ配列に組み立てる
    // 処理自体が重く、シート直読みとあまり変わらない速度になってしまっていた（実地報告で発覚・
    // 2026-08-23）。bqDailyStoreと同じくmonthsで絞る（クライアント側はmonthsWindow()=既定13ヶ月を渡す）。
    var months = Number(p.months) || 0;
    // 2026-08-26修正（担当D依頼）: 上のmonths絞り込みだけだと「媒体別 売上」パネルの前年比が
    // 常に「前年 ―」になっていた（stg_media自体は2023-11から3年弱のデータがあるのに、フロントが
    // 直近3ヶ月しか受け取らないため前年同期間が1件も無かった＝データ不足ではなくこの絞り込みが原因と
    // mediaDateRangeDiagで確定）。前年比を必要とするmediaTableRows()のために、直近months分に加えて
    // 「ちょうど1年前の同じ幅」の期間もOR条件で一緒に返す（p.alsoPriorYearが真の時のみ・
    // 呼び出し元がmonthsWindow()の全期間を要求する場合は不要なので明示オプトインにしてある）。
    if (months > 0) {
      var cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - months);
      var cutoffStr = Utilities.formatDate(cutoff, 'Asia/Tokyo', 'yyyy-MM-dd');
      var dateCond = "date >= DATE('" + cutoffStr + "')";
      if (p.alsoPriorYear) {
        var priorEnd = new Date(); priorEnd.setFullYear(priorEnd.getFullYear() - 1);
        var priorStart = new Date(priorEnd); priorStart.setMonth(priorStart.getMonth() - months);
        var priorEndStr = Utilities.formatDate(priorEnd, 'Asia/Tokyo', 'yyyy-MM-dd');
        var priorStartStr = Utilities.formatDate(priorStart, 'Asia/Tokyo', 'yyyy-MM-dd');
        dateCond = '(' + dateCond + " OR (date >= DATE('" + priorStartStr + "') AND date <= DATE('" + priorEndStr + "')))";
      }
      where += (where ? ' AND ' : 'WHERE ') + dateCond;
    }
    var ck = bqCacheKey_('media', [months, p.alsoPriorYear ? 1 : 0, restricted && allowNames.length ? allowNames.slice().sort().join('.') : 'all']);
    var cached = bqCacheGet_(ck);
    if (cached) return cached;
    var sql = 'SELECT store_name, date, media_name, guests, parties, net_sales FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_media` ' + where + ' ORDER BY date';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var out = [['店舗名', '営業日', '媒体名', '客数', '客組数', '純売上']];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      out.push([r[0], String(r[1]).replace(/-/g, '/'), r[2], Number(r[3] || 0), Number(r[4] || 0), Number(r[5] || 0)]);
    }
    var res = { ok: true, sheets: { media: out } };
    bqCachePut_(ck, res);
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 直近days日分の合計(純売上・仕入れ・人件費合計)をBQとシートで突合。差額が出たテーブル名をmismatchedに返す
// （通知メールはこの関数自体では送らない。呼び出し元＝ns-daily-importの日次タスクが
//  mismatchedを見てemailNotify()するのが役割分担。GASの権限を増やさないための設計）
function bqReconcileSales(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var days = Number((p || {}).days) || 35;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('分析_日別店舗');
  if (!sh) return { ok: false, error: '分析_日別店舗が見つかりません' };
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'データがありません' };
  var values = sh.getRange(2, 1, lastRow - 1, 35).getValues();
  var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  var cutoffStr = Utilities.formatDate(cutoff, 'Asia/Tokyo', 'yyyy-MM-dd');
  var sheetSum = { net_sales: 0, cogs: 0, labor_cost_total: 0, count: 0 };
  for (var i = 0; i < values.length; i++) {
    var d = values[i][0];
    // 2026-08-22 修正: 時刻付きのDate同士で比較すると「今日の現在時刻」がズレを生み境界日が
    // 抜け落ちる(BQ側はDATE型の日付のみ比較のため)。日付文字列同士の比較に統一して一致させる。
    if (!(Object.prototype.toString.call(d) === '[object Date]')) continue;
    var dStr = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
    if (dStr < cutoffStr) continue;
    sheetSum.net_sales += Number(values[i][17]) || 0;        // 18列目: 純売上
    sheetSum.labor_cost_total += Number(values[i][25]) || 0; // 26列目: 人件費合計
    sheetSum.cogs += Number(values[i][26]) || 0;             // 27列目: 仕入れ
    sheetSum.count++;
  }
  var sql = 'SELECT SUM(net_sales) AS net_sales, SUM(cogs) AS cogs, SUM(labor_cost_total) AS labor_cost_total, COUNT(*) AS cnt ' +
    'FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store` WHERE date >= DATE(\'' + cutoffStr + '\')';
  var bqRows = bqRows_(sql);
  if (!bqRows || bqRows.length < 2) return { ok: false, error: 'BQクエリ失敗（先にbqSyncSalesを実行済みか確認）' };
  var row = bqRows[1];
  var bq = { net_sales: Number(row[0] || 0), cogs: Number(row[1] || 0), labor_cost_total: Number(row[2] || 0), count: Number(row[3] || 0) };
  var diffs = {
    net_sales: Math.round(sheetSum.net_sales - bq.net_sales),
    cogs: Math.round(sheetSum.cogs - bq.cogs),
    labor_cost_total: Math.round(sheetSum.labor_cost_total - bq.labor_cost_total)
  };
  var threshold = 100; // 円。丸め誤差程度は許容
  var mismatched = [];
  for (var k in diffs) if (Math.abs(diffs[k]) >= threshold) mismatched.push(k);
  return { ok: true, days: days, sinceDate: cutoffStr, sheet: sheetSum, bq: bq, diffs: diffs, mismatched: mismatched };
}

// ================== 軽量レポート数値（Lark/Chatwork自動配信用・2026-08-23追加） ==================
// 背景: 媒体別日次シートが21,000件超まで育ち、ログイン→スプレッドシート全読みを待つ
// 従来方式（Puppeteerでダッシュボードを開いてスクリーンショット）がGAS側の読込待ちで
// 詰まり、自動配信全体が止まる問題が発生した（2026-08-22）。この方式はログイン・画面描画・
// スクリーンショットを一切使わず、必要な数字だけをBigQueryから直接返す。
// 専用トークン認証・ログイン不要（bqDailyStoreForSyncと同じ方針）。
// ランチ/ディナー内訳・Google口コミはBigQuery未対応のため省略（呼び出し側のbuildText()は
// これらが無くても正常に動く設計になっている）。
// 一時的な診断用（2026-08-23）: DB_PLの運営委託費(自動計上)行を年月×店舗ごとに件数と
// 合計を返す。二重計上が無いか確認するため。読み取り専用（BigQuery stg_plを見るだけ）。
// 一時テスト用（2026-09-02・使用後削除予定）: 入金の二重計上疑い調査（ユーザー報告・A-hf⑤）。
// stg_deposit（正規化後）で同一store_name×date×amountが複数件になっている組を抽出し、
// その原因となった可能性のある「入金DB」シート側の生の店舗名表記（正規化前）も突き合わせる。
function depositDupDiag_(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var sql = "SELECT store_name, date, amount, COUNT(*) n, STRING_AGG(DISTINCT memo, ' / ') memos " +
    "FROM `" + BQ_PROJECT + "." + BQ_SALES_DATASET + ".stg_deposit` " +
    "GROUP BY store_name, date, amount HAVING n > 1 ORDER BY date DESC LIMIT 50";
  var rows = bqRows_(sql);
  if (!rows) return { ok: false, error: 'query failed' };
  var dupGroups = [];
  for (var i = 1; i < rows.length; i++) {
    dupGroups.push({ store: rows[i][0], date: rows[i][1], amount: rows[i][2], count: Number(rows[i][3]), memos: rows[i][4] });
  }
  // 入金DBシート（ダッシュボード本体側）の生の店舗名一覧（正規化前・重複含む）も返す
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('入金DB');
  var rawStoreNames = [];
  if (sh) {
    var head = depositHeaderRow_(sh);
    if (head > 0 && sh.getLastRow() > head) {
      var vals = sh.getRange(head + 1, 1, sh.getLastRow() - head, 1).getValues();
      var seen = {};
      for (var j = 0; j < vals.length; j++) {
        var nm = String(vals[j][0] || '').trim();
        if (nm && !seen[nm]) { seen[nm] = true; rawStoreNames.push(nm); }
      }
    }
  }
  return { ok: true, dupGroupCount: dupGroups.length, dupGroups: dupGroups, rawStoreNamesInSheet: rawStoreNames };
}
function plSeisanDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var ym = String((p || {}).ym || '').trim();
  var where = "WHERE item = '運営委託費'" + (ym ? " AND year_month = '" + ym.replace(/'/g, "''") + "'" : '');
  var sql = 'SELECT year_month, store_name, amount, memo, COUNT(*) OVER (PARTITION BY year_month, store_name) as dup_count ' +
    'FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_pl` ' + where + ' ORDER BY year_month, store_name';
  var rows = bqRows_(sql);
  if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
  var out = [];
  for (var i = 1; i < rows.length; i++) out.push(rows[i]);
  return { ok: true, header: rows[0], rows: out };
}

// 一時的な診断用（2026-08-23）: DB_店舗ID対応（dinii明細の店舗名）とfact_daily_store.store_name
// （店舗別実績の店舗名）が一致しているか突合する。明細分析の店舗別・客数/組数の実績差し替えが
// 効かない店舗（表記ゆれで突合できていない店舗）を特定するため。読み取り専用。
// 診断用（2026-09-02追加）: 「DB_権限定義」シートの内容をそのまま返す（読み取り専用・専用トークン
// 認証）。ユーザー報告「予約タブがチーム長等で開くと経営ダッシュボードになる」の調査用。新しいタブを
// 追加したときにこのシートの更新が追いつかない、という同種の問題が今後も起こり得るため、一時使い捨て
// にせず常設の診断actionとして残す（storeNameAudit等と同じ方針）。
// 使い方: ?action=roleDefDiag&token=<BQ_LOAD_TOKEN>
function roleDefDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_権限定義');
  if (!sh) return { ok: true, exists: false, rows: [] };
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, exists: true, rows: [] };
  var vals = sh.getRange(2, 1, last - 1, 4).getValues();
  var rows = vals.filter(function (r) { return String(r[0]).trim() || String(r[1]).trim(); })
    .map(function (r) { return { 区分: r[0], 名称: r[1], 表示するタブ: r[2], 使える機能: r[3] }; });
  return { ok: true, exists: true, rows: rows };
}
function storeMapDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var diniiNames = Object.values(bqStoreMap_());
  var real = bqRows_('SELECT DISTINCT store_name FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store` ORDER BY store_name');
  var realNames = real ? real.slice(1).map(function (r) { return r[0]; }) : [];
  var unmatched = diniiNames.filter(function (n) { return realNames.indexOf(n) < 0; });
  return { ok: true, diniiNames: diniiNames, realNames: realNames, unmatched: unmatched };
}

// 診断用（2026-08-28追加）: 分析_日別店舗ほかBQミラー対象8テーブルのDISTINCT store_nameを、
// Supabase store_aliases（bqStoreNameIndex_・store_directory_vのaliases）と突き合わせ、
// どのエイリアスにも一致しない（＝表記ゆれ未登録の可能性がある）店舗名だけを一覧で返す。
// じんべぇ 川崎／じんべぇ 新横浜／エース 本厚木の3件がBQ側で売上シートの生表記のまま入っており
// Chatwork/Lark配信から見つからなくなっていた不具合（2026-08-28担当D実機調査）を踏まえ、
// 「取込むCSVによって今後も同種の表記ゆれが起こり得る」という指摘への恒常チェック手段として新設。
// 読み取り専用・専用トークン認証。使い方: ?action=storeNameAudit&token=<BQ_LOAD_TOKEN>
function storeNameAudit(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var idx = bqStoreNameIndex_();
  if (!idx) return { ok: false, error: '店舗マスタ（Supabase store_directory_v）の取得に失敗しました' };
  var tables = ['fact_daily_store', 'stg_payment', 'stg_media', 'stg_siire', 'stg_jinken', 'stg_deposit', 'stg_spot', 'stg_loan_principal'];
  var out = {};
  for (var i = 0; i < tables.length; i++) {
    var t = tables[i];
    try {
      var rows = bqRows_('SELECT DISTINCT store_name FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.' + t +
        '` WHERE store_name IS NOT NULL AND store_name != \'\' ORDER BY store_name');
      var names = rows ? rows.slice(1).map(function (r) { return r[0]; }) : [];
      var unmatched = names.filter(function (n) { return !idx[storeKey_(n)]; });
      if (unmatched.length) out[t] = unmatched;
    } catch (e) {
      out[t] = { error: String(e && e.message || e) };
    }
  }
  var clean = Object.keys(out).length === 0;
  return {
    ok: true, clean: clean, unmatched_by_table: out,
    note: clean ? '全テーブルで未登録の店舗名表記は見つかりませんでした'
      : '下記の店舗名はSupabase store_aliasesのどのエイリアスにも一致しません。新しい表記ゆれ・新規店舗・入力ミスのいずれかの可能性があるため確認してください（一致すればbqSyncSales側は自動で正規化されます。エイリアス登録はstore_aliasesテーブルへの追加のみで対応可能）'
  };
}

// 一時的な診断用（2026-08-23）: 「ダッシュボード全体が遅い」報告を受け、BQモード(useBqDaily)の各アクション
// 実体を計測し、ボトルネックが「BigQueryのクエリ実行そのもの」なのか別要因なのかを切り分ける。
// 読み取り専用・専用トークン認証。実データは返さず時間だけ返す（全店・直近13ヶ月＝クライアントの既定と同条件）。
function bqPerfDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var now = function () { return new Date().getTime(); };
  var sess = { stores: '全店' };
  var T = {}, t0 = now();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var monthStart = today.slice(0, 8) + '01';
  var s;
  s = now(); try { var d1 = bqDetail({ from: monthStart, to: today, store: 'all' }, sess); T.bqDetail_明細分析 = { ms: now() - s, ok: !!(d1 && d1.ok), rows: d1 ? { hour: (d1.hour || []).length, item: (d1.item || []).length, store: (d1.store || []).length, hourItem: (d1.hourItem || []).length } : null }; } catch (e) { T.bqDetail_明細分析 = { ms: now() - s, error: String(e) }; }
  s = now(); try { var d2 = bqDailyStore({ months: 13 }, sess); T.bqDailyStore_推移分析 = { ms: now() - s, ok: !!(d2 && d2.ok), rows: d2 && d2.sheets ? d2.sheets.daily.length : null }; } catch (e) { T.bqDailyStore_推移分析 = { ms: now() - s, error: String(e) }; }
  s = now(); try { var d3 = bqGetPL({}, sess); T.bqGetPL_PLタブ = { ms: now() - s, ok: !!(d3 && d3.ok) }; } catch (e) { T.bqGetPL_PLタブ = { ms: now() - s, error: String(e) }; }
  s = now(); try { var d4 = bqGetDeposit({ months: 13 }, sess); T.bqGetDeposit_入金管理 = { ms: now() - s, ok: !!(d4 && d4.ok) }; } catch (e) { T.bqGetDeposit_入金管理 = { ms: now() - s, error: String(e) }; }
  s = now(); try { var d5 = bqGetMedia({ months: 3 }, sess); T.bqGetMedia_媒体別 = { ms: now() - s, ok: !!(d5 && d5.ok) }; } catch (e) { T.bqGetMedia_媒体別 = { ms: now() - s, error: String(e) }; }
  T.grandTotal_5アクション合計 = now() - t0;
  var freshness = null;
  s = now(); try { freshness = dataFreshness({}, sess); T.dataFreshness = { ms: now() - s, ok: !!(freshness && freshness.ok !== false) }; } catch (e) { T.dataFreshness = { ms: now() - s, error: String(e) }; }
  return { ok: true, timing_ms: T, freshness: freshness, note: 'いずれも全店・直近13ヶ月分でクライアントと同条件。キャッシュがあれば効いた状態での計測（実利用に近い）。' };
}

// 一時的な診断用（2026-08-23）: 「広告管理タブが「DB_広告シートを受信できていません」になる」報告を受け、
// 実際にgetData()（action:'data'）をログイン中のクライアントと同じexclude条件で叩いた時、
// レスポンスのsheetsに実際どのキーが含まれるか・各キー何行あるかをそのまま返す。読み取り専用。
// exclude省略可（省略時はBQモードのフェーズ1と同じ既定 = media,deposit,dinii,予約,daily,PL を除外）。
function dataKeysDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var exclude = String((p || {}).exclude || 'media,deposit,dinii,予約,daily,PL');
  var now = function () { return new Date().getTime(); };
  var s = now();
  try {
    var d = getData({ months: Number(p.months) || 13, exclude: exclude }, { stores: '全店' });
    var keys = {};
    for (var k in (d.sheets || {})) keys[k] = (d.sheets[k] || []).length;
    return { ok: true, ms: now() - s, excludeUsed: exclude, receivedKeys: Object.keys(d.sheets || {}), rowsPerKey: keys, storesOk: !!(d.stores && d.stores.length) };
  } catch (e) {
    return { ok: false, ms: now() - s, error: String(e && e.message || e) };
  }
}

// 一時的な診断用（2026-08-26）: 担当D依頼「媒体別売上パネルの前年比が全行前年比較不可になる」の調査用。
// stg_media（媒体別日次のBQミラー）に前年同期間のデータがそもそも存在しないのでは、という仮説の確認。
// 読み取り専用・数値の書き換えは一切行わない。
// 診断用（2026-08-31）: ユーザー報告「予約管理タブの同期がずっと止まっている・予約分析が
// データなしになる」の調査用。stg_reservationの店舗別・最新日付・件数を返す（読み取り専用）。
// store省略可（省略時は全店の内訳を返す）。
function rsvDateRangeDiag_(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  try {
    var storeMap = rsvStoreMap_();
    var sql = 'SELECT store_id, MIN(visit_date) AS min_d, MAX(visit_date) AS max_d, COUNT(*) AS n, MAX(imported_at) AS last_imported ' +
      'FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_reservation` GROUP BY store_id ORDER BY max_d DESC';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var out = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      out.push({ store: storeMap[r[0]] || r[0], minDate: r[1], maxDate: r[2], count: Number(r[3]), lastImported: r[4] });
    }
    return { ok: true, byStore: out };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
function mediaDateRangeDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  try {
    var sql = 'SELECT MIN(date) AS min_d, MAX(date) AS max_d, COUNT(*) AS n, COUNT(DISTINCT store_name) AS stores FROM `' +
      BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_media`';
    var rows = bqRows_(sql);
    if (!rows) return { ok: false, error: 'BigQueryクエリ失敗' };
    var r = rows[1];
    return { ok: true, minDate: r[0], maxDate: r[1], count: Number(r[2]), stores: Number(r[3]) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 一時的な診断用（2026-08-23）: 明細分析(dinii明細集計)とダッシュボード(fact_daily_store=分析_日別店舗の
// BQミラー)の「売上・客数・組数」がどれくらい・なぜ違うのかを、実際の数字で突合する。読み取り専用。
// store省略可（省略時は全店合計）。ym必須（YYYY-MM、その月まるごと）。
function detailVsDailyDiag(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var store = String((p || {}).store || '').trim();
  var ym = String((p || {}).ym || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: 'ymはYYYY-MM形式で指定してください' };
  var y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  var from = ym + '-01';
  var to = Utilities.formatDate(new Date(y, mo, 0), 'Asia/Tokyo', 'yyyy-MM-dd'); // その月の末日
  var out = { ok: true, store: store || '(全店)', from: from, to: to };
  try {
    var maxDinii = bqRows_('SELECT MAX(business_date) d FROM ' + BQ_TABLE);
    out.diniiMaxBusinessDate = (maxDinii && maxDinii[1] && maxDinii[1][0]) ? String(maxDinii[1][0]) : null;
    var maxDaily = bqRows_('SELECT MAX(date) d FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store`');
    out.dailyMaxDate = (maxDaily && maxDaily[1] && maxDaily[1][0]) ? String(maxDaily[1][0]) : null;
    var diniiWhere = "WHERE business_date BETWEEN DATE('" + from + "') AND DATE('" + to + "')";
    if (store) {
      var id = reverseStoreId_(store);
      if (!id) return { ok: false, error: '明細分析側の店舗名マップにありません: ' + store };
      out.storeId = id;
      diniiWhere += " AND store_id = '" + String(id).replace(/'/g, '') + "'";
    }
    var dinii = bqRows_("SELECT SUM(sales_incl) sales_incl, SUM(price_excl*qty) sales_excl, COUNT(DISTINCT check_id) checks, SUM(IF(menu LIKE '%お通し%', qty, 0)) guests FROM " + BQ_TABLE + ' ' + diniiWhere);
    out.detail明細分析側 = (dinii && dinii[1]) ? { sales_incl: Number(dinii[1][0] || 0), sales_excl: Number(dinii[1][1] || 0), checks: Number(dinii[1][2] || 0), guests: Number(dinii[1][3] || 0) } : null;
    var dailyWhere = "WHERE date BETWEEN DATE('" + from + "') AND DATE('" + to + "')" + (store ? " AND store_name = '" + store.replace(/'/g, "''") + "'" : '');
    var daily = bqRows_('SELECT SUM(net_sales) net_sales, SUM(guests_total) guests, SUM(parties_total) checks FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store` ' + dailyWhere);
    out.dashboard側 = (daily && daily[1]) ? { net_sales: Number(daily[1][0] || 0), guests: Number(daily[1][1] || 0), checks: Number(daily[1][2] || 0) } : null;
    if (out.detail明細分析側 && out.dashboard側 && out.dashboard側.net_sales) {
      out.salesRatio_incl大dashboard比 = Number((out.detail明細分析側.sales_incl / out.dashboard側.net_sales).toFixed(3));
      out.salesRatio_excl大dashboard比 = Number((out.detail明細分析側.sales_excl / out.dashboard側.net_sales).toFixed(3));
    }
    // fix-v72の実績差し替えロジックが実際に働いているかを、bqDetail()自体を呼んで直接確認する
    // （このdetailVsDailyDiagのdetail明細分析側は差し替え前の生の推定値のため、それだけでは確認できない）。
    try {
      var bd = bqDetail({ from: from, to: to, store: store || 'all' }, { stores: '全店' });
      if (bd && bd.ok && bd.store && bd.store.length > 1) {
        var H = bd.store[0], iSales = H.indexOf('sales'), iChk = H.indexOf('checks'), iG = H.indexOf('guests');
        var rowsOut = [];
        for (var bi = 1; bi < bd.store.length; bi++) {
          if (store && bd.store[bi][0] !== store) continue;
          rowsOut.push({ store: bd.store[bi][0], sales: bd.store[bi][iSales], checks: bd.store[bi][iChk], guests: bd.store[bi][iG] });
        }
        out.bqDetail実際の出力 = rowsOut;
      } else {
        out.bqDetail実際の出力 = { error: (bd && bd.error) || '取得失敗' };
      }
    } catch (eBd) { out.bqDetail実際の出力 = { error: String(eBd && eBd.message || eBd) }; }
    return out;
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function reportDataBQ(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var kind = (p.kind === 'weekly' || p.kind === 'monthly') ? p.kind : 'daily';
  var storeList = String(p.stores || '').trim() ? String(p.stores).split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
  var single = storeList.length === 1 ? storeList[0] : null;
  var storeWhere = storeList.length
    ? " AND store_name IN (" + storeList.map(function (s) { return "'" + s.replace(/'/g, "''") + "'"; }).join(',') + ")"
    : '';

  // 対象日: 指定が無ければテーブル内の最新日。
  // 単純にMAX(date)を取ると、月末まで日付欄だけ先に埋まっているテンプレート行（実績はまだ0件）を
  // 拾ってしまう（2026-08-23の実地テストで発覚：8日も先の未来日を「本日」として送ってしまった）。
  // 実績（純売上または客数）が入っている行に限定して最新日を取る。
  var d0 = String(p.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d0)) {
    var latest = bqRows_('SELECT MAX(date) AS d FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store`' +
      ' WHERE net_sales > 0 OR guests_total > 0');
    if (!latest || latest.length < 2 || !latest[1][0]) return { ok: false, error: '対象日が見つかりません' };
    d0 = String(latest[1][0]);
  }
  var d0Date = new Date(d0 + 'T00:00:00+09:00');
  var fmt = function (dt) { return Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyy-MM-dd'); };
  var addDays = function (dt, n) { return new Date(dt.getTime() + n * 86400000); };
  var addYears = function (dt, n) { var x = new Date(dt.getTime()); x.setFullYear(x.getFullYear() + n); return x; };

  var periodStart, periodEnd, title, sub, salesLabel;
  if (kind === 'daily') {
    periodStart = periodEnd = d0Date;
    title = '日報'; sub = d0.replace(/-/g, '/'); salesLabel = '本日売上';
  } else if (kind === 'weekly') {
    var wd = (d0Date.getUTCDay() + 6) % 7; // 月曜=0
    periodStart = addDays(d0Date, -wd); periodEnd = addDays(periodStart, 6);
    title = '週報'; sub = fmt(periodStart).replace(/-/g, '/') + '〜' + fmt(periodEnd).replace(/-/g, '/'); salesLabel = '週間売上';
  } else {
    periodStart = new Date(d0Date.getFullYear(), d0Date.getMonth(), 1);
    periodEnd = new Date(d0Date.getFullYear(), d0Date.getMonth() + 1, 0);
    title = '月報'; sub = fmt(periodStart).slice(0, 7).replace('-', '/') + '月'; salesLabel = '月間売上';
  }
  var prevStart = addYears(periodStart, -1), prevEnd = addYears(periodEnd, -1);
  var monthStart = new Date(d0Date.getFullYear(), d0Date.getMonth(), 1);
  var monthPrevStart = addYears(monthStart, -1), monthPrevEnd = addYears(d0Date, -1);

  var T = '`' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.fact_daily_store`';
  var rangeWhere = function (a, b) { return "date BETWEEN DATE('" + fmt(a) + "') AND DATE('" + fmt(b) + "')"; };
  var totSql = 'SELECT SUM(net_sales) sales, SUM(guests_total) guests, SUM(cogs) cogs, SUM(labor_cost_total) labor FROM ' + T +
    ' WHERE ' + rangeWhere(periodStart, periodEnd) + storeWhere;
  var prevSql = 'SELECT SUM(net_sales) sales FROM ' + T + ' WHERE ' + rangeWhere(prevStart, prevEnd) + storeWhere;
  var cumSql = 'SELECT SUM(net_sales) sales FROM ' + T + ' WHERE ' + rangeWhere(monthStart, d0Date) + storeWhere;
  var cumPrevSql = 'SELECT SUM(net_sales) sales FROM ' + T + ' WHERE ' + rangeWhere(monthPrevStart, monthPrevEnd) + storeWhere;
  var byStoreSql = 'SELECT store_name, SUM(net_sales) sales FROM ' + T + ' WHERE ' + rangeWhere(periodStart, periodEnd) + storeWhere + ' GROUP BY store_name';
  var byStorePrevSql = 'SELECT store_name, SUM(net_sales) sales FROM ' + T + ' WHERE ' + rangeWhere(prevStart, prevEnd) + storeWhere + ' GROUP BY store_name';

  var tot = bqRows_(totSql);
  if (!tot || tot.length < 2) return { ok: false, error: 'BigQueryクエリ失敗' };
  var prev = bqRows_(prevSql), cum = bqRows_(cumSql), cumPrev = bqRows_(cumPrevSql);
  var byStore = bqRows_(byStoreSql), byStorePrev = bqRows_(byStorePrevSql);

  var sales = Number(tot[1][0] || 0), guests = Number(tot[1][1] || 0);
  var cogsV = Number(tot[1][2] || 0), laborV = Number(tot[1][3] || 0);
  // スポット人件費（タイミー等）も人件費率に合算する（2026-08-23追加）。stg_spotが未作成/未同期でも日報を止めない。
  try {
    var spotWhere = "work_date BETWEEN DATE('" + fmt(periodStart) + "') AND DATE('" + fmt(periodEnd) + "')";
    var spotRes = bqRows_('SELECT SUM(amount) spot FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_spot` WHERE ' + spotWhere + storeWhere);
    if (spotRes && spotRes[1] && spotRes[1][0] != null) laborV += Number(spotRes[1][0]);
  } catch (eSpot) { /* stg_spot未作成でもここは無視 */ }
  var prevSales = (prev && prev[1] && prev[1][0] != null) ? Number(prev[1][0]) : null;
  var cumSales = (cum && cum[1] && cum[1][0] != null) ? Number(cum[1][0]) : null;
  var cumPrevSales = (cumPrev && cumPrev[1] && cumPrev[1][0] != null) ? Number(cumPrev[1][0]) : null;

  var prevByStore = {};
  if (byStorePrev) for (var i = 1; i < byStorePrev.length; i++) prevByStore[byStorePrev[i][0]] = Number(byStorePrev[i][1] || 0);
  var rows = [];
  if (byStore) for (var j = 1; j < byStore.length; j++) {
    rows.push({ store: byStore[j][0], sales: Number(byStore[j][1] || 0), prevSales: prevByStore[byStore[j][0]] || 0 });
  }
  rows.sort(function (a, b) { return b.sales - a.sales; });

  var media = [];
  if (single) {
    var mediaSql = 'SELECT media_name, SUM(net_sales) sales FROM `' + BQ_PROJECT + '.' + BQ_SALES_DATASET + '.stg_media` ' +
      "WHERE store_name = '" + single.replace(/'/g, "''") + "' AND " + rangeWhere(periodStart, periodEnd) +
      ' GROUP BY media_name ORDER BY sales DESC LIMIT 5';
    var mrows = bqRows_(mediaSql);
    if (mrows) for (var k = 1; k < mrows.length; k++) media.push({ media: mrows[k][0], sales: Number(mrows[k][1] || 0) });
  }

  return {
    ok: true, title: title, sub: sub, kind: kind, salesLabel: salesLabel, hasDinii: false,
    singleStore: single, fileKey: (storeList[0] || 'all'),
    tot: {
      sales: sales, prevSales: prevSales, guests: guests,
      fr: sales > 0 ? (cogsV / sales) : null, lr: sales > 0 ? (laborV / sales) : null,
      cum: cumSales, cumPrev: cumPrevSales
    },
    rows: rows, media: media
  };
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
    return { id: a.id, name: a.name, role: a.role, stores: a.stores, active: a.active, memo: a.memo, tabs: a.tabs, perms: a.perms, position: a.position, email: a.email, media: a.media, hasPw: a.pw !== '' };
  });
  return { ok: true, accounts: rows };
}

function saveAccount(p, session) {
  if (!isAdmin(session)) return { ok: false, error: 'アカウント管理の権限がありません' };
  var id = String(p.accountId || '').trim();
  if (!id) return { ok: false, error: 'ログインIDが未指定です' };
  var role = String(p.role || '店舗');
  if (['社長', '本部', 'マネージャー', '店舗', '外販'].indexOf(role) < 0) return { ok: false, error: '権限は 社長/本部/マネージャー/店舗/外販 のいずれかです' };

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
    String(p.position != null ? p.position : (target ? target.position : '')),  // 役職
    String(p.email != null ? p.email : (target ? target.email : '')).trim().toLowerCase(),  // 統合アカウントのメール
    String(p.media != null ? p.media : (target ? target.media : ''))  // 担当媒体（権限「外販」で使う）
  ];
  if (!values[1]) return { ok: false, error: '新規アカウントにはパスワードが必要です' };

  if (target) sh.getRange(target.row, 1, 1, 12).setValues([values]);
  else sh.getRange(sh.getLastRow() + 1, 1, 1, 12).setValues([values]);
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
// Day6②: 正本はSupabase store_aliases（表記ゆれ・口コミ別掲載名を1つのテーブルに統合済みなので
// DB_店舗名対応→DB_店舗親子の2段引きは不要・1段で解決できる）。取得できない間だけ現行シート方式にフォールバック。
// 解決できなければ元の名前を返す。※権限チェックのために使う。
function resolveAdStore_(name) {
  var cur = String(name == null ? '' : name).trim();
  if (!cur) return '';
  var key = storeKey_(cur);
  var dir = fetchStoreDirectory_();
  if (dir) {
    for (var i = 0; i < dir.length; i++) {
      var aliases = dir[i].aliases || [];
      for (var j = 0; j < aliases.length; j++) {
        if (storeKey_(aliases[j].alias) === key && storeKey_(dir[i].name) !== key) return dir[i].name;
      }
    }
    return cur;
  }
  // フォールバック: 現行のシート方式（DB_店舗名対応→DB_店舗親子の順に引く）
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  function lookup(sheetName) {
    var sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return null;
    var v = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
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

// 補助科目のその場追加（2026-08-23追加）: 保存された勘定科目×補助科目の組が
// DB_補助科目マスタに無ければ末尾に追加する（表示順=999・有効=TRUE）。既にあれば何もしない。
// 1回の保存（最大300行）ごとに読み書きするだけなので負荷は小さい。
function ensureSubItemMaster_(pairs) {
  if (!pairs || !pairs.length) return;
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_補助科目');
    if (!sh) return;
    var last = sh.getLastRow();
    var known = {};
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
        known[String(r[0]).trim() + '\t' + String(r[1]).trim()] = true;
      });
    }
    var add = [];
    var seen = {};
    pairs.forEach(function (pr) {
      var item = String(pr[0] || '').trim(), sub = String(pr[1] || '').trim();
      if (!item || !sub) return;
      var k = item + '\t' + sub;
      if (known[k] || seen[k]) return;
      seen[k] = true;
      add.push([item, sub, 999, true]);
    });
    if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, 4).setValues(add);
  } catch (e) { /* マスタ追加に失敗しても本体の保存は失敗させない */ }
}

// PL経費の保存：対象月×店舗の手入力行を丸ごと差し替え。entries=[[科目,区分,金額,メモ,補助科目],...]
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
    var sub = String(a[4] || '').trim().slice(0, 60);   // 補助科目（任意・2026-08-23追加）
    if (item && amt > 0) clean.push([item, cat, amt, memo, sub]);
  });
  if (clean.length > 300) return { ok: false, error: '一度に保存できるのは300行までです' };
  var y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);
  // ① DB_PL（対象月×店舗の行を差し替え。媒体販促費（自動計上）は保持）
  var dp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!dp) return { ok: false, error: 'DB_PLシートがありません' };
  var dlast = dp.getLastRow(), keep = [];
  var dlastCol = Math.max(dp.getLastColumn(), 7);
  if (dlast >= 2) {
    dp.getRange(2, 1, dlast - 1, dlastCol).getValues().forEach(function (r) {
      if (r[0] === '' && r[1] === '' && r[2] === '') return;
      var same = ymOf_(r[0]) === ymSlash && String(r[1]).trim() === store;
      if (same && String(r[5]) !== PL_AUTO_MEMO) return;   // 差し替え対象は捨てる
      keep.push(r);
    });
  }
  var out = keep.concat(clean.map(function (a) { return [new Date(y, mo - 1, 1), store, a[0], a[1], a[2], a[3], a[4]]; }));
  if (dlast >= 2) dp.getRange(2, 1, dlast - 1, dlastCol).clearContent();
  if (out.length) { dp.getRange(2, 1, out.length, 7).setValues(out); dp.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d'); }
  ensureSubItemMaster_(clean.map(function (a) { return [a[0], a[4]]; }));
  // ② PL管理システム ✍販管費入力（A年月/B店舗/C科目/E金額/Fメモ/G補助科目。D列の式は触らない）
  var plsys = '';
  try {
    var psh = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (psh) {
      var plStore = isCommon ? '本社・共通' : store;
      var lastR = psh.getLastRow(), n = Math.max(lastR - 2, 0);   // データは3行目から（D列の式で行数は伸びている）
      var A = n > 0 ? psh.getRange(3, 1, n, 3).getValues() : [];
      var E = n > 0 ? psh.getRange(3, 5, n, 2).getValues() : [];
      var G = n > 0 ? psh.getRange(3, 7, n, 1).getValues() : [];
      var keepP = [];
      for (var i = 0; i < n; i++) {
        if (String(A[i][0]) === '' && String(A[i][2]) === '') continue;                 // 空行
        if (ymOf_(A[i][0]) === ymSlash && String(A[i][1]).trim() === plStore) continue; // 差し替え対象
        keepP.push([A[i][0], A[i][1], A[i][2], E[i][0], E[i][1], G[i][0]]);
      }
      clean.forEach(function (a) { keepP.push([ymSlash, plStore, a[0], a[2], a[3] || 'ダッシュボードから入力', a[4]]); });
      if (n > 0) { psh.getRange(3, 1, n, 3).clearContent(); psh.getRange(3, 5, n, 2).clearContent(); psh.getRange(3, 7, n, 1).clearContent(); }
      if (keepP.length) {
        psh.getRange(3, 1, keepP.length, 3).setValues(keepP.map(function (r) { return [r[0], r[1], r[2]]; }));
        psh.getRange(3, 5, keepP.length, 2).setValues(keepP.map(function (r) { return [r[3], r[4]]; }));
        psh.getRange(3, 7, keepP.length, 1).setValues(keepP.map(function (r) { return [r[5]]; }));
      }
      plsys = 'PL管理システムにも反映しました';
    } else plsys = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (e) { plsys = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(e && e.message || e); }
  // DB_PL（シート）を更新しただけではBigQueryモードのPLタブに反映されない（bqSyncPLで別途ミラーする
  // 設計のため）。syncSeisanFeeToPlでは対応済みだったが、この画面からの手入力保存は同期を呼んでおらず
  // 「入力してもBQモードでは翌朝8時の自動同期まで反映されない」状態だった（2026-08-23発覚・修正）。
  try {
    var tkPl = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
    if (tkPl) bqSyncPL({ token: tkPl });
  } catch (eSync) { /* BQ同期に失敗してもシート保存自体は成功として扱う（次回同期で追いつく） */ }
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

// ================== A-8: 広告費のtoken書き込み（担当C invoicesのad-cost-reflectから呼ばれる） ==================
// 経緯: 設計書_広告費自動連携と精算書PL科目連携_2026-08-31.md §4・WORKLOG「担当Aへの依頼・A-8」。
// invoices側は請求書の仕訳登録と同時に広告費を確定するため、ログインセッションを持たないサーバー間
// 呼び出し（Supabase Edge Function → GAS）で書き込む必要がある。saveAdFee（本部ログイン前提のUI用
// action）とは別に、専用トークン認証（AD_COST_WRITE_TOKEN。BQ_LOAD_TOKENとは別の専用トークン＝
// 依頼どおりinvoices側だけに渡す想定のため使い回さない）の軽量actionとして新設する。
// 1回の呼び出しで複数店舗ぶん（allocations配列）をまとめて書ける点がsaveAdFeeとの違い。
function writeAdCost(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('AD_COST_WRITE_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  // 2026-09-01追加（設計書_広告費自動連携と精算書PL科目連携_2026-08-31.md §5・ラウンド5指示書§6.1
  // 「A-8拡張」）: p.account/p.account_name が指定された場合は勘定科目汎用の経路（DB_PL直接計上＋
  // 精算対象店舗は精算書へも自動追加）へ分岐する。実際の呼び出しはaction='writePlFee'（下のwritePlFee
  // 経由）を使う想定だが、念のためwriteAdCost経由でも同じ経路に入れるようここにも残す。p.media指定時
  // （従来どおり）は下の💾広告費DBへの書き込みのまま・完全に独立した経路のため、担当C invoicesの
  // ad-cost-reflect（既存の広告費呼び出し）には一切影響しない。
  if (p.account || p.account_name) return writeAccountCostToPl_(p);
  var ym = String(p.year_month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: '年月が不正です（例: 2026-08）' };
  var media = String(p.media || '').trim().slice(0, 40);
  if (!media) return { ok: false, error: '媒体が未指定です' };
  var allocations = Array.isArray(p.allocations) ? p.allocations : [];
  if (!allocations.length) return { ok: false, error: 'allocations（店舗×金額）が空です' };
  var mss = mgmtOpen();
  if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  var sh = mgmtFindTab(mss, /広告費DB/);
  if (!sh) return { ok: false, error: '管理シートに💾広告費DBタブが見つかりません' };
  var scan = sh.getRange(1, 1, Math.min(sh.getLastRow(), 6), Math.min(sh.getLastColumn(), 12)).getValues();
  var hr = -1, c0 = -1;
  for (var r = 0; r < scan.length && hr < 0; r++) {
    for (var c = 0; c < scan[r].length; c++) {
      if (String(scan[r][c]).trim() === '年月') { hr = r + 1; c0 = c + 1; break; }
    }
  }
  if (hr < 0) return { ok: false, error: '💾広告費DBの見出し行（年月）が見つかりません' };
  var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);
  var plan = '一式';
  var memo = ['請求書連携', p.vendor_name ? '発行元:' + String(p.vendor_name).trim().slice(0, 40) : '', p.source_invoice_id ? 'invoice:' + String(p.source_invoice_id).trim().slice(0, 40) : '']
    .filter(Boolean).join(' / ').slice(0, 100);
  var now = new Date();
  var last = sh.getLastRow();
  var v = last > hr ? sh.getRange(hr + 1, c0, last - hr, 4).getValues() : []; // 年月|店舗|媒体|プラン
  var foundBy = {}; // storeKey → 行番号（対象月・対象媒体・プラン一式のみ）
  for (var i = 0; i < v.length; i++) {
    if (String(v[i][0]) === '' && String(v[i][1]) === '') continue;
    if (ymOf_(v[i][0]) !== ymSlash) continue;
    if (String(v[i][2]).trim() !== media || String(v[i][3]).trim() !== plan) continue;
    foundBy[storeKey_(v[i][1])] = hr + 1 + i;
  }
  var results = [], appendRows = [];
  allocations.forEach(function (a) {
    var dashStore = String((a && a.store_name) || '').trim();
    var amt = Number((a && a.amount) || 0);
    if (!dashStore) { results.push({ store: dashStore, ok: false, error: '店舗名が空です' }); return; }
    if (!isFinite(amt) || amt < 0) { results.push({ store: dashStore, ok: false, error: '金額が不正です' }); return; }
    var store = mgmtStoreName_(mss, dashStore);
    var key = ymSlash + '_' + store + '_' + media + '_' + plan;
    var fr = foundBy[storeKey_(store)];
    if (fr > 0) {
      sh.getRange(fr, c0 + 4).setValue(amt).setNumberFormat('#,##0');
      sh.getRange(fr, c0 + 6).setValue(now).setNumberFormat('yyyy/mm/dd');
      sh.getRange(fr, c0 + 7).setValue(memo);
      sh.getRange(fr, c0 + 8).setValue(key);
      results.push({ store: store, ok: true, updated: true });
    } else {
      appendRows.push([ymSlash, store, media, plan, amt, now, now, memo, key]);
      results.push({ store: store, ok: true, updated: false });
    }
  });
  if (appendRows.length) {
    var nr = sh.getLastRow() + 1;
    sh.getRange(nr, c0, appendRows.length, 9).setValues(appendRows);
    sh.getRange(nr, c0 + 4, appendRows.length, 1).setNumberFormat('#,##0');
    sh.getRange(nr, c0 + 5, appendRows.length, 2).setNumberFormat('yyyy/mm/dd');
  }
  // 設計書§4 Q1確定仕様: シート書き込みと同時にBigQuery stg_ad_costへも反映（二重書き）。
  // stg_pl等と同じ「シート全体を都度ミラーする」方式（bqSyncPL参照）。失敗してもシート保存自体は成功扱いにする。
  var bqRes = null;
  try { bqRes = bqSyncAdCost({ token: PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN') }); }
  catch (eBq) { bqRes = { ok: false, error: String(eBq && eBq.message || eBq) }; }
  return { ok: true, media: media, year_month: ym, results: results, bq: bqRes };
}

// ================== A-8拡張: 勘定科目汎用のPL自動計上（2026-09-01・設計書§5） ==================
// invoices側 pl-fee-reflect/confirm から呼ばれる本来の入口（action='writePlFee'）。writeAdCostと
// 同じAD_COST_WRITE_TOKEN認証をここでも行う（writeAdCost経由の分岐と処理は完全に共通）。
function writePlFee(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('AD_COST_WRITE_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  return writeAccountCostToPl_(p);
}
// カード手数料・PayPay手数料など、MF会計仕訳（invoices側の会計入力）で確定した経費を、writeAdCostと
// 同じAD_COST_WRITE_TOKEN認証のまま、任意の勘定科目でDB_PL（＋PL管理システム）へ自動計上する。
// syncSeisanCategoriesToPl等の既存PL自動連携と違い、この処理は「1回の呼び出し=1件の仕訳」という
// 増分呼び出し（invoices側が仕訳を処理するたびに都度呼ぶ想定）のため、月全体を洗い替える方式ではなく
// 「この月×このメモ×このsource_key」の行だけを店舗単位でupsertする（他の仕訳の行には一切触れない）。
// これにより「同じ仕訳からは1回だけ」の二重計上ガード（design§5）と、同じ科目・同じ月に複数の別々の
// 仕訳が積み上がっても正しく合算される、の両方を満たす。
// 精算対象店舗（Supabase stores.seisan_target）については、精算書側の新規token authアクション
// sd_apiAddExternalLine（seisan-dashboard）を呼び、同じ内容を精算書の明細にも自動追加する。
// 呼び出し例（invoices側pl-fee-reflect/confirmが実際に送ってくる形）: {token,
//   year_month:'2026-08', account_name:'カード手数料', allocations:[{store_name:'鳥一代 恵比寿', amount:12345}],
//   source_invoice_id:'...', vendor_name:'○○カード'}（account/sub_account/source_key/taxは別名または追加項目として許容）
function writeAccountCostToPl_(p) {
  var ym = String(p.year_month || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) return { ok: false, error: '年月が不正です（例: 2026-08）' };
  var account = String(p.account_name || p.account || '').trim().slice(0, 60);
  if (!account) return { ok: false, error: '勘定科目（account_name）が未指定です' };
  var subAccount = String(p.sub_account || '').trim().slice(0, 60);
  var sourceKey = String(p.source_key || p.source_invoice_id || p.mf_journal_id || '').trim().slice(0, 80);
  if (!sourceKey) return { ok: false, error: 'source_key（冪等キー・仕訳ID等）が未指定です' };
  var allocations = Array.isArray(p.allocations) ? p.allocations : [];
  if (!allocations.length) return { ok: false, error: 'allocations（店舗×金額）が空です' };
  var tax = String(p.tax || '10%');
  var vendorLabel = p.vendor_name ? String(p.vendor_name).trim().slice(0, 40) : '';
  var memo = '自動｜' + account;
  var noteTag = '外部連携:' + sourceKey;
  var y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
  var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);

  var results = [], validAllocs = [];
  allocations.forEach(function (a) {
    var dashStore = String((a && a.store_name) || '').trim();
    var amt = Number((a && a.amount) || 0);
    if (!dashStore) { results.push({ store: dashStore, ok: false, error: '店舗名が空です' }); return; }
    if (!isFinite(amt) || amt < 0) { results.push({ store: dashStore, ok: false, error: '金額が不正です' }); return; }
    validAllocs.push({ store: dashStore, amount: amt });
  });
  if (!validAllocs.length) return { ok: false, error: '有効な店舗×金額がありません', results: results };

  // ① DB_PL：この月×このメモ×このsource_keyの行だけを店舗単位でupsert
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!sh) return { ok: false, error: 'DB_PLシートがありません' };
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(sh.getLastColumn(), 7);
  var allRows = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, lastCol).getValues() : [];
  var byStoreIdx = {}; // store -> allRowsのindex（同月・同メモ・同source_keyの既存行のみ）
  for (var i = 0; i < allRows.length; i++) {
    var r = allRows[i];
    if (r[0] === '' && r[1] === '') continue;
    if (bqPlYm_(r[0]) !== ymSlash || String(r[5]) !== memo || String(r[6]) !== noteTag) continue;
    byStoreIdx[String(r[1]).trim()] = i;
  }
  var cat = plSeisanGuessCat_(account);
  validAllocs.forEach(function (a) {
    var idx = byStoreIdx[a.store];
    var row = [new Date(y, mo - 1, 1), a.store, account, cat, a.amount, memo, noteTag];
    if (idx != null) { allRows[idx] = row; results.push({ store: a.store, ok: true, updated: true }); }
    else { allRows.push(row); results.push({ store: a.store, ok: true, updated: false }); }
  });
  if (lastRow >= 2) sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  if (allRows.length) { sh.getRange(2, 1, allRows.length, 7).setValues(allRows); sh.getRange(2, 1, allRows.length, 1).setNumberFormat('yyyy/m/d'); }

  // ② PL管理システム（✍販管費入力）にも同じキーでupsert（既存の各PL自動連携と同じ二重反映パターン）
  var plsysNote = '';
  try {
    var pshS = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (pshS) {
      var lastRS = pshS.getLastRow(), nRS = Math.max(lastRS - 2, 0);
      var AS = nRS > 0 ? pshS.getRange(3, 1, nRS, 3).getValues() : [];
      var ES = nRS > 0 ? pshS.getRange(3, 5, nRS, 2).getValues() : [];
      var GS = nRS > 0 ? pshS.getRange(3, 7, nRS, 1).getValues() : [];
      var byStoreIdxS = {};
      for (var iS = 0; iS < nRS; iS++) {
        if (String(AS[iS][0]) === '' && String(AS[iS][2]) === '') continue;
        if (bqPlYm_(AS[iS][0]) !== ymSlash || String(ES[iS][1]) !== memo || String(GS[iS][0]) !== noteTag) continue;
        byStoreIdxS[String(AS[iS][1]).trim()] = iS;
      }
      validAllocs.forEach(function (a) {
        var idxS = byStoreIdxS[a.store];
        if (idxS != null) { AS[idxS] = [ymSlash, a.store, account]; ES[idxS] = [a.amount, memo]; GS[idxS] = [noteTag]; }
        else { AS.push([ymSlash, a.store, account]); ES.push([a.amount, memo]); GS.push([noteTag]); }
      });
      if (nRS > 0) { pshS.getRange(3, 1, nRS, 3).clearContent(); pshS.getRange(3, 5, nRS, 2).clearContent(); pshS.getRange(3, 7, nRS, 1).clearContent(); }
      if (AS.length) {
        pshS.getRange(3, 1, AS.length, 3).setValues(AS);
        pshS.getRange(3, 5, AS.length, 2).setValues(ES);
        pshS.getRange(3, 7, AS.length, 1).setValues(GS);
      }
      plsysNote = 'PL管理システムにも反映しました';
    } else plsysNote = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (eP) { plsysNote = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(eP && eP.message || eP); }

  // ③ 精算対象店舗（Supabase stores.seisan_target）は精算書にも同じ内容を自動追加
  var seisanResults = [];
  try {
    var seisanUrl = PropertiesService.getScriptProperties().getProperty('SEISAN_WEBAPP_URL');
    var plSyncToken = PropertiesService.getScriptProperties().getProperty('PL_SYNC_TOKEN');
    if (seisanUrl && plSyncToken) {
      var storeRes = UrlFetchApp.fetch(
        'https://uuvsxzhpxtghojoubjcc.supabase.co/rest/v1/store_directory_v?select=name,seisan_target,seisan_store_name',
        { headers: { apikey: STORE_DIRECTORY_ANON_KEY_, Authorization: 'Bearer ' + STORE_DIRECTORY_ANON_KEY_ }, muteHttpExceptions: true }
      );
      if (storeRes.getResponseCode() === 200) {
        var dirRows = JSON.parse(storeRes.getContentText());
        var seisanNameOf = {};
        dirRows.forEach(function (s) { if (s.seisan_target) seisanNameOf[s.name] = s.seisan_store_name || s.name; });
        validAllocs.forEach(function (a) {
          var seisanName = seisanNameOf[a.store];
          if (!seisanName) return; // 精算対象外の店舗はスキップ
          try {
            var res = UrlFetchApp.fetch(seisanUrl, {
              method: 'post', contentType: 'application/json', muteHttpExceptions: true,
              payload: JSON.stringify({
                fn: 'sd_apiAddExternalLine',
                args: [plSyncToken, seisanName, ym, {
                  item: vendorLabel ? account + '（' + vendorLabel + '）' : account,
                  amount: a.amount, tax: tax, account: account, subAccount: subAccount, sourceKey: sourceKey
                }]
              })
            });
            var j = JSON.parse(res.getContentText());
            seisanResults.push({ store: a.store, ok: !!(j.ok && j.result && j.result.ok), detail: j.result || j });
          } catch (eSd) { seisanResults.push({ store: a.store, ok: false, error: String(eSd && eSd.message || eSd) }); }
        });
      }
    }
  } catch (eDir) { /* 店舗一覧取得に失敗しても致命的ではない（DB_PL計上自体は完了しているため） */ }

  var bqRes2 = null;
  try { bqRes2 = bqSyncPL({ token: PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN') }); }
  catch (eBq2) { bqRes2 = { ok: false, error: String(eBq2 && eBq2.message || eBq2) }; }

  return { ok: true, account: account, year_month: ym, results: results, plsys: plsysNote, seisan: seisanResults, bq: bqRes2 };
}

// 💾広告費DBシート全体を stg_ad_cost へミラー（WRITE_TRUNCATE。bqSyncPLと同じ方式）。
// writeAdCostから毎回呼ばれるほか、単独でも呼べる（手入力saveAdFee後の手動再同期用）。
var BQ_STG_AD_COST_SCHEMA = [
  { name: 'year_month', type: 'STRING' }, { name: 'store_name', type: 'STRING' },
  { name: 'media', type: 'STRING' }, { name: 'plan', type: 'STRING' },
  { name: 'amount', type: 'NUMERIC' }, { name: 'memo', type: 'STRING' },
  { name: 'updated_at', type: 'STRING' }, { name: 'key', type: 'STRING' }
];
function bqSyncAdCost(p) {
  var tk = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
  if (!tk || String((p || {}).token || '').trim() !== String(tk).trim()) return { ok: false, error: 'unauthorized' };
  var mss = mgmtOpen();
  if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  var sh = mgmtFindTab(mss, /広告費DB/);
  if (!sh) return { ok: false, error: '管理シートに💾広告費DBタブが見つかりません' };
  var scan = sh.getRange(1, 1, Math.min(sh.getLastRow(), 6), Math.min(sh.getLastColumn(), 12)).getValues();
  var hr = -1, c0 = -1;
  for (var r = 0; r < scan.length && hr < 0; r++) {
    for (var c = 0; c < scan[r].length; c++) {
      if (String(scan[r][c]).trim() === '年月') { hr = r + 1; c0 = c + 1; break; }
    }
  }
  if (hr < 0) return { ok: true, table: 'stg_ad_cost', rows: 0, note: '見出し行が見つかりません（未セットアップ）' };
  var last = sh.getLastRow();
  if (last <= hr) return bqLoadSheetToTable_('', 'stg_ad_cost', BQ_STG_AD_COST_SCHEMA);
  var vals = sh.getRange(hr + 1, c0, last - hr, 9).getValues(); // 年月|店舗|媒体|プラン|広告費|入力日|更新日|備考|キー
  var lines = [];
  for (var i = 0; i < vals.length; i++) {
    var r2 = vals[i];
    if (String(r2[0]) === '' && String(r2[1]) === '') continue;
    var amt2 = Number(r2[4]);
    var upd = r2[6] instanceof Date ? Utilities.formatDate(r2[6], 'Asia/Tokyo', 'yyyy-MM-dd') : String(r2[6] || '');
    lines.push([
      bqCsvStr_(ymOf_(r2[0])), bqCsvStr_(r2[1]), bqCsvStr_(r2[2]), bqCsvStr_(r2[3]),
      isFinite(amt2) ? amt2.toFixed(6) : '0', bqCsvStr_(r2[7]), bqCsvStr_(upd), bqCsvStr_(r2[8])
    ].join(','));
  }
  return bqLoadSheetToTable_(lines.join('\n'), 'stg_ad_cost', BQ_STG_AD_COST_SCHEMA);
}

// PL経費の期間一括計上：開始月〜終了月の各月に 店舗×科目×補助科目 の行を作成（既存の同科目・同補助科目行は差し替え）。
// 金額が空/0なら期間内のその科目（＋補助科目）の行を削除。DB_PLとPL管理システム（✍販管費入力）の両方に反映。
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
  var sub = String(p.sub || '').trim().slice(0, 60);   // 補助科目（任意・2026-08-23追加）
  var y1 = +ym1.slice(0, 4), m1 = +ym1.slice(5, 7), y2 = +ym2.slice(0, 4), m2 = +ym2.slice(5, 7);
  var n = (y2 - y1) * 12 + (m2 - m1) + 1;
  if (n < 1) return { ok: false, error: '終了月が開始月より前です' };
  if (n > 36) return { ok: false, error: '一括計上できるのは36ヶ月までです' };
  var months = {}, list = [];
  for (var i = 0; i < n; i++) { var yy = y1 + Math.floor((m1 - 1 + i) / 12), mm = (m1 - 1 + i) % 12 + 1; var ms = yy + '/' + ('0' + mm).slice(-2); months[ms] = 1; list.push([yy, mm, ms]); }
  // ① DB_PL：期間内の 店舗×科目×補助科目 行（AUTO以外）を除去 → 金額>0なら各月分を追加
  var dp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!dp) return { ok: false, error: 'DB_PLシートがありません' };
  var dlast = dp.getLastRow(), keep = [];
  var dlastCol = Math.max(dp.getLastColumn(), 7);
  if (dlast >= 2) {
    dp.getRange(2, 1, dlast - 1, dlastCol).getValues().forEach(function (r) {
      if (r[0] === '' && r[1] === '' && r[2] === '') return;
      if (months[ymOf_(r[0])] && String(r[1]).trim() === store && String(r[2]).trim() === item && String(r[6] || '').trim() === sub && String(r[5]) !== PL_AUTO_MEMO) return;
      keep.push(r);
    });
  }
  var out = keep.slice();
  if (amount > 0) list.forEach(function (mo) { out.push([new Date(mo[0], mo[1] - 1, 1), store, item, cat, amount, memo, sub]); });
  if (dlast >= 2) dp.getRange(2, 1, dlast - 1, dlastCol).clearContent();
  if (out.length) { dp.getRange(2, 1, out.length, 7).setValues(out); dp.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d'); }
  if (amount > 0 && sub) ensureSubItemMaster_([[item, sub]]);
  // ② PL管理システム ✍販管費入力：同じ差し替え（D列の区分式は触らない）
  var plsys = '';
  try {
    var psh = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (psh) {
      var plStore = isCommon ? '本社・共通' : store;
      var lastR = psh.getLastRow(), nR = Math.max(lastR - 2, 0);
      var A = nR > 0 ? psh.getRange(3, 1, nR, 3).getValues() : [];
      var E = nR > 0 ? psh.getRange(3, 5, nR, 2).getValues() : [];
      var G = nR > 0 ? psh.getRange(3, 7, nR, 1).getValues() : [];
      var keepP = [];
      for (var i2 = 0; i2 < nR; i2++) {
        if (String(A[i2][0]) === '' && String(A[i2][2]) === '') continue;
        if (months[ymOf_(A[i2][0])] && String(A[i2][1]).trim() === plStore && String(A[i2][2]).trim() === item && String(G[i2][0] || '').trim() === sub) continue;
        keepP.push([A[i2][0], A[i2][1], A[i2][2], E[i2][0], E[i2][1], G[i2][0]]);
      }
      if (amount > 0) list.forEach(function (mo) { keepP.push([mo[2], plStore, item, amount, memo || 'ダッシュボードから一括計上', sub]); });
      if (nR > 0) { psh.getRange(3, 1, nR, 3).clearContent(); psh.getRange(3, 5, nR, 2).clearContent(); psh.getRange(3, 7, nR, 1).clearContent(); }
      if (keepP.length) {
        psh.getRange(3, 1, keepP.length, 3).setValues(keepP.map(function (r) { return [r[0], r[1], r[2]]; }));
        psh.getRange(3, 5, keepP.length, 2).setValues(keepP.map(function (r) { return [r[3], r[4]]; }));
        psh.getRange(3, 7, keepP.length, 1).setValues(keepP.map(function (r) { return [r[5]]; }));
      }
      plsys = 'PL管理システムにも反映しました';
    } else plsys = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (e) { plsys = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(e && e.message || e); }
  // savePlEntriesと同じ理由でBQミラーも同期する（2026-08-23発覚・修正）。
  try {
    var tkPl2 = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
    if (tkPl2) bqSyncPL({ token: tkPl2 });
  } catch (eSync2) { /* BQ同期に失敗してもシート保存自体は成功として扱う（次回同期で追いつく） */ }
  return { ok: true, months: n, deleted: amount <= 0, plsys: plsys };
}

// MF取込マスタの新規マッピングをDB_科目対応へ反映（キー=MF勘定科目×MF補助科目。既存キーは上書き・無ければ追加）。
// mappings=[[mfItem, mfSub, item, sub, cat, exclude], ...]
function mfEnsureCategoryMap_(mappings) {
  if (!mappings || !mappings.length) return;
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_科目対応');
  if (!sh) return;
  var last = sh.getLastRow();
  var rowByKey = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 6).getValues().forEach(function (r, i) {
      rowByKey[String(r[0]).trim() + '\t' + String(r[1]).trim()] = i + 2;
    });
  }
  var toAppend = [];
  mappings.forEach(function (m) {
    var mfItem = String(m[0] || '').trim(), mfSub = String(m[1] || '').trim();
    if (!mfItem) return;
    var item = String(m[2] || '').trim().slice(0, 60);
    var sub = String(m[3] || '').trim().slice(0, 60);
    var cat = String(m[4] || 'O').trim().toUpperCase();
    if (['S', 'F', 'L', 'A', 'R', 'O', 'X'].indexOf(cat) < 0) cat = 'O';
    var exclude = !!m[5];
    var key = mfItem + '\t' + mfSub;
    var row = [mfItem, mfSub, item, sub, cat, exclude];
    if (rowByKey[key]) sh.getRange(rowByKey[key], 1, 1, 6).setValues([row]);
    else toAppend.push(row);
  });
  if (toAppend.length) sh.getRange(sh.getLastRow() + 1, 1, toAppend.length, 6).setValues(toAppend);
}

// MF取込の確定処理（2026-08-24追加）。プレビューでユーザーが確定した行をDB_PL（＋PL管理システム）へ書き込み、
// 未対応科目の解決結果をDB_科目対応へ・新しい補助科目をDB_補助科目へ学習させる。
// entries=[[ym(YYYY-MM), item, cat, amount, sub], ...]（同一store・複数月・複数科目が混在してよい）
// newMappings=[[mfItem, mfSub, item, sub, cat, exclude], ...] newSubItems=[[item, sub], ...]
function mfConfirmImport(p, session) {
  var isCommon = String(p.store) === '__common__';
  if (isCommon && !isAdmin(session)) return { ok: false, error: '全社共通経費は社長・本部のみ入力できます' };
  var store = isCommon ? '' : String(p.store || '').trim();
  if (!isCommon) {
    if (!store) return { ok: false, error: '店舗が未指定です' };
    if (!scopeAllows_(session, store)) return { ok: false, error: 'この店舗の経費を編集する権限がありません' };
  }
  var entries; try { entries = JSON.parse(p.entries || '[]'); } catch (e) { entries = []; }
  var newMappings; try { newMappings = JSON.parse(p.newMappings || '[]'); } catch (e2) { newMappings = []; }
  var newSubItems; try { newSubItems = JSON.parse(p.newSubItems || '[]'); } catch (e3) { newSubItems = []; }

  var clean = [], keySet = {}, monthSet = {};
  entries.forEach(function (a) {
    var ym = String(a[0] || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) return;
    var item = String(a[1] || '').trim().slice(0, 60);
    var cat = String(a[2] || 'O').trim().toUpperCase();
    if (['S', 'F', 'L', 'A', 'R', 'O', 'X'].indexOf(cat) < 0) cat = 'O';
    var amt = Number(a[3]) || 0;
    var sub = String(a[4] || '').trim().slice(0, 60);
    if (!item) return;
    var ymSlash = ym.slice(0, 4) + '/' + ym.slice(5, 7);
    monthSet[ymSlash] = 1;
    keySet[ymSlash + '\t' + item + '\t' + sub] = 1;
    if (amt > 0) clean.push([ymSlash, item, cat, amt, sub]);
  });
  if (clean.length > 500) return { ok: false, error: '一度に確定できるのは500行までです（月・科目を分けて取り込んでください）' };
  if (!clean.length) return { ok: false, error: '確定する行がありません' };

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Tokyo', 'yyyy-MM-dd');
  var memoTag = '[MF取込 ' + todayStr + ']';

  // ① DB_PL：対象キー（年月×店舗×科目×補助科目）に一致する既存行を除去 → 確定分を追加
  var dp = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DB_PL');
  if (!dp) return { ok: false, error: 'DB_PLシートがありません' };
  var dlast = dp.getLastRow(), keep = [];
  var dlastCol = Math.max(dp.getLastColumn(), 7);
  if (dlast >= 2) {
    dp.getRange(2, 1, dlast - 1, dlastCol).getValues().forEach(function (r) {
      if (r[0] === '' && r[1] === '' && r[2] === '') return;
      var key = ymOf_(r[0]) + '\t' + String(r[2]).trim() + '\t' + String(r[6] || '').trim();
      if (String(r[1]).trim() === store && keySet[key] && String(r[5]) !== PL_AUTO_MEMO) return;
      keep.push(r);
    });
  }
  var out = keep.concat(clean.map(function (a) {
    var y = +a[0].slice(0, 4), mo = +a[0].slice(5, 7);
    return [new Date(y, mo - 1, 1), store, a[1], a[2], a[3], memoTag, a[4]];
  }));
  if (dlast >= 2) dp.getRange(2, 1, dlast - 1, dlastCol).clearContent();
  if (out.length) { dp.getRange(2, 1, out.length, 7).setValues(out); dp.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d'); }
  ensureSubItemMaster_(newSubItems);

  // ② PL管理システム ✍販管費入力：同じキーで差し替え（D列の区分式は触らない）
  var plsys = '';
  try {
    var psh = SpreadsheetApp.openById(PL_SYSTEM_ID).getSheetByName(PL_INPUT_SHEET);
    if (psh) {
      var plStore = isCommon ? '本社・共通' : store;
      var lastR = psh.getLastRow(), nR = Math.max(lastR - 2, 0);
      var A = nR > 0 ? psh.getRange(3, 1, nR, 3).getValues() : [];
      var E = nR > 0 ? psh.getRange(3, 5, nR, 2).getValues() : [];
      var G = nR > 0 ? psh.getRange(3, 7, nR, 1).getValues() : [];
      var keepP = [];
      for (var i = 0; i < nR; i++) {
        if (String(A[i][0]) === '' && String(A[i][2]) === '') continue;
        var keyP = ymOf_(A[i][0]) + '\t' + String(A[i][2]).trim() + '\t' + String(G[i][0] || '').trim();
        if (String(A[i][1]).trim() === plStore && keySet[keyP]) continue;
        keepP.push([A[i][0], A[i][1], A[i][2], E[i][0], E[i][1], G[i][0]]);
      }
      clean.forEach(function (a) { keepP.push([a[0], plStore, a[1], a[3], memoTag, a[4]]); });
      if (nR > 0) { psh.getRange(3, 1, nR, 3).clearContent(); psh.getRange(3, 5, nR, 2).clearContent(); psh.getRange(3, 7, nR, 1).clearContent(); }
      if (keepP.length) {
        psh.getRange(3, 1, keepP.length, 3).setValues(keepP.map(function (r) { return [r[0], r[1], r[2]]; }));
        psh.getRange(3, 5, keepP.length, 2).setValues(keepP.map(function (r) { return [r[3], r[4]]; }));
        psh.getRange(3, 7, keepP.length, 1).setValues(keepP.map(function (r) { return [r[5]]; }));
      }
      plsys = 'PL管理システムにも反映しました';
    } else plsys = 'PL管理システムに「' + PL_INPUT_SHEET + '」シートが見つかりません（DB_PLのみ反映）';
  } catch (e) { plsys = 'PL管理システムへの反映に失敗（DB_PLのみ反映）: ' + String(e && e.message || e); }

  mfEnsureCategoryMap_(newMappings);

  try {
    var tkPl3 = PropertiesService.getScriptProperties().getProperty('BQ_LOAD_TOKEN');
    if (tkPl3) bqSyncPL({ token: tkPl3 });
  } catch (eSync3) { /* BQ同期に失敗してもシート保存自体は成功として扱う（次回同期で追いつく） */ }

  return { ok: true, saved: clean.length, months: Object.keys(monthSet).length, plsys: plsys };
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

/* ---- 単価設定（⚙単価設定）のダッシュボードからの編集 ----
 * 2026-08-30追加。これまで「⚙単価設定」タブはユーザーがスプレッドシートを直接編集する運用
 * だったが、ユーザーから「スプレッドシートではなくダッシュボード上で設定できるようにしてほしい」
 * と依頼があり追加。保存先は従来どおり同じ⚙単価設定タブ（＝新しいデータ源は増やさない。
 * getData()のMGMT_TABS経由でこれまでどおりD.tanka等に反映される）。 */
// 店舗が空欄（＝全店共通）の行は社長・本部のみ編集可、店舗が指定されていればその店舗の担当者も編集可
function tankaEditAllowed_(session, store) {
  if (!store) return isAdmin(session);
  return scopeAllows_(session, store);
}
function saveTanka(p, session) {
  var store = String(p.store || '').trim();
  var media = String(p.media || '').trim();
  var price = Number(p.price);
  if (!(price > 0)) return { ok: false, error: '設定単価は1以上の数字で入力してください' };
  var avg = Number(p.avg) || 0;
  var cvRaw = Number(p.cv) || 0;
  var cv = cvRaw >= 1 ? cvRaw / 100 : cvRaw; // 30 でも 0.3 でもOK（30以上=%表記とみなす）
  var memo = String(p.memo || '').trim();
  var oldStore = String(p.oldStore || '').trim();
  var oldMedia = String(p.oldMedia || '').trim();
  if (!tankaEditAllowed_(session, store)) return { ok: false, error: '全店共通の単価設定は社長・本部のみ編集できます' };
  if (oldStore && oldStore !== store && !tankaEditAllowed_(session, oldStore)) return { ok: false, error: '元の店舗の単価設定を編集する権限がありません' };
  var mss = mgmtOpen(); if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  mgmtEnsure(mss);
  var sh = mgmtFindTab(mss, /単価設定/); if (!sh) return { ok: false, error: '⚙単価設定タブが見つかりません' };
  var last = sh.getLastRow(), found = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '').trim() === oldStore && String(vals[i][1] || '').trim() === oldMedia) { found = i + 2; break; }
    }
  }
  var row = [store, media, price, avg || '', cv || '', memo];
  var target = found > 0 ? found : sh.getLastRow() + 1;
  sh.getRange(target, 1, 1, 6).setValues([row]);
  return { ok: true };
}
function deleteTanka(p, session) {
  var store = String(p.store || '').trim();
  var media = String(p.media || '').trim();
  if (!tankaEditAllowed_(session, store)) return { ok: false, error: 'この単価設定を削除する権限がありません' };
  var mss = mgmtOpen(); if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  var sh = mgmtFindTab(mss, /単価設定/); if (!sh) return { ok: false, error: '⚙単価設定タブが見つかりません' };
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '').trim() === store && String(vals[i][1] || '').trim() === media) { sh.deleteRow(i + 2); return { ok: true }; }
    }
  }
  return { ok: false, error: '該当の設定が見つかりませんでした（既に削除済みかもしれません）' };
}

// ================== 媒体手数料設定（A-6 Phase2・2026-08-31追加） ==================
// 参照モック`docs/mockups/NStyle_統合ポータル_予約管理_UI_v3`v3.1の「予約媒体・手数料設定」モーダル。
// 計算方式=予約売上×手数料率／予約人数×単価／予約件数×単価／固定費、のいずれか。
// 対象店舗が空欄＝全店（saveTanka/deleteTankaと同じ「店舗×媒体」キー設計・同じ権限方式を踏襲）。
var MEDIA_FEE_METHODS = ['予約売上 × 手数料率', '予約人数 × 単価', '予約件数 × 単価', '固定費'];
function saveMediaFee(p, session) {
  var media = String(p.media || '').trim();
  if (!media) return { ok: false, error: '媒体を選択してください' };
  var method = String(p.method || '').trim();
  if (MEDIA_FEE_METHODS.indexOf(method) < 0) return { ok: false, error: '計算方式が不正です' };
  var value = String(p.value || '').trim();
  if (!value) return { ok: false, error: '手数料率／単価を入力してください' };
  var store = String(p.store || '').trim();
  var plan = String(p.plan || '').trim();
  var memo = String(p.memo || '').trim();
  var oldMedia = String(p.oldMedia || '').trim() || media;
  var oldStore = String(p.oldStore || '').trim();
  if (!tankaEditAllowed_(session, store)) return { ok: false, error: '全店共通の手数料設定は社長・本部のみ編集できます' };
  if (oldStore && oldStore !== store && !tankaEditAllowed_(session, oldStore)) return { ok: false, error: '元の店舗の手数料設定を編集する権限がありません' };
  var mss = mgmtOpen(); if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  mgmtEnsure(mss);
  var sh = mgmtFindTab(mss, /媒体手数料設定/); if (!sh) return { ok: false, error: '⚙媒体手数料設定タブが見つかりません' };
  var last = sh.getLastRow(), found = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '').trim() === oldMedia && String(vals[i][3] || '').trim() === oldStore) { found = i + 2; break; }
    }
  }
  var row = [media, method, value, store, plan, memo];
  var target = found > 0 ? found : sh.getLastRow() + 1;
  sh.getRange(target, 1, 1, 6).setValues([row]);
  return { ok: true };
}
function deleteMediaFee(p, session) {
  var media = String(p.media || '').trim();
  var store = String(p.store || '').trim();
  if (!tankaEditAllowed_(session, store)) return { ok: false, error: 'この手数料設定を削除する権限がありません' };
  var mss = mgmtOpen(); if (!mss) return { ok: false, error: '管理シートを開けません（MGMT_SHEET_ID）' };
  var sh = mgmtFindTab(mss, /媒体手数料設定/); if (!sh) return { ok: false, error: '⚙媒体手数料設定タブが見つかりません' };
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 4).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0] || '').trim() === media && String(vals[i][3] || '').trim() === store) { sh.deleteRow(i + 2); return { ok: true }; }
    }
  }
  return { ok: false, error: '該当の設定が見つかりませんでした（既に削除済みかもしれません）' };
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
    if (id.indexOf(PFX) !== 0 || String(r[3]).trim() !== venue) { keep.push(r); return; }   // 手動イベント＋他会場の自動行は常に保持（会場ごとに独立更新）
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
      '・区分=権限（社長/本部/マネージャー/店舗/外販）または 役職（店長/社員 など任意）\n' +
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
  if (['社長', '本部', 'マネージャー', '店舗', '外販'].indexOf(role) < 0) return { ok: false, error: '権限の指定が不正です' };
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

// ================== 入金備考（DB_入金備考） ==================
// 日別入金明細の各行に付けるメモ。日付×店舗で1つ。社長・本部のみ編集できる。
// 「DB_」始まりなので再デプロイ不要で配信される（雛形の自動生成のみ再デプロイ要）。
function depNoteSheet_() {
  return sheetOrCreate_('DB_入金備考', ['日付', '店舗', '備考', '更新者', '更新日時'],
    '入金管理の日別明細に表示されるメモ。日付×店舗で1件。ダッシュボードの入金管理タブ（社長・本部のみ）から入力します。');
}
function saveDepNote(p, session) {
  if (!isAdmin(session)) return { ok: false, error: '入金の備考は社長・本部のみ編集できます' };
  var date = String(p.date || '').trim();
  var store = String(p.store || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !store) return { ok: false, error: '日付と店舗が必要です' };
  var note = String(p.note == null ? '' : p.note);
  var sh = depNoteSheet_();
  var d = date.split('-');
  var dateVal = new Date(Number(d[0]), Number(d[1]) - 1, Number(d[2]));
  var last = sh.getLastRow(), found = -1;
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      var rd = vals[i][0] ? ymd_(new Date(vals[i][0])) : '';
      if (rd === date && String(vals[i][1]).trim() === store) { found = i + 2; break; }
    }
  }
  if (!note) {
    // 空で保存＝削除
    if (found > 0) sh.deleteRow(found);
    return { ok: true, deleted: true };
  }
  var row = [dateVal, store, note, session.name || session.id, new Date()];
  var target = found > 0 ? found : sh.getLastRow() + 1;
  sh.getRange(target, 1, 1, 5).setValues([row]);
  sh.getRange(target, 1).setNumberFormat('yyyy/m/d');
  return { ok: true };
}