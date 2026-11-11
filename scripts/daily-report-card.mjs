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
// 前年比の比較対象日（共通関数・正本 shared/prev-year-date.js）。ハブ側 jp_prev_year_same_nth_weekday と一致することを検算で確認する
const { createRequire } = await import('node:module');
const { getPreviousYearComparableDate } = createRequire(import.meta.url)('../shared/prev-year-date.js');
const yen = (v) => (num(v) === null ? '—' : Math.round(num(v)).toLocaleString('ja-JP') + '円');
const cnt = (v) => (num(v) === null ? '—' : Math.round(num(v)).toLocaleString('ja-JP'));
// 'YYYY-MM-DD' を Date を経由せず分解（UTCランナーで1日ずれるのを防ぐ）
const ymd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
const md = (s) => { const t = ymd(s); return t ? `${t.m}/${t.d}` : ''; };
const pct = (v, d = 1) => (num(v) === null ? '—' : (num(v) * 100).toFixed(d) + '%');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function normalize(vm) {
  const v = { ...vm };
  // 仕入・人件費が 0 のまま売上がある店（N-Style 4 店など＝データ未整備）は率を「—」にする
  if (num(v.sales_today) > 0 && !(num(v.cogs_today) > 0)) v.food_cost_ratio_today = null;
  if (num(v.sales_today) > 0 && !(num(v.labor_today) > 0)) v.labor_ratio_today = null;
  if (num(v.mtd_sales) > 0 && !(num(v.mtd_food_cost_ratio) > 0)) v.mtd_food_cost_ratio = null;
  if (num(v.mtd_sales) > 0 && !(num(v.mtd_labor_ratio) > 0)) v.mtd_labor_ratio = null;
  // 原価か人件費のどちらかが未整備（率が「—」）の日は、片方だけのFL比率を出さない（FL＝F+L のため誤解を避ける）
  if (v.food_cost_ratio_today === null || v.labor_ratio_today === null) v.fl_ratio_today = null;
  if (v.mtd_food_cost_ratio === null || v.mtd_labor_ratio === null) v.mtd_fl_ratio = null;
  // ランチ/ディナー（明細ベース）は、両方そろい・合計が当日売上の ±1% 以内のときだけ出す
  const L = v.lunch, D = v.dinner, S = num(v.sales_today);
  // 売上内訳の正本 = 経営ダッシュボードの「営業区分別売上」（VM v6.2: breakdown＝kd_media_daily を mediaClassOf と同じ規則でランチ／ディナーに分類）。
  //   明細（kd_detail_hour_daily）での代用・按分は行わない。取れない日は「未取得」と明示。通常店は2行・デリバリー店は3行（デリバリーは別系統）
  const B = v.breakdown;
  v.show_ld = !!(B && B.status === 'ok' && num(B.total) !== null);
  v.ld_lunch = v.show_ld ? (num(B.lunch) || 0) : 0; v.ld_dinner = v.show_ld ? (num(B.dinner) || 0) : 0;
  v.ld_has_lunch = !!(B && B.has_lunch); v.ld_has_dinner = v.ld_dinner > 0;
  v.ld_note = v.show_ld ? '' : '売上内訳（ランチ/ディナー）は未取得';
  // 前年比 = 前年同月の第N週・同曜日（VM v2）。比較対象が無い／前年のデータが無いときは null → 「—」
  v.cmp = getPreviousYearComparableDate(v.date);
  v.yoy = v.ly_found && num(v.ly_sales) > 0 ? num(v.yoy_same_week_ratio) : null;
  v.cmp_text = v.cmp ? (v.cmp.comparison_date ? `比較対象：${v.cmp.comparison_date.replace(/-/g, '/')}（${v.cmp.label}）` : `前年同月に${v.cmp.label}なし`) : '';
  // イベント（新横浜エリアなど。無ければ空配列＝何も出さない）
  v.events = Array.isArray(v.events) ? v.events : [];
  v.events_total = num(v.events_total) ?? v.events.length;
  return v;
}
function selfCheck(v) {
  const issues = [];
  const S = num(v.sales_today), G = num(v.guests_today);
  if (S !== null && G > 0 && num(v.avg_spend_today) !== null && Math.abs(S / G - num(v.avg_spend_today)) > 1) issues.push('客単価 ≠ 売上÷客数');
  if (v.show_ld && Math.abs(v.ld_lunch + v.ld_dinner - S) > Math.max(1, S * 0.001)) issues.push('ランチ+ディナー（営業区分別売上）≠ 当日売上');   // 正本どうしなので一致するはず（差があればデータ不整合）
  if (num(v.budget_today) > 0 && num(v.budget_ratio_today) !== null && Math.abs(S / num(v.budget_today) - num(v.budget_ratio_today)) > 0.0005) issues.push('予算比の再計算が一致しない');
  if (num(v.mtd_budget) > 0 && num(v.mtd_budget_ratio) !== null && Math.abs(num(v.mtd_sales) / num(v.mtd_budget) - num(v.mtd_budget_ratio)) > 0.0005) issues.push('月累計予算比が一致しない');
  const FSd = num(v.fl_sales_today) > 0 ? num(v.fl_sales_today) : S;   // F/L/FLの分母＝FL計算用売上（店内＋デリバリー税抜・VM v6）。無い旧VMは店内のまま
  if (num(v.cogs_today) > 0 && num(v.food_cost_ratio_today) !== null && Math.abs(num(v.cogs_today) / FSd - num(v.food_cost_ratio_today)) > 0.0005) issues.push('原価率が一致しない');
  if (num(v.labor_today) > 0 && num(v.labor_ratio_today) !== null && Math.abs(num(v.labor_today) / FSd - num(v.labor_ratio_today)) > 0.0005) issues.push('人件費率が一致しない');
  if (v.cmp && 'ly_comparison_date' in v && (v.cmp.comparison_date || null) !== (v.ly_comparison_date || null)) issues.push(`比較対象日が共通関数とハブで不一致（${v.cmp.comparison_date} ≠ ${v.ly_comparison_date}）`);
  if (v.yoy !== null && num(v.ly_sales) > 0 && Math.abs(S / num(v.ly_sales) - v.yoy) > 0.0005) issues.push('前年同月同週比の再計算が一致しない');
  return issues;
}
// ---------- 3. HTML テンプレート v2（確定デザイン 2026-11-10: 濃紺ヘッダー・白背景・イベント右上・売上内訳右下・最下段要確認） ----------
// 画像側では計算しない（VM v6 の値を表示するだけ）。評価（優秀/普通/要改善/危険水準）はVMの ratings をそのまま表示。
const GRADE = {
  excellent: { label: '優秀', cls: 'g-ex' }, normal: { label: '普通', cls: 'g-no' },
  warn: { label: '要改善', cls: 'g-wa' }, danger: { label: '危険水準', cls: 'g-da' }, unset: { label: '基準未設定', cls: 'g-un' },
  hold: { label: '評価保留（デリバリー未取得）', cls: 'g-un' },   // デリバリー取扱店で期間内の取得が欠けている時（VM: ratings.*.grade='hold'）
};
const grade = (v, key) => GRADE[(v.ratings && v.ratings[key] && v.ratings[key].grade) || 'unset'] || GRADE.unset;
function diniiText(v) {
  const sc = num(v.mtd_dinii_score), n = num(v.mtd_dinii_count), tg = num(v.target_dinii);
  if (sc === null) return { main: '—', unit: '', na: true, n };
  // 小数なし・四捨五入（ユーザー指示 2026-11-06）。「58点 / 75点」の右は目標点（設定があれば）
  return { main: String(Math.round(sc)), unit: '点' + (tg ? ` / ${Math.round(tg)}点` : ''), na: false, n };
}
function reviewInc(v) {
  const inc = num(v.mtd_review_count ?? v.google_review_month_increase);
  return inc === null ? { main: '—', cls: 'na' } : { main: (inc > 0 ? '+' : '') + cnt(inc) + '件', cls: inc < 0 ? 'bad' : 'good' };
}
// 最下段の要確認: 優先順位＝危険水準（FL→L→F）＞月間の目標超過＞本日予算未達＞(デリバリー未取得の参考値)＞良い点。表示は最大2件、3件以上は「ほか○件」
// 危険水準が3件以上のときは危険水準を優先して2件表示し「ほか○件（危険水準含む）」と明記する
function alertList(v) {
  const out = [];
  const lr = num(v.mtd_labor_ratio), tl = num(v.target_labor_rate), fr = num(v.mtd_food_cost_ratio), tf = num(v.target_food_cost_rate);
  const br = num(v.budget_ratio_today), yr = v.yoy;
  let danger = 0;
  for (const [k, name] of [['fl', 'FL比率'], ['labor', '人件費率'], ['food', '原価率']]) {
    if (grade(v, k) === GRADE.danger) { out.push({ lv: 'bad', t: `${name}（月間）が危険水準です` }); danger++; }
  }
  if (lr !== null && tl !== null && lr > tl) out.push({ lv: 'bad', t: `人件費率（月間）が目標${pct(tl)}を${((lr - tl) * 100).toFixed(1)}pt超過` });
  if (fr !== null && tf !== null && fr > tf) out.push({ lv: 'bad', t: `原価率（月間）が目標${pct(tf)}を${((fr - tf) * 100).toFixed(1)}pt超過` });
  if (br !== null && br < 1) out.push({ lv: 'warn', t: `本日の売上は予算比${pct(br)}（未達 ${yen(num(v.budget_today) - num(v.sales_today))}）` });
  if (v.delivery && v.delivery.unlinked_note) out.push({ lv: 'warn', t: `${v.delivery.unlinked_note}のため、F/L/FLにはその分が入っていません（今ある数字で評価）` });   // 例「デリバリー売上の一部（Uber Eats）が未連携」（VM v6.3）
  else if (v.fl_reference_mtd || v.fl_reference_today) out.push({ lv: 'warn', t: 'デリバリー未取得のためF/L/FLは店内のみの参考値（評価は保留）' });
  if (!out.length) {
    const good = [];
    if (br !== null && br >= 1) good.push(`予算比${pct(br)}`);
    if (yr !== null && yr >= 1) good.push(`前年比${pct(yr)}`);
    out.push({ lv: 'good', t: good.length ? `売上は${good.join('、')}と好調` : '特記事項なし' });
    return { shown: out, more: 0, moreNote: '' };
  }
  return { shown: out.slice(0, 2), more: Math.max(0, out.length - 2), moreNote: danger >= 3 ? '（危険水準含む）' : '' };
}
const SVG = {
  bars: '<svg viewBox="0 0 24 24" width="34" height="34"><rect x="3" y="12" width="4" height="9" rx="1" fill="#1f2f4d"/><rect x="10" y="6" width="4" height="15" rx="1" fill="#1f2f4d"/><rect x="17" y="3" width="4" height="18" rx="1" fill="#1f2f4d"/></svg>',
  cal: '<svg viewBox="0 0 24 24" width="34" height="34"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="#1f2f4d" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke="#1f2f4d" stroke-width="2"/></svg>',
  mega: '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M3 10v4l9 4V6L3 10zM14 8c3 1 3 7 0 8" fill="#1f2f4d" stroke="#1f2f4d" stroke-width="1.5"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M12 2l3 7 7 .6-5.3 4.7 1.7 7.2L12 17.8 5.6 21.5l1.7-7.2L2 9.6 9 9z" fill="#1f2f4d"/></svg>',
  fork: '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M6 2v8M4 2v6a2 2 0 004 0V2M6 10v12M17 2c-2 2-2 8 0 9v11" fill="none" stroke="#1f2f4d" stroke-width="2"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="60" height="60"><path d="M12 3l10 18H2z" fill="#d9342b"/><path d="M12 9v5M12 17v1.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  warns: '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 3l10 18H2z" fill="currentColor"/><path d="M12 9v5M12 17v1.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" width="32" height="32"><path d="M7 3h10v5a5 5 0 01-10 0V3zM7 5H3c0 4 2 6 4 6M17 5h4c0 4-2 6-4 6M9 21h6M12 14v7" fill="#1a8f3c" stroke="#1a8f3c" stroke-width="1.5"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="40" height="40"><circle cx="12" cy="12" r="5" fill="#f6b100"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2" stroke="#f6b100" stroke-width="2"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M20 14A8 8 0 019 3a9 9 0 1011 11z" fill="#2b5fb8"/></svg>',
  bike: '<svg viewBox="0 0 24 24" width="40" height="40"><circle cx="6" cy="17" r="3.5" fill="none" stroke="#f05a1a" stroke-width="2"/><circle cx="18" cy="17" r="3.5" fill="none" stroke="#f05a1a" stroke-width="2"/><path d="M6 17l4-8h5l3 8M10 9H7" fill="none" stroke="#f05a1a" stroke-width="2"/></svg>',
  stadium: '<svg viewBox="0 0 48 32" width="64" height="44"><ellipse cx="24" cy="10" rx="20" ry="6" fill="none" stroke="#1f2f4d" stroke-width="2"/><path d="M4 10v12c0 4 9 7 20 7s20-3 20-7V10" fill="none" stroke="#1f2f4d" stroke-width="2"/></svg>',
};
// 出力は全店・全条件で同一サイズ（基準画像と同じ 1230×1279 の論理px）。各セクションの高さは固定で、内容量で伸縮しない。
// はみ出す文字は .fit（JSで段階縮小）か …（省略）で収める。可変は 店舗名・日付/祝日・数値・イベント・口コミ・内訳・評価/アラート のみ。
const CANVAS = { w: 1230, h: 1279 };
function buildHtml(v) {
  const d = ymd(v.date);
  const dateJa = `${d.y}年${d.m}月${d.d}日（${v.weekday_ja}${v.holiday_name ? '・祝' : ''}）`;
  const chips = [];
  if (v.holiday_name) chips.push(`<span class="chip y">${esc(v.holiday_name)}</span>`);
  if (v.is_holiday_eve) chips.push('<span class="chip y"><i>▦</i>祝前日</span>');
  if (num(v.days_to_holiday) !== null && num(v.days_to_holiday) <= 14) chips.push(`<span class="chip o">祝日まであと${num(v.days_to_holiday)}日</span>`);
  const evs = v.events.slice(0, 2), evMore = Math.max(0, (v.events_total || v.events.length) - evs.length);
  const evHtml = !evs.length ? '<div class="evnone">本日のイベントなし</div>'
    : evs.length === 1
      ? `<div class="evbox"><div class="evtxt"><div class="e1 fit" data-max="25" data-min="16">● ${esc(evs[0].venue || '会場')}</div><div class="e2 fit" data-max="25" data-min="15">「${esc(evs[0].event_name)}」</div>${evs[0].start_time ? `<div class="e3 fit" data-max="25" data-min="16">（${esc(evs[0].start_time)}開演）</div>` : ''}</div><div class="evic">${SVG.stadium}</div></div>`
      : `<div class="evbox two">${evs.map((e) => `<div class="ev2"><b>● ${esc(e.venue || '会場')}</b>「${esc(e.event_name)}」${e.start_time ? `（${esc(e.start_time)}開演）` : ''}</div>`).join('')}${evMore ? `<div class="ev2 more">ほか${evMore}件</div>` : ''}</div>`;
  const br = num(v.budget_ratio_today), yr = v.yoy;
  const lr = num(v.labor_ratio_today), fr = num(v.food_cost_ratio_today), tl = num(v.target_labor_rate), tf = num(v.target_food_cost_rate);
  const mlr = num(v.mtd_labor_ratio), mfr = num(v.mtd_food_cost_ratio);
  const rateCls = (r, t) => (r === null ? 'na' : t === null ? 'neutral' : r <= t ? 'good' : 'bad');
  const tileBg = (c) => (c === 'good' ? 'g' : c === 'bad' ? 'r' : '');
  const tgt = (t) => (t === null ? '目標 未設定' : `（目標 ≦${pct(t)}）`);
  const chk = (r, t) => (r !== null && t !== null && r <= t ? ' ✓' : '');
  const dn = diniiText(v), rv = reviewInc(v), low = num(v.mtd_dinii_low_count);
  const gl = grade(v, 'labor'), gf = grade(v, 'food'), gfl = grade(v, 'fl');
  const dl = v.delivery || { enabled: false };
  const mtdFrom = md(v.mtd_from), mtdTo = md(v.date), mtdStatus = v.mtd_status || '暫定';
  const al = alertList(v);
  const yenS = (n) => (num(n) === null ? '—' : '¥' + Math.round(num(n)).toLocaleString('ja-JP'));
  const ratio = (r) => (num(r) === null ? '' : `<span class="rt">(${pct(r)})</span>`);
  const irow = (icon, name, amount, r) => `<div class="irow"><span class="ico">${icon}</span><span class="nm">${name}</span><span class="am">${amount}</span>${ratio(r)}</div>`;
  const rows = [];
  const none = '<span class="na" style="font-size:24px">—（営業なし）</span>';
  const miss = '<span class="na" style="font-size:24px">未取得</span>';
  // 通常店は常に2行（ランチ・ディナー）。営業のない区分は「—（営業なし）」、取れない日は「未取得」
  rows.push(irow(SVG.sun, 'ランチ', v.show_ld ? (v.ld_has_lunch ? yen(v.ld_lunch) : none) : miss));
  rows.push(irow(SVG.moon, 'ディナー', v.show_ld ? (v.ld_has_dinner ? yen(v.ld_dinner) : none) : miss));
  if (dl.enabled) rows.push(irow(SVG.bike, 'デリバリー', dl.status === 'missing' ? '<span class="na">未取得</span>' : dl.status === 'zero' ? '¥0（注文なし）' : yen(dl.sales), dl.budget_ratio));   // 税抜換算後（取込は税込のため÷1.08。FL計算用と同じ）
  const bdBody = rows.join('');
  const flNote = dl.enabled ? `<span class="fln">FL用売上 ${num(v.fl_sales_today) === null ? '—' : yen(v.fl_sales_today)}</span>` : '';
  const ref = (f) => (f ? '<div class="refn">参考値</div>' : '');
  const holdLbl = (g) => (g === GRADE.hold ? '評価保留' : g.label);
  const ntg = (n) => `<div class="al n${n}">`;
  const alertHtml = al.shown.map((a, i) => {
    const last = i === al.shown.length - 1;
    const more = last && al.more ? `<span class="more">ほか${al.more}件${al.moreNote}</span>` : '';
    return `<div class="al ${a.lv} k${al.shown.length}"><span class="tg">${a.lv === 'bad' ? (al.shown.length === 1 ? SVG.warn : SVG.warns) + '<b>要確認</b>' : a.lv === 'warn' ? '<b>注意</b>' : '<b>良い</b>'}</span><span class="tx">${esc(a.t)}${more}</span></div>`;
  }).join('');
  const sampleOrGen = v._sample
    ? '<div class="sample">サンプルデータ（実データではありません）</div>'
    : `<div class="gen">生成 ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　正本: 経営ダッシュボード日次集計${dl.enabled ? '（FL＝店内＋デリバリー税抜）' : '（FL＝店内売上）'}</div>`;
  const nmLen = String(v.store_name).length;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=${CANVAS.w}">
<title>${esc(v.store_name)} 日報 ${esc(v.date)}</title>
<style>
  :root{--navy:#14213f;--ink:#1a1a1a;--gray:#5b6470;--line:#e3e7ee;--bg:#eef1f6;--good:#127a31;--bad:#d9342b;--warn:#e07b00}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${CANVAS.w}px;height:${CANVAS.h}px;background:var(--navy);color:var(--ink);font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans CJK JP","Noto Sans JP","Yu Gothic",sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden}
  .page{width:${CANVAS.w}px;height:${CANVAS.h}px;position:relative;background:var(--navy);overflow:hidden}
  .fit{display:block;width:100%;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .snum{min-width:0;width:100%}.scol1{min-width:0}.vv{min-width:0;width:100%}
  /* ヘッダー（高さ140固定） */
  header{position:absolute;left:0;top:0;width:100%;height:140px;color:#fff}
  .store{position:absolute;left:48px;top:22px;width:395px;height:96px}
  .store .nm{font-weight:900;letter-spacing:1px;line-height:62px;height:62px}
  .store small{position:absolute;left:0;top:78px;font-size:17px;font-weight:700;letter-spacing:5px;opacity:.85}
  .pill{position:absolute;left:462px;top:28px;width:346px;height:67px;border:2px solid rgba(255,255,255,.55);border-radius:34px;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:800;white-space:nowrap}
  .pill em{font-style:normal;margin-left:14px}
  .date{position:absolute;right:20px;top:10px;width:362px;height:52px;border:2px solid rgba(255,255,255,.55);border-radius:26px;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center}
  .chips{position:absolute;right:20px;top:72px;height:46px;display:flex;gap:14px;justify-content:flex-end}
  .chip{height:46px;border-radius:23px;padding:0 20px;display:flex;align-items:center;font-size:26px;font-weight:900;white-space:nowrap}
  .chip i{font-style:normal;margin-right:8px}.chip.y{background:#ffd23f;color:#1a1a1a}.chip.o{background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.5);color:#fff;font-size:23px}
  /* 本体（高さ固定の5段） */
  .panel{position:absolute;left:5px;top:140px;width:1220px;height:1125px;background:var(--bg);border-radius:28px;padding:15px 15px 0;display:grid;grid-template-rows:185px 233px 255px 225px 108px;row-gap:16px}
  .card{background:#fff;border-radius:22px;box-shadow:0 1px 6px rgba(20,30,60,.08);overflow:hidden;position:relative}
  .ttl{font-size:32px;font-weight:900;display:flex;align-items:center;gap:12px;height:44px;white-space:nowrap}
  .ttl small{font-size:24px;color:var(--gray);font-weight:700}
  .r1{display:grid;grid-template-columns:753px 1fr;column-gap:17px}
  .sales{padding:15px 28px 0}
  .sgrid{display:grid;grid-template-columns:minmax(0,1fr) 218px 137px;column-gap:10px;height:140px}
  .scol1{min-width:0;display:flex;flex-direction:column}
  .snum{margin-top:14px;height:92px;display:flex;align-items:center}
  .snum .fit{font-weight:900;letter-spacing:-1px;line-height:1.05}
  .sbox{margin-top:-19px;height:117px;border-radius:16px;text-align:center;padding:10px 6px 0;flex:none;min-width:0}
  .sbox.b{width:218px}.sbox.y{width:137px}
  .sbox .l{font-size:27px;font-weight:800;line-height:32px}.sbox .vv{height:60px;display:flex;align-items:center;justify-content:center;margin-top:4px}.sbox .vv .fit{text-align:center;font-weight:900}
  .sbox.good{background:#127a31;color:#fff}.sbox.warn{background:#fff1e0;color:var(--warn)}.sbox.bad{background:#fde9e7;color:var(--bad)}.sbox.na{background:#eef1f5;color:#9aa3ad}.sbox.gray{background:#eceff4;color:var(--ink)}
  .events{background:#eef3ff;padding:15px 20px 0 22px}
  .evbox{margin-top:12px;height:114px;background:#dfe9fb;border-radius:14px;padding:10px 16px;display:flex;align-items:center;gap:8px;overflow:hidden}
  .evtxt{flex:1;min-width:0;font-size:25px;font-weight:700;line-height:1.3}.evtxt .e1{font-weight:900}.evtxt div{overflow:hidden;white-space:nowrap}
  .evic{flex:none}
  .evbox.two{flex-direction:column;align-items:stretch;justify-content:center;gap:4px}.ev2{font-size:21px;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ev2.more{color:var(--gray)}
  .evnone{margin-top:30px;font-size:26px;color:#8a93a0;font-weight:700}
  /* KPI・月間（タイル固定高） */
  .kc{padding:15px 18px 0}
  .tiles{display:grid;column-gap:12px;margin-top:6px;height:152px}
  .t5{grid-template-columns:repeat(5,minmax(0,1fr))}
  .tm{grid-template-columns:249fr 211fr 219fr 208fr 241fr}
  .tile{border-radius:18px;background:#eceff4;text-align:center;padding:12px 8px 0;min-width:0;overflow:hidden}
  .tile.g{background:#e8f7ec}.tile.r{background:#fdeceb}.tile.fl{background:#eaf8ee;border:3px solid #2f9e4f;padding-top:9px}
  .tile .l{font-size:29px;font-weight:900;line-height:34px;white-space:nowrap}
  .tile .vv{height:58px;display:flex;align-items:center;justify-content:center;margin-top:6px}.tile .vv .fit{text-align:center;font-weight:800}
  .tile .t{font-size:21px;color:var(--gray);font-weight:700;line-height:24px;height:24px;white-space:nowrap}
  .badge{display:inline-block;padding:3px 16px;border-radius:12px;font-size:21px;font-weight:900;color:#fff;line-height:26px;margin-top:2px}
  .badge.sm{font-size:19px;padding:0 12px;line-height:24px;margin-top:4px}
  .g-ex{background:#127a31}.g-no{background:#6fbf73}.g-wa{background:#e07b00}.g-da{background:#d9342b}.g-un{background:#9aa3ad}
  .refn{font-size:17px;color:var(--warn);font-weight:800;line-height:20px}
  /* 口コミ・内訳（高さ225固定） */
  .r4{display:grid;grid-template-columns:692px 1fr;column-gap:15px}
  .lc,.bc{padding:15px 28px 0}
  .rvrow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:14px;height:130px}
  .rvrow>div{text-align:center;border-left:2px solid var(--line);padding:0 6px}.rvrow>div:first-child{border-left:0}
  .rvrow .l{font-size:28px;font-weight:900;line-height:36px;white-space:nowrap}.rvrow .vv{height:78px;display:flex;align-items:center;justify-content:center}.rvrow .vv .fit{text-align:center;font-weight:900}
  .bc .ttl{justify-content:space-between}.fln{font-size:17px;color:var(--gray);font-weight:700}
  .irows{height:150px;margin-top:6px;display:flex;flex-direction:column;gap:6px}
  .irow{flex:1;min-height:0;display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:12px;padding:0 14px;font-size:27px;font-weight:800;white-space:nowrap;overflow:hidden}
  .irow .ico{display:inline-flex;flex:none}.irow .nm{width:128px;flex:none}.irow .am{margin-left:auto;font-size:30px;font-weight:800}.irow .rt{font-size:22px;color:var(--gray);font-weight:700}
  .note{margin-top:20px;font-size:22px;color:var(--gray)}
  /* アラート（高さ108固定: 1件=大, 2件=小2本） */
  .alz{display:flex;flex-direction:column;gap:8px}
  .al{display:flex;align-items:center;border-radius:20px;overflow:hidden}
  .al.k1{height:108px;padding:0 26px;gap:22px;font-size:40px}.al.k2{height:50px;padding:0 20px;gap:16px;font-size:27px;border-radius:14px}
  .al .tg{display:flex;align-items:center;gap:12px;white-space:nowrap;padding-right:22px;border-right:2px solid rgba(0,0,0,.12);font-size:inherit}.al .tg b{font-weight:900}
  .al.k1 .tg b{font-size:46px}.al.k2 .tg b{font-size:28px}
  .al .tx{font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.al .more{margin-left:14px;font-size:.7em;color:var(--gray);font-weight:800}
  .al.bad{background:#fde9e7;border:2px solid #f7c4be;color:var(--bad)}.al.warn{background:#fff1e0;border:2px solid #f6d3a6;color:var(--warn)}.al.good{background:#e8f7ec;border:2px solid #bfe3c9;color:var(--good)}
  .al .tx{color:var(--ink)}
  .good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}.na{color:#9aa3ad}.neutral{color:var(--ink)}
  /* フッター帯（高さ54固定）: 通常=生成情報／サンプル=「サンプルデータ」帯 */
  .foot{position:absolute;left:5px;top:1265px;width:1220px;height:14px}
  .gen{position:absolute;right:30px;top:1229px;font-size:15px;color:#8e9bb5}
  .sample{position:absolute;left:40px;right:40px;top:1230px;height:36px;background:#fff3b0;border:3px dashed #c98a00;color:#7a4b00;border-radius:12px;text-align:center;font-size:22px;font-weight:900;letter-spacing:2px;line-height:30px}
</style></head><body><div class="page">
<header>
  <div class="store"><div class="nm fit" data-max="${nmLen > 12 ? 40 : 58}" data-min="26">${esc(v.store_name)}</div><small>NSTYLE GROUP</small></div>
  <div class="pill">日報<em>Daily Report</em></div>
  <div class="date"><div class="fit" data-max="34" data-min="22" style="text-align:center;font-weight:900;width:340px">${dateJa}</div></div>
  ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
</header>
<div class="panel">
  <div class="r1">
    <section class="card sales"><div class="ttl">${SVG.bars}本日の売上</div>
      <div class="sgrid">
        <div class="scol1"><div class="snum"><div class="fit ${num(v.sales_today) === null ? 'na' : ''}" data-max="76" data-min="14" data-noell="1">${num(v.sales_today) === null ? '—' : yenS(v.sales_today)}</div></div></div>
        <div class="sbox b ${br === null ? 'na' : br >= 1 ? 'good' : br >= 0.9 ? 'warn' : 'bad'}"><div class="l">予算比</div><div class="vv"><div class="fit" data-max="42" data-min="22">${pct(br)}${br !== null && br >= 1 ? ' ✓' : ''}</div></div></div>
        <div class="sbox y gray"><div class="l">前年比</div><div class="vv"><div class="fit" data-max="38" data-min="20">${pct(yr)}</div></div></div>
      </div></section>
    <section class="card events"><div class="ttl">${SVG.mega}本日のイベント</div>${evHtml}</section>
  </div>
  <section class="card kc"><div class="ttl">${SVG.bars}本日のKPI</div>
    <div class="tiles t5">
      <div class="tile"><div class="l">客数</div><div class="vv"><div class="fit" data-max="46" data-min="24">${cnt(v.guests_today)}人</div></div></div>
      <div class="tile"><div class="l">客単価</div><div class="vv"><div class="fit" data-max="46" data-min="24">${yenS(v.avg_spend_today)}</div></div></div>
      <div class="tile ${tileBg(rateCls(lr, tl))}"><div class="l">人件費率</div><div class="vv"><div class="fit ${rateCls(lr, tl)}" data-max="52" data-min="26">${pct(lr)}${chk(lr, tl)}</div></div><div class="t">${v.fl_reference_today ? '<span class="refn">参考値</span>　' : ''}${tgt(tl)}</div></div>
      <div class="tile ${tileBg(rateCls(fr, tf))}"><div class="l">原価率</div><div class="vv"><div class="fit ${rateCls(fr, tf)}" data-max="52" data-min="26">${pct(fr)}${chk(fr, tf)}</div></div><div class="t">${v.fl_reference_today ? '<span class="refn">参考値</span>　' : ''}${tgt(tf)}</div></div>
      <div class="tile"><div class="l">FL比率</div><div class="vv"><div class="fit" data-max="52" data-min="26">${pct(v.fl_ratio_today)}</div></div><div class="t">${v.fl_reference_today ? '<span class="refn">参考値（店内のみ）</span>' : ''}</div></div>
    </div></section>
  <section class="card kc"><div class="ttl">${SVG.cal}月間累計<small>（${mtdFrom}〜${mtdTo}・${esc(mtdStatus)}）</small></div>
    <div class="tiles tm" style="height:170px">
      <div class="tile"><div class="l">累計売上</div><div class="vv"><div class="fit" data-max="36" data-min="20">${yenS(v.mtd_sales)}</div></div></div>
      <div class="tile ${num(v.mtd_budget_ratio) === null ? '' : num(v.mtd_budget_ratio) >= 1 ? 'g' : ''}"><div class="l ${num(v.mtd_budget_ratio) >= 1 ? 'good' : ''}">予算進捗</div><div class="vv"><div class="fit ${num(v.mtd_budget_ratio) === null ? 'na' : num(v.mtd_budget_ratio) >= 1 ? 'good' : 'warn'}" data-max="46" data-min="24">${pct(v.mtd_budget_ratio)}${num(v.mtd_budget_ratio) >= 1 ? ' ✓' : ''}</div></div></div>
      <div class="tile ${tileBg(rateCls(mlr, tl))}"><div class="l">人件費率</div><div class="vv"><div class="fit ${rateCls(mlr, tl)}" data-max="46" data-min="24">${pct(mlr)}</div></div><div class="t">${tgt(tl)}</div>${ref(v.fl_reference_mtd)}<span class="badge sm ${gl.cls}">${holdLbl(gl)}</span></div>
      <div class="tile ${tileBg(rateCls(mfr, tf))}"><div class="l">原価率</div><div class="vv"><div class="fit ${rateCls(mfr, tf)}" data-max="46" data-min="24">${pct(mfr)}</div></div><div class="t">${tgt(tf)}</div>${ref(v.fl_reference_mtd)}<span class="badge sm ${gf.cls}">${holdLbl(gf)}</span></div>
      <div class="tile fl"><div class="l" style="display:flex;justify-content:center;align-items:center;gap:6px">${SVG.trophy}FL比率</div><div class="vv"><div class="fit" data-max="46" data-min="24">${pct(v.mtd_fl_ratio)}</div></div>${ref(v.fl_reference_mtd)}<span class="badge ${gfl.cls}" style="${gfl === GRADE.hold ? 'font-size:17px' : ''}">${gfl === GRADE.hold ? '評価保留（デリバリー未取得）' : gfl.label}</span></div>
    </div></section>
  <div class="r4">
    <section class="card lc"><div class="ttl">${SVG.star}口コミ・評価</div>
      <div class="rvrow">
        <div><div class="l">口コミ増減</div><div class="vv"><div class="fit ${rv.cls}" data-max="60" data-min="28">${rv.main}</div></div></div>
        <div><div class="l">ダイニー低評価</div><div class="vv"><div class="fit ${low === null ? 'na' : low > 0 ? 'bad' : 'good'}" data-max="60" data-min="28">${low === null ? '—' : low + '件'}</div></div></div>
        <div><div class="l">ダイニー点数</div><div class="vv"><div class="fit ${dn.na ? 'na' : ''}" data-max="52" data-min="24">${dn.main}${dn.unit}</div></div></div>
      </div></section>
    <section class="card bc"><div class="ttl"><span style="display:flex;align-items:center;gap:12px">${SVG.fork}売上内訳</span>${flNote}</div><div class="irows">${bdBody}</div></section>
  </div>
  <div class="alz">${alertHtml}</div>
</div>
${sampleOrGen}
<script>
  // 数値・店名・日付は、枠に収まる最大の文字サイズに自動調整（はみ出し・切れ・重なりを防ぐ。枠のサイズ自体は固定）
  document.querySelectorAll('.fit').forEach(function (el) {
    var fs = +el.dataset.max || 40, mn = +el.dataset.min || 16;
    el.style.fontSize = fs + 'px'; el.style.textOverflow = 'clip';   // 計測中は省略記号を切る（省略記号があると scrollWidth が狭く見えるため）
    while (fs > mn && el.scrollWidth > el.clientWidth + 0.5) { fs -= 1; el.style.fontSize = fs + 'px'; }
    if (!el.dataset.noell) el.style.textOverflow = 'ellipsis';   // 最小サイズでも収まらない時だけ … で省略（売上金額は省略しない＝data-noell）
  });
</script>
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
    await page.setViewport({ width: CANVAS.w, height: CANVAS.h, deviceScaleFactor: 1.5 }); // 基準画像と同じ 1230×1279（全店・全条件で同一サイズ）。実寸 1845×1919
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const el = await page.$('.page');
    await el.screenshot({ path: outPng, type: 'png' });
  } finally { await browser.close(); }
}

// ---------- 5. 保存と Slack 投稿 ----------
function slackBlocks(v, imageUrl) {
  const title = `📊 ${md(v.date)} ${v.store_name} 日報`;
  return {
    text: `${title}（画像が表示されない場合はこちら: ${imageUrl}）`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      { type: 'image', image_url: imageUrl, alt_text: `${v.store_name} ${v.date} 日報${v.cmp_text ? '／' + v.cmp_text : ''}` },
      { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '管理システムで詳細確認', emoji: true }, url: PORTAL_URL, action_id: 'report.card.open' }] },
    ],
  };
}

(async () => {
  const raw = await getVM();
  const v = normalize(raw);
  if (!v.has_data) throw new Error(`${v.store_name} ${v.date} の日次データがありません`);
  // 売上も客数も 0 のままなら、レジ集計がまだハブに反映されていない（12:00 の同期前など）と見なして画像は作らない → 文章日報へ
  if (!(num(v.sales_today) > 0) && !(num(v.guests_today) > 0)) throw new Error(`${v.store_name} ${v.date} の売上がまだ 0 円です（ハブ未反映の可能性）`);
  if (v.cmp) log(`前年比較: target_date=${v.cmp.target_date} weekday=${v.cmp.weekday} week_index=${v.cmp.week_index} comparison_date=${v.cmp.comparison_date ?? 'null'}${v.cmp.reason ? ' reason=' + v.cmp.reason : ''} ly_sales=${v.ly_sales ?? 'null'} holiday=${v.holiday_name ?? '-'} events=${v.events.length}`);
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
    const up = await api({ action: 'upload', date: v.date, store_key: key, png_base64: fs.readFileSync(pngPath).toString('base64'), vm: raw });   // vm=配信時スナップショット（過去日報を当時の基準で再現。TK-252）
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
    if (!r.ok || !j.ok) {
      const hint = j && j.error === 'invalid_blocks' ? '（Slack が画像 URL を取得できません。バケットの公開設定か署名 URL を確認）' : '';
      throw new Error('Slack送信失敗: HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 300) + hint);
    }
    log(`✓ Slack ${channel} / ${j.status} / notification_id=${j.notification_id}`);
  }
  console.log(JSON.stringify({ ok: true, store: v.store_name, date: v.date, image_url: url, alerts: alertList(v).shown.map((a) => a.t) }));
})().catch((e) => { console.error('[daily-report-card] 失敗:', e.message || e); process.exit(1); });
