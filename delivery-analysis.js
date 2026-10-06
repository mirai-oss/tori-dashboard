/* デリバリー分析タブ（2026-10-06追加）
 * ロケットナウ等のデリバリー注文明細（BQ sales.stg_delivery_order）を、
 *   ・時間帯別の注文数／売上
 *   ・曜日×時間帯のヒートマップ
 *   ・時間帯区分（ランチ／午後／ディナー／夜）ごとの人気商品
 *   ・商品別の数量・推定売上・時間帯別の内訳
 * で見るためのタブ。データはGAS bqGetDeliveryOrders（読み取り専用・店舗スコープ制限つき）から取得し、
 * 商品の分解・集計はすべてこのファイル内（ブラウザ側）で行う。
 *
 * 【データ上の制約（重要）】
 *  ・注文内容(items_text)は「商品名x数量, 商品名, …」という1注文1文字列で、商品ごとの単価・金額は無い。
 *    → 商品の「数量」「注文数」は正確。商品別「売上」は【推定】（下記の按分）。
 *  ・按分: 1品だけの注文から商品ごとの単価（中央値）を学習 → 複数品の注文は 単価×数量 の比で注文の売上を配分
 *    （単価が未学習の商品は既知商品の平均単価で代用。合計は必ず注文の売上に一致する）。
 *  ・CANCELは売上がマイナスの別行として入っている → 同じ符号を数量・注文数にも掛けて相殺する。
 */
