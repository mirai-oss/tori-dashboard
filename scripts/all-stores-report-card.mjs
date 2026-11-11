#!/usr/bin/env node
/**
 * 全12店舗 日報（Slack 自動配信・TK-255）— 日次画像＋月次累計画像の生成と投稿（2026-11-11）
 *
 *   データ: Edge Function daily-report-card の action=all_stores（RPC all_stores_report_vm＝店舗別日報と同じ daily_report_card_vm を12店分）
 *   画像  : HTML → Chromium(puppeteer-core) → PNG（日次1枚・月次累計1枚）。画像生成AIは使わない。デザインは確定デザイン（紺・白カード2枚）。
 *   投稿  : 親＝「MM/DD 全店舗 日報／✅ 直営N/8店舗 配信成功」＋日次画像、スレッド返信＝月次累計画像（notify-slack・thread_ts）。
 *   数字  : 全店舗専用の別計算は作らない（合計・累計は店舗別の金額の合算のみ）。直営8店は店舗別日報の VM と再照合し、1件でも不一致・検算NGなら送らず exit 2。
 *   重複  : dedupe_key=all_stores_report:<日付>:parent / :monthly。同日の再実行は duplicate（親の ts を使ってスレッドも重複しない）。
 *
 * 使い方: node scripts/all-stores-report-card.mjs --date 2026-11-10 --channel report.all-stores [--test] [--no-send] [--out ./out] [--data-file data.json]
 * 環境変数: NOTIFY_SLACK_SECRET / DAILY_REPORT_API / NOTIFY_SLACK_URL / CHROME_PATH / REPORT_DEDUPE_SUFFIX（再送時のみ）
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
const SUFFIX = process.env.REPORT_DEDUPE_SUFFIX || '';
const log = (...a) => console.log('[all-stores-report]', ...a);

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
const md = (s) => { const t = ymd(s); return t ? `${t.m}/${t.d}` : ''; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (v, d = 1) => (num(v) === null ? '—' : (num(v) * 100).toFixed(d) + '%');
const yenS = (n) => (num(n) === null ? '—' : '¥' + Math.round(num(n)).toLocaleString('ja-JP'));
const cnt = (n) => (num(n) === null ? '—' : Math.round(num(n)).toLocaleString('ja-JP'));

async function api(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-notify-secret': SECRET }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`daily-report-card ${body.action} 失敗: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

// ---------- 行モデル（計算は作らない。VM のキーを選ぶ・null 化ルールは店舗別日報(normalize)と同じ） ----------
const GRADE = {
  excellent: { label: '優秀', cls: 'g-ex' }, normal: { label: '普通', cls: 'g-no' },
  warn: { label: '要改善', cls: 'g-wa' }, danger: { label: '危険水準', cls: 'g-da' },
};
const ratingOf = (vm) => (vm.ratings && vm.ratings.fl) || {};
const gradeOf = (vm) => GRADE[ratingOf(vm).grade] || null;   // 基準未設定(unset)・保留(hold)は非表示

function dailyRow(s) {
  const v = s.vm, S = num(v.sales_today);
  const open = !!v.has_data && S > 0;
  const B = v.breakdown, show = !!(B && B.status === 'ok' && num(B.total) !== null);
  let lr = num(v.labor_ratio_today), fr = num(v.food_cost_ratio_today), fl = num(v.fl_ratio_today);
  if (S > 0 && !(num(v.labor_today) > 0)) lr = null;
  if (S > 0 && !(num(v.cogs_today) > 0)) fr = null;
  if (fr === null || lr === null) fl = null;
  return {
    name: s.store_name, consigned: s.consigned, open,
    sales: open ? S : null,
    lunch: open && show ? (B.has_lunch ? num(B.lunch) : null) : null, dinner: open && show ? num(B.dinner) : null,
    budget: open ? num(v.budget_ratio_today) : null,
    yoy: open && v.ly_found && num(v.ly_sales) > 0 ? num(v.yoy_same_week_ratio) : null,
    guests: open ? num(v.guests_today) : null, avg: open ? num(v.avg_spend_today) : null,
    labor: open ? lr : null, food: open ? fr : null, fl: open ? fl : null,
    review: open ? num(v.google_review_day_increase) : null,
    grade: gradeOf(v), rating: ratingOf(v), targetLabor: num(v.target_labor_rate),
  };
}
function monthlyRow(s) {
  const v = s.vm, m = s.mtd, S = num(v.mtd_sales);
  const open = S > 0;
  let lr = num(v.mtd_labor_ratio), fr = num(v.mtd_food_cost_ratio), fl = num(v.mtd_fl_ratio);
  if (S > 0 && !(lr > 0)) lr = null;
  if (S > 0 && !(fr > 0)) fr = null;
  if (fr === null || lr === null) fl = null;
  const lyOk = num(m.ly_days) > 0 && num(m.ly_sales) > 0;
  const lunch = num(m.lunch), dinner = num(m.dinner);
  return {
    name: s.store_name, consigned: s.consigned, open,
    sales: open ? S : null,
    lunch: open && num(m.bd_bad_days) === 0 ? (lunch > 0 ? lunch : null) : null, dinner: open && num(m.bd_bad_days) === 0 ? dinner : null,
    budget: open ? num(v.mtd_budget_ratio) : null,
    yoy: open && lyOk ? num(m.sales_on_ly_days) / num(m.ly_sales) : null,
    guests: open ? num(v.mtd_guests) : null, avg: open && num(v.mtd_guests) > 0 ? S / num(v.mtd_guests) : null,
    labor: open ? lr : null, food: open ? fr : null, fl: open ? fl : null,
    review: open ? num(v.google_review_month_increase) : null,
    grade: gradeOf(v), rating: ratingOf(v), targetLabor: num(v.target_labor_rate),
    // 合計用（金額の合算のみ）
    _fls: num(v.fl_sales_mtd), _laborAmt: lr !== null && num(v.fl_sales_mtd) !== null ? lr * num(v.fl_sales_mtd) : null, _cost: num(v.cost_mtd),
    _budget: num(v.mtd_budget), _lyS: lyOk ? num(m.sales_on_ly_days) : 0, _lyD: lyOk ? num(m.ly_sales) : 0,
  };
}
// 合計行（月次のみ）。比率の平均は使わない: FL = (Σ原価＋Σ人件費) ÷ ΣFL用売上（原価・人件費が計測されている店だけ）
function totalRow(rows) {
  const open = rows.filter((r) => r.open);
  const sum = (f) => open.reduce((a, r) => a + (num(f(r)) || 0), 0);
  const meas = open.filter((r) => r.labor !== null && r.food !== null && num(r._fls) > 0);
  const fls = meas.reduce((a, r) => a + r._fls, 0);
  const lab = meas.reduce((a, r) => a + r._laborAmt, 0), cost = meas.reduce((a, r) => a + r._cost, 0);
  const withBud = open.filter((r) => num(r._budget) > 0);
  const budS = withBud.reduce((a, r) => a + r.sales, 0), budD = withBud.reduce((a, r) => a + r._budget, 0);
  const lyS = sum((r) => r._lyS), lyD = sum((r) => r._lyD);
  const guests = sum((r) => r.guests), sales = sum((r) => r.sales);
  return {
    name: '合計（12店舗）', sales, lunch: sum((r) => r.lunch), dinner: sum((r) => r.dinner),
    budget: budD > 0 ? budS / budD : null, yoy: lyD > 0 ? lyS / lyD : null, guests, avg: guests > 0 ? sales / guests : null,
    labor: fls > 0 ? lab / fls : null, food: fls > 0 ? cost / fls : null, fl: fls > 0 ? (lab + cost) / fls : null,
    review: sum((r) => r.review), _total: true,
  };
}

// ---------- アラート（基準は店舗別の目標・FL評価設定から。該当店舗がある帯だけ表示） ----------
function alerts(rows, kind) {
  const out = [];
  const open = rows.filter((r) => r.open);
  // ①人件費率 超過: 店舗別の目標(目標管理)を超えた店のうち超過幅が最大の1店
  const lab = open.filter((r) => r.labor !== null && r.targetLabor !== null && r.labor > r.targetLabor)
    .sort((a, b) => (b.labor - b.targetLabor) - (a.labor - a.targetLabor))[0];
  if (lab) out.push({ lv: 'bad', t: '人件費率 超過', sub: `（目標≦${(lab.targetLabor * 100).toFixed(1)}%）`, store: lab.name, val: pct(lab.labor), diff: `（+${((lab.labor - lab.targetLabor) * 100).toFixed(1)}pt）` });
  // ②FL比率 悪化: FL評価設定の基準（普通の上限）を超え、最も外れた1店。基準未設定・評価保留の店は対象外
  const th = (r) => (r.rating && r.rating.thresholds) || null;
  const settled = open.filter((r) => r.fl !== null && th(r) && !['unset', 'hold'].includes(r.rating.grade));
  const worst = settled.filter((r) => r.fl * 100 > th(r).normal_max).sort((a, b) => (b.fl * 100 - th(b).normal_max) - (a.fl * 100 - th(a).normal_max))[0];
  if (worst) out.push({ lv: 'bad', t: 'FL比率 悪化', sub: `（基準≦${th(worst).normal_max}%）`, store: worst.name, val: pct(worst.fl), diff: `（+${(worst.fl * 100 - th(worst).normal_max).toFixed(1)}pt）` });
  // ③売上 目標達成: 予算比100%以上のうち最も高い1店（110%固定にしない）
  const sale = open.filter((r) => r.budget !== null && r.budget >= 1).sort((a, b) => b.budget - a.budget)[0];
  if (sale) out.push({ lv: 'good', t: '売上 目標達成', sub: '（予算比≧100%）', store: sale.name, val: pct(sale.budget), diff: '' });
  // ④FL比率 良好: FL評価設定の「優秀」基準以下で、最も余裕のある1店
  const best = settled.filter((r) => r.fl * 100 <= th(r).excellent_max).sort((a, b) => (th(b).excellent_max - b.fl * 100) - (th(a).excellent_max - a.fl * 100))[0];
  if (best) out.push({ lv: 'good', t: 'FL比率 良好', sub: `（基準≦${th(best).excellent_max}%）`, store: best.name, val: pct(best.fl), diff: '' });
  return out;
}

// ---------- 検算（不一致があれば送らない） ----------
async function selfCheck(data, date) {
  const issues = [];
  const st = data.stores || [];
  if (st.length !== 12) issues.push(`店舗数が12ではない(${st.length})`);
  if (!args['data-file'] && SECRET) {
    // 直営8店: 店舗別日報と同じ経路（action=vm）で取り直し、表示に使う主要キーが完全一致すること
    const KEYS = ['sales_today', 'guests_today', 'budget_ratio_today', 'labor_ratio_today', 'food_cost_ratio_today', 'fl_ratio_today', 'mtd_sales', 'mtd_guests', 'mtd_budget_ratio', 'mtd_labor_ratio', 'mtd_food_cost_ratio', 'mtd_fl_ratio', 'cost_today', 'cost_mtd', 'google_review_day_increase', 'google_review_month_increase'];
    for (const s of st.filter((x) => !x.consigned)) {
      const j = await api({ action: 'vm', store_id: s.store_id, date });
      for (const k of KEYS) if (String(num(j.vm[k])) !== String(num(s.vm[k]))) issues.push(`${s.store_name} ${k} が店舗別日報と不一致`);
      if ((j.vm.ratings?.fl?.grade) !== (s.vm.ratings?.fl?.grade)) issues.push(`${s.store_name} FL評価が不一致`);
    }
  }
  for (const s of st.filter((x) => !x.consigned)) {
    const m = s.mtd;
    if (Math.abs(num(m.media_total_vm) - num(m.media_total_db)) > 1) issues.push(`${s.store_name} 営業区分別売上の月間合計が媒体別売上と不一致`);
    if (num(m.bd_bad_days) === 0 && Math.abs(num(m.lunch) + num(m.dinner) - num(s.vm.mtd_sales)) > Math.max(1, num(s.vm.mtd_sales) * 0.001)) issues.push(`${s.store_name} ランチ+ディナー累計 ≠ 累計売上`);
    if (num(s.vm.sales_today) > 0 && s.vm.breakdown?.status === 'ok' && Math.abs(num(s.vm.breakdown.lunch) + num(s.vm.breakdown.dinner) - num(s.vm.sales_today)) > Math.max(1, num(s.vm.sales_today) * 0.001)) issues.push(`${s.store_name} ランチ+ディナー ≠ 当日売上`);
  }
  return issues;
}

// ---------- HTML ----------
const W = 1230;
const CSS = `
:root{--navy:#14213f;--ink:#1a1a1a;--gray:#5b6470;--line:#e3e7ee;--bg:#eef1f6;--good:#127a31;--bad:#d9342b}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;background:var(--navy);color:var(--ink);font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans CJK JP","Noto Sans JP","Yu Gothic",sans-serif;-webkit-font-smoothing:antialiased}
.page{width:${W}px;background:var(--navy);padding:22px 8px 28px}
header{display:flex;justify-content:space-between;align-items:flex-start;color:#fff;padding:0 14px 16px}
.logo{display:flex;align-items:center;gap:12px;font-weight:800;font-size:26px;letter-spacing:2px}
.logo b{display:inline-block;width:34px;height:34px;border:3px solid #fff;border-radius:6px;text-align:center;line-height:28px;font-size:22px}
h1{font-size:40px;font-weight:900;margin-top:2px;white-space:nowrap}h1 small{font-size:24px;font-weight:700;margin-left:8px}
.hr{display:flex;align-items:center;gap:12px;margin-top:6px;flex-shrink:0}
.dpill{border:2px solid rgba(255,255,255,.6);border-radius:24px;padding:8px 20px;font-size:24px;font-weight:800;white-space:nowrap}
.tabs{display:flex;white-space:nowrap;flex-shrink:0;border:2px solid rgba(255,255,255,.4);border-radius:20px;overflow:hidden;font-size:22px;font-weight:800}
.tabs span{padding:8px 18px;color:rgba(255,255,255,.75)}.tabs span.on{background:#fff;color:var(--navy)}
.kind{white-space:nowrap;flex-shrink:0;background:#fff;color:var(--navy);border-radius:20px;padding:9px 20px;font-size:24px;font-weight:900}
.card{background:#fff;border-radius:22px;margin-bottom:16px;padding:14px 12px 14px;box-shadow:0 1px 6px rgba(20,30,60,.08)}
.ttl{font-size:30px;font-weight:900;display:flex;align-items:center;gap:12px;padding:2px 12px 12px;white-space:nowrap}
.ttl i{display:inline-block;width:34px;height:34px;border-radius:8px;background:var(--navy)}
table{width:100%;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}
th{background:#eef1f6;font-size:15px;font-weight:800;line-height:1.2;padding:8px 2px;border-right:1px solid #fff}
td{height:50px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);text-align:center;font-size:17px;font-weight:600;padding:0 2px;white-space:nowrap;overflow:hidden}
td.l{text-align:left;font-weight:800;padding-left:6px}td.no{font-weight:700}
td.sales{font-weight:800;letter-spacing:-.3px}
td.ok{background:#e6f7ea;color:var(--good);font-weight:800}td.ng{background:#fde8e6;color:var(--bad);font-weight:800}td.rv{color:var(--good);font-weight:900}
td.cl{color:#8a93a0;font-weight:700}
tr.tot td{background:#e6f7ea;font-weight:800;border-bottom:none;font-size:16px}
.bd{display:inline-block;min-width:62px;border-radius:9px;padding:6px 4px;white-space:nowrap;color:#fff;font-size:16px;font-weight:900}
.g-ex{background:#126b2c}.g-no{background:#3dbb5a}.g-wa{background:#f0a020}.g-da{background:#d9342b}
.al{display:grid;grid-template-columns:56px 1fr 2px 250px 300px;align-items:center;border-radius:16px;height:64px;margin:0 6px 10px;padding:0 16px}
.al.bad{background:#fde8e6;border:1px solid #f3b9b4}.al.good{background:#e6f7ea;border:1px solid #b4e0bf}
.al .ic{font-size:34px;font-weight:900}.al.bad .ic{color:var(--bad)}.al.good .ic{color:var(--good)}
.al .t{font-size:26px;font-weight:900}.al .t small{font-size:19px;font-weight:700;color:#444;margin-left:6px}
.al .sep{width:2px;height:34px;background:#c9cfd9}
.al .st{font-size:24px;padding:0 6px;font-weight:900;text-align:center;overflow:hidden;white-space:nowrap}
.al .v{font-size:32px;font-weight:900;text-align:center;white-space:nowrap}.al.bad .v{color:var(--bad)}.al.good .v{color:var(--good)}.al .v small{font-size:21px;margin-left:8px}
.none{padding:14px 18px;font-size:22px;color:var(--gray);font-weight:700}
.gen{color:rgba(255,255,255,.55);font-size:14px;text-align:right;padding:2px 14px 0}
`;
const COLS = [
  ['No', 38], ['店舗', 140], ['@sales', 140], ['@lunch', 116], ['@dinner', 128], ['予算比', 78], ['前年比', 78], ['客数', 56], ['客単価', 74], ['人件費率', 68], ['原価率', 64], ['FL比率', 64], ['口コミ増加', 66], ['評価', 80],
];
function table(rows, kind) {
  const monthly = kind === 'monthly';
  const head = COLS.map(([n, w]) => {
    const t = n === '@sales' ? (monthly ? '累計売上<br>(店内POS)' : '売上<br>(店内POS)') : n === '@lunch' ? (monthly ? 'ランチ累計' : 'ランチ<br>売上') : n === '@dinner' ? (monthly ? 'ディナー累計' : 'ディナー<br>売上') : n === '口コミ増加' ? '口コミ<br>増加' : n;
    return `<th style="width:${w}px">${t}</th>`;
  }).join('');
  const ratio = (v) => pct(v);
  const body = rows.map((r, i) => {
    if (!r.open) return `<tr><td class="no">${i + 1}</td><td class="l">${esc(r.name)}</td><td class="cl" colspan="12">休業（売上なし）</td></tr>`;
    const bc = r.budget === null ? '' : r.budget >= 1 ? 'ok' : 'ng';
    const bd = r.grade ? `<span class="bd ${r.grade.cls}">${r.grade.label}</span>` : '';
    return `<tr><td class="no">${i + 1}</td><td class="l">${esc(r.name)}</td><td class="sales">${yenS(r.sales)}</td><td>${r.lunch === null ? '—' : yenS(r.lunch)}</td><td>${r.dinner === null ? '—' : yenS(r.dinner)}</td>`
      + `<td class="${bc}">${ratio(r.budget)}</td><td>${ratio(r.yoy)}</td><td>${cnt(r.guests)}</td><td>${yenS(r.avg)}</td><td>${ratio(r.labor)}</td><td>${ratio(r.food)}</td><td>${ratio(r.fl)}</td>`
      + `<td class="rv">${r.review === null ? '—' : (r.review >= 0 ? '+' : '') + r.review + '件'}</td><td>${bd}</td></tr>`;
  }).join('');
  let tot = '';
  if (monthly) {
    const t = totalRow(rows);
    tot = `<tr class="tot"><td colspan="2" class="l">合計（12店舗）</td><td class="sales">${yenS(t.sales)}</td><td>${yenS(t.lunch)}</td><td>${yenS(t.dinner)}</td><td>${ratio(t.budget)}</td><td>${ratio(t.yoy)}</td><td>${cnt(t.guests)}</td><td>${yenS(t.avg)}</td><td>${ratio(t.labor)}</td><td>${ratio(t.food)}</td><td>${ratio(t.fl)}</td><td class="rv">${t.review >= 0 ? '+' : ''}${t.review}件</td><td></td></tr>`;
  }
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}${tot}</tbody></table>`;
}
function alertHtml(list) {
  if (!list.length) return '<div class="none">該当する店舗はありません</div>';
  return list.map((a) => `<div class="al ${a.lv}"><span class="ic">${a.lv === 'bad' ? '⚠' : '✓'}</span><span class="t">${esc(a.t)}<small>${esc(a.sub)}</small></span><span class="sep"></span><span class="st">${esc(a.store)}</span><span class="v">${esc(a.val)}<small>${esc(a.diff)}</small></span></div>`).join('');
}
function buildHtml(kind, data, rows) {
  const d = ymd(data.date), mf = ymd(data.month_from);
  const wk = '日月火水木金土'[new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay()];
  const monthly = kind === 'monthly';
  const title = monthly ? '全店舗 月次累計' : '全店舗 日報';
  const dateTxt = monthly ? `${d.y}年${d.m}月（${mf.m}/${mf.d}〜${d.m}/${d.d}）` : `${d.y}年${d.m}月${d.d}日（${wk}）`;
  const right = monthly ? '<span class="kind">月次累計</span>' : '<div class="tabs"><span class="on">日次</span><span>週次</span><span>月次</span></div>';
  const sub = monthly ? `（12店舗：${mf.m}/${mf.d}〜${d.m}/${d.d} 累計）` : '（12店舗）';
  const alTitle = monthly ? `アラート / 注目店舗（${d.m}月 累計）` : 'アラート / 注目店舗';
  const gen = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=${W}"><title>${title} ${esc(data.date)}</title><style>${CSS}</style></head><body><div class="page">
<header><div><div class="logo"><b>N</b>NSTYLE GROUP</div><h1>${title}<small>（本部・経営用）</small></h1></div><div class="hr"><div class="dpill">${dateTxt}</div>${right}</div></header>
<section class="card"><div class="ttl"><i></i>店舗別サマリー${sub}</div>${table(rows, kind)}</section>
<section class="card"><div class="ttl"><i></i>${alTitle}</div>${alertHtml(alerts(rows, kind))}</section>
<div class="gen">生成 ${gen}　正本: 店舗別日報と同じ集計（直営8＋業務委託4）</div>
</div></body></html>`;
}

// ---------- PNG ----------
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cands = os.platform() === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  return cands.find((p) => fs.existsSync(p)) || null;
}
async function renderPngs(jobs) {
  const { default: puppeteer } = await import('puppeteer-core');
  const exe = chromePath();
  if (!exe) throw new Error('Chrome が見つかりません（CHROME_PATH を指定）');
  const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--hide-scrollbars'] });
  try {
    for (const j of jobs) {
      const page = await browser.newPage();
      await page.setViewport({ width: W, height: 1500, deviceScaleFactor: 1.5 });
      await page.setContent(j.html, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      const el = await page.$('.page');
      await el.screenshot({ path: j.png, type: 'png' });
      await page.close();
    }
  } finally { await browser.close(); }
}

async function slackSend(body) {
  const r = await fetch(SLACK_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-notify-secret': SECRET }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error('Slack送信失敗: HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}

(async () => {
  const date = String(args.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date YYYY-MM-DD が必要です');
  let data;
  if (args['data-file']) data = JSON.parse(fs.readFileSync(args['data-file'], 'utf8'));
  else { if (!SECRET) throw new Error('NOTIFY_SLACK_SECRET が未設定です'); data = (await api({ action: 'all_stores', date })).data; }
  const stores = data.stores || [];
  const issues = await selfCheck(data, date);
  if (issues.length) { console.error('[all-stores-report] 検算NG（配信しません）:\n - ' + issues.join('\n - ')); process.exit(2); }
  log(`検算OK: 12店 / ${args['data-file'] ? '（--data-file のため店舗別日報との再照合は省略）' : '直営8店の店舗別日報との再照合 一致・不一致0'}`);
  const dRows = stores.map(dailyRow), mRows = stores.map(monthlyRow);
  fs.mkdirSync(OUT, { recursive: true });
  const jobs = [
    { kind: 'daily', html: buildHtml('daily', data, dRows), png: path.join(OUT, `all-stores-daily-${date}.png`) },
    { kind: 'monthly', html: buildHtml('monthly', data, mRows), png: path.join(OUT, `all-stores-monthly-${date}.png`) },
  ];
  for (const j of jobs) fs.writeFileSync(j.png.replace(/\.png$/, '.html'), j.html);
  if (args['html-only']) return;
  await renderPngs(jobs);
  for (const j of jobs) log('PNG:', j.png, fs.statSync(j.png).size, 'bytes');
  if (args['no-send']) { console.log(JSON.stringify({ ok: true, sent: false })); return; }

  const channel = args.channel || process.env.SLACK_CHANNEL_KEY;
  if (!channel) throw new Error('--channel が必要です');
  const urls = {};
  for (const j of jobs) {
    const up = await api({ action: 'upload', date, store_key: `all-stores-${j.kind}`, png_base64: fs.readFileSync(j.png).toString('base64') });
    urls[j.kind] = up.url; log('Storage:', up.path);
  }
  const directTotal = num(data.direct_total) || 8;
  const direct = stores.filter((s) => !s.consigned).map((s) => s.store_name);
  const delivered = new Set(data.delivered_direct || []);
  const okN = direct.filter((n) => delivered.has(n)).length;
  const missing = direct.filter((n) => !delivered.has(n));
  const mark = args.test ? '【テスト】' : '';
  const head = `${mark}${md(date)} 全店舗 日報`;
  const status = okN >= directTotal ? `✅ 直営${okN}/${directTotal}店舗 配信成功` : `⚠ 直営${okN}/${directTotal}店舗 配信成功（未配信: ${missing.join('・')}）`;
  const parent = await slackSend({
    action: 'send', channel_key: channel, source: 'tori-dashboard', event: 'report_all_stores_daily',
    text: `${head}\n${status}\n全12店舗・日次画像`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${head}*\n${status}\n全12店舗・日次画像` } },
      { type: 'image', image_url: urls.daily, alt_text: `全12店舗 日次 ${date}` },
    ],
    dedupe_key: `all_stores_report:${date}:parent${mark ? ':test' : ''}${SUFFIX}`, username: '経営日報', icon_emoji: ':bar_chart:',
    ref: { table: 'all_stores_report', id: `daily:${date}` },
  });
  log(`✓ 親投稿 ${parent.status} / ts=${parent.ts}`);
  if (!parent.ts) throw new Error('親投稿の投稿ID(ts)が取得できません');
  const th = await slackSend({
    action: 'send', channel_key: channel, source: 'tori-dashboard', event: 'report_all_stores_monthly', thread_ts: parent.ts,
    text: `${mark}${md(date)} 全店舗 月次累計（${md(data.month_from)}〜${md(date)}）`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${mark}全店舗 月次累計（${md(data.month_from)}〜${md(date)}）*` } },
      { type: 'image', image_url: urls.monthly, alt_text: `全12店舗 月次累計 ${data.month_from}〜${date}` },
    ],
    dedupe_key: `all_stores_report:${date}:monthly${mark ? ':test' : ''}${SUFFIX}`, username: '経営日報', icon_emoji: ':bar_chart:',
    ref: { table: 'all_stores_report', id: `monthly:${date}` },
  });
  log(`✓ スレッド返信 ${th.status} / ts=${th.ts}`);
  console.log(JSON.stringify({ ok: true, date, direct_ok: okN, direct_total: directTotal, parent: { status: parent.status, ts: parent.ts }, thread: { status: th.status, ts: th.ts } }));
})().catch((e) => { console.error('[all-stores-report] 失敗:', e.message || e); process.exit(1); });
