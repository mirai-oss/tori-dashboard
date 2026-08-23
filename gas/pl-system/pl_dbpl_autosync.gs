/* =====================================================================
 * pl_dbpl_autosync.gs ── ✍販管費入力 → ダッシュボード DB_PL 自動同期
 * ---------------------------------------------------------------------
 * 【追加ファイル】PL管理システムのApps Scriptに「新しいファイル」として追加する。
 *   コード.gs は絶対に上書きしないこと（syncAd 等がリポジトリ側に無いため消える）。
 *
 * 背景:
 *   - これまで 販管費入力 → DB_PL は メニュー「DB_PLへ転記」の手動のみ。
 *     シートを直接編集してもダッシュボードに出ない、という問題があった。
 *   - 既存の自動反映は autoPromoToDbPl_（毎朝8時）だが、媒体販促費（自動）行しか
 *     触らず、手入力行は一切更新しない。
 *   → 本ファイルは「手入力行＋媒体販促費（自動）行」を両方まとめて反映する上位互換。
 *     installPlAutoSync() が古い autoPromoToDbPl_ トリガーを削除して置き換える。
 *
 * 既存コードとの関係:
 *   - グローバル（DASH_ID / N / AUTO_MEMO / computeAutoPromoRows）が有れば再利用し、
 *     無ければフォールバックする。関数名・変数名はすべて pl〜 / PLS〜 で衝突なし。
 *   - コード.gs は一切変更不要（メニューに載せたい場合のみ onOpen に2行追加）。
 * ===================================================================== */

/* ---------- 設定 ---------- */
function plsCfg_() {
  return {
    dashId: (typeof DASH_ID !== 'undefined' && DASH_ID) ? DASH_ID : '1OuaAQBeXHxJZtDXEbQx-V7w56fCWW5jpDmZvBpkfIbQ',
    autoMemo: (typeof AUTO_MEMO !== 'undefined' && AUTO_MEMO) ? AUTO_MEMO : '媒体販促費（自動計上）',
    inputName: (typeof N !== 'undefined' && N && N.i) ? N.i : '✍ 販管費入力',
    setName: (typeof N !== 'undefined' && N && N.s) ? N.s : '⚙ 設定',
    mstName: (typeof N !== 'undefined' && N && N.m) ? N.m : '📚 科目マスタ',
    dbPl: 'DB_PL',
    common: '本社・共通',   // DB_PL 側では店舗名を空欄にする（＝全社共通経費の約束）
    hour: 8,                // 毎日同期の実行時刻（既存 autoPromoToDbPl_ と同じ枠）
    tickMinutes: 10         // 編集検知後の反映チェック間隔
  };
}

// 絵文字付きタブ名は表記ゆれが起きやすいので、完全一致→部分一致の順で探す
function plsSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  var key = String(name).replace(/[^぀-ヿ一-鿿_A-Za-z0-9]/g, '');
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    var n = all[i].getName().replace(/[^぀-ヿ一-鿿_A-Za-z0-9]/g, '');
    if (n === key) return all[i];
  }
  return null;
}

// 年月を 'yyyy/MM' に正規化（Date / 'yyyy/mm' / 'yyyy/m' / 'yyyy-mm' を許容）
function plsYm_(v, tz) {
  if (v === '' || v == null) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy/MM');
  var s = String(v).trim().replace(/-/g, '/');
  var m = s.match(/^(\d{4})\/(\d{1,2})/);
  if (!m) return '';
  return m[1] + '/' + ('0' + m[2]).slice(-2);
}

function plsYmToDate_(ym) {
  var p = ym.split('/');
  return new Date(Number(p[0]), Number(p[1]) - 1, 1);
}

