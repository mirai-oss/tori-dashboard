#!/usr/bin/env node
/**
 * 日報カード（Slack 画像日報）生成・送信スクリプト（2026-11-05）
 *
 *   NStyle 日報データ(ハブ kd_*) → ViewModel(Edge Function daily-report-card: vm) → HTML テンプレート(このファイル)
 *   → Chromium(puppeteer-core) で PNG → Storage 保存(Edge Function: upload) → Slack 投稿(notify-slack・Block Kit)
 *
 * 使い方:
 *   node scripts/daily-report-card.mjs --store "鳥一代 本店" --date 2026-11-03 --channel keiei.report
 *   node scripts/daily-report-card.mjs --vm-file vm.json --out ./out --no-upload --no-send   … ローカル確認（HTML と PNG を書くだけ）
 *   node scripts/daily-report-card.mjs --store ... --date ... --html-only                      … HTML だけ書いてブラウザで見る
 *
 * 環境変数:
 *   NOTIFY_SLACK_SECRET  … Edge Function の合言葉（GitHub Secret）。vm/upload/send すべてこれで認証
 *   DAILY_REPORT_API     … 既定 https://uuvsxzhpxtghojoubjcc.supabase.co/functions/v1/daily-report-card
 *   NOTIFY_SLACK_URL     … 既定 https://uuvsxzhpxtghojoubjcc.supabase.co/functions/v1/notify-slack
 *   CHROME_PATH          … Chrome/Chromium の実行ファイル。未指定なら OS 別の既定を探す
 *   PORTAL_URL           … 「管理システムで詳細確認」ボタンの飛び先（既定: 経営ダッシュボード）
 *
 * 失敗したら exit 1（呼び出し側の workflow が従来の文章日報へフォールバックする）。画像生成 AI は使わない。
 * 画像側で独自の計算はしない（検算だけ）。数字の正本は ViewModel（＝管理システムと同じ表）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), (arr[i + 1] && !arr[i + 1].startsWith('--')) ? arr[i + 1] : true]);
  return a;
}, []));
const API = process.env.DAILY_REPORT_API || 'https://uuvsxzhpxtghojoubjcc.supabase.co/functions/v1/daily-report-card';
const SLACK_API = process.env.NOTIFY_SLACK_URL || 'https://uuvsxzhpxtghojoubjcc.supabase.co/functions/v1/notify-slack';
const SECRET = process.env.NOTIFY_SLACK_SECRET || '';
const PORTAL_URL = process.env.PORTAL_URL || 'https://mirai-oss.github.io/tori-dashboard/?tab=dash';
const OUT = args.out || '.';
const log = (...a) => console.log('[daily-report-card]', ...a);

// ---------- 1. ViewModel ----------
async function api(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-notify-secret': SECRET }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`daily-report-card ${body.action} 失敗: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
async function getVM() {
  if (args['vm-file']) return JSON.parse(fs.readFileSync(args['vm-file'], 'utf8'));
  if (!args.store || !args.date) throw new Error('--store と --date が必要です（または --vm-file）');
  if (!SECRET) throw new Error('NOTIFY_SLACK_SECRET が未設定です');
  const j = await api({ action: 'vm', store_name: args.store, date: args.date });
  return j.vm;
}

// ---------- 2. 検算・整形ルール（計算は作らない。矛盾の検出と表示の判断だけ） ----------
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const yen = (v) => (num(v) === null ? '—' : Math.round(num(v)).toLocaleString('ja-JP') + '円');
const cnt = (v) => (num(v) === null ? '—' : Math.round(num(v)).toLocaleString('ja-JP'));
const pct = (v, d = 1) => (num(v) === null ? '—' : (num(v) * 100).toFixed(d) + '%');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function normalize(vm) {
  const v = { ...vm };
  // 仕入・人件費が 0 のまま売上がある店（N-Style 4 店など＝データ未整備）は率を「—」にする
  if (num(v.sales_today) > 0 && !(num(v.cogs_today) > 0)) v.food_cost_ratio_today = null;
  if (num(v.sales_today) > 0 && !(num(v.labor_today) > 0)) v.labor_ratio_today = null;
  if (num(v.mtd_sales) > 0 && !(num(v.mtd_food_cost_ratio) > 0)) v.mtd_food_cost_ratio = null;
  if (num(v.mtd_sales) > 0 && !(num(v.mtd_labor_ratio) > 0)) v.mtd_labor_ratio = null;
  // ランチ/ディナー（明細ベース）は、両方そろい・合計が当日売上の ±1% 以内のときだけ出す
  const L = v.lunch, D = v.dinner, S = num(v.sales_today);
  v.show_ld = !!(L && D && S > 0 && Math.abs(num(L.sales) + num(D.sales) - S) <= S * 0.01);
  v.ld_note = v.show_ld ? '' : (D && !L ? 'ランチ営業なし／内訳は明細未整備のため省略' : '');
  return v;
}
function selfCheck(v) {
  const issues = [];
  const S = num(v.sales_today), G = num(v.guests_today);
  if (S !== null && G > 0 && num(v.avg_spend_today) !== null && Math.abs(S / G - num(v.avg_spend_today)) > 1) issues.push('客単価 ≠ 売上÷客数');
  if (v.show_ld && Math.abs(num(v.lunch.sales) + num(v.dinner.sales) - S) > S * 0.01) issues.push('ランチ+ディナー ≠ 当日売上');
  if (v.show_ld && num(v.lunch.guests) + num(v.dinner.guests) !== G) issues.push('客数合計が一致しない（明細ベース）');
  if (num(v.budget_today) > 0 && num(v.budget_ratio_today) !== null && Math.abs(S / num(v.budget_today) - num(v.budget_ratio_today)) > 0.0005) issues.push('予算比の再計算が一致しない');
  if (num(v.mtd_budget) > 0 && num(v.mtd_budget_ratio) !== null && Math.abs(num(v.mtd_sales) / num(v.mtd_budget) - num(v.mtd_budget_ratio)) > 0.0005) issues.push('月累計予算比が一致しない');
  if (num(v.cogs_today) > 0 && num(v.food_cost_ratio_today) !== null && Math.abs(num(v.cogs_today) / S - num(v.food_cost_ratio_today)) > 0.0005) issues.push('原価率が一致しない');
  if (num(v.labor_today) > 0 && num(v.labor_ratio_today) !== null && Math.abs(num(v.labor_today) / S - num(v.labor_ratio_today)) > 0.0005) issues.push('人件費率が一致しない');
  return issues;
}
// 本日のポイント: 優先 1.大きな異常 2.目標超過 3.売上未達 4.原価異常 5.良い点 ／ 最大 2 件
function alerts(v) {
  const out = [];
  const lr = num(v.labor_ratio_today), tl = num(v.target_labor_rate);
  const fr = num(v.food_cost_ratio_today), tf = num(v.target_food_cost_rate);
  const br = num(v.budget_ratio_today), yr = num(v.yoy_same_weekday_ratio);
  if (lr !== null && tl !== null && lr - tl >= 0.10) out.push({ lv: 'bad', t: `人件費率 ${pct(lr)} が目標 ${pct(tl)} を大きく超過（+${((lr - tl) * 100).toFixed(1)}pt）` });
  if (fr !== null && tf !== null && fr - tf >= 0.10) out.push({ lv: 'bad', t: `原価率 ${pct(fr)} が目標 ${pct(tf)} を大きく超過（+${((fr - tf) * 100).toFixed(1)}pt）` });
  if (lr !== null && tl !== null && lr > tl && lr - tl < 0.10) out.push({ lv: 'warn', t: `人件費率が目標（${pct(tl)}）を +${((lr - tl) * 100).toFixed(1)}pt 超過` });
  if (br !== null && br < 1) out.push({ lv: 'warn', t: `売上は予算比 ${pct(br)}（未達 ${yen(num(v.budget_today) - num(v.sales_today))}）` });
  if (fr !== null && tf !== null && fr > tf && fr - tf < 0.10) out.push({ lv: 'warn', t: `原価率が目標（${pct(tf)}）を +${((fr - tf) * 100).toFixed(1)}pt 超過` });
  const good = [];
  if (br !== null && br >= 1) good.push(`予算比 ${pct(br)}`);
  if (yr !== null && yr >= 1) good.push(`前年同曜日比 ${pct(yr)}`);
  if (good.length) out.push({ lv: 'good', t: `売上は ${good.join('、')} と好調` });
  if (!out.length && yr !== null && yr < 0.9) out.push({ lv: 'warn', t: `前年同曜日比 ${pct(yr)}（前年を下回っています）` });
  return out.slice(0, 2);
}

// ---------- 3. HTML テンプレート（白ベース・色は 緑=良い/赤=悪い/オレンジ=注意/青=ディナー/黄=ランチ） ----------
function buildHtml(v) {
  const d = new Date(v.date + 'T00:00:00+09:00');
  const dateJa = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${v.weekday_ja}）`;
  const cls = (val, good, bad) => (val === null ? 'na' : val >= good ? 'good' : val < bad ? 'bad' : 'warn');
  const br = num(v.budget_ratio_today), yr = num(v.yoy_same_weekday_ratio);
  const lr = num(v.labor_ratio_today), fr = num(v.food_cost_ratio_today), tl = num(v.target_labor_rate), tf = num(v.target_food_cost_rate);
  const rateCls = (r, t) => (r === null ? 'na' : t === null ? 'neutral' : r <= t ? 'good' : r - t < 0.03 ? 'warn' : 'bad');
  const al = alerts(v);
  const mtdFrom = v.mtd_from ? `${new Date(v.mtd_from + 'T00:00:00+09:00').getMonth() + 1}/${new Date(v.mtd_from + 'T00:00:00+09:00').getDate()}` : '';
  const mtdTo = `${d.getMonth() + 1}/${d.getDate()}`;
  const ldBlock = v.show_ld ? `
  <section class="row2">
    <div class="card lunch"><div class="ttl"><span class="ic sun">☀</span>ランチ</div>
      <div class="big">${yen(v.lunch.sales)}</div>
      <div class="sub"><span>客数 <b>${cnt(v.lunch.guests)}名</b></span><span>客単価 <b>${yen(v.lunch.avg_spend)}</b></span></div></div>
    <div class="card dinner"><div class="ttl"><span class="ic moon">☾</span>ディナー</div>
      <div class="big">${yen(v.dinner.sales)}</div>
      <div class="sub"><span>客数 <b>${cnt(v.dinner.guests)}名</b></span><span>客単価 <b>${yen(v.dinner.avg_spend)}</b></span></div></div>
  </section>` : (v.ld_note ? `<section class="note">${esc(v.ld_note)}</section>` : '');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=1080">
<title>${esc(v.store_name)} 日報 ${esc(v.date)}</title>
<style>
  :root{--navy:#1f2f4d;--ink:#1a1a1a;--gray:#5b6470;--line:#e6e9ef;--bg:#f3f5f9;--good:#1a8f3c;--bad:#d9342b;--warn:#e07b00;--blue:#2b5fb8;--yellow:#f6b100;--orange:#f05a1a}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1080px;background:var(--bg);color:var(--ink);font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans CJK JP","Noto Sans JP","Yu Gothic",sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{width:1080px;padding:0 0 36px}
  header{background:linear-gradient(90deg,#1f2f4d,#2a4470);color:#fff;padding:30px 40px;display:flex;align-items:center;justify-content:space-between}
  header .store{font-size:44px;font-weight:800;letter-spacing:1px}
  header .store small{display:block;font-size:16px;font-weight:600;opacity:.75;letter-spacing:3px;margin-top:4px}
  header .rep{text-align:right}
  header .rep .t{font-size:30px;font-weight:800}
  header .rep .t em{font-style:normal;font-size:20px;margin-left:10px;opacity:.9}
  header .rep .d{display:inline-block;margin-top:10px;background:rgba(255,255,255,.14);border-radius:12px;padding:8px 16px;font-size:22px;font-weight:700}
  section{margin:22px 40px 0}
  .card{background:#fff;border-radius:22px;padding:26px 30px;box-shadow:0 2px 10px rgba(20,30,60,.06)}
  .ttl{font-size:26px;font-weight:800;display:flex;align-items:center;gap:12px}
  .ic{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;background:#eef1f7;font-size:22px;font-weight:900;color:#1f2f4d;font-family:"Hiragino Sans","Noto Sans CJK JP",sans-serif}
  .ic.coin{background:#fff1d6}.ic.sun{background:#fff3c4}.ic.moon{background:#dfe8fb}.ic.kpi{background:#e3e9f5}.ic.cal{background:#e3e9f5}.ic.alert{background:#ffe3e0}
  .sales{display:flex;gap:24px;align-items:stretch}
  .sales .main{flex:1}
  .sales .main .num{font-size:92px;font-weight:900;color:var(--orange);letter-spacing:-1px;line-height:1.1;margin-top:10px}
  .sales .main .num small{font-size:40px;margin-left:4px}
  .sales .side{width:400px;display:flex;flex-direction:column;gap:14px;justify-content:center}
  .kv{display:flex;justify-content:space-between;align-items:center;background:#f6f8fb;border:1px solid var(--line);border-radius:16px;padding:16px 20px;font-size:24px;font-weight:700;color:var(--gray)}
  .kv b{font-size:34px;font-weight:900}
  .good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.na{color:#9aa3ad}.neutral{color:var(--ink)}
  .row2{display:flex;gap:22px}
  .row2 .card{flex:1}
  .card.lunch{background:#fff9e6}.card.dinner{background:#eaf1fc}
  .row2 .big{font-size:60px;font-weight:900;color:var(--orange);margin:10px 0 12px}
  .row2 .sub{display:flex;gap:18px;font-size:22px;color:var(--gray);background:rgba(255,255,255,.7);border-radius:14px;padding:12px 16px}
  .row2 .sub b{color:var(--ink);font-size:26px;margin-left:6px}
  .note{color:var(--gray);font-size:18px;padding:0 6px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:18px}
  .kpi{background:#f6f8fb;border-radius:16px;padding:18px 14px;text-align:center}
  .kpi .l{font-size:20px;color:var(--gray);font-weight:700}
  .kpi .v{font-size:44px;font-weight:900;margin-top:6px}
  .kpi .t{font-size:17px;color:var(--gray);margin-top:4px}
  .mtd{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr 1fr;gap:10px;margin-top:18px}
  .mtd .cell{padding:8px 10px;border-left:1px solid var(--line)}
  .mtd .cell:first-child{border-left:0;padding-left:0}
  .mtd .l{font-size:19px;color:var(--gray);font-weight:700}
  .mtd .v{font-size:34px;font-weight:900;margin-top:6px;white-space:nowrap;letter-spacing:-0.5px}
  .mtd .v.sm{font-size:30px}
  .mtd .t{font-size:16px;color:var(--gray);margin-top:4px}
  .badge{display:inline-block;margin-top:8px;padding:6px 12px;border-radius:10px;font-size:20px;font-weight:800;background:#e7f6ec;color:var(--good)}
  .badge.bad{background:#fde9e7;color:var(--bad)}.badge.warn{background:#fff1e0;color:var(--warn)}.badge.na{background:#eef1f5;color:#9aa3ad}
  .points{background:#fff4f2;border:1px solid #ffd9d4}
  .points ul{list-style:none;margin-top:14px;display:flex;flex-direction:column;gap:10px}
  .points li{font-size:24px;font-weight:700;display:flex;gap:12px;align-items:flex-start}
  .points li .dot{flex:none;width:18px;height:18px;border-radius:50%;margin-top:9px}
  .dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}.dot.good{background:var(--good)}
  .points li .tag{font-size:18px;font-weight:800;border-radius:8px;padding:2px 8px;margin-right:4px}
  .tag.bad{background:#fde9e7;color:var(--bad)}.tag.warn{background:#fff1e0;color:var(--warn)}.tag.good{background:#e7f6ec;color:var(--good)}
  footer{margin:24px 40px 0;background:var(--navy);color:#fff;border-radius:18px;padding:22px;text-align:center;font-size:28px;font-weight:800}
  .gen{margin:14px 40px 0;color:#9aa3ad;font-size:15px;text-align:right}
</style></head><body><div class="wrap">
<header>
  <div class="store">${esc(v.store_name)}<small>N-STYLE GROUP</small></div>
  <div class="rep"><div class="t">Daily Report<em>日報</em></div><div class="d">${dateJa}</div></div>
</header>

<section class="card sales">
  <div class="main"><div class="ttl"><span class="ic coin">¥</span>本日の売上</div>
    <div class="num">${num(v.sales_today) === null ? '<span class="na">—</span>' : Math.round(num(v.sales_today)).toLocaleString('ja-JP') + '<small>円</small>'}</div></div>
  <div class="side">
    <div class="kv"><span>予算比</span><b class="${cls(br, 1, 0.9)}">${pct(br)}</b></div>
    <div class="kv"><span>前年同曜日比</span><b class="${cls(yr, 1, 0.9)}">${pct(yr)}</b></div>
  </div>
</section>
${ldBlock}
<section class="card">
  <div class="ttl"><span class="ic kpi">▮</span>本日のKPI</div>
  <div class="kpis">
    <div class="kpi"><div class="l">客数</div><div class="v good">${cnt(v.guests_today)}<span style="font-size:22px">名</span></div></div>
    <div class="kpi"><div class="l">客単価</div><div class="v good">${num(v.avg_spend_today) === null ? '—' : Math.round(num(v.avg_spend_today)).toLocaleString('ja-JP') + '<span style="font-size:22px">円</span>'}</div></div>
    <div class="kpi"><div class="l">人件費率</div><div class="v ${rateCls(lr, tl)}">${pct(lr)}</div><div class="t">${tl === null ? '目標 未設定' : '（目標 ' + pct(tl) + '）'}</div></div>
    <div class="kpi"><div class="l">原価率</div><div class="v ${rateCls(fr, tf)}">${pct(fr)}</div><div class="t">${tf === null ? '目標 未設定' : '（目標 ' + pct(tf) + '）'}</div></div>
  </div>
</section>

<section class="card">
  <div class="ttl"><span class="ic cal">▦</span>今月累計 <span style="font-size:20px;color:var(--gray);font-weight:700;margin-left:6px">（${mtdFrom}〜${mtdTo}）</span></div>
  <div class="mtd">
    <div class="cell"><div class="l">売上</div><div class="v">${yen(v.mtd_sales)}</div>
      <div class="t">${num(v.mtd_budget) === null ? '予算 未設定' : '（予算 ' + yen(v.mtd_budget) + '）'}</div>
      <div class="badge ${cls(num(v.mtd_budget_ratio), 1, 0.9)}">予算比 ${pct(v.mtd_budget_ratio)}</div></div>
    <div class="cell"><div class="l">人件費率</div><div class="v sm ${rateCls(num(v.mtd_labor_ratio), tl)}">${pct(v.mtd_labor_ratio)}</div><div class="t">${tl === null ? '目標 未設定' : '（目標 ' + pct(tl) + '）'}</div></div>
    <div class="cell"><div class="l">原価率</div><div class="v sm ${rateCls(num(v.mtd_food_cost_ratio), tf)}">${pct(v.mtd_food_cost_ratio)}</div><div class="t">${tf === null ? '目標 未設定' : '（目標 ' + pct(tf) + '）'}</div></div>
    <div class="cell"><div class="l">口コミ件数</div><div class="v sm ${num(v.mtd_review_count) === null ? 'na' : ''}">${num(v.mtd_review_count) === null ? '—' : cnt(v.mtd_review_count) + '件'}</div><div class="t">（当月累計）</div></div>
    <div class="cell"><div class="l">ダイニー点数</div><div class="v sm ${num(v.mtd_dinii_score) === null ? 'na' : ''}">${num(v.mtd_dinii_score) === null ? '—' : num(v.mtd_dinii_score)}</div><div class="t">${num(v.target_dinii) === null ? '（当月最新）' : '（目標 ' + num(v.target_dinii) + '）'}</div></div>
  </div>
</section>

<section class="card points">
  <div class="ttl"><span class="ic alert" style="color:#d9342b">!</span>本日のポイント</div>
  <ul>${al.length ? al.map((a) => `<li><span class="dot ${a.lv}"></span><span><span class="tag ${a.lv}">${a.lv === 'bad' ? '要確認' : a.lv === 'warn' ? '注意' : '良い'}</span>${esc(a.t)}</span></li>`).join('') : '<li><span class="dot good"></span><span>特記事項なし</span></li>'}</ul>
</section>

<footer>管理システムで詳細確認 ↗</footer>
<div class="gen">生成 ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　正本: 経営ダッシュボード日次集計</div>
</div></body></html>`;
}

// ---------- 4. PNG 描画（Chromium・画像生成 AI は使わない） ----------
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cands = os.platform() === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  return cands.find((p) => fs.existsSync(p)) || null;
}
async function renderPng(html, outPng) {
  const { default: puppeteer } = await import('puppeteer-core');
  const exe = chromePath();
  if (!exe) throw new Error('Chrome が見つかりません（CHROME_PATH を指定）');
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--hide-scrollbars'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1200, deviceScaleFactor: 2 }); // Retina 相当（実寸 2160px 幅）
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$('.wrap');
    await el.screenshot({ path: outPng, type: 'png' });
  } finally { await browser.close(); }
}

// ---------- 5. 保存と Slack 投稿 ----------
function slackBlocks(v, imageUrl) {
  const d = new Date(v.date + 'T00:00:00+09:00');
  const title = `📊 ${d.getMonth() + 1}/${d.getDate()} ${v.store_name} 日報`;
  return {
    text: `${title}（画像が表示されない場合はこちら: ${imageUrl}）`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      { type: 'image', image_url: imageUrl, alt_text: `${v.store_name} ${v.date} 日報` },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '管理システムで詳細確認', emoji: true }, url: PORTAL_URL, action_id: 'report.card.open' }] },
    ],
  };
}

(async () => {
  const raw = await getVM();
  const v = normalize(raw);
  if (!v.has_data) throw new Error(`${v.store_name} ${v.date} の日次データがありません`);
  const issues = selfCheck(v);
  if (issues.length) throw new Error('検算エラー: ' + issues.join(' / '));
  const key = (v.file_key || ('store_' + v.store_no)).replace(/[^a-zA-Z0-9_-]/g, '');
  fs.mkdirSync(OUT, { recursive: true });
  const html = buildHtml(v);
  const htmlPath = path.join(OUT, `daily-report-${key}-${v.date}.html`);
  fs.writeFileSync(htmlPath, html);
  log('HTML:', htmlPath);
  if (args['html-only']) return;
  const pngPath = path.join(OUT, `daily-report-${key}-${v.date}.png`);
  await renderPng(html, pngPath);
  log('PNG:', pngPath, fs.statSync(pngPath).size, 'bytes');

  let url = null;
  if (!args['no-upload']) {
    const up = await api({ action: 'upload', date: v.date, store_key: key, png_base64: fs.readFileSync(pngPath).toString('base64') });
    url = up.url; log('Storage:', up.path, '→', url);
  }
  if (!args['no-send']) {
    if (!url) throw new Error('--no-upload のときは送信できません');
    const channel = args.channel || process.env.SLACK_CHANNEL_KEY;
    if (!channel) throw new Error('--channel か SLACK_CHANNEL_KEY が必要です');
    const { text, blocks } = slackBlocks(v, url);
    const body = {
      action: 'send', channel_key: channel, text, blocks,
      source: 'tori-dashboard', event: 'report_daily_card',
      dedupe_key: `report_daily_card:${v.date}:${channel}:${v.store_name}` + (process.env.REPORT_DEDUPE_SUFFIX || ''),
      username: '経営日報', icon_emoji: ':bar_chart:',
      ref: { table: 'daily_report_card', id: `${v.store_no}:${v.date}` },
    };
    const r = await fetch(SLACK_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-notify-secret': SECRET }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error('Slack送信失敗: HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
    log(`✓ Slack ${channel} / ${j.status} / notification_id=${j.notification_id}`);
  }
  console.log(JSON.stringify({ ok: true, store: v.store_name, date: v.date, image_url: url, alerts: alerts(v).map((a) => a.t) }));
})().catch((e) => { console.error('[daily-report-card] 失敗:', e.message || e); process.exit(1); });
