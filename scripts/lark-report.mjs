/**
 * 鳥一代グループ ダッシュボード → Lark/Chatwork 自動日報/週報/月報
 * =====================================================================
 * サブコマンド:
 *   node scripts/lark-report.mjs capture     … ブラウザでログイン→カード撮影→ report.png + report-meta.json 出力
 *   node scripts/lark-report.mjs capture-bq  … ブラウザ操作なし。GAS(reportDataBQ)から数字だけ取得して
 *                                                report-meta.json のみ出力（report.pngは作らない）。
 *                                                2026-08-23追加。媒体別日次の肥大化でcaptureがGASの
 *                                                データ読込待ちに詰まる問題への根本対応（ログイン・
 *                                                画面描画・スクリーンショットを一切使わない）。
 *                                                ランチ/ディナー内訳・Google口コミは無し（buildText側が
 *                                                無くても正常動作する設計）。画像が無いのでLarkは画像
 *                                                リンク無し・Chatworkはテキストのみで送られる（sendは
 *                                                report.png有無を見て自動でその挙動になるため変更不要）。
 *   node scripts/lark-report.mjs send        … report-meta.json から配信先へ送信（CHANNEL_KINDで切替）
 *
 * GitHub Actions では capture(-bq) → (Larkかつ画像ありのみ)画像をReleaseにアップロード → send の順で実行する。
 * Lark: 「要約テキスト＋画像リンクボタン」のカード（Larkのボット機能不要）。
 * Chatwork: 要約テキストをメッセージ送信＋report.pngをそのままファイル添付（Day6③）。
 *
 * 環境変数:
 *   DASH_ID / DASH_PW  : ダッシュボードのログイン（captureのみ）
 *   BQ_LOAD_TOKEN      : GAS reportDataBQ の専用トークン認証（capture-bqのみ）
 *   GAS_URL            : GASウェブアプリのURL（capture-bqのみ。省略時は本番URLを既定値として使用）
 *   REPORT_KIND        : daily | weekly | monthly
 *   SITE_URL           : 省略時 https://mirai-oss.github.io/tori-dashboard/
 *   CHANNEL_KIND        : lark（既定） | chatwork
 *   LARK_WEBHOOK        : kind=larkのとき。Larkカスタムボットの Webhook URL
 *   IMAGE_URL           : kind=larkのsend時、公開された日報画像のURL（capture後にActionsが渡す）
 *   CHATWORK_TOKEN       : kind=chatworkのとき。Chatwork APIトークン（X-ChatWorkToken）
 *   CHATWORK_ROOM_ID     : kind=chatworkのとき。送信先ルームID
 */
import fs from 'node:fs';