/* =====================================================================
 * 本体：✍販管費入力（＋媒体販促費の自動行）→ DB_PL へ反映（UIなし・トリガー可）
 *
 * 洗い替えの範囲（ここが手動版 syncToDbPl との最大の違い）:
 *   手入力行 … 「⚙設定の対象期間の全月」＋「販管費入力に存在する月」の和集合。
 *     → 販管費入力である月の行を"全部消した"場合でも DB_PL 側から消える。
 *       （手動版は「データが有る月」しか洗い替えないため、全削除が反映されなかった）
 *   自動行   … 媒体販促費（自動計上）メモを持つ行のうち、今回算出した月だけ差し替え。
 *   対象範囲外の月の行は一切触らない（過去分の保全）。
 *
 * 除外ルール:
 *   - 科目マスタのデータ源が「自動｜…」の科目は手入力行として転記しない。
 *     （例: 広告宣伝費は syncAd が 取込_月次 経由で計上済み。DB_広告との二重計上を防ぐ）
 *   - 区分が S/F/L/R/A/O/X 以外（科目マスタ未登録＝D列が「？」）の行はスキップして件数だけ報告。
 *   - 店舗「本社・共通」は DB_PL では店舗名を空欄にする（ダッシュボードの全社共通経費の扱いに合わせる）。
 * ===================================================================== */
