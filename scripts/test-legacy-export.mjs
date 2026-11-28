// gas/LegacyDepositExport.gs（旧入金DBの読み取り専用の取り出し）の検証。GAS の部品（SpreadsheetApp など）を模擬して、Node で動かす。
// 実行: node scripts/test-legacy-export.mjs      確かめること: 6 列をそのまま返す／空行は飛ばす／行番号／指紋／備考／権限／【書き込み・シート作成を一切しない】
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x ? ' → ' + x : '')); } };

// 模擬のシート: 読み取り（getRange/getValues/getLastRow）だけ許し、書き込み系を呼んだら失敗にする
function makeSheet(values, header) {
  const calls = [];
  const all = [header, ...values];
  const guard = (name) => () => { calls.push(name); throw new Error('書き込み禁止: ' + name); };
  return {
    calls, getLastRow: () => all.length,
    getRange(r, c, nr, nc) {
      return { getValues: () => all.slice(r - 1, r - 1 + nr).map((row) => { const out = []; for (let i = 0; i < nc; i++) out.push(row[c - 1 + i] ?? ''); return out; }),
        setValue: guard('setValue'), setValues: guard('setValues'), setNumberFormat: guard('setNumberFormat'), clear: guard('clear'), getFormula: () => '' };
    },
    appendRow: guard('appendRow'), deleteRow: guard('deleteRow'), insertRowAfter: guard('insertRowAfter'), sort: guard('sort'), clear: guard('clear'),
  };
}
const D = (s) => new Date(s);   // Date 型（シートの日付セル）
const header = ['店舗', '日付', '入金額', '摘要', '取引時刻', '登録日時'];
const salesRows = [
  ['鳥一代 本店', D('2026-11-01T00:00:00+09:00'), 10000, 'ATM セブン銀行', '10:00:00', D('2026-11-02T14:05:30+09:00')],
  ['', '', '', '', '', ''],                                                                 // 空行
  ['鳥一代 本店', '2026/11/1', '10,000', 'ATM セブン銀行', '10:00:00', D('2026-11-02T14:05:30+09:00')],   // 全く同じ内容（日付・金額の表記違い）
  ['じんべぇ 川崎', D('2026-11-02T00:00:00+09:00'), -3000, 'sssへ入金', '#1', ''],
  ['エース 本厚木', D('2026-11-03T00:00:00+09:00'), 50000, '調整分', D('1899-12-30T10:30:00+09:00'), D('2026-11-04T09:00:00+09:00')],   // 時刻型に化けた取引時刻
];
const noteRows = [[D('2026-11-01T00:00:00+09:00'), '鳥一代 本店', 'メモ1', '社長', D('2026-11-02T00:00:00+09:00')], ['', '', '', '', ''], [D('2026-11-02T00:00:00+09:00'), 'じんべぇ 川崎', 'メモ2', '本部', '']];
const sales = makeSheet(salesRows, header);
const notes = makeSheet(noteRows, ['日付', '店舗', '備考', '更新者', '更新日時']);
let created = 0;
const ctx = {
  console, Date, Number, String, Math, JSON,
  SALES_DB_ID: 'X',
  isAdmin: (s) => s.role === '社長' || s.role === '本部',
  depositHeaderRow_: () => 1,
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  Utilities: {
    formatDate: (d, tz, f) => {   // 簡易: JST 固定
      const j = new Date(d.getTime() + 9 * 3600e3); const p = (n, w = 2) => String(n).padStart(w, '0');
      const base = { 'yyyy-MM-dd': `${j.getUTCFullYear()}-${p(j.getUTCMonth() + 1)}-${p(j.getUTCDate())}`, 'HH:mm:ss': `${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}` };
      if (base[f]) return base[f];
      return `${base['yyyy-MM-dd']}T${base['HH:mm:ss']}+09:00`;
    },
    computeDigest: (_a, str) => [...createHash('sha256').update(str, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b)),
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
  },
  SpreadsheetApp: {
    openById: () => ({ getSheetByName: (n) => (n === '入金DB' ? sales : null) }),
    getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === 'DB_入金備考' ? notes : n === '入金DB' ? sales : null), insertSheet: () => { created++; throw new Error('シート作成禁止'); } }),
  },
};
vm.createContext(ctx);
const full = readFileSync(join(here, '../gas/Code.gs'), 'utf8');
const sec = full.slice(full.indexOf('// ===== legacyDepositExport 開始'), full.indexOf('// ===== legacyDepositExport 終了'));
ok('Code.gs の末尾に、取り出しの処理が 1 か所だけ入っている', sec.length > 500 && full.split('function legacyDepositExport(').length === 2);
ok('呼び出し口が depositCarry の行のすぐ下にある', /action === 'depositCarry'[^\n]*\n\s*if \(action === 'legacyDepositExport'\)/.test(full));
ok('ping の版表示が末尾 -lde1', full.includes("ver: 'token-336h-v1-c19-pllock-a7pg-lde1'"));
vm.runInContext(sec, ctx);
const call = (p, role = '社長') => vm.runInContext('legacyDepositExport', ctx)(p, { role });

