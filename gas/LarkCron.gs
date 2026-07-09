/**
 * Lark日報の定時トリガー（GAS時計トリガー版）
 * =============================================================
 * GitHub内蔵スケジュールは時刻がずれるため、Googleの時計トリガーから
 * 毎日決まった時刻にGitHubのワークフローを起動する。
 *
 * 【セットアップ】
 *  1. Apps Scriptエディタで「＋」→「スクリプト」で新規ファイルを作り、この内容を貼り付け
 *  2. 左メニュー「プロジェクトの設定」→「スクリプト プロパティ」で以下を追加
 *        プロパティ名: GH_TOKEN   値: github_pat_xxxx...（Fine-grained PAT / Actions:Read&Write）
 *  3. 関数 testDaily を一度実行して認可＆送信テスト（初回は権限の承認ダイアログが出る）
 *  4. 時計アイコン「トリガー」→「トリガーを追加」:
 *        実行する関数        = larkReportTick
 *        イベントのソース    = 時間主導型
 *        時間ベースのタイマー = 分ベースのタイマー → 15分おき
 *     これで毎日 正午ごろに日報が自動配信される。
 *
 * 【配信スケジュール】JST
 *   日報 : 毎日 12:00
 *   週報 : 1,8,15,22,29日 12:15
 *   月報 : 毎月1日 12:30
 */

var GH_REPO = 'mirai-oss/tori-dashboard';
var GH_WORKFLOW = 'lark-report.yml';
var TZ = 'Asia/Tokyo';

/** 15分おきに呼ばれ、時刻を見て該当レポートを1日1回だけ起動する */
function larkReportTick() {
  var now = new Date();
  var hh = Number(Utilities.formatDate(now, TZ, 'HH'));
  var mm = Number(Utilities.formatDate(now, TZ, 'mm'));
  var dd = Number(Utilities.formatDate(now, TZ, 'd'));
  var today = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  var props = PropertiesService.getScriptProperties();

  // 日報 12:00台の最初のtick（12:00〜12:14）
  if (hh === 12 && mm < 15) {
    fireOnce_('daily', today, props);
  }
  // 週報 12:15〜12:29（1,8,15,22,29日）
  if (hh === 12 && mm >= 15 && mm < 30 && [1, 8, 15, 22, 29].indexOf(dd) >= 0) {
    fireOnce_('weekly', today, props);
  }
  // 月報 12:30〜12:44（1日）
  if (hh === 12 && mm >= 30 && mm < 45 && dd === 1) {
    fireOnce_('monthly', today, props);
  }
}

/** 同じ種別を同日に二重起動しないためのガード付きで起動 */
function fireOnce_(kind, today, props) {
  var key = 'lastFired_' + kind;
  if (props.getProperty(key) === today) return; // 今日はもう送信済み
  dispatchGithub_(kind);
  props.setProperty(key, today);
}

/** GitHubのworkflow_dispatch APIを叩いてレポートを起動 */
function dispatchGithub_(kind) {
  var token = PropertiesService.getScriptProperties().getProperty('GH_TOKEN');
  if (!token) throw new Error('GH_TOKEN が未設定です（プロジェクトの設定→スクリプトプロパティ）');
  var url = 'https://api.github.com/repos/' + GH_REPO + '/actions/workflows/' + GH_WORKFLOW + '/dispatches';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'tori-lark-report'
    },
    payload: JSON.stringify({ ref: 'main', inputs: { kind: kind } }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 204) {
    throw new Error('GitHub起動に失敗 code=' + code + ' / ' + res.getContentText());
  }
  Logger.log('GitHub起動OK: ' + kind);
}

// ============ 手動テスト用（エディタから実行して確認） ============
function testDaily()   { dispatchGithub_('daily'); }
function testWeekly()  { dispatchGithub_('weekly'); }
function testMonthly() { dispatchGithub_('monthly'); }
