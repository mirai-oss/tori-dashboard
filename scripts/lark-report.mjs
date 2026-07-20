/**
 * 鳥一代グループ ダッシュボード → Lark 自動日報/週報/月報（画像リンク方式）
 * =====================================================================
 * サブコマンド:
 *   node scripts/lark-report.mjs capture   … ログイン→カード撮影→ report.png + report-meta.json 出力
 *   node scripts/lark-report.mjs send      … report-meta.json + 環境変数 IMAGE_URL からLarkへカード送信
 *
 * GitHub Actions では capture → 画像をReleaseにアップロード → send の順で実行する。
 * 送るのは「要約テキスト＋画像リンクボタン」のカード（Larkのボット機能不要）。
 *
 * 環境変数:
 *   DASH_ID / DASH_PW  : ダッシュボードのログイン
 *   LARK_WEBHOOK       : Larkカスタムボットの Webhook URL
 *   REPORT_KIND        : daily | weekly | monthly
 *   SITE_URL           : 省略時 https://mirai-oss.github.io/tori-dashboard/
 *   IMAGE_URL          : send時、公開された日報画像のURL（capture後にActionsが渡す）
 */
import fs from 'node:fs';

const MODE = (process.argv[2] || 'send').trim();
const SITE_URL = process.env.SITE_URL || 'https://mirai-oss.github.io/tori-dashboard/';
const KIND = (process.env.REPORT_KIND || 'daily').trim();
const WEBHOOK = process.env.LARK_WEBHOOK || '';
const META = 'report-meta.json';

const yen = (n) => '¥' + Math.round(n || 0).toLocaleString('ja-JP');
const cnt = (n) => Math.round(n || 0).toLocaleString('ja-JP');
const yoy = (c, p) => (p > 0 ? `${(c - p) / p >= 0 ? '+' : '▲'}${Math.abs((c - p) / p * 100).toFixed(1)}%` : '—');
const log = (...a) => console.log('[lark-report]', ...a);

// ---------- capture: スクリーンショット + メタ ----------
async function capture() {
  const { default: puppeteer } = await import('puppeteer');
  const DASH_ID = process.env.DASH_ID || '', DASH_PW = process.env.DASH_PW || '';
  if (!DASH_ID || !DASH_PW) { console.error('DASH_ID / DASH_PW が未設定です'); process.exit(1); }
  log('browser起動 / kind =', KIND);
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--lang=ja-JP'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1800, deviceScaleFactor: 2 });
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    const loginOnce = async () => {
      await page.waitForSelector('#li-id', { timeout: 60000 });
      await page.$eval('#li-id', (el) => { el.value = ''; });
      await page.$eval('#li-pw', (el) => { el.value = ''; });
      await page.type('#li-id', DASH_ID);
      await page.type('#li-pw', DASH_PW);
      await page.click('#li-btn');
      log('ログイン送信、データ読込待ち…');
      // 媒体別(D.media)はフェーズ2の裏読みで後から届く。ランチ/ディナー内訳と媒体別売上が
      // 空のまま撮影されるのを防ぐため mediaPending===false まで待つ（読込失敗時もfalseになるので固まらない）。
      await Promise.race([
        page.waitForFunction(() => typeof S !== 'undefined' && S.auth && S.connState === 'live' && typeof D !== 'undefined' && D.daily.length > 0 && D.mediaPending === false, { timeout: 180000, polling: 2000 }),
        page.waitForFunction(() => { const el = document.querySelector('.login-err'); return el && el.textContent.length > 0 ? el.textContent : false; }, { timeout: 180000, polling: 2000 })
          .then(async (h) => { throw new Error('ログイン失敗: ' + (await h.jsonValue())); }),
      ]);
    };
    let ok = false, lastErr;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        if (attempt > 1) { log('再読み込みして再試行 (' + attempt + '/3)'); await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 90000 }); await new Promise((r) => setTimeout(r, 2500)); }
        await loginOnce(); ok = true;
      } catch (e) { lastErr = e; log('ログイン試行' + attempt + '失敗:', e.message); await new Promise((r) => setTimeout(r, 6000)); }
    }
    if (!ok) throw lastErr;

    const stores = (process.env.REPORT_STORES || '').trim();   // カンマ区切りで店舗を絞る（空=全店）
    const group = (process.env.REPORT_GROUP || '').trim();     // 画像ファイル名の識別子（例 tori）
    const dateOverride = (process.env.REPORT_DATE || '').trim(); // 過去の期間を指定して再送したい時（例 2026-06-15）。空=最新日
    await page.evaluate((k, dt, st, g) => { App.report(k, dt || '', st || null, g || ''); }, KIND, dateOverride, stores, group);
    await page.waitForSelector('#report-card', { timeout: 30000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    await new Promise((r) => setTimeout(r, 1200));

    const data = await page.evaluate(() => window.__REPORT_JSON);
    const el = await page.$('#report-card');
    await el.screenshot({ path: 'report.png' });
    fs.writeFileSync(META, JSON.stringify(data));
    log('保存: report.png / メタ:', data.title, data.sub, '/ fileKey:', data.fileKey);
  } finally { await browser.close(); }
}