function plSyncToDbPl_(dryRun) {
  var cfg = plsCfg_(), tz = Session.getScriptTimeZone();
  var ss = SpreadsheetApp.getActive();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: '他の処理が実行中のためスキップしました' };
  try {
    var src = plsSheet_(ss, cfg.inputName);
    if (!src) return { ok: false, error: '「' + cfg.inputName + '」シートが見つかりません' };
    var dash = SpreadsheetApp.openById(cfg.dashId);
    var dp = dash.getSheetByName(cfg.dbPl);
    if (!dp) return { ok: false, error: 'ダッシュボードに「' + cfg.dbPl + '」シートがありません' };

    /* ① 科目マスタ: 科目名 → データ源（自動｜… は手入力転記から除外） */
    var autoAcct = {};
    var mst = plsSheet_(ss, cfg.mstName);
    if (mst) {
      mst.getRange(3, 2, 60, 3).getValues().forEach(function (r) {   // B=科目名, C=区分, D=データ源
        var nm = String(r[0]).trim();
        if (nm && /^自動｜/.test(String(r[2]).trim())) autoAcct[nm] = true;
      });
    }

    /* ② 洗い替え対象月：設定の対象期間（月リスト）＋ 販管費入力に存在する月 */
    var targetMonths = {};
    var setSh = plsSheet_(ss, cfg.setName);
    if (setSh) {
      setSh.getRange(8, 4, 24, 1).getValues().forEach(function (r) {   // ⚙設定 D8:D31 = 月リスト（自動）
        var ym = plsYm_(r[0], tz);
        if (ym) targetMonths[ym] = true;
      });
    }

    /* ③ 販管費入力の手入力行（G列＝補助科目。2026-08-23追加・任意項目） */
    var last = src.getLastRow();
    var raw = last >= 3 ? src.getRange(3, 1, last - 2, 7).getValues() : [];
    var manual = [], skippedAuto = 0, skippedBad = 0;
    raw.forEach(function (r) {
      var ym = plsYm_(r[0], tz);
      var store = String(r[1] == null ? '' : r[1]).trim();
      var acct = String(r[2] == null ? '' : r[2]).trim();
      var cat = String(r[3] == null ? '' : r[3]).trim().toUpperCase();
      var amt = Number(String(r[4] == null ? '' : r[4]).replace(/[,¥\s]/g, ''));
      var memo = String(r[5] == null ? '' : r[5]).trim();
      var sub = String(r[6] == null ? '' : r[6]).trim();
      if (!ym && !store && !acct) return;                       // 空行
      if (!ym || !store || !acct || !amt) { if (ym || store || acct) skippedBad++; return; }
      if (autoAcct[acct]) { skippedAuto++; return; }             // 自動計上科目は転記しない
      if (['S', 'F', 'L', 'R', 'A', 'O', 'X'].indexOf(cat) < 0) { skippedBad++; return; }
      targetMonths[ym] = true;                                   // データが有る月も洗い替え対象に
      if (store === cfg.common) store = '';                      // 全社共通 → DB_PLでは店舗空欄
      manual.push([plsYmToDate_(ym), store, acct, cat, amt, memo, sub]);
    });

    /* ④ 媒体販促費（自動）行（既存 computeAutoPromoRows を再利用。補助科目は常に空） */
    var auto = [], autoMonths = {};
    if (typeof computeAutoPromoRows === 'function') {
      try {
        computeAutoPromoRows(ss).forEach(function (r) {           // [年月, 店舗, 科目, 'O', 金額, AUTO_MEMO]
          var ym = plsYm_(r[0], tz);
          if (!ym) return;
          autoMonths[ym] = true;
          var st = String(r[1]).trim();
          auto.push([plsYmToDate_(ym), st === cfg.common ? '' : st, r[2], r[3], r[4], r[5], '']);
        });
      } catch (e) { /* 媒体販促の算出に失敗しても手入力の同期は続行する */ }
    }

    /* ⑤ DB_PL 洗い替え */
    var dlast = dp.getLastRow(), keep = [], dropped = [];
    var dlastCol = Math.max(dp.getLastColumn(), 7);
    // 販管費入力に現存する 月×店舗×科目×補助科目 のキー（差し替えではなく"消滅"した行を見分けるため）
    var liveKey = {};
    manual.forEach(function (r) { liveKey[plsYm_(r[0], tz) + '\t' + r[1] + '\t' + r[2] + '\t' + r[6]] = true; });
    if (dlast >= 2) {
      dp.getRange(2, 1, dlast - 1, dlastCol).getValues().forEach(function (r) {
        if (r[0] === '' && r[1] === '' && r[2] === '') return;    // 空行は捨てる
        var ym = plsYm_(r[0], tz);
        if (String(r[5]).trim() === cfg.autoMemo) {               // 自動行：今回更新する月だけ差し替え
          if (!autoMonths[ym]) keep.push(r);
        } else {                                                  // 手入力行：対象月なら差し替え
          if (!targetMonths[ym]) keep.push(r);
          else if (!liveKey[ym + '\t' + String(r[1]).trim() + '\t' + String(r[2]).trim() + '\t' + String(r[6] || '').trim()]) {
            dropped.push([ym, String(r[1]).trim(), String(r[2]).trim(), r[4]]);   // 入力側に無い＝消える行
          }
        }
      });
    }
    var out = keep.concat(manual).concat(auto);
    if (!dryRun) {
      if (dlast >= 2) dp.getRange(2, 1, dlast - 1, dlastCol).clearContent();
      if (out.length) {
        dp.getRange(2, 1, out.length, 7).setValues(out);
        dp.getRange(2, 1, out.length, 1).setNumberFormat('yyyy/m/d');
      }
      SpreadsheetApp.flush();
    }

    var months = Object.keys(targetMonths).sort();
    var res = {
      ok: true, dryRun: !!dryRun, manual: manual.length, auto: auto.length, kept: keep.length,
      months: months, skippedAuto: skippedAuto, skippedBad: skippedBad, dropped: dropped
    };
    console.log('plSyncToDbPl_ ' + JSON.stringify(res));
    return res;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 事前確認（書き込まない） ----------
 * ★自動同期をONにする前に、まずこれを実行すること。
 *   DB_PL にあって 販管費入力 に無い行＝今後 DB_PL から消える行 を一覧表示する。
 *   意図せず消える行があれば、先に 販管費入力 側へその行を追加してから ON にする。 */
function plSyncPreview() {
  var r = plSyncToDbPl_(true);
  if (!r.ok) { console.log('エラー: ' + r.error); return r; }
  var msg = '【事前確認・書き込みなし】\n'
    + '販管費入力から転記される手入力行: ' + r.manual + ' 行\n'
    + '媒体販促費（自動）行: ' + r.auto + ' 行\n'
    + '対象外の月として保持される行: ' + r.kept + ' 行\n'
    + '自動計上科目のためスキップ: ' + r.skippedAuto + ' 行\n'
    + '不備でスキップ: ' + r.skippedBad + ' 行\n\n'
    + '▼ DB_PLから消える行（販管費入力に存在しない）: ' + r.dropped.length + ' 行\n'
    + (r.dropped.length
        ? r.dropped.map(function (d) { return '  ' + d[0] + ' / ' + (d[1] || '(全社共通)') + ' / ' + d[2] + ' / ' + d[3]; }).join('\n')
        : '  なし（安全にONにできます）');
  console.log(msg);
  try { SpreadsheetApp.getUi().alert('同期プレビュー', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

/* ---------- 手動実行（メニュー用・アラートあり） ---------- */
function syncPlToDbPlNow() {
  var r = plSyncToDbPl_();
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { return r; }   // スクリプトエディタから実行した場合
  if (!r.ok) { ui.alert('同期エラー', r.error, ui.ButtonSet.OK); return r; }
  var msg = 'DB_PLへ 手入力 ' + r.manual + ' 行＋媒体販促費（自動）' + r.auto + ' 行を反映しました。\n'
    + '対象月: ' + (r.months.join(', ') || 'なし') + '\n'
    + '（対象月の既存行は差し替え、対象外の月は保持：' + r.kept + ' 行）';
  if (r.skippedAuto) msg += '\n※ 自動計上科目（広告宣伝費など）の ' + r.skippedAuto + ' 行は二重計上防止のため転記していません。';
  if (r.skippedBad) msg += '\n⚠ 年月/店舗/科目/金額が不足、または科目マスタ未登録の ' + r.skippedBad + ' 行をスキップしました。';
  if (r.dropped.length) msg += '\n⚠ 販管費入力に無いため DB_PL から削除: ' + r.dropped.length + ' 行（詳細は実行ログ）';
  ui.alert('同期完了', msg, ui.ButtonSet.OK);
  return r;
}

/* ---------- 編集検知（インストール型 onEdit） ---------- */
// 販管費入力が編集されたら「未反映」フラグを立てるだけ。実書き込みは plSyncTick_ が行う
//（1セル編集ごとに他ブックへ書き込むと重い・競合するため、10分おきのデバウンス方式）。
function plOnInputEdit_(e) {
  try {
    if (!e || !e.range) return;
    var cfg = plsCfg_();
    var nm = e.range.getSheet().getName().replace(/[^぀-ヿ一-鿿_A-Za-z0-9]/g, '');
    var key = cfg.inputName.replace(/[^぀-ヿ一-鿿_A-Za-z0-9]/g, '');
    if (nm !== key) return;
    if (e.range.getRow() < 3) return;              // 見出し行
    var c1 = e.range.getColumn(), c2 = c1 + e.range.getNumColumns() - 1;
    if (c2 < 1 || c1 > 7) return;                  // A〜G列以外は無視（G=補助科目）
    PropertiesService.getScriptProperties().setProperty('PLSYNC_DIRTY', String(Date.now()));
  } catch (err) { /* onEditは失敗してもユーザー操作を妨げない */ }
}

// 10分おき。未反映フラグが立っていて、最後の編集から90秒以上経っていれば同期する。
function plSyncTick_() {
  var props = PropertiesService.getScriptProperties();
  var t = Number(props.getProperty('PLSYNC_DIRTY') || 0);
  if (!t) return;
  if (Date.now() - t < 90000) return;              // 入力中はまだ待つ
  props.deleteProperty('PLSYNC_DIRTY');
  var r = plSyncToDbPl_();
  if (!r.ok) props.setProperty('PLSYNC_DIRTY', String(t));   // 失敗したら次回に再試行
}

// 毎日1回のフルスキャン（トリガー本体）。編集検知が取りこぼしても必ず追いつく保険。
function plSyncDaily_() { plSyncToDbPl_(); }

/* =====================================================================
 * トリガー設置 ── ユーザーが1回だけ実行して承認する
 *   1) 毎日 8:00 フル同期（syncAd と同じ「毎日トリガー」方式）
 *   2) 販管費入力の編集検知 → 最短10分で自動反映
 *   3) 旧 autoPromoToDbPl_ トリガーは本同期に含まれるので削除（二重書き込み防止）
 * ===================================================================== */
function installPlAutoSync() {
  var cfg = plsCfg_();
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'plSyncDaily_' || f === 'plSyncTick_' || f === 'plOnInputEdit_' || f === 'autoPromoToDbPl_') {
      ScriptApp.deleteTrigger(t); removed++;
    }
  });
  ScriptApp.newTrigger('plSyncDaily_').timeBased().atHour(cfg.hour).everyDays(1).create();
  ScriptApp.newTrigger('plSyncTick_').timeBased().everyMinutes(cfg.tickMinutes).create();
  ScriptApp.newTrigger('plOnInputEdit_').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  var r = plSyncToDbPl_();   // 設置と同時に今すぐ最新化
  var msg = '自動同期を設定しました（旧トリガー ' + removed + ' 件を置換）。\n'
    + '・毎日 ' + cfg.hour + ':00 にフル同期\n'
    + '・✍販管費入力を編集すると最短 ' + cfg.tickMinutes + ' 分で反映\n\n'
    + '今回の反映: 手入力 ' + (r.manual || 0) + ' 行／自動 ' + (r.auto || 0) + ' 行'
    + (r.ok ? '' : '\n⚠ ' + r.error);
  console.log(msg);
  try { SpreadsheetApp.getUi().alert('自動同期ON', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

// 元に戻す（自動同期を止める）。手動メニューは残る。
function uninstallPlAutoSync() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'plSyncDaily_' || f === 'plSyncTick_' || f === 'plOnInputEdit_') { ScriptApp.deleteTrigger(t); n++; }
  });
  console.log('自動同期トリガーを ' + n + ' 件削除しました');
  return n;
}