console.log('\n■ 旧入金DBの取り出し（読み取り専用）');
let r = call({});
ok('社長は取り出せる', r.ok === true, JSON.stringify(r).slice(0, 100));
ok('本部も取り出せる', call({}, '本部').ok === true);
for (const role of ['店舗', 'マネージャー', '']) ok(`${role || '(役職なし)'}: 取り出せない`, call({}, role).ok === false);
ok('空行は返さず、行番号（シート上の行）は飛ぶ（2・4・5・6 行目）', r.rows.map((x) => x.row_no).join(',') === '2,4,5,6', r.rows.map((x) => x.row_no).join(','));
ok('全く同じ内容の行は、2 行とも返す（統合しない）', r.rows.filter((x) => x.store === '鳥一代 本店').length === 2);
ok('日付は yyyy-MM-dd・金額は数値（カンマ付きの文字列も数値に）・マイナスも保つ', r.rows[0].date === '2026-11-01' && r.rows[1].date === '2026-11-01' && r.rows[1].amount === 10000 && r.rows[2].amount === -3000);
ok('取引時刻は文字列のまま（#1 も保つ）。時刻型に化けた行も HH:mm:ss で返す', r.rows[0].token === '10:00:00' && r.rows[2].token === '#1' && r.rows[3].token === '10:30:00', JSON.stringify(r.rows.map((x) => x.token)));
ok('登録日時は秒までの日時（時差つき）。空は空', r.rows[0].registered_at === '2026-11-02T14:05:30+09:00' && r.rows[2].registered_at === '');
ok('備考は空行を飛ばして 2 件', r.notes.length === 2 && r.notes[0].note === 'メモ1' && r.notes[1].store === 'じんべぇ 川崎');
const lines = r.rows.map((x) => [x.row_no, x.store, x.date, x.amount, x.desc, x.token, x.registered_at].join('|')).join('\n');
ok('指紋（fingerprint）は、返した行から受け取り側が同じ計算で再現できる', createHash('sha256').update(lines, 'utf8').digest('hex') === r.fingerprint);
ok('ページ指定（offset/limit）でも返せる', call({ offset: 1, limit: 2 }).count === 1 && call({ limit: 1 }).rows.length === 1);
ok('【書き込みをしない】シートの書き込み系・シート作成が 1 回も呼ばれていない', sales.calls.length === 0 && notes.calls.length === 0 && created === 0, JSON.stringify([sales.calls, notes.calls, created]));
// 備考のシートが無い場合も、作らずに空で返す
ctx.SpreadsheetApp.getActiveSpreadsheet = () => ({ getSheetByName: () => null, insertSheet: () => { created++; throw new Error('作成禁止'); } });
const r2 = call({});
ok('備考のシートが無くても、作らずに空の備考を返す', r2.ok && r2.notes.length === 0 && created === 0);
// 入金DBが見つからない
ctx.SpreadsheetApp.openById = () => ({ getSheetByName: () => null });
ok('入金DBが無ければ、エラーを返す（何も作らない）', call({}).ok === false && created === 0);
console.log(`\n==== 結果: ${pass} 件 OK ／ ${fail} 件 NG ====`);
process.exit(fail ? 1 : 0);