// ---------- send: Larkカード（要約テキスト＋画像リンク） ----------
async function send() {
  if (!WEBHOOK) { console.error('LARK_WEBHOOK が未設定です'); process.exit(1); }
  const d = JSON.parse(fs.readFileSync(META, 'utf8'));
  const imageUrl = process.env.IMAGE_URL || '';
  const t = d.tot;
  const spend = t.guests > 0 ? t.sales / t.guests : 0;
  const single = d.singleStore || null;

  // 「日報」はWebhookのカスタムキーワード。ヘッダーにも入るが note でも必ず含める
  const frTxt = t.fr != null ? (t.fr * 100).toFixed(1) + '%' : '—';
  const lrTxt = t.lr != null ? (t.lr * 100).toFixed(1) + '%' : '—';
  const dnTxt = t.dinii != null ? t.dinii.toFixed(2) : '—';
  const headline = single ? `【${single} ${d.title}】${d.sub}` : `【${d.title}】${d.sub}`;
  const pctTxt = (v) => (v != null ? (v * 100).toFixed(1) + '%' : '—');
  const summary =
    `**${single ? '' : '全店'}${d.salesLabel} ${yen(t.sales)}**（前年比 ${yoy(t.sales, t.prevSales)}）\n` +
    `客数 ${cnt(t.guests)}人 ／ 客単価 ${yen(spend)} ／ F率 ${frTxt} ／ L率 ${lrTxt}` +
    (d.hasDinii ? `\nダイニー再来店 **${dnTxt}**（${d.diniiRangeLabel}・${cnt(t.diniiCount)}件）` : '') +
    (d.kind === 'monthly' ? '' : `\n累計売上（月間） ${yen(t.cum)}（前年比 ${yoy(t.cum, t.cumPrev)}）`) +
    (single && d.cumRate && d.kind !== 'monthly' ? `\n累計F率 ${pctTxt(d.cumRate.fr)} ／ 累計L率 ${pctTxt(d.cumRate.lr)}（月間）` : '') +
    (single && d.review ? `\nGoogle口コミ ★${d.review.star.toFixed(2)}（${cnt(d.review.count)}件）／ ${d.kind === 'monthly' ? '今月' : d.kind === 'weekly' ? '今週' : '本日'}${d.review.inc == null ? ' —' : (d.review.inc >= 0 ? ' +' : ' ') + d.review.inc + '件'}` : '') +
    (single ? '' : (() => {
      const up = d.rows.filter((r) => r.prevSales > 0 && r.sales >= r.prevSales).length;
      const down = d.rows.filter((r) => r.prevSales > 0 && r.sales < r.prevSales).length;
      return `\n<font color="green">前年超え ${up}店</font> ／ <font color="red">前年割れ ${down}店</font>`;
    })());

  // 単店舗＝ランチ/ディナー内訳＋媒体別トップ3、複数店舗＝店舗別トップ3
  let detailBlock, mediaBlock = '';
  if (single && d.seg && (d.seg.hasNet || d.seg.hasG)) {
    const segLine = (label, sales, prevSales, guests) => {
      const sp = guests > 0 ? sales / guests : 0;
      return `${label}　${yen(sales)}（前年比 ${yoy(sales, prevSales)}）／ 客数 ${cnt(guests)}人 ・ 客単価 ${yen(sp)}`;
    };
    detailBlock = `**ランチ/ディナー内訳**\n${segLine('🌤 ランチ', d.seg.ln, d.seg.prevLn, d.seg.lg)}\n${segLine('🌙 ディナー', d.seg.dn, d.seg.prevDn, d.seg.dg)}`;
  } else if (!single) {
    const medal = ['🥇', '🥈', '🥉'];
    const topLines = d.rows.filter((r) => r.sales > 0).slice(0, 3)
      .map((r, i) => `${medal[i] || '　'} **${r.store}**　${yen(r.sales)}（前年比 ${yoy(r.sales, r.prevSales)}）`).join('\n');
    detailBlock = `**店舗別トップ**\n${topLines}`;
  } else {
    detailBlock = '';
  }
  if (single && d.media && d.media.length) {
    const mTot = d.media.reduce((s, r) => s + r.sales, 0);
    const lines = d.media.slice(0, 3)
      .map((r) => `・${r.media}　${yen(r.sales)}${mTot > 0 ? `（${(r.sales / mTot * 100).toFixed(1)}%）` : ''}`).join('\n');
    mediaBlock = `**媒体別 売上トップ3**\n${lines}`;
  }

  const elements = [{ tag: 'markdown', content: summary }];
  if (detailBlock) elements.push({ tag: 'hr' }, { tag: 'markdown', content: detailBlock });
  if (mediaBlock) elements.push({ tag: 'markdown', content: mediaBlock });
  if (imageUrl) {
    elements.push({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: single ? `📊 ${single}の${d.title}画像を見る` : '📊 日報の全体画像を見る（全店）' }, type: 'primary', url: imageUrl }],
    });
  }
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `自動日報Bot ／ ダッシュボード: ${SITE_URL} ／ 生成 ${d.gen}` }] });

  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: headline }, template: d.kind === 'monthly' ? 'purple' : d.kind === 'weekly' ? 'green' : 'blue' },
    elements,
  };
  const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_type: 'interactive', card }) });
  const j = await r.json().catch(() => ({}));
  if (j.code !== 0 && j.StatusCode !== 0) throw new Error('Webhook送信失敗: ' + JSON.stringify(j));
  log('✓ カードを送信しました', imageUrl ? '（画像リンク付き）' : '（画像リンクなし）');
}

(async () => {
  if (MODE === 'capture') await capture();
  else if (MODE === 'send') await send();
  else { console.error('使い方: node lark-report.mjs capture | send'); process.exit(1); }
})().catch((e) => { console.error('[lark-report] 失敗:', e); process.exit(1); });