const MODE = (process.argv[2] || 'send').trim();
const SITE_URL = process.env.SITE_URL || 'https://mirai-oss.github.io/tori-dashboard/';
const GAS_URL = process.env.GAS_URL || 'https://script.google.com/macros/s/AKfycbz9rd37EZa6X8WRMVEBrXobN8DbYWkHRlhFNYU5rd1UZ0V8j0-6shMQjEeoi4HDWZ0B/exec';
const KIND = (process.env.REPORT_KIND || 'daily').trim();
const CHANNEL_KIND = (process.env.CHANNEL_KIND || 'lark').trim();
const WEBHOOK = process.env.LARK_WEBHOOK || '';
const META = 'report-meta.json';
const IMAGE_PATH = 'report.png';

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
  // protocolTimeout未指定だとPuppeteerの既定値(180000ms=3分)が、下のDATA_WAIT(4分)より先に
  // 効いてしまい「Runtime.callFunctionOn timed out」で強制終了する（2026-08-22の本番テストで実際に発生・原因判明）。
  // DATA_WAITより長い値にしておく。
  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 300000, args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--lang=ja-JP'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1800, deviceScaleFactor: 2 });
    await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    const DATA_WAIT = 240000;   // データ読込待ち（GAS混雑時は3分を超えることがあるため4分まで許容）

    const loginOnce = async () => {
      // 【重要】1回目のログイン後にセッションが残るため、再読み込みすると「ログイン済み」で開き
      //   ログインフォーム(#li-id)は現れない。以前はここを待ち続けて全リトライが空振りしていた。
      //   → 「フォームが出る」か「既にログイン済み」かを競争させ、済みならログイン手順を飛ばす。
      let mode;
      try {
        mode = await Promise.race([
          page.waitForSelector('#li-id', { timeout: 90000 }).then(() => 'form'),
          page.waitForFunction(() => typeof S !== 'undefined' && S.auth, { timeout: 90000, polling: 1000 }).then(() => 'already'),
        ]);
      } catch (e) {
        const st = await page.evaluate(() => ({
          url: location.href, title: document.title, ready: document.readyState,
          hasLoginBox: !!document.querySelector('#li-id, #li-pw, .login-err'),
          bodyHead: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 200),
        })).catch(() => ({ url: 'evaluate失敗' }));
        log('ログインフォームも認証済み状態も検出できない。ページ状態:', JSON.stringify(st));
        throw e;
      }

      if (mode === 'form') {
        await page.$eval('#li-id', (el) => { el.value = ''; });
        await page.$eval('#li-pw', (el) => { el.value = ''; });
        await page.type('#li-id', DASH_ID);
        await page.type('#li-pw', DASH_PW);
        await page.click('#li-btn');
        log('ログイン送信、データ読込待ち…');
      } else {
        log('既にログイン済み（セッション復元）→ ログイン手順を飛ばしてデータ読込待ち…');
      }
      // ログイン成功の判定は daily（軽い）だけを条件にする。以前は媒体別(D.media)の
      // 裏読み完了(mediaPending===false)まで一緒に待っていたが、2026-08-22時点で
      // 媒体別日次シートが21,000件超まで育ち、GAS側の読込がDATA_WAIT(4分)を超えて
      // 終わらないことがあり、ログインごとリトライが空振りして自動配信全体が
      // 止まる不具合が発生した（本番テストで確認済み）。ログイン自体は daily が
      // 届いた時点で成功とみなし、媒体別は下のMEDIA_WAITで別枠・短めに待つ
      // （間に合わなければ空のまま撮影を続行＝レポートの一部欄が空くのを許容し、
      // 配信全体が止まる方を避ける）。
      await Promise.race([
        page.waitForFunction(() => typeof S !== 'undefined' && S.auth && S.connState === 'live' && typeof D !== 'undefined' && D.daily.length > 0, { timeout: DATA_WAIT, polling: 2000 }),
        page.waitForFunction(() => { const el = document.querySelector('.login-err'); return el && el.textContent.length > 0 ? el.textContent : false; }, { timeout: DATA_WAIT, polling: 2000 })
          .then(async (h) => { throw new Error('ログイン失敗: ' + (await h.jsonValue())); }),
      ]);
      const MEDIA_WAIT = 90000;   // 媒体別データの別枠待ち（ここで詰まっても配信全体は止めない）
      try {
        await page.waitForFunction(() => typeof D !== 'undefined' && D.mediaPending === false, { timeout: MEDIA_WAIT, polling: 2000 });
      } catch (e) {
        log('媒体別データの読込がMEDIA_WAIT(' + MEDIA_WAIT + 'ms)内に終わらなかったため、空のまま続行します（ランチ/ディナー内訳・媒体別売上が空欄になる可能性）');
      }
    };
    // 混雑時の一時的な遅延に耐えるため4回まで試し、待ち時間を段階的に伸ばす（6s→15s→30s）
    const MAX_LOGIN_TRY = 4;
    const BACKOFF = [6000, 15000, 30000];
    let ok = false, lastErr;
    for (let attempt = 1; attempt <= MAX_LOGIN_TRY && !ok; attempt++) {
      try {
        if (attempt > 1) { log('再読み込みして再試行 (' + attempt + '/' + MAX_LOGIN_TRY + ')'); await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 90000 }); await new Promise((r) => setTimeout(r, 2500)); }
        await loginOnce(); ok = true;
      } catch (e) {
        lastErr = e; log('ログイン試行' + attempt + '失敗:', e.message);
        if (attempt < MAX_LOGIN_TRY) await new Promise((r) => setTimeout(r, BACKOFF[attempt - 1] || 30000));
      }
    }
    if (!ok) throw lastErr;

    const stores = (process.env.REPORT_STORES || '').trim();   // カンマ区切りで店舗を絞る（空=全店）
    const group = (process.env.REPORT_GROUP || '').trim();     // 画像ファイル名の識別子（例 tori）
    const dateOverride = (process.env.REPORT_DATE || '').trim(); // 過去の期間を指定して再送したい時（例 2026-06-15）。空=最新日

    // 2026-08-22追加（データ基盤ロードマップDay5「Lark新経路」）: データ元をBigQueryに切替えて撮影する。
    // 推移分析タブのトグル(S.useBqDaily)と全く同じ仕組みで、reportData()が使うD.dailyもBQ経由になる。
    // group1だけで先行検証→画像崩れが無ければ他グループにも展開する運用（workflow側のmatrix.useBqで制御）。
    if ((process.env.REPORT_USE_BQ || '').trim() === '1') {
      log('BigQueryモードに切替中…');
      await page.evaluate(() => App.setDailySource('bq'));
      await page.waitForFunction(
        () => typeof D !== 'undefined' && D.daily.length > 0 && D.dailyBqLoading === false,
        { timeout: DATA_WAIT, polling: 2000 },
      );
      log('BigQueryモードでのデータ取得完了');
    }

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

