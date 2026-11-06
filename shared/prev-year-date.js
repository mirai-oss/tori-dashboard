// =============================================================
// 前年比の比較対象日（共通関数）2026-11-06
//   定義: 「前年同月の 第N週・同曜日」。N は対象日が その月で同じ曜日の何回目か（1〜5）。
//   例: 2026-11-03(火・第1火曜) → 2025-11-04(第1火曜) ／ 2026-11-20(金・第3金曜) → 2025-11-21(第3金曜)
//   前年同月に同じ第N曜日が無い（第5曜日など）ときは comparison_date=null・found=false（第4曜日などへ代替しない）。
//   364日前（単純な同曜日）ではない。
// 使う場所: 画像日報(scripts/daily-report-card.mjs)・経営ダッシュボード(app.js・index.htmlで読込)・
//   文章日報 GAS(gas/Code.gs getPreviousYearComparableDate)・ハブSQL(jp_prev_year_same_nth_weekday)。
//   GAS と SQL は言語が違うため同じロジックを書いている。**3箇所は必ず揃えて直すこと**（正本はこのファイル）。
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PrevYearDate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var WD_JA = ['日', '月', '火', '水', '木', '金', '土'];
  var WD_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function parse(d) {
    if (d instanceof Date) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var m = String(d || '').match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(dt) { return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()); }
  function getPreviousYearComparableDate(date) {
    var dt = parse(date); if (!dt) return null;
    var y = dt.getFullYear(), m = dt.getMonth(), d = dt.getDate(), dow = dt.getDay();
    var weekIndex = Math.ceil(d / 7);                                  // その月で同じ曜日の何回目か
    var py = y - 1;
    var firstDow = new Date(py, m, 1).getDay();
    var firstDay = 1 + ((dow - firstDow) + 7) % 7;                     // 前年同月で最初にその曜日が来る日
    var day = firstDay + 7 * (weekIndex - 1);
    var dim = new Date(py, m + 1, 0).getDate();
    var found = day <= dim;
    return {
      target_date: fmt(dt), weekday: WD_EN[dow], weekday_ja: WD_JA[dow], week_index: weekIndex,
      comparison_date: found ? fmt(new Date(py, m, day)) : null, found: found,
      label: '第' + weekIndex + WD_JA[dow] + '曜日',
      reason: found ? null : 'comparison_target_not_found'
    };
  }
  return { getPreviousYearComparableDate: getPreviousYearComparableDate };
});
