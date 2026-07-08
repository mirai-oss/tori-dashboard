/**
 * 鳥一代グループ ダッシュボード → Lark 自動日報/週報/月報
 * =========================================================
 * GitHub Actions から定時実行される。
 *  1. ヘッドレスブラウザで公開ダッシュボードにログイン（専用アカウント）
 *  2. レポートカード（1枚レイアウト）を描画してスクリーンショット
 *  3. Lark にアップロードしてグループのWebhookボットへ投稿
 *
 * 必要な環境変数（GitHub Secrets で設定）:
 *  - DASH_ID / DASH_PW : ダッシュボードのログインID/パスワード（本部権限のBot用アカウント推奨）
 *  - LARK_WEBHOOK      : Larkグループのカスタムボット Webhook URL
 *  - LARK_APP_ID / LARK_APP_SECRET : （画像送信に必要）Larkカスタムアプリの認証情報
 *  - LARK_DOMAIN       : 省略時 https://open.larksuite.com（Feishuなら https://open.feishu.cn）
 *  - REPORT_KIND       : daily | weekly | monthly
 *  - SITE_URL          : 省略時 https://mirai-oss.github.io/tori-dashboard/
 * アプリ認証情報が無い場合は、画像の代わりにテキストカード（数値サマリー）を送る。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const SITE_URL = process.env.SITE_URL || 'https://mirai-oss.github.io/tori-dashboard/';
const KIND = (process.env.REPORT_KIND || 'daily').trim();
const DASH_ID = process.env.DASH_ID || '';
const DASH_PW = process.env.DASH_PW || '';
const WEBHOOK = process.env.LARK_WEBHOOK || '';
const APP_ID = process.env.LARK_APP_ID || '';
const APP_SECRET = process.env.LARK_APP_SECRET || '';
const DOMAIN = (process.env.LARK_DOMAIN || 'https://open.larksuite.com').replace(/\/$/, '');

const yen = (n) => '¥' + Math.round(n || 0).toLocaleString('ja-JP');
const log = (...a) => console.log('[lark-report]', ...a);

if (!DASH_ID || !DASH_PW) { console.error('DASH_ID / DASH_PW が未設定です'); process.exit(1); }
if (!WEBHOOK) { console.error('LARK_WEBHOOK が未設定です'); process.exit(1); }

// ---------- 1. スクリーンショット取得 ----------
async function capture() {
  log('browser起動 / kind =', KIND);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--lang=ja-JP'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1800, deviceScaleFactor: 2 });
    log('open:', SITE_URL);
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    // ログイン
    await page.waitForSelector('#li-id', { timeout: 60000 });
    await page.type('#li-id', DASH_ID);
    await page.type('#li-pw', DASH_PW);
    await page.click('#li-btn');
    log('ログイン送信、データ読込待ち…（GASの応答に1〜2分かかることがあります）');

    // 認証エラーの即時検知
    await Promise.race([
      page.waitForFunction(
        () => typeof S !== 'undefined' && S.auth && S.connState === 'live' && typeof D !== 'undefined' && D.daily.length > 0,
        { timeout: 180000, polling: 2000 }
      ),
      page.waitForFunction(
        () => { const el = document.querySelector('.login-err'); return el && el.textContent.length > 0 ? el.textContent : false; },
        { timeout: 180000, polling: 2000 }
      ).then(async (h) => { throw new Error('ログイン失敗: ' + (await h.jsonValue())); }),
    ]);
    log('データ読込完了。レポート描画:', KIND);

    await page.evaluate((k) => { App.report(k); }, KIND);
    await page.waitForSelector('#report-card', { timeout: 30000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    await new Promise((r) => setTimeout(r, 1200)); // フォント・描画の安定待ち

    const data = await page.evaluate(() => window.__REPORT_JSON);
    const el = await page.$('#report-card');
    await el.screenshot({ path: 'report.png' });
    log('スクリーンショット保存: report.png /', data.title, data.sub);
    return data;
  } finally {
    await browser.close();
  }
}

// ---------- 2. Lark 送信 ----------
async function larkJson(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

async function tenantToken() {
  const { j } = await larkJson(`${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal`, { app_id: APP_ID, app_secret: APP_SECRET });
  if (!j.tenant_access_token) throw new Error('tenant_access_token取得失敗: ' + JSON.stringify(j));
  return j.tenant_access_token;
}

async function uploadImage(token) {
  const buf = fs.readFileSync('report.png');
  const fd = new FormData();
  fd.append('image_type', 'message');
  fd.append('image', new Blob([buf], { type: 'image/png' }), 'report.png');
  const r = await fetch(`${DOMAIN}/open-apis/im/v1/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.data || !j.data.image_key) throw new Error('画像アップロード失敗: ' + JSON.stringify(j));
  return j.data.image_key;
}

function summaryTitle(d) {
  const t = d.tot; const p = t.prevSales;
  const yoy = p > 0 ? ((t.sales - p) / p * 100) : null;
  const yoyTxt = yoy == null ? '' : `（前年比 ${yoy >= 0 ? '+' : '▲'}${Math.abs(yoy).toFixed(1)}%）`;
  return `【${d.title}】${d.sub}　全店売上 ${yen(t.sales)}${yoyTxt}`;
}

async function sendImageCard(d, imageKey) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: summaryTitle(d) }, template: d.kind === 'monthly' ? 'purple' : d.kind === 'weekly' ? 'green' : 'blue' },
    elements: [
      { tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: d.title } },
      // 「日報」はWebhookのカスタムキーワード。週報・月報でも必ず本文に含める
      { tag: 'note', elements: [{ tag: 'plain_text', content: `自動日報Bot ／ 詳細: ${SITE_URL} ／ 生成 ${d.gen}` }] },
    ],
  };
  const { j } = await larkJson(WEBHOOK, { msg_type: 'interactive', card });
  if (j.code !== 0 && j.StatusCode !== 0) throw new Error('Webhook送信失敗: ' + JSON.stringify(j));
}

async function sendTextCard(d) {
  // 画像なしフォールバック：数値サマリーのカード
  const lines = d.rows.filter((r) => r.sales > 0).map((r, i) => {
    const yoy = r.prevSales > 0 ? `（前年 ${((r.sales - r.prevSales) / r.prevSales * 100) >= 0 ? '+' : '▲'}${Math.abs((r.sales - r.prevSales) / r.prevSales * 100).toFixed(1)}%）` : '';
    return `**${i + 1}. ${r.store}**　${yen(r.sales)} ${yoy}`;
  }).join('\n');
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: summaryTitle(d) }, template: 'blue' },
    elements: [
      { tag: 'markdown', content: lines || 'データなし' },
      { tag: 'hr' },
      // 「日報」はWebhookのカスタムキーワード。週報・月報でも必ず本文に含める
      { tag: 'note', elements: [{ tag: 'plain_text', content: `自動日報Bot ／ 詳細: ${SITE_URL} ／ 画像送信にはLARK_APP_ID/SECRETの設定が必要です` }] },
    ],
  };
  const { j } = await larkJson(WEBHOOK, { msg_type: 'interactive', card });
  if (j.code !== 0 && j.StatusCode !== 0) throw new Error('Webhook送信失敗: ' + JSON.stringify(j));
}

// ---------- main ----------
(async () => {
  const data = await capture();
  if (APP_ID && APP_SECRET) {
    log('Larkアプリ認証 → 画像アップロード → カード送信');
    const token = await tenantToken();
    const key = await uploadImage(token);
    await sendImageCard(data, key);
    log('✓ 画像カードを送信しました');
  } else {
    log('LARK_APP_ID/SECRET未設定 → テキストカードで送信（画像なし）');
    await sendTextCard(data);
    log('✓ テキストカードを送信しました');
  }
})().catch((e) => { console.error('[lark-report] 失敗:', e); process.exit(1); });