// ---------- capture-bq: ブラウザ操作なし。GASの軽量アクションから数字だけ取得（2026-08-23追加） ----------
async function captureBQ() {
  const token = process.env.BQ_LOAD_TOKEN || '';
  if (!token) { console.error('BQ_LOAD_TOKEN が未設定です'); process.exit(1); }
  const stores = (process.env.REPORT_STORES || '').trim();   // カンマ区切りで店舗を絞る（空=全店）
  const dateOverride = (process.env.REPORT_DATE || '').trim(); // 過去日を指定して再送したい時（例 2026-06-15）。空=最新日
  const qs = new URLSearchParams({ action: 'reportDataBQ', token, kind: KIND });
  if (stores) qs.set('stores', stores);
  if (dateOverride) qs.set('date', dateOverride);
  log('BigQueryから数値を取得中… kind =', KIND, stores ? ('store = ' + stores) : '（全店）');
  const res = await fetch(GAS_URL + '?' + qs.toString());
  if (!res.ok) throw new Error('GAS応答エラー: HTTP ' + res.status);
  const data = await res.json();
  if (!data || !data.ok) throw new Error('reportDataBQ失敗: ' + (data && data.error));
  data.gen = new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  fs.writeFileSync(META, JSON.stringify(data));
  log('保存: report-meta.json（画像なし・数値のみ）/ メタ:', data.title, data.sub, '/ fileKey:', data.fileKey);
}

// ---------- 要約テキスト組み立て（Lark/Chatwork共通） ----------
function buildText(d) {
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
  return { headline, summary, detailBlock, mediaBlock, single };
}

// ---------- send: Larkカード（要約テキスト＋画像リンク） ----------
async function sendLark(d) {
  if (!WEBHOOK) { console.error('LARK_WEBHOOK が未設定です'); process.exit(1); }
  const imageUrl = process.env.IMAGE_URL || '';
  const { headline, summary, detailBlock, mediaBlock, single } = buildText(d);

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
  log('✓ Larkカードを送信しました', imageUrl ? '（画像リンク付き）' : '（画像リンクなし）');
}

// ---------- send: Chatworkメッセージ＋画像添付（Day6③。GitHub Releaseを経由せず直接添付できる） ----------
// Larkのmarkdown記法（**太字**・<font color>）はChatworkに無いのでプレーンテキストへ整形する。
const stripMd = (s) => String(s || '').replace(/\*\*/g, '').replace(/<font[^>]*>/g, '').replace(/<\/font>/g, '');
async function sendChatwork(d) {
  const token = process.env.CHATWORK_TOKEN || '';
  const room = process.env.CHATWORK_ROOM_ID || '';
  if (!token || !room) { console.error('CHATWORK_TOKEN / CHATWORK_ROOM_ID が未設定です'); process.exit(1); }
  const { headline, summary, detailBlock, mediaBlock } = buildText(d);
  const text = [headline, '', stripMd(summary), detailBlock ? stripMd(detailBlock) : '', mediaBlock ? stripMd(mediaBlock) : '',
    '', `自動日報Bot ／ ダッシュボード: ${SITE_URL} ／ 生成 ${d.gen}`].filter((s) => s !== '').join('\n');

  const mRes = await fetch(`https://api.chatwork.com/v2/rooms/${room}/messages`, {
    method: 'POST',
    headers: { 'X-ChatWorkToken': token, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ body: text, self_unread: '1' }).toString(),
  });
  if (!mRes.ok) throw new Error('Chatworkメッセージ送信失敗: HTTP ' + mRes.status + ' ' + (await mRes.text()).slice(0, 300));
  log('✓ Chatworkメッセージを送信しました');

  if (fs.existsSync(IMAGE_PATH)) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(IMAGE_PATH)], { type: 'image/png' }), (d.fileKey || 'report') + '.png');
    const fRes = await fetch(`https://api.chatwork.com/v2/rooms/${room}/files`, {
      method: 'POST',
      headers: { 'X-ChatWorkToken': token },
      body: form,
    });
    if (!fRes.ok) throw new Error('Chatwork画像添付失敗: HTTP ' + fRes.status + ' ' + (await fRes.text()).slice(0, 300));
    log('✓ Chatworkへ画像を添付しました');
  } else {
    log('report.png が無いため画像添付はスキップしました');
  }
}

async function send() {
  const d = JSON.parse(fs.readFileSync(META, 'utf8'));
  if (CHANNEL_KIND === 'chatwork') await sendChatwork(d);
  else await sendLark(d);
}

(async () => {
  if (MODE === 'capture') await capture();
  else if (MODE === 'capture-bq') await captureBQ();
  else if (MODE === 'send') await send();
  else { console.error('使い方: node lark-report.mjs capture | capture-bq | send'); process.exit(1); }
})().catch((e) => { console.error('[lark-report] 失敗:', e); process.exit(1); });
