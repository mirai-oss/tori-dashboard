/**
 * Larkコマンドボット（受け口）— GAS Webアプリ
 * =============================================================
 * Larkのグループで「日報」「週報」「月報」「再送」等と発言すると、
 * この受け口がGitHubのレポートワークフローを起動し、Botが返事をする。
 *
 * ※ダッシュボード用のGAS(Code.gs)とは別に、【新しいApps Scriptプロジェクト】を作り、
 *   このファイルだけを入れて「ウェブアプリ」としてデプロイしてください（doPostが衝突するため）。
 *
 * 【スクリプトプロパティに登録するもの】（プロジェクトの設定→スクリプトプロパティ）
 *   GH_TOKEN            : GitHubのFine-grained PAT（Actions: Read and write）
 *   LARK_APP_ID         : cli_xxxxx（Larkアプリ）
 *   LARK_APP_SECRET     : アプリのSecret
 *   LARK_VERIFY_TOKEN   : イベント購読の「Verification Token」
 *
 * 【デプロイ】ウェブアプリ / 実行ユーザー=自分 / アクセス=全員（匿名を含む）
 *   → 発行されたURLをLarkの「イベント購読」リクエストURLに設定
 */

var GH_REPO = 'mirai-oss/tori-dashboard';
var GH_WORKFLOW = 'lark-report.yml';
var LARK_BASE = 'https://open.larksuite.com';

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}

  // ① URL検証（イベント購読の初回設定時に1度だけ来る）
  if (body.type === 'url_verification') {
    return okJson_({ challenge: body.challenge });
  }

  try {
    var header = body.header || {};
    // 検証トークン照合（設定していれば）
    var vtoken = prop_('LARK_VERIFY_TOKEN');
    if (vtoken && header.token && header.token !== vtoken) return okJson_({});

    // 重複イベントは無視（Larkは応答が遅いと再送してくる）
    var eid = header.event_id;
    if (eid) {
      var cache = CacheService.getScriptCache();
      if (cache.get('ev_' + eid)) return okJson_({});
      cache.put('ev_' + eid, '1', 600);
    }

    if (header.event_type === 'im.message.receive_v1') {
      handleMessage_(body.event);
    }
  } catch (err) {
    Logger.log('doPost err: ' + err);
  }
  return okJson_({}); // Larkには常に素早く200を返す
}

function handleMessage_(ev) {
  if (!ev || !ev.message) return;
  // Bot自身/アプリの発言には反応しない（無限ループ防止）
  if (ev.sender && ev.sender.sender_type && ev.sender.sender_type !== 'user') return;
  if (ev.message.message_type !== 'text') return;

  var text = '';
  try { text = (JSON.parse(ev.message.content || '{}').text) || ''; } catch (err) {}
  text = String(text).replace(/@_user_\d+/g, ' ').trim(); // メンション除去
  var chatId = ev.message.chat_id;

  // ヘルプ
  if (/ヘルプ|help|使い方/i.test(text)) {
    reply_(chatId, '【日報】使い方: このグループで「日報」「週報」「月報」または「再送」と送ると、最新のレポートを再生成して配信します。');
    return;
  }

  // 種別判定
  var kind = null;
  if (/月報|monthly/i.test(text)) kind = 'monthly';
  else if (/週報|weekly/i.test(text)) kind = 'weekly';
  else if (/日報|再送|daily|送/i.test(text)) kind = 'daily';

  if (!kind) {
    reply_(chatId, '【日報】ご用件が分かりませんでした。「日報」「週報」「月報」「再送」のいずれかを送ってください。');
    return;
  }

  var ok = dispatch_(kind);
  var name = kind === 'daily' ? '日報' : (kind === 'weekly' ? '週報' : '月報');
  if (ok) reply_(chatId, '【日報】了解しました。' + name + 'を再生成しています。1〜2分ほどで各グループに届きます。');
  else    reply_(chatId, '【日報】起動に失敗しました。GitHubトークンの設定をご確認ください。');
}

/** GitHubのworkflow_dispatchを起動 */
function dispatch_(kind) {
  var token = prop_('GH_TOKEN');
  if (!token) return false;
  var res = UrlFetchApp.fetch(
    'https://api.github.com/repos/' + GH_REPO + '/actions/workflows/' + GH_WORKFLOW + '/dispatches',
    {
      method: 'post', contentType: 'application/json',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tori-lark-bot'
      },
      payload: JSON.stringify({ ref: 'main', inputs: { kind: kind } }),
      muteHttpExceptions: true
    }
  );
  return res.getResponseCode() === 204;
}

/** Larkの該当チャットに返信 */
function reply_(chatId, text) {
  var at = tenantToken_();
  if (!at || !chatId) return;
  UrlFetchApp.fetch(LARK_BASE + '/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'post', contentType: 'application/json; charset=utf-8',
    headers: { 'Authorization': 'Bearer ' + at },
    payload: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: text }) }),
    muteHttpExceptions: true
  });
}

/** テナントアクセストークン取得 */
function tenantToken_() {
  var res = UrlFetchApp.fetch(LARK_BASE + '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ app_id: prop_('LARK_APP_ID'), app_secret: prop_('LARK_APP_SECRET') }),
    muteHttpExceptions: true
  });
  try { return JSON.parse(res.getContentText()).tenant_access_token; } catch (e) { return null; }
}

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function okJson_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ===== 動作テスト用（エディタから実行してGitHub起動だけ確認） =====
function testDispatchDaily() { Logger.log(dispatch_('daily')); }