(function () {
  const st = { loading: false, loaded: false, err: '', rows: [], period: '30', store: 'all', metric: 'qty', at: 0 };

  // 時間帯区分（ユーザー要望: 時間帯別の売上と、時間帯ごとに何が注文されているか）
  const BANDS = [
    { key: 'am',  label: '〜10時台',        from: 0,  to: 11 },
    { key: 'lun', label: 'ランチ 11〜14時台', from: 11, to: 15 },
    { key: 'aft', label: '午後 15〜16時台',  from: 15, to: 17 },
    { key: 'din', label: 'ディナー 17〜21時台', from: 17, to: 22 },
    { key: 'ngt', label: '夜 22時〜',        from: 22, to: 24 },
  ];
  const bandOf = (h) => (BANDS.find((b) => h >= b.from && h < b.to) || BANDS[BANDS.length - 1]);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  // "キジ焼丼 ゆずこしょう付きx2, 砂肝串 2本" → [{name, qty}]。区切りは「カンマ＋空白」、数量は末尾の「x数字」。
  function parseItems(text) {
    return String(text || '').split(/,\s+/).map((s) => s.trim()).filter(Boolean).map((t) => {
      const m = t.match(/^(.*?)\s*[x×](\d+)$/);
      return m && m[1] ? { name: m[1].trim(), qty: Number(m[2]) } : { name: t, qty: 1 };
    });
  }
  const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

  function inPeriod(dateStr, ref) {
    if (st.period === 'all') return true;
    const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
    const days = Number(st.period);
    return (ref - d) / 86400000 < days;
  }

  // rows: [[店舗名, 日時, 取引タイプ, 注文番号, 注文内容, 売上], ...(先頭はヘッダー)]
  function analyze() {
    const all = st.rows.slice(1).map((r) => ({ store: r[0], at: String(r[1]).replace('T', ' '), type: r[2], no: r[3], items: parseItems(r[4]), sales: Number(r[5]) || 0 }));
    const stores = Array.from(new Set(all.map((x) => x.store))).sort();
    let ref = new Date(0);
    all.forEach((x) => { const d = new Date(x.at.slice(0, 10) + 'T00:00:00'); if (d > ref) ref = d; });
    const evs = all.filter((x) => (st.store === 'all' || x.store === st.store) && inPeriod(x.at, ref));
    evs.forEach((e) => {
      e.sign = (e.type === 'CANCEL' || e.sales < 0) ? -1 : 1;
      e.hour = Number(e.at.slice(11, 13));
      e.dow = new Date(e.at.slice(0, 10) + 'T00:00:00').getDay();
    });

    // 商品ごとの単価を「1品だけのPAY注文」から学習（全期間・全店のデータを使い、期間/店舗フィルタの影響を受けない）
    const priceSamples = {};
    all.forEach((x) => {
      if (x.sales > 0 && x.type !== 'CANCEL' && x.items.length === 1 && x.items[0].qty > 0) {
        (priceSamples[x.items[0].name] = priceSamples[x.items[0].name] || []).push(x.sales / x.items[0].qty);
      }
    });
    const price = {}; let sumP = 0, nP = 0;
    Object.keys(priceSamples).forEach((k) => { price[k] = median(priceSamples[k]); sumP += price[k]; nP++; });
    const avgPrice = nP ? sumP / nP : 0;

    const hour = Array.from({ length: 24 }, () => ({ orders: 0, sales: 0 }));
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    const band = {}; BANDS.forEach((b) => { band[b.key] = { orders: 0, sales: 0, prod: {} }; });
    const prod = {};
    let orders = 0, sales = 0, items = 0;
    const days = new Set();

    evs.forEach((e) => {
      const b = bandOf(e.hour);
      orders += e.sign; sales += e.sales; days.add(e.at.slice(0, 10));
      hour[e.hour].orders += e.sign; hour[e.hour].sales += e.sales;
      heat[e.dow][e.hour] += e.sign;
      band[b.key].orders += e.sign; band[b.key].sales += e.sales;
      // 按分
      const ws = e.items.map((it) => it.qty * (price[it.name] || avgPrice || 1));
      const wsum = ws.reduce((a, c) => a + c, 0) || 1;
      e.items.forEach((it, i) => {
        const q = it.qty * e.sign, s = e.sales * (ws[i] / wsum);
        items += q;
        const p = prod[it.name] || (prod[it.name] = { name: it.name, qty: 0, orders: 0, sales: 0, band: {}, known: !!price[it.name] });
        p.qty += q; p.orders += e.sign; p.sales += s;
        const pb = p.band[b.key] || (p.band[b.key] = { qty: 0, sales: 0 }); pb.qty += q; pb.sales += s;
        const bp = band[b.key].prod[it.name] || (band[b.key].prod[it.name] = { name: it.name, qty: 0, sales: 0 });
        bp.qty += q; bp.sales += s;
      });
    });
    return { stores, orders, sales, items, days: days.size, hour, heat, band, prod: Object.values(prod).sort((a, b) => b.qty - a.qty), ref, count: evs.length };
  }

  function load(force) {
    if (st.loading || (st.loaded && !force)) return;
    if (!S.auth || !S.auth.token) return;
    st.loading = true; st.err = '';
    api({ action: 'bqGetDeliveryOrders', token: S.auth.token }, 60000).then((d) => {
      if (d && d.ok && d.sheets && d.sheets.deliveryOrders) { st.rows = d.sheets.deliveryOrders; st.loaded = true; st.at = Date.now(); }
      else st.err = (d && d.error) || '取得に失敗しました（GASの更新が未反映の可能性があります）';
    }).catch((e) => { st.err = String((e && e.message) || e); }).finally(() => { st.loading = false; if (S.tab === 'delivery' && !targetModalOpen_()) render(); });
  }

  const num = (v) => Math.round(v).toLocaleString('ja-JP');
  const pct = (v, t) => (t > 0 ? (v / t * 100).toFixed(1) + '%' : '—');
  const metricVal = (o) => (st.metric === 'sales' ? o.sales : o.qty);
  const metricFmt = (v) => (st.metric === 'sales' ? yen(v) : num(v));

  function ctrl(stores) {
    const per = [['7', '直近7日'], ['30', '直近30日'], ['90', '直近90日'], ['all', '全期間']];
    return `<div class="ctrl-bar no-print">
      <select onchange="DlvAn.set('store',this.value)"><option value="all">全店舗</option>${stores.map((s) => `<option value="${esc(s)}"${st.store === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      ${per.map(([k, l]) => `<button class="icon-btn${st.period === k ? ' primary' : ''}" onclick="DlvAn.set('period','${k}')">${l}</button>`).join('')}
      <span style="width:10px"></span>
      <button class="icon-btn${st.metric === 'qty' ? ' primary' : ''}" onclick="DlvAn.set('metric','qty')">商品：数量</button>
      <button class="icon-btn${st.metric === 'sales' ? ' primary' : ''}" onclick="DlvAn.set('metric','sales')">商品：推定売上</button>
      <button class="icon-btn" onclick="DlvAn.reload()" title="最新のデータを取り直す">↻ 更新</button>
    </div>`;
  }

  function heatTable(A) {
    let mx = 0; A.heat.forEach((r) => r.forEach((v) => { if (v > mx) mx = v; }));
    const hs = []; for (let h = 10; h <= 23; h++) hs.push(h);
    let h = `<div style="overflow-x:auto"><table class="tbl" style="min-width:560px"><thead><tr><th>曜日＼時</th>${hs.map((x) => `<th style="text-align:center">${x}</th>`).join('')}</tr></thead><tbody>`;
    [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
      h += `<tr><td><b>${WD[d]}</b></td>` + hs.map((x) => {
        const v = A.heat[d][x]; const a = mx > 0 ? Math.max(0, v) / mx : 0;
        return `<td style="text-align:center;background:rgba(181,80,47,${(a * 0.75).toFixed(2)});color:${a > 0.55 ? '#fff' : 'inherit'}">${v || ''}</td>`;
      }).join('') + '</tr>';
    });
    return h + '</tbody></table></div><div class="sub" style="margin-top:6px">数値＝注文数（期間内の合計。濃いほど多い）</div>';
  }

  function bandCards(A) {
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px">` + BANDS.map((b) => {
      const B = A.band[b.key];
      const list = Object.values(B.prod).sort((x, y) => metricVal(y) - metricVal(x)).slice(0, 8);
      const tot = Object.values(B.prod).reduce((a, c) => a + metricVal(c), 0);
      const mx = list.length ? metricVal(list[0]) : 0;
      return `<div style="border:1px solid var(--line2);border-radius:10px;padding:10px 12px;background:var(--panel)">
        <div style="font-weight:700;font-size:13px">${b.label}</div>
        <div class="sub">${num(B.orders)}注文 ／ ${yen(B.sales)}</div>
        ${list.length ? list.map((p, i) => `<div style="margin-top:7px;font-size:12px">
          <div style="display:flex;justify-content:space-between;gap:6px"><span>${i + 1}. ${esc(p.name)}</span><span style="white-space:nowrap">${metricFmt(metricVal(p))}<span class="sub"> ${pct(metricVal(p), tot)}</span></span></div>
          <div style="height:5px;background:#efe9dd;border-radius:3px;margin-top:2px"><div style="height:5px;width:${mx > 0 ? (metricVal(p) / mx * 100).toFixed(0) : 0}%;background:#b5502f;border-radius:3px"></div></div></div>`).join('') : '<div class="sub" style="margin-top:8px">注文なし</div>'}
      </div>`;
    }).join('') + '</div>';
  }

  function prodTable(A) {
    const tot = A.prod.reduce((a, c) => a + metricVal(c), 0);
    const bmx = {}; BANDS.forEach((b) => { bmx[b.key] = 0; });
    A.prod.forEach((p) => BANDS.forEach((b) => { const v = p.band[b.key] ? metricVal(p.band[b.key]) : 0; if (v > bmx[b.key]) bmx[b.key] = v; }));
    let h = `<div style="overflow-x:auto"><table class="tbl" style="min-width:760px"><thead><tr><th>商品</th><th style="text-align:right">数量</th><th style="text-align:right">注文数</th><th style="text-align:right">推定売上</th><th style="text-align:right">構成比</th>${BANDS.map((b) => `<th style="text-align:center">${b.label.split(' ')[0]}</th>`).join('')}</tr></thead><tbody>`;
    A.prod.forEach((p) => {
      h += `<tr><td>${esc(p.name)}${p.known ? '' : ' <span class="sub" title="単品注文が無く単価を学習できていないため、売上は平均単価での按分です">※</span>'}</td><td style="text-align:right">${num(p.qty)}</td><td style="text-align:right">${num(p.orders)}</td><td style="text-align:right">${yen(p.sales)}</td><td style="text-align:right">${pct(metricVal(p), tot)}</td>` +
        BANDS.map((b) => {
          const v = p.band[b.key] ? metricVal(p.band[b.key]) : 0; const a = bmx[b.key] > 0 ? Math.max(0, v) / bmx[b.key] : 0;
          return `<td style="text-align:center;background:rgba(61,81,99,${(a * 0.55).toFixed(2)});color:${a > 0.5 ? '#fff' : 'inherit'}">${v ? (st.metric === 'sales' ? compact(v) : num(v)) : ''}</td>`;
        }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function view() {
    if (!st.loaded && !st.loading && !st.err) setTimeout(() => load(false), 0);
    if (st.loading && !st.loaded) return `<div class="panel"><div class="empty">デリバリー注文データを読み込み中…</div></div>`;
    if (st.err && !st.loaded) return `<div class="panel"><div class="empty">${esc(st.err)}<br><button class="icon-btn" onclick="DlvAn.reload()">再読み込み</button></div></div>`;
    if (!st.loaded) return `<div class="panel"><div class="empty">読み込み中…</div></div>`;
    const A = analyze();
    const label = ({ '7': '直近7日', '30': '直近30日', '90': '直近90日', all: '全期間' })[st.period];
    const hrs = []; for (let h = 10; h <= 23; h++) hrs.push(h);
    const cat = hrs.map((h) => h + '時');
    let h = ctrl(A.stores);
    if (!A.count) return h + `<div class="panel"><div class="empty">この条件のデリバリー注文はありません</div></div>`;
    h += `<div class="kpi-grid" style="margin:10px 0">
      <div class="kpi"><div class="lb">注文数</div><div class="vl">${num(A.orders)}件</div><div class="yy">${label}・${A.days}日分</div></div>
      <div class="kpi"><div class="lb">売上</div><div class="vl">${yen(A.sales)}</div><div class="yy">1日平均 ${yen(A.days ? A.sales / A.days : 0)}</div></div>
      <div class="kpi"><div class="lb">平均注文単価</div><div class="vl">${yen(A.orders ? A.sales / A.orders : 0)}</div><div class="yy">1注文あたり</div></div>
      <div class="kpi"><div class="lb">1注文の点数</div><div class="vl">${A.orders ? (A.items / A.orders).toFixed(2) : '—'}点</div><div class="yy">数量ベース</div></div>
    </div>`;
    h += `<div class="panel"><div class="panel-head"><div><h3>時間帯別 注文数</h3><div class="sub">注文時刻の1時間ごと（${esc(st.store === 'all' ? '全店舗' : st.store)}・${label}）</div></div></div>${barChart(cat, [{ color: '#3d5163', data: hrs.map((x) => A.hour[x].orders) }])}</div>`;
    h += `<div class="panel"><div class="panel-head"><div><h3>時間帯別 売上</h3></div></div>${barChart(cat, [{ color: '#b5502f', data: hrs.map((x) => A.hour[x].sales) }])}</div>`;
    h += `<div class="panel"><div class="panel-head"><div><h3>曜日×時間帯（注文数）</h3></div></div>${heatTable(A)}</div>`;
    h += `<div class="panel"><div class="panel-head"><div><h3>時間帯ごとの人気商品</h3><div class="sub">上位8商品・${st.metric === 'sales' ? '推定売上' : '数量'}順</div></div></div>${bandCards(A)}</div>`;
    h += `<div class="panel"><div class="panel-head"><div><h3>商品別（時間帯の内訳つき）</h3><div class="sub">右側の時間帯列＝その商品が各時間帯でどれだけ注文されたか（列ごとに濃淡）。<b>売上は推定</b>：注文の売上を商品の単価比で按分しています（※＝単品注文が無く平均単価で代用）。数量・注文数は正確です。</div></div></div>${prodTable(A)}</div>`;
    try {
      EXPORT.push({ title: 'デリバリー商品別（' + label + '・' + (st.store === 'all' ? '全店舗' : st.store) + '）', headers: ['商品', '数量', '注文数', '推定売上'].concat(BANDS.map((b) => b.label + '(数量)')), rows: A.prod.map((p) => [p.name, p.qty, p.orders, Math.round(p.sales)].concat(BANDS.map((b) => (p.band[b.key] ? p.band[b.key].qty : 0)))) });
      EXPORT.push({ title: 'デリバリー時間帯別', headers: ['時', '注文数', '売上'], rows: hrs.map((x) => [x, A.hour[x].orders, A.hour[x].sales]) });
    } catch (e) { /* エクスポート登録の失敗は表示に影響させない */ }
    return h;
  }

  window.DlvAn = {
    view,
    set(k, v) { st[k] = v; render(); },
    reload() { st.loaded = false; load(true); render(); },
    _test: { parseItems, BANDS },
  };
})();