/* ---------- 補助科目（G列）の追加（2026-08-23・本番シートへの一回きりの安全な移行） ----------
 * buildInput()（pl_system.gs）はsheetResetで全体を作り直すため、実データが入った本番シートに
 * 対して再実行するのは危険（seedを渡さないと消える）。この関数はG列ヘッダーを追加するだけで、
 * 既存の年月/店舗/科目/区分/金額/メモ（A〜F列）には一切触れない。
 * 実行方法: このApps Scriptエディタで plsMigrateAddSubItemColumn_ を選んで実行ボタンを押すだけ。 */
function plsMigrateAddSubItemColumn_() {
  var cfg = plsCfg_();
  var ss = SpreadsheetApp.getActive();
  var sh = plsSheet_(ss, cfg.inputName);
  if (!sh) { var m0 = '「' + cfg.inputName + '」シートが見つかりません'; console.log(m0); return m0; }
  if (String(sh.getRange('G2').getValue()).trim() === '補助科目') {
    var m1 = '既に補助科目（G列）はあります。何もしていません。';
    console.log(m1); return m1;
  }
  sh.getRange('G2').setValue('補助科目').setFontWeight('bold');
  try { sh.getRange('G2').setBackground(sh.getRange('C2').getBackground()); } catch (e) {}
  sh.getRange(3, 7, 2000, 1).setBackground('#FFF2CC');   // C.in相当（黄色系の入力色）
  sh.setColumnWidth(7, 150);
  var msg = '「' + cfg.inputName + '」にG列（補助科目）を追加しました。A〜F列のデータは変更していません。';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert('補助科目列を追加', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

/* ---------- 現在のトリガー確認（デバッグ用） ---------- */
function plSyncStatus() {
  var lines = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction() + ' / ' + t.getEventType();
  });
  var dirty = PropertiesService.getScriptProperties().getProperty('PLSYNC_DIRTY');
  var s = 'トリガー:\n  ' + (lines.join('\n  ') || 'なし') + '\n未反映フラグ: ' + (dirty ? new Date(Number(dirty)) : 'なし');
  console.log(s);
  return s;
}
