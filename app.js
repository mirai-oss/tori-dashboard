/* =====================================================================
 * 鳥一代グループ 経営ダッシュボード
 *  - 4権限ログイン（社長 / 本部 / マネージャー / 店舗）
 *  - Googleスプレッドシート(GAS API)からのリアルタイム取得（自動更新）
 *  - CSV / PDF エクスポート
 *  - 全店比較・入金管理（月次日別）・広告管理（シート追加で自動拡張）
 * ===================================================================== */
'use strict';

/* =====================================================================
 * ★本番デプロイ設定★
 * 下の '' の中に、GASウェブアプリのURL（…/exec）を貼り付けると、
 * このダッシュボードを開いた全員（PC・スマホ）が自動でスプレッドシートに
 * 接続されます（各自が接続設定を入力する必要がなくなります）。
 * 例: const DEFAULT_API_URL = 'https://script.google.com/macros/s/XXXX/exec';
 * 空のままなら、従来どおり各ブラウザの接続設定（社長のみ）で設定します。
 * ===================================================================== */
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbz9rd37EZa6X8WRMVEBrXobN8DbYWkHRlhFNYU5rd1UZ0V8j0-6shMQjEeoi4HDWZ0B/exec';

/* ---------------- 定数 ---------------- */
const CANON_STORES = ['芝の鳥一代','鳥一代 はなれ','鳥一代 恵比寿','鳥一代 新橋','鳥一代 本店','鶏武者 新横浜','鶏武者 川崎店','黒霧屋 新横浜'];
const PALETTE = ['#3d5163','#b5502f','#5f7052','#c9a86a','#7d8b6f','#2a6f8f','#9a6a4a','#6a5f8f','#a99f8c','#4a7a6a'];
const C_NOW='#3d5163', C_PREV='#c9b7a0', C_MID='#7d8b6f';
const LS = { api:'toriApiUrl', sess:'toriSession', acc:'toriDemoAccounts', poll:'toriPollSec', months:'toriMonths' };
const ROLE_TABS = {
  '社長':       ['dash','target','analysis','detail','pl','deposit','ad','review','weekly','weeklyAdmin','ai','accounts'],
  '本部':       ['dash','target','analysis','detail','pl','deposit','ad','review','weekly','weeklyAdmin','ai','accounts'],
  'マネージャー':['dash','target','analysis','detail','pl','deposit','ad','review','weekly','weeklyAdmin','ai'],
  '店舗':       ['dash','target','analysis','detail','deposit','review','weekly','ai'],   // PL・広告管理は既定で非表示（アカウントごとの「表示タブ」で変更可）
};
const TAB_LABELS = { dash:'ダッシュボード', target:'目標管理', analysis:'推移分析', detail:'明細分析', pl:'PL（損益）', deposit:'入金管理', ad:'広告管理', review:'口コミ', weekly:'週報', weeklyAdmin:'週報管理', ai:'AI検索', accounts:'アカウント管理' };
// 入力・取込系の機能権限。閲覧は「表示タブ」で、データを書き込む操作はこちらで制御する。
// 既定は権限ごとの ROLE_FEATURES、アカウントごとに上書きしたい場合は「アカウント」シートのI列に保存する。
const FEATURE_LABELS = {
  depositImport:'口座CSVを取込（入金管理）',
  plInput:'経費を入力（PL）',
  adInput:'広告費を入力（広告管理）',
  adSales:'売上を入力（広告管理）',
  rsvImport:'予約CSVを取込（広告管理）',
};
const ALL_FEATURES = Object.keys(FEATURE_LABELS);
const ROLE_FEATURES = {
  '社長':       ALL_FEATURES.slice(),
  '本部':       ALL_FEATURES.slice(),
  'マネージャー':[],   // 既定は閲覧のみ（アカウントごとに個別許可できる）
  '店舗':       [],
};
// 口コミ集約：同じ実店舗にぶら下がる別名店舗（Googleマイビジネスが分かれているケース）
// 親店舗（=分析_日別店舗の店舗名）に、口コミ上の子店舗名をぶら下げる
const REVIEW_CHILDREN = {
  '黒霧屋 新横浜': ['カラオケ 彩-irodori 新横浜アリーナ通り店', 'うお蔵 新横浜'],
  '鶏武者 新横浜': ['匠味 新横浜'],
  '鶏武者 川崎店': ['匠味 川崎'],
};
// コード側の 子→親 逆引き（既定値）。実際の親子は下の関数でスプレッドシート(DB_店舗親子)とも合成する。
const REVIEW_PARENT_CODE = (()=>{ const m={}; Object.keys(REVIEW_CHILDREN).forEach(p=>REVIEW_CHILDREN[p].forEach(c=>m[c]=p)); return m; })();
// 親店舗にぶら下がる子店舗（サブブランド）一覧＝コード既定 ＋ スプレッドシート「DB_店舗親子」(D.storeParent)
function childrenOfStore(parent){
  const kids=(REVIEW_CHILDREN[parent]||[]).slice();
  const sp=D.storeParent||{};
  for(const c in sp){ if(sp[c]===parent && !kids.includes(c)) kids.push(c); }
  return kids;
}
// 子店舗 → 親店舗（スプレッドシート優先）
function parentOfStore(name){ return (D.storeParent&&D.storeParent[name]) || REVIEW_PARENT_CODE[name] || null; }
// 全子店舗の一覧（コード＋シート）
function allChildStores(){ const set=new Set(); Object.keys(REVIEW_CHILDREN).forEach(p=>REVIEW_CHILDREN[p].forEach(c=>set.add(c))); Object.keys(D.storeParent||{}).forEach(c=>set.add(c)); return [...set]; }
// ある親店舗に表示すべき口コミ店舗名（親自身＋子）
function reviewNamesFor(parent){ return [parent].concat(childrenOfStore(parent)); }

// 広告DBの店舗名 → 売上ダッシュボード(分析_日別店舗)の店舗名 のコード内対応表（通常は使わない）。
// 対応表は基本スプレッドシートの「DB_店舗名対応」タブで管理します（D.storeAlias）。
const AD_STORE_ALIAS = {
};
const _norm = (s)=>String(s==null?'':s).replace(/[\s　]/g,'').toLowerCase();
// 広告DB等の店舗名を、売上側の正式な店舗名に解決する（見つからなければ null）
// 優先順: スプレッドシートの対応表(D.storeAlias) → コード内対応表 → 完全一致 → スペース差 → 部分一致
function resolveStore(name){
  if(!name) return null;
  const target = (D.storeAlias&&D.storeAlias[name]) || AD_STORE_ALIAS[name] || name;
  const all=allStores();
  if(all.includes(target)) return target;             // 完全一致（対応表の指定先も含む）
  const nn=_norm(target);
  let hit=all.find(s=>_norm(s)===nn);                  // スペース・全半角の違いを無視
  if(hit) return hit;
  hit=all.find(s=>{ const ns=_norm(s); return ns.length>=2 && (ns.includes(nn)||nn.includes(ns)); }); // 部分一致
  return hit||null;
}
// 名前がサブブランド(子店舗)に一致すれば、その正式な子店舗名を返す（スペース差も吸収）
function matchChildStore(name){
  if(!name) return null;
  const nn=_norm(name);
  return allChildStores().find(c=>{ const nc=_norm(c); return nc===nn || (nc.length>=2 && (nc.includes(nn)||nn.includes(nc))); })||null;
}
// 広告等の店舗名を { own:表示名, parent:売上側の親店舗 } に解決（子店舗は親の下に別表示）。見つからなければ null
function resolveStoreEx(name){
  if(!name) return null;
  const mapped=(D.storeAlias&&D.storeAlias[name])||AD_STORE_ALIAS[name]||name;   // 対応表で別表記を吸収
  const child=matchChildStore(mapped);                                            // サブブランド判定
  const cp=child?parentOfStore(child):null;
  if(child && cp) return { own:child, parent:cp };
  const parent=resolveStore(mapped);
  return parent?{ own:parent, parent }:null;
}
const DEMO_ACCOUNTS = [
  { id:'shacho',   pw:'tori2026',  name:'社長',           role:'社長',        stores:'全店', active:true, memo:'全店舗・全機能' },
  { id:'honbu',    pw:'torihq',    name:'本部 経営管理部', role:'本部',        stores:'全店', active:true, memo:'全店舗・全機能' },
  { id:'yokohama', pw:'toriarea',  name:'横浜エリアMG',    role:'マネージャー', stores:'鶏武者 新横浜, 鶏武者 川崎店, 黒霧屋 新横浜', active:true, memo:'担当店舗のみ' },
  { id:'shiba',    pw:'torishiba', name:'芝の鳥一代',      role:'店舗',        stores:'芝の鳥一代', active:true, memo:'自店のみ' },
];

/* ---------------- 状態 ---------------- */
const S = {
  auth:null, connState:'demo', lastSync:'', loading:false,
  tab:'dash', period:'month', store:'all',
  pDay:'', pMonth:'', pYear:'', pWeekIdx:null, cStart:'', cEnd:'',
  depMonth:'', adMonth:'', plMonth:'', plPeriod:'month', plYear:'', plStart:'', plEnd:'',
  revPeriod:'month', revMonth:'', revWeekIdx:null, revYear:'', revStart:'', revEnd:'',
  aMetric:'sales', aGran:'day', aBreak:'total', aRange:'30', aYoY:true, mediaMode:'media', detailTax:'excl',
  dPeriod:'month', dStore:'all', dRankMode:'sales', dBasis:'checkout', dDay:'', dMonth:'', dYear:'', dWeekIdx:null, dStart:'', dEnd:'',
  tMonth:'', tStore:'',   // 目標管理タブ：対象月・対象店舗
  aiQ:'', aiResult:null, dataVersion:'',
  reportMode:null, invite:null, inviteDone:false, wkWeek:'', wkFStore:'', wkFPos:'', wkFState:'', wkFQ:'',   // {kind:'daily'|'weekly'|'monthly', date:'YYYY-MM-DD'} Lark日報用の1枚カード表示
  accounts:null, accErr:'', modal:null, loginErr:'',
};
const D = { daily:[], media:[], deposit:[], review:[], ad:[], adfx:[], tanka:{}, pl:[], dinii:[], diniiCols:[], targets:[], targetsM:[], events:[], extra:{}, storeAlias:{}, storeParent:{}, mediaClass:{}, adMediaMaster:[], adPlanMaster:{}, adStoreMaster:[], holidays:null, detailData:null, detailKey:'', detailLoading:'', refDate:null, maxDate:null,
  wkTpl:{}, wkRep:[], wkAns:{}, wkFb:{}, roleDef:{} };
let EXPORT = [];      // 現在タブのCSVエクスポート対象 [{title,headers,rows}]
let pollTimer = null;

/* ---------------- 共通ユーティリティ ---------------- */
const $ = (id)=>document.getElementById(id);
const esc = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen = (n)=>'¥'+Math.round(n||0).toLocaleString('ja-JP');
const num = (v)=>parseFloat(String(v==null?'':v).replace(/[^0-9.\-]/g,''))||0;
const cnt = (n)=>Math.round(n||0).toLocaleString('ja-JP');
// 長い店舗名を短縮表示（会社名・建物名トークンを落とし、末尾「店」を除く。本店/支店は残す）
// 例: 横濱ホルモン会館 エース 本厚木店 → エース本厚木 ／ 鶏武者 川崎店 → 鶏武者川崎 ／ 鳥一代 本店 → 鳥一代本店
function shortStore(nm){
  let s=String(nm==null?'':nm).trim(); if(!s) return '';
  const parts=s.split(/[\s　]+/).filter(Boolean);
  const drop=/ホルモン会館|会館|株式会社|有限会社|合同会社|^ビル$|グループ$/;
  let toks=parts.filter(t=>!drop.test(t)); if(!toks.length) toks=parts.slice();
  const last=toks[toks.length-1];
  if(last && /店$/.test(last) && !/^(本店|支店)$/.test(last) && last.length>2) toks[toks.length-1]=last.replace(/店$/,'');
  return toks.join('')||s;
}
// 長い商品名を短縮。コース系は「金額＋種別」に圧縮、一般商品は括弧補足を落として詰める（元名はtitle=で保持）
function shortMenu(nm){
  let s=String(nm==null?'':nm).trim(); if(!s) return '';
  if([...s].length<=16) return s;
  const price=(s.match(/([0-9][0-9,]{2,})\s*円/)||[])[1];
  if(/コース|プラン|飲み放題|食べ放題|飲放|食放/.test(s)){
    // コース／プランが主役（「飲み放題付コース」等）。単品の放題系はそのまま放題表記に。
    const kind=/コース/.test(s)?'コース':/プラン/.test(s)?'プラン':/食べ放題|食放/.test(s)?'食べ放題':'飲み放題';
    return (price?price+'円':'')+kind;
  }
  const base=s.replace(/[【（(\[〔].*?[】）)\]〕]/g,'').replace(/[\s　]+/g,'').trim();
  return ([...base].slice(0,16).join(''))||([...s].slice(0,16).join(''));
}
// 短縮名をhover(title)で元名を見られる<span>にする（テーブルセル用）
const shortStoreTd=(nm)=>`<span title="${esc(nm)}">${esc(shortStore(nm))}</span>`;
const shortMenuTd=(nm)=>`<span title="${esc(nm)}">${esc(shortMenu(nm))}</span>`;
const dayMs = (d)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
const addD = (d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
const sub1y = (d)=>new Date(d.getFullYear()-1,d.getMonth(),d.getDate());
const WD = ['日','月','火','水','木','金','土'];
const mdw = (d)=>(d.getMonth()+1)+'/'+d.getDate()+'('+WD[d.getDay()]+')';
// 日本の祝日（2024〜2027年・振替休日/国民の休日含む）
const JP_HOLIDAYS=new Set(('2024:1/1,1/8,2/11,2/12,2/23,3/20,4/29,5/3,5/4,5/5,5/6,7/15,8/11,8/12,9/16,9/22,9/23,10/14,11/3,11/4,11/23|'+
 '2025:1/1,1/13,2/11,2/23,2/24,3/20,4/29,5/3,5/4,5/5,5/6,7/21,8/11,9/15,9/23,10/13,11/3,11/23,11/24|'+
 '2026:1/1,1/12,2/11,2/23,3/20,4/29,5/3,5/4,5/5,5/6,7/20,8/11,9/21,9/22,9/23,10/12,11/3,11/23|'+
 '2027:1/1,1/11,2/11,2/23,3/21,3/22,4/29,5/3,5/4,5/5,7/19,8/11,9/20,9/23,10/11,11/3,11/23')
 .split('|').flatMap(y=>{ const[Y,ds]=y.split(':'); return ds.split(',').map(md=>Y+'-'+md); }));
// 祝日判定：内蔵テーブル（〜2027）＋ スプレッドシート「DB_祝日」で追加した分（D.holidays）
const isJpHoliday=(d)=>{ const k=d.getFullYear()+'-'+(d.getMonth()+1)+'/'+d.getDate(); return JP_HOLIDAYS.has(k)||(D.holidays&&D.holidays.has(k)); };
const isRedDay=(d)=>d.getDay()===0||d.getDay()===6||isJpHoliday(d);   // 土日祝
// HTML用の日付表示：M/D(曜) — 土日祝は曜日を赤に。祝日は「祝」を付記
const mdwH=(d)=>{ const wd=WD[d.getDay()]+(isJpHoliday(d)?'・祝':'');
  return (d.getMonth()+1)+'/'+d.getDate()+'(<span'+(isRedDay(d)?' class="wd-hol"':'')+'>'+wd+'</span>)'; };
const compact = (v)=>{ v=v||0; if(v>=1e8)return (v/1e8).toFixed(2)+'億'; if(v>=1e4)return Math.round(v/1e4)+'万'; return Math.round(v).toLocaleString('ja-JP'); };
const parseDateStr = (ds)=>{ const m=String(ds==null?'':ds).match(/(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})/); if(!m)return 0; const Y=+m[1],M=+m[2],Dd=+m[3]; if(!Y||!M||!Dd)return 0; return new Date(Y,M-1,Dd).getTime(); };  // "2026/07/01 12:34"や"2026年7月1日"も対応
// 「2025/01」「2025-1」「2025年1月」など年月だけの表記は月初日として解釈（広告費DB連携用）
const parseYm = (ds)=>{ const s=String(ds==null?'':ds).trim(); let m=s.match(/^(\d{4})\s*[年\/\-\.]\s*(\d{1,2})/); if(!m)m=s.match(/^(\d{4})(\d{2})$/); if(!m)return 0; const M=+m[2]; if(M<1||M>12)return 0; return new Date(+m[1],M-1,1).getTime(); };

function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._tm); t._tm=setTimeout(()=>t.classList.remove('show'),2600); }

/* =====================================================================
 * 天気（Open-Meteo：APIキー不要・CORS対応・無料）
 * 売上と天気の関係を見るため、日別の実績天気と16日先までの予報を表示する。
 * 台風級の暴風・雷雨・大雨・大雪は目立つバッジで警告する。
 * ===================================================================== */
// 店舗名のキーワード → 観測地点。該当しなければ東京。
const WX_LOCS=[
  { key:'yokohama', re:/新横浜|横浜|川崎|うお蔵|黒霧屋|鶏武者|匠味|彩/, lat:35.4437, lon:139.6380, name:'横浜' },
  { key:'atsugi',   re:/本厚木|厚木|エース/,                            lat:35.4408, lon:139.3648, name:'本厚木' },
  { key:'tokyo',    re:/.*/,                                            lat:35.6895, lon:139.6917, name:'東京' }
];
function wxLocOf(store){ const s=String(store||''); return WX_LOCS.find(l=>l.re.test(s))||WX_LOCS[WX_LOCS.length-1]; }
// WMO天気コード → 表示。alert: typhoon/thunder/rain/snow は強調表示する
const WX_CODES={
  0:{i:'☀️',t:'快晴'}, 1:{i:'🌤️',t:'晴れ'}, 2:{i:'⛅',t:'晴れ時々くもり'}, 3:{i:'☁️',t:'くもり'},
  45:{i:'🌫️',t:'霧'}, 48:{i:'🌫️',t:'霧（着氷）'},
  51:{i:'🌦️',t:'霧雨'}, 53:{i:'🌦️',t:'霧雨'}, 55:{i:'🌧️',t:'強い霧雨'},
  56:{i:'🌧️',t:'着氷性の霧雨'}, 57:{i:'🌧️',t:'着氷性の霧雨'},
  61:{i:'🌦️',t:'小雨'}, 63:{i:'🌧️',t:'雨'}, 65:{i:'🌧️',t:'大雨',alert:'rain'},
  66:{i:'🌧️',t:'着氷性の雨'}, 67:{i:'🌧️',t:'着氷性の雨',alert:'rain'},
  71:{i:'🌨️',t:'小雪'}, 73:{i:'🌨️',t:'雪'}, 75:{i:'❄️',t:'大雪',alert:'snow'}, 77:{i:'🌨️',t:'霧雪'},
  80:{i:'🌦️',t:'にわか雨'}, 81:{i:'🌧️',t:'強いにわか雨'}, 82:{i:'⛈️',t:'激しいにわか雨',alert:'rain'},
  85:{i:'🌨️',t:'にわか雪'}, 86:{i:'❄️',t:'強いにわか雪',alert:'snow'},
  95:{i:'⛈️',t:'雷雨',alert:'thunder'}, 96:{i:'🌩️',t:'雷雨（ひょう）',alert:'thunder'}, 99:{i:'🌩️',t:'激しい雷雨（ひょう）',alert:'thunder'}
};
const WX_ALERT={
  typhoon:{ i:'🌀', t:'台風級の暴風', bg:'#f7e6e2', bd:'#d9a294', fg:'#b5502f' },
  thunder:{ i:'⛈️', t:'雷雨',        bg:'#efeaf7', bd:'#b9a8d6', fg:'#6b4fa0' },
  rain:   { i:'🌧️', t:'大雨',        bg:'#e6eff7', bd:'#9dbcd6', fg:'#3d6b93' },
  snow:   { i:'❄️', t:'大雪',        bg:'#eaf2f7', bd:'#a8c4d6', fg:'#3d6b93' }
};
const ymdStr=(t)=>{ const d=new Date(t); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
// 1日ぶんの天気からアラート種別を決める（台風＞雷＞大雨＞大雪）
function wxAlertOf(w){
  if(!w) return null;
  if((w.gust>=25)||(w.wind>=17.2)) return 'typhoon';   // 気象庁の台風基準＝最大風速17.2m/s以上
  const c=WX_CODES[w.code];
  if(c&&c.alert) return c.alert;
  if(w.prec>=50) return 'rain';
  return null;
}
D.wx={}; D.wxLoading={}; D.wxErr='';
const wxKey=(loc,ds)=>loc+'|'+ds;
function wxGet(store,t){ return D.wx[wxKey(wxLocOf(store).key, ymdStr(t))]||null; }
// 指定の地点・期間の天気を取得（未取得ぶんだけ）。取得できたら再描画する。
// 直近92日〜16日先は予報API、それ以前は過去実績API（archive）を使う。
function ensureWeather(stores, fromT, toT){
  if(!(fromT>0)||!(toT>0)) return;
  const today=dayMs(new Date());
  const locs=[...new Set((stores&&stores.length?stores:['']).map(s=>wxLocOf(s).key))];
  locs.forEach(lk=>{
    const loc=WX_LOCS.find(l=>l.key===lk);
    // 未取得の日付があるか
    let need=false;
    for(let t=fromT;t<=toT;t+=86400000){ if(!(wxKey(lk,ymdStr(t)) in D.wx)){ need=true; break; } }
    if(!need) return;
    const recent=fromT>=today-91*86400000;   // 予報APIの past_days は最大92日
    const tag=lk+(recent?'|f':'|a')+'|'+ymdStr(fromT)+'|'+ymdStr(toT);
    if(D.wxLoading[tag]) return;
    D.wxLoading[tag]=1;
    const daily='weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max';
    const base=`latitude=${loc.lat}&longitude=${loc.lon}&daily=${daily}&timezone=Asia%2FTokyo&wind_speed_unit=ms`;
    const url=recent
      ? `https://api.open-meteo.com/v1/forecast?${base}&past_days=92&forecast_days=16`
      : `https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${ymdStr(fromT)}&end_date=${ymdStr(Math.min(toT,today-5*86400000))}`;
    fetch(url).then(r=>r.json()).then(j=>{
      const d=j&&j.daily;
      if(d&&d.time){
        for(let i=0;i<d.time.length;i++){
          D.wx[wxKey(lk,d.time[i])]={
            code:Number(d.weather_code[i]), tmax:d.temperature_2m_max[i], tmin:d.temperature_2m_min[i],
            prec:Number(d.precipitation_sum[i])||0, wind:Number(d.wind_speed_10m_max[i])||0, gust:Number(d.wind_gusts_10m_max[i])||0,
            future:d.time[i]>ymdStr(today)
          };
        }
      }
      // 取得できなかった日も「無し」として記録し、同じ範囲を何度も叩かない
      for(let t=fromT;t<=toT;t+=86400000){ const k=wxKey(lk,ymdStr(t)); if(!(k in D.wx)) D.wx[k]=null; }
      D.wxErr=''; render();
    }).catch(e=>{
      D.wxErr='天気を取得できませんでした（'+e.message+'）';
      for(let t=fromT;t<=toT;t+=86400000){ const k=wxKey(lk,ymdStr(t)); if(!(k in D.wx)) D.wx[k]=null; }
      render();
    });
  });
}
// 表形式の小さい天気セル（アイコン＋気温、警報時は色付きバッジ）
function wxCell(w){
  if(!w) return '<span class="mut">—</span>';
  const c=WX_CODES[w.code]||{i:'･',t:''};
  const al=wxAlertOf(w);
  const temp=(w.tmax!=null?Math.round(w.tmax)+'°':'')+(w.tmin!=null?'/'+Math.round(w.tmin)+'°':'');
  if(al){ const a=WX_ALERT[al];
    return `<span style="display:inline-block;background:${a.bg};border:1px solid ${a.bd};color:${a.fg};border-radius:6px;padding:1px 6px;font-size:11px;font-weight:700;white-space:nowrap">${a.i} ${esc(a.t)}</span>`
      +`<span class="mut" style="font-size:10.5px;margin-left:4px">${temp}</span>`;
  }
  return `<span style="white-space:nowrap">${c.i} <span style="font-size:11px">${esc(c.t)}</span> <span class="mut" style="font-size:10.5px">${temp}</span></span>`;
}
// CSV書き出し用のテキスト（例: 小雨 24°/21° ／ 大雨）
function wxText(w){
  if(!w) return '';
  const c=WX_CODES[w.code]||{t:''};
  const al=wxAlertOf(w);
  const temp=(w.tmax!=null?Math.round(w.tmax)+'°':'')+(w.tmin!=null?'/'+Math.round(w.tmin)+'°':'');
  return [c.t,temp].filter(Boolean).join(' ')+(al?' ／'+WX_ALERT[al].t:'');
}

// CSVテキスト → 行列
function csvToRows(text){
  const rows=[]; let cur='', row=[], q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){ if(q&&text[i+1]==='"'){cur+='"';i++;} else q=!q; }
    else if(c===','&&!q){ row.push(cur); cur=''; }
    else if((c==='\n'||c==='\r')&&!q){ if(c==='\r'&&text[i+1]==='\n')i++; row.push(cur); rows.push(row); row=[]; cur=''; }
    else cur+=c;
  }
  if(cur!==''||row.length){ row.push(cur); rows.push(row); }
  return rows;
}
// ヘッダー行を探す（キーワード全部を含む行）
function findHeader(rows, kws){
  for(let i=0;i<Math.min(rows.length,10);i++){
    const line=rows[i].join(',');
    if(kws.every(k=>line.includes(k))) return i;
  }
  return 0;
}
const colOf = (H,kw)=>H.findIndex(h=>String(h).indexOf(kw)>=0);
// 複数候補のいずれか最初に一致した列を返す（表記揺れ対策）
const colAny = (H,kws)=>{ for(const kw of kws){ const i=colOf(H,kw); if(i>=0) return i; } return -1; };
// 直近取込の結果（診断用）
D.diag = {};

/* ---------------- データ取込 ---------------- */
function ingestDaily(rows){
  const hi=findHeader(rows,['店舗','純売上']);
  const H=rows[hi].map(h=>String(h).trim());
  const iD=colAny(H,['日付','営業日','勤務日','年月日']), iS=colAny(H,['店舗名','店舗']),
        iSl=colAny(H,['純売上','総売上','売上']), iG=colAny(H,['総客数','客数','店内客数','人数']),
        iPA=colAny(H,['アルバイト人件費','PA人件費','ＰＡ人件費']), iEmp=colAny(H,['社員人件費']),
        iL=colAny(H,['人件費合計','人件費']), iC=colAny(H,['仕入金額','仕入','原価']), iCash=colAny(H,['現金']),
        iEmpBase=colAny(H,['社員給与賞与']), iWelf=colAny(H,['法定福利費']), iComm=colAny(H,['通勤手当']),
        iGrp=colAny(H,['組数','客組数','会計組数','会計数']);
  if(iD<0||iS<0||iSl<0){ D.diag.daily='列が見つかりません（必要: 店舗名・日付/営業日・純売上）'; return false; }
  const recs=[]; let max=0;
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const st=String(c[iS]||'').trim(); const t=parseDateStr(c[iD]);
    if(!st||!t) continue;
    recs.push({ store:st, t, sales:num(c[iSl]), guests:num(c[iG]), pa:num(c[iPA]), emp:num(c[iEmp]), labor:num(c[iL]), cost:num(c[iC]), cash:num(c[iCash]),
      groups:(iGrp>=0&&String(c[iGrp]).trim()!=='')?num(c[iGrp]):null,
      empBase:iEmpBase>=0?num(c[iEmpBase]):0, welfare:iWelf>=0?num(c[iWelf]):0, commute:iComm>=0?num(c[iComm]):0 });
    if(t>max)max=t;
  }
  if(!recs.length){ D.diag.daily='0件（ヘッダーは一致したがデータ行なし）'; return false; }
  D.daily=recs; D.maxDate=new Date(max); D.diag.daily='OK '+recs.length+'件';
  D.hasLaborSplit=(iEmpBase>=0&&iWelf>=0&&iComm>=0);
  const jstYest=(()=>{ const n=new Date(Date.now()+9*3600000); return new Date(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()-1).getTime(); })();
  D.refDate=new Date(Math.min(max,jstYest));
  return true;
}
function ingestMedia(rows){
  const hi=findHeader(rows,['店舗','媒体']);
  const H=rows[hi].map(h=>String(h).trim());
  const iS=colAny(H,['店舗名','店舗']), iD=colAny(H,['営業日','日付']), iM=colAny(H,['媒体名','媒体']), iG=colAny(H,['人数','客数']);
  const iN=colAny(H,['純売上','総売上','売上']);
  if(iD<0||iM<0||iN<0){ D.diag.media='列が見つかりません（必要: 営業日/日付・媒体・売上）'; return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const st=String(c[iS]||'').trim(); const t=parseDateStr(c[iD]);
    if(!st||!t) continue;
    recs.push({ store:st, t, media:String(c[iM]||'').trim(), guests:num(c[iG]), net:num(c[iN]) });
  }
  if(!recs.length){ D.diag.media='0件'; return false; }
  D.media=recs; D.diag.media='OK '+recs.length+'件'; return true;
}
function ingestDeposit(rows){
  const hi=findHeader(rows,['店舗','入金']);
  const H=rows[hi].map(h=>String(h).trim());
  const iS=colAny(H,['店舗名','店舗']), iD=colAny(H,['日付','営業日','入金日']), iA=colAny(H,['入金額','入金合計','入金']);
  if(iS<0||iD<0||iA<0){ D.diag.deposit='列が見つかりません（必要: 店舗・日付/営業日・入金額/入金合計）'; return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const st=String(c[iS]||'').trim(); const t=parseDateStr(c[iD]);
    if(!st||!t) continue;
    recs.push({ store:st, t, amount:num(c[iA]) });
  }
  if(!recs.length){ D.diag.deposit='0件'; return false; }
  D.deposit=recs; D.diag.deposit='OK '+recs.length+'件'; return true;
}
function ingestReview(rows){
  const hi=findHeader(rows,['店舗','平均星']);
  const H=rows[hi].map(h=>String(h).trim());
  const iD=colAny(H,['取得日','日付']), iS=colAny(H,['店舗名','店舗']), iC=colAny(H,['累計','件数']), iSt=colAny(H,['平均星','星','評価']), iDl=colOf(H,'前回比');
  if(iS<0||iSt<0){ D.diag.review='列が見つかりません（必要: 店舗名・平均星）'; return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const st=String(c[iS]||'').trim(); if(!st)continue;
    recs.push({ store:st, t:parseDateStr(c[iD])||0, count:num(c[iC]), star:num(c[iSt]), delta:num(c[iDl]) });
  }
  if(!recs.length){ D.diag.review='0件'; return false; }
  D.review=recs; D.diag.review='OK '+recs.length+'件'; return true;
}
function ingestAd(rows){
  // 見出し行を検出：広告費(広告/費用/金額) と 日付/年月/店舗 を含む行。タイトル行が上にあってもズレない
  let hi=-1;
  for(let i=0;i<Math.min(rows.length,12);i++){
    const line=rows[i].map(x=>String(x==null?'':x)).join(',');
    if(/広告費|広告|費用|金額/.test(line) && /年月|日付|店舗/.test(line)){ hi=i; break; }
  }
  if(hi<0) hi=0;
  const H=rows[hi].map(h=>String(h).trim());
  const iD=colAny(H,['日付','年月','年月日']), iS=colOf(H,'店舗'), iM=colOf(H,'媒体');
  let iC=colOf(H,'広告費'); if(iC<0)iC=colOf(H,'広告'); if(iC<0)iC=colOf(H,'費用'); if(iC<0)iC=colOf(H,'金額');
  let iOK=colOf(H,'確認'); if(iOK<0)iOK=colOf(H,'承認');
  if(iD<0||iC<0){ D.diag['広告']='列が見つかりません（必要: 日付または年月・広告費）／見出し行: '+H.filter(Boolean).join('|'); return false; }
  const okVal=(v)=>{const s=String(v==null?'':v).trim().toUpperCase();return s==='TRUE'||s==='✓'||s==='✔'||s==='○'||s==='◯'||s==='済'||s==='OK'||s==='1'||s==='はい';};
  // 「確認」列は"使っている時だけ"フィルタに使う。1つもチェックが無い＝運用していないとみなし、全行を表示（数字を入れたのに未接続、を防ぐ）
  let anyChecked=false;
  if(iOK>=0){ for(let i=hi+1;i<rows.length;i++){ if(okVal(rows[i][iOK])){ anyChecked=true; break; } } }
  const useConfirm = iOK>=0 && anyChecked;
  const recs=[]; let dateSkipped=0;
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i];
    if(useConfirm && !okVal(c[iOK])) continue;
    const t=parseDateStr(c[iD])||parseYm(c[iD]);
    if(!t){ if(String(c[iC]||'').trim()||String(c[iS]||'').trim()) dateSkipped++; continue; }
    recs.push({ store:String(iS>=0?c[iS]||'':'').trim(), t, media:String(iM>=0?c[iM]||'':'').trim(), cost:num(c[iC]) });
  }
  if(!recs.length){ D.diag['広告']='0件'+(dateSkipped>0?'（'+dateSkipped+'行あるが日付/年月列を読めていません）':'（データ行がありません）'); return false; }
  D.ad=recs; D.diag['広告']='OK '+recs.length+'件'+(useConfirm?'（確認済みのみ）':''); return true;
}
// 広告効果シート（DB_広告効果: 年月×店舗×媒体のアクセス数・ネット予約組数/人数・電話数）を取り込む
const isAdFxKey=(k)=>/広告効果|adfx|ad_?kpi|広告kpi/i.test(String(k));
function ingestAdFx(rows){
  let hi=-1;
  for(let i=0;i<Math.min(rows.length,12);i++){
    const line=rows[i].map(x=>String(x==null?'':x)).join(',');
    if(/アクセス/.test(line)&&/予約|組数/.test(line)){ hi=i; break; }
  }
  if(hi<0) hi=0;
  const H=rows[hi].map(h=>String(h).trim());
  const iD=colAny(H,['年月','日付']), iS=colOf(H,'店舗'), iM=colOf(H,'媒体');
  const iA=colOf(H,'アクセス');
  const iG=colAny(H,['ネット予約組数','予約組数','NET件数','NET組数','ネット予約件数','予約件数','組数']);
  let iP=colAny(H,['ネット予約人数','予約人数','NET人数']); if(iP<0){const x=colOf(H,'人数'); if(x>=0&&x!==iG)iP=x;}
  const iT=colAny(H,['電話数','電話']);
  // 以下はダッシュボードの集計には使わないが、売上入力モーダルで既存値を出すために保持する
  const iTel2=colAny(H,['TEL件数']), iTelP=colAny(H,['TEL人数']);
  const iTG=colAny(H,['総組数']), iTP=colAny(H,['総人数']), iTS=colAny(H,['総売上']), iFee=colAny(H,['集客手数料']);
  if(iD<0||(iA<0&&iG<0)){ D.diag['広告効果']='列が見つかりません（必要: 年月・アクセス数または予約組数）／見出し行: '+H.filter(Boolean).join('|'); return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i];
    const t=parseDateStr(c[iD])||parseYm(c[iD]); if(!t)continue;
    const access=iA>=0?num(c[iA]):0, grp=iG>=0?num(c[iG]):0, ppl=iP>=0?num(c[iP]):0, tel=iT>=0?num(c[iT]):0;
    const telCnt=iTel2>=0?num(c[iTel2]):0, telPpl=iTelP>=0?num(c[iTelP]):0;
    const tGrp=iTG>=0?num(c[iTG]):0, tPpl=iTP>=0?num(c[iTP]):0, tSales=iTS>=0?num(c[iTS]):0, fee=iFee>=0?num(c[iFee]):0;
    if(!(access||grp||ppl||tel||telCnt||tGrp||tPpl||tSales||fee))continue;
    recs.push({ store:String(iS>=0?c[iS]||'':'').trim(), t, media:String(iM>=0?c[iM]||'':'').trim(), access, grp, ppl, tel,
      telCnt, telPpl, tGrp, tPpl, tSales, fee });
  }
  if(!recs.length){ D.diag['広告効果']='0件'; return false; }
  D.adfx=recs; D.diag['広告効果']='OK '+recs.length+'件'; return true;
}
// 予約明細（管理シート💾予約DB: 予約一覧CSV貼り付け）。曜日別・当日予約の時刻分析用
const isRsvKey=(k)=>/予約DB|予約明細|予約一覧|reserv/i.test(String(k))||String(k)==='予約';
function ingestRsv(rows){
  if(!rows||!rows.length) return false;
  let hi=-1;
  for(let i=0;i<Math.min(rows.length,5);i++){ const line=rows[i].map(x=>String(x==null?'':x)).join(','); if(/来店日/.test(line)){hi=i;break;} }
  if(hi<0){ D.diag['予約']='見出し行（来店日）が見つかりません'; return false; }
  const H=rows[hi].map(h=>String(h).trim());
  const iD=colOf(H,'来店日'), iT=colOf(H,'来店時間');
  let iP=H.findIndex(h=>h==='人数'); if(iP<0)iP=H.findIndex(h=>/人数/.test(h)&&!/子/.test(h));
  const iS=colOf(H,'ステータス'), iW=colAny(H,['受付窓口','経路','媒体']);
  const iC=colOf(H,'作成日'), iCT=colOf(H,'作成時間');
  const iSt=H.findIndex(h=>/店舗/.test(h));
  if(iD<0){ D.diag['予約']='来店日列がありません／見出し行: '+H.filter(Boolean).join('|'); return false; }
  const hhmm=(v)=>{ const m2=String(v==null?'':v).match(/(\d{1,2}):(\d{2})/); return m2?(+m2[1]+(+m2[2])/60):-1; };
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const t=parseDateStr(c[iD]); if(!t)continue;
    recs.push({ t, hh:iT>=0?hhmm(c[iT]):-1, n:iP>=0?num(c[iP])||0:0,
      st:String(iS>=0?c[iS]||'':'').trim(), win:String(iW>=0?c[iW]||'':'').trim(),
      ct:iC>=0?parseDateStr(c[iC]):0, ch:iCT>=0?hhmm(c[iCT]):-1,
      store:String(iSt>=0?c[iSt]||'':'').trim() });
  }
  if(!recs.length){ D.diag['予約']='0件'; return false; }
  D.rsv=recs; D.diag['予約']='OK '+recs.length+'件'; return true;
}
// 設定単価シート（DB_単価設定: 店舗×媒体の想定客単価）。予想売上＝ネット予約人数×設定単価
const isTankaKey=(k)=>/単価/.test(String(k))||/tanka|unit_?price/i.test(String(k));
function ingestTanka(rows){
  if(!rows||!rows.length) return false;
  const H=rows[0].map(h=>String(h).trim());
  let iS=colOf(H,'店舗'), iM=colOf(H,'媒体'), iV=colAny(H,['設定単価','客単価','単価']);
  let iAvg=colAny(H,['平均1組人数','平均１組人数','1組人数','１組人数','組人数']), iCv=colAny(H,['電話CV','電話ＣＶ','電話成約']);
  let start=1;
  if(iV<0){ iS=0;iM=1;iV=2;start=0; iAvg=-1;iCv=-1; }   // 見出しなし＝A:店舗 B:媒体 C:単価とみなす
  const map={}, avg={}, cv={}; let n=0;
  for(let i=start;i<rows.length;i++){
    const c=rows[i]; const v=num(c[iV]);
    const st=String(iS>=0?c[iS]||'':'').trim(), md=canonMedia(String(iM>=0?c[iM]||'':'').trim());
    const key=st+'|'+md;
    if(iAvg>=0){ const a=num(c[iAvg]); if(a>0) avg[key]=a; }
    if(iCv>=0){ let z=num(c[iCv]); if(z>0){ if(z>=1)z=z/100; cv[key]=z; } }  // 30% でも 0.3 でもOK（1以上＝%表記とみなす）
    if(!(v>0))continue;
    map[key]=v; n++;
  }
  if(!n){ D.diag['単価設定']='0件'; return false; }
  D.tanka=map; D.tankaAvg=avg; D.tankaCv=cv; D.diag['単価設定']='OK '+n+'件'; return true;
}
// 設定単価を引く：店舗×媒体 → 店舗のみ → 全店×媒体 → 全店共通 の順
function tankaOf(store,cm){
  const t=D.tanka||{};
  return t[store+'|'+cm]||t[store+'|']||t['|'+cm]||t['|']||0;
}
// 平均1組人数・電話CV も同じ優先順位で引く
function tkOf(m,store,cm){ m=m||{}; return m[store+'|'+cm]||m[store+'|']||m['|'+cm]||m['|']||0; }
function tankaAvgOf(store,cm){ return tkOf(D.tankaAvg,store,cm); }
function tankaCvOf(store,cm){ return tkOf(D.tankaCv,store,cm); }
/* ---- 役職・権限ごとの既定（DB_権限定義） ----
 * 優先順位: アカウント個別の設定 → 役職の行 → 権限の行 → コード内の既定
 * シートを編集すればコード変更なしで全員に反映される。 */
const isRoleDefKey=(k)=>/^権限定義$|^役職定義$/.test(String(k).trim());
function ingestRoleDef(rows){
  if(!rows||rows.length<2){ D.roleDef={}; D.diag['権限定義']='0件'; return false; }
  const H=rows[0].map(h=>String(h).trim());
  const iK=colAny(H,['区分']), iN=colAny(H,['名称','名前']), iT=colAny(H,['表示するタブ','表示タブ','タブ']), iF=colAny(H,['使える機能','機能']);
  if(iN<0){ D.diag['権限定義']='列が見つかりません（必要: 名称）'; return false; }
  const out={}; let n=0;
  for(let i=1;i<rows.length;i++){
    const c=rows[i]; const name=String(c[iN]||'').trim(); if(!name) continue;
    const kind=String(iK>=0?c[iK]||'':'').trim()||'権限';
    out[kind+'|'+name]={ tabs:String(iT>=0?c[iT]||'':'').trim(), feats:String(iF>=0?c[iF]||'':'').trim() };
    n++;
  }
  D.roleDef=out; D.diag['権限定義']='OK '+n+'件'; return true;
}
// シートに書かれた既定を引く（役職優先→権限）。未設定・空欄なら null を返して次の候補へ委ねる
function roleDefOf(field){
  const acc=S.auth&&S.auth.account; if(!acc) return null;
  const d=D.roleDef||{};
  const cand=[acc.position?('役職|'+acc.position):null, acc.role?('権限|'+acc.role):null].filter(Boolean);
  for(const k of cand){ const r=d[k]; if(r&&r[field]) return r[field]; }
  return null;
}
/* ---- 週報（DB_週報 / DB_週報回答 / DB_週報FB / DB_週報テンプレート） ----
 * 週の区切りは「火曜〜翌月曜」。分析タブの月内ブロック週（1-7日…）とは別物。
 * 判定は厳密一致にする（「週報回答」が「週報」にも前方一致してしまうため）。 */
const isWkTplKey=(k)=>/^週報テンプレート$|^週報フォーマット$/.test(String(k).trim());
const isWkAnsKey=(k)=>/^週報回答$/.test(String(k).trim());
const isWkFbKey =(k)=>/^週報FB$|^週報フィードバック$/i.test(String(k).trim());
const isWkRepKey=(k)=>/^週報$/.test(String(k).trim());
// テンプレート: 役職 / 表示順 / 項目名 / 入力形式 / 必須
function ingestWkTemplate(rows){
  if(!rows||rows.length<2){ D.diag['週報テンプレート']='0件'; return false; }
  const H=rows[0].map(h=>String(h).trim());
  const iP=colAny(H,['役職']), iO=colAny(H,['表示順','順']), iL=colAny(H,['項目名','項目','質問']),
        iT=colAny(H,['入力形式','形式']), iR=colAny(H,['必須']);
  if(iP<0||iL<0){ D.diag['週報テンプレート']='列が見つかりません（必要: 役職・項目名）'; return false; }
  const out={};
  for(let i=1;i<rows.length;i++){
    const c=rows[i]; const pos=String(c[iP]||'').trim(), label=String(c[iL]||'').trim();
    if(!pos||!label) continue;
    (out[pos]=out[pos]||[]).push({
      order: iO>=0?(num(c[iO])||i):i, label,
      type: (iT>=0?String(c[iT]||'').trim():'')||'長文',
      required: iR<0?true:/^(TRUE|1|はい|必須|○|◯)$/i.test(String(c[iR]||'').trim()),
    });
  }
  Object.keys(out).forEach(k=>out[k].sort((a,b)=>a.order-b.order));
  D.wkTpl=out; D.diag['週報テンプレート']='OK '+Object.keys(out).length+'役職'; return true;
}
// 提出記録: ID / 週開始日 / 投稿者ID / 投稿者名 / 店舗 / 役職 / 提出日時 / 更新日時
function ingestWkReports(rows){
  if(!rows||rows.length<2){ D.wkRep=[]; D.diag['週報']='0件'; return false; }
  const H=rows[0].map(h=>String(h).trim());
  const iId=colAny(H,['ID']), iW=colAny(H,['週開始日','週']), iU=colAny(H,['投稿者ID']), iN=colAny(H,['投稿者名']),
        iS=colAny(H,['店舗']), iP=colAny(H,['役職']), iT=colAny(H,['提出日時']);
  if(iId<0||iW<0||iU<0){ D.diag['週報']='列が見つかりません'; return false; }
  const recs=[];
  for(let i=1;i<rows.length;i++){
    const c=rows[i]; const id=String(c[iId]||'').trim(); const t=parseDateStr(c[iW]);
    if(!id||!t) continue;
    recs.push({ id, week:t, userId:String(c[iU]||'').trim(), userName:String(iN>=0?c[iN]||'':'').trim(),
      store:String(iS>=0?c[iS]||'':'').trim(), position:String(iP>=0?c[iP]||'':'').trim(),
      submittedAt:iT>=0?parseDateStr(c[iT]):0 });
  }
  D.wkRep=recs; D.diag['週報']='OK '+recs.length+'件'; return true;
}
// 回答（縦持ち）: 週報ID / 表示順 / 項目名 / 回答
function ingestWkAnswers(rows){
  if(!rows||rows.length<2){ D.wkAns={}; D.diag['週報回答']='0件'; return false; }
  const H=rows[0].map(h=>String(h).trim());
  const iId=colAny(H,['週報ID']), iO=colAny(H,['表示順','順']), iL=colAny(H,['項目名','項目']), iV=colAny(H,['回答']);
  if(iId<0||iL<0){ D.diag['週報回答']='列が見つかりません'; return false; }
  const map={}; let n=0;
  for(let i=1;i<rows.length;i++){
    const c=rows[i]; const id=String(c[iId]||'').trim(); if(!id) continue;
    (map[id]=map[id]||[]).push({ order:iO>=0?(num(c[iO])||i):i, label:String(c[iL]||'').trim(), value:String(iV>=0?c[iV]||'':'') });
    n++;
  }
  Object.keys(map).forEach(k=>map[k].sort((a,b)=>a.order-b.order));
  D.wkAns=map; D.diag['週報回答']='OK '+n+'件'; return true;
}
// フィードバック: ID / 週報ID / 投稿者ID / 投稿者名 / 本文 / 日時
function ingestWkFb(rows){
  if(!rows||rows.length<2){ D.wkFb={}; D.diag['週報FB']='0件'; return false; }
  const H=rows[0].map(h=>String(h).trim());
  const iR=colAny(H,['週報ID']), iU=colAny(H,['投稿者ID']), iN=colAny(H,['投稿者名']), iB=colAny(H,['本文']), iT=colAny(H,['日時']);
  if(iR<0||iB<0){ D.diag['週報FB']='列が見つかりません'; return false; }
  const map={}; let n=0;
  for(let i=1;i<rows.length;i++){
    const c=rows[i]; const rid=String(c[iR]||'').trim(); const body=String(c[iB]||'').trim();
    if(!rid||!body) continue;
    (map[rid]=map[rid]||[]).push({ userId:String(iU>=0?c[iU]||'':'').trim(), userName:String(iN>=0?c[iN]||'':'').trim(),
      body, t:iT>=0?parseDateStr(c[iT]):0 });
    n++;
  }
  D.wkFb=map; D.diag['週報FB']='OK '+n+'件'; return true;
}
// PL経費シート（DB_PL: 年月×店舗×費目×金額の縦持ち）を取り込む
const isPLKey=(k)=>/^pl$|^ＰＬ$|損益|pl経費|経費db/i.test(String(k).trim());
// ダイニー来店アンケート（また来たいと思いますか？の点数）を取り込む
const isDiniiKey=(k)=>/ダイニー|dinii/i.test(String(k));
function ingestDinii(rows){
  // 見出し行：店舗 ＋「また来たい/またきたい」を含む行を探す
  let hi=-1;
  for(let i=0;i<Math.min(rows.length,12);i++){
    const line=rows[i].map(x=>String(x==null?'':x)).join(',');
    if(/また来|またき/.test(line)&&/店舗/.test(line)){ hi=i; break; }
  }
  if(hi<0) hi=0;
  const H=rows[hi].map(h=>String(h).trim());
  const iS=colAny(H,['店舗名','店舗']), iD=colAny(H,['来店日','来店','日付','営業日','タイムスタンプ','回答日']);  // 来店日時を最優先（回答日時より前）
  let iQ=H.findIndex(h=>/また来|またき/.test(h));
  if(iQ<0&&H.length>6) iQ=6;   // 見出しで見つからなければG列を採用
  if(iS<0||iQ<0){ D.diag['dinii']='列が見つかりません（必要: 店舗名・また来たい点数）／見出し行: '+H.filter(Boolean).join('|'); return false; }
  // アンケートの設問列（自由記述・カテゴリ）をすべて拾う。店舗/日時/来店回数/再来店点数/LINE IDなどのメタ列は除外。
  const metaRe=/^(店舗|来店回数|回数|回答日|来店日|来店日時|営業日|日付|タイムスタンプ|当店にまた来|また来|またき)|LINE\s?ID|LINEID|ラインID/i;
  const qCols=[];
  for(let c=0;c<H.length;c++){
    if(c===iS||c===iD||c===iQ) continue;
    const nm=String(H[c]||'').trim();
    if(!nm||metaRe.test(nm)) continue;
    qCols.push({ idx:c, name:nm });
  }
  D.diniiCols=qCols;
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const st=String(c[iS]||'').trim(); if(!st)continue;
    // 0点も有効回答としてカウントする。除外するのは「空欄」と「数字を含まないテキスト（未回答等）」のみ
    const raw=String(c[iQ]==null?'':c[iQ]).trim().replace(/[０-９]/g,ch=>String.fromCharCode(ch.charCodeAt(0)-0xFEE0));  // 全角数字→半角
    if(raw===''||!/[0-9]/.test(raw)) continue;
    // 各設問の回答を保持（空欄はスキップ）
    const ans={};
    qCols.forEach(q=>{ const v=String(c[q.idx]==null?'':c[q.idx]).trim(); if(v) ans[q.name]=v; });
    recs.push({ store:st, t:iD>=0?(parseDateStr(c[iD])||0):0, score:num(raw), ans });
  }
  if(!recs.length){ D.diag['dinii']='0件（また来たい点数の列に数値がありません）'; return false; }
  D.dinii=recs; D.diag['dinii']='OK '+recs.length+'件 ／ 設問'+qCols.length+'列'; return true;
}
// 対象店舗×期間のダイニー平均（期間内に回答が無ければ累計も返す）
function diniiStats(storeNames, a, b){
  const set=new Set(storeNames); const rc={};
  let sum=0,n=0,allSum=0,allN=0;
  for(const r of D.dinii){
    const res=(r.store in rc)?rc[r.store]:(rc[r.store]=resolveStoreEx(r.store));
    const p=res?res.parent:r.store;
    if(!set.has(p)) continue;
    allSum+=r.score; allN++;
    if(r.t>=a&&r.t<=b){ sum+=r.score; n++; }
  }
  return { avg:n>0?sum/n:null, count:n, allAvg:allN>0?allSum/allN:null, allCount:allN };
}
// 区分（F=仕入れ / L=人件費 / A=広告 / R=家賃 / O=他）の正規化。全角・日本語表記も吸収
function plCatOf(v){
  const s=String(v==null?'':v).trim().toUpperCase().replace(/[Ａ-Ｚ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0xFEE0));
  if(!s) return 'O';
  if(s[0]==='F'||/仕入|原価/.test(s)) return 'F';
  if(s[0]==='L'||/人件/.test(s)) return 'L';
  if(s[0]==='A'||/広告/.test(s)) return 'A';
  if(s[0]==='R'||/家賃|賃料/.test(s)) return 'R';
  return 'O';
}
function ingestPL(rows){
  // 見出し行を検出（費目/科目 ＋ 年月/日付 ＋ 金額）。タイトル行が上にあってもズレない
  let hi=-1;
  for(let i=0;i<Math.min(rows.length,12);i++){
    const line=rows[i].map(x=>String(x==null?'':x)).join(',');
    if(/費目|科目|項目/.test(line) && /年月|日付/.test(line) && /金額|費用|円/.test(line)){ hi=i; break; }
  }
  if(hi<0) hi=0;
  const H=rows[hi].map(h=>String(h).trim());
  const iD=colAny(H,['年月','日付','年月日']), iS=colAny(H,['店舗名','店舗']), iI=colAny(H,['勘定科目','費目','科目','項目']);
  const iA=colAny(H,['金額','費用','経費']);
  const iK=colAny(H,['区分','分類','カテゴリ']);   // F/L/A/R/O（無ければ全てO=その他扱い）
  const iMemo=colAny(H,['メモ','備考']);           // 経費入力モーダルでの編集時に保持する
  if(iD<0||iI<0||iA<0){ D.diag['PL']='列が見つかりません（必要: 年月・勘定科目・金額）／見出し行: '+H.filter(Boolean).join('|'); return false; }
  const recs=[]; let dateSkipped=0;
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i];
    const item=String(c[iI]||'').trim(); if(!item) continue;
    const t0=parseYm(c[iD])||parseDateStr(c[iD]);
    if(!t0){ dateSkipped++; continue; }
    const d=new Date(t0);
    recs.push({ store:String(iS>=0?c[iS]||'':'').trim(), t:new Date(d.getFullYear(),d.getMonth(),1).getTime(), item, cat:iK>=0?plCatOf(c[iK]):'O', amount:num(c[iA]), memo:iMemo>=0?String(c[iMemo]||'').trim():'' });
  }
  if(!recs.length){ D.diag['PL']='0件'+(dateSkipped>0?'（'+dateSkipped+'行あるが年月を読めていません）':'（データ行がありません）'); return false; }
  D.pl=recs; D.diag['PL']='OK '+recs.length+'件'; return true;
}
// 広告費用対効果_管理シートの ⚙️媒体マスタ / ⚙️プランマスタ。
// 広告費入力モーダルのプルダウン候補（マスタに行を足せばそのまま選択肢が増える）
// 見出し行の検出：指定した列名が「セル単体で」存在する行を探す。
// ※タイトル行（例「■ ⚙️ 媒体マスタ」）にも"媒体"が含まれるため、部分一致で探すと
//   タイトル行を誤検出して隣の媒体ID列を拾ってしまう。完全一致を優先する。
function findHeaderExact(rows, names, maxScan){
  const max=Math.min(rows.length, maxScan||15);
  for(let i=0;i<max;i++){
    const cells=(rows[i]||[]).map(c=>String(c==null?'':c).trim());
    if(names.every(n=>cells.some(c=>c===n))) return i;
  }
  for(let i=0;i<max;i++){   // 完全一致が無ければ部分一致（ただし2セル以上埋まっている行＝タイトル行を除外）
    const cells=(rows[i]||[]).map(c=>String(c==null?'':c).trim());
    if(cells.filter(Boolean).length<2) continue;
    if(names.every(n=>cells.some(c=>c.indexOf(n)>=0))) return i;
  }
  return -1;
}
const colExact=(H,name)=>H.findIndex(h=>String(h).trim()===name);
// 完全一致 → 部分一致 → 既定列(fallbackIdx) の順で列を決める
const colPick=(H,name,fallbackIdx)=>{ let i=colExact(H,name); if(i<0)i=colOf(H,name); return i>=0?i:(fallbackIdx==null?-1:fallbackIdx); };
// ⚙️媒体マスタ：B=媒体ID / C=媒体名 / D=表示順。媒体名（C列）をプルダウン候補にする
function ingestMediaMaster(rows){
  const hi=findHeaderExact(rows,['媒体名']);
  if(hi<0){ D.diag['媒体マスタ']='見出し行（媒体名）が見つかりません'; return false; }
  const H=rows[hi].map(h=>String(h).trim());
  const iN=colPick(H,'媒体名',2);   // 既定はC列（0始まりで2）
  const iO=colPick(H,'表示順',null);
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const nm=String((rows[i]||[])[iN]||'').trim(); if(!nm)continue;
    out.push({name:nm, order:iO>=0?num(rows[i][iO])||999:999});
  }
  out.sort((a,b)=>a.order-b.order);
  D.adMediaMaster=[...new Set(out.map(x=>x.name))];
  D.diag['媒体マスタ']='OK '+D.adMediaMaster.length+'件（'+String.fromCharCode(65+iN)+'列＝媒体名）'; return true;
}
// ⚙️プランマスタ：B=媒体名 / C=プラン名 / D=種別 / E=標準料金 / F=表示順。媒体名ごとにプラン名（C列）を持つ
function ingestPlanMaster(rows){
  const hi=findHeaderExact(rows,['媒体名','プラン名']);
  if(hi<0){ D.diag['プランマスタ']='見出し行（媒体名・プラン名）が見つかりません'; return false; }
  const H=rows[hi].map(h=>String(h).trim());
  const iM=colPick(H,'媒体名',1);    // 既定はB列
  const iP=colPick(H,'プラン名',2);  // 既定はC列
  const iF=colPick(H,'標準料金',null), iO=colPick(H,'表示順',null);
  const map={};
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i]||[];
    const md=String(r[iM]||'').trim(), pl=String(r[iP]||'').trim(); if(!md||!pl)continue;
    (map[md]=map[md]||[]).push({plan:pl, fee:iF>=0?num(r[iF])||0:0, order:iO>=0?num(r[iO])||999:999});
  }
  for(const k in map) map[k].sort((a,b)=>a.order-b.order);
  D.adPlanMaster=map;
  D.diag['プランマスタ']='OK '+Object.keys(map).length+'媒体 / '+Object.values(map).reduce((s,v)=>s+v.length,0)+'プラン（'+String.fromCharCode(65+iP)+'列＝プラン名）'; return true;
}
// ⚙️店舗マスタ（管理シート）：B=店舗ID / C=店舗名 / D=エリア。広告側の店舗名（匠味（新横浜）等）を
// 広告費・売上入力のプルダウン候補にする。売上側に無い広告専用の店舗もここから選べるようになる。
function ingestAdStoreMaster(rows){
  const hi=findHeaderExact(rows,['店舗名']);
  if(hi<0){ D.diag['広告店舗マスタ']='見出し行（店舗名）が見つかりません'; return false; }
  const H=rows[hi].map(h=>String(h).trim());
  const iN=colPick(H,'店舗名',2);   // 既定はC列
  const iO=colPick(H,'表示順',null);
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const nm=String((rows[i]||[])[iN]||'').trim(); if(!nm)continue;
    out.push({name:nm, order:iO>=0?num(rows[i][iO])||999:999});
  }
  out.sort((a,b)=>a.order-b.order);
  D.adStoreMaster=[...new Set(out.map(x=>x.name))];
  D.diag['広告店舗マスタ']='OK '+D.adStoreMaster.length+'件（'+String.fromCharCode(65+iN)+'列＝店舗名）'; return true;
}
// 広告費・売上入力の店舗候補。⚙️店舗マスタ（広告側の店舗名）を、DB_店舗名対応・DB_店舗親子で
// 売上側の店舗に解決したうえで、そのアカウントの担当店舗ぶんだけに絞る。
// マスタ未受信のときは従来どおり売上側の店舗（scopeStores）を返す。
function adStoreOptions(){
  const sales=scopeStores();
  if(!D.adStoreMaster.length) return sales;
  const acc=S.auth&&S.auth.account;
  const sp=String(acc&&acc.stores||'').trim();
  const isAll=!acc||!sp||sp==='全店';
  const allowed=new Set(sales.map(normStore));
  const out=[];
  D.adStoreMaster.forEach(nm=>{
    if(isAll){ out.push(nm); return; }
    const res=resolveStoreEx(nm);                       // 対応表→親子で売上側の店舗へ解決
    if(res&&allowed.has(normStore(res.parent))) out.push(nm);
  });
  // 売上側にあってマスタに無い店舗（じんべえ等）も選べるように残す
  sales.forEach(nm=>{ if(!out.some(x=>normStore(x)===normStore(nm))) out.push(nm); });
  return out.length?out:sales;
}
// 店舗名対応表シート（左＝広告等の店舗名 / 右＝売上側の正式な店舗名）を取り込む
const isStoreMapKey=(k)=>/店舗名対応|店舗マッピング|店舗名変換|店舗対応|storemap|storealias/i.test(String(k));
function ingestStoreMap(rows){
  const map={};
  if(!Array.isArray(rows)||rows.length<1) return map;
  let start=0;
  const h0=(rows[0]||[]).map(x=>String(x==null?'':x).trim());
  // 1行目が見出しっぽければスキップ
  if(h0.some(c=>/店舗|別名|正式|広告|売上|対応|変換|名/.test(c)) && !h0.join('').match(/[0-9]{3,}/)){
    // 列の特定（左＝別名/広告、右＝正式/売上）。見つからなければ 0,1 列
    let fi=h0.findIndex(c=>/広告|別名|旧|表記|入力|元|マイビジ|変換前|左/.test(c));
    let ti=h0.findIndex(c=>/売上|正式|統一|ダッシュ|分析|正|新|変換後|右/.test(c));
    if(fi<0)fi=0; if(ti<0||ti===fi)ti=fi===0?1:0;
    for(let i=1;i<rows.length;i++){ const r=rows[i]||[]; const f=String(r[fi]||'').trim(), t=String(r[ti]||'').trim(); if(f&&t) map[f]=t; }
    return map;
  }
  // 見出し無し＝1列目→2列目
  for(let i=0;i<rows.length;i++){ const r=rows[i]||[]; const f=String(r[0]||'').trim(), t=String(r[1]||'').trim(); if(f&&t) map[f]=t; }
  return map;
}
// 媒体分類シート（DB_媒体分類）: 媒体名 → 入店用途（予約/フリー/外販…）・営業区分（ランチ/ディナー…）の対応表
const isMediaClassKey=(k)=>/媒体分類|入店用途|営業区分|mediaclass/i.test(String(k));
function ingestMediaClass(rows){
  const map={};
  if(!Array.isArray(rows)||rows.length<1) return false;
  const H=(rows[0]||[]).map(x=>String(x==null?'':x).trim());
  let iM=colAny(H,['媒体']), iU=colAny(H,['入店用途','用途']), iG=colAny(H,['営業区分','区分']);
  let start=1;
  if(iM<0){ iM=0;iU=1;iG=2;start=0; }   // 見出し無し＝A:媒体 B:入店用途 C:営業区分
  let n=0;
  for(let i=start;i<rows.length;i++){
    const c=rows[i]; const md=String(c&&c[iM]!=null?c[iM]:'').trim(); if(!md)continue;
    const use=iU>=0?String(c[iU]==null?'':c[iU]).trim():'';
    const seg=iG>=0?String(c[iG]==null?'':c[iG]).trim():'';
    if(!use&&!seg)continue;
    map[md]={use,seg}; n++;
  }
  D.mediaClass=map; D.diag['媒体分類']='OK '+n+'件';
  return n>0;
}
// 媒体名から 入店用途／営業区分 を判定：DB_媒体分類が最優先、無ければ名前のキーワードで自動判定
// 入店用途: 外販(Live GATE/Peevo/Ring-style/いちご屋…) / リピーター(リピーター/鍋倉/キュア鍋) / 他店パス(本店パス) / フリー / それ以外は予約
// 営業区分: 媒体名に「ランチ」→ランチ、それ以外はすべてディナー
function mediaClassOf(media){
  const s=String(media==null?'':media).trim();
  const hit=D.mediaClass[s];
  const out={ use:hit&&hit.use?hit.use:'', seg:hit&&hit.seg?hit.seg:'' };
  if(!out.use){
    if(/Live\s?GATE|Peevo|Ring-?style|いちご屋|外販|テイクアウト|デリバリ|出前|催事|EC/i.test(s)) out.use='外販';
    else if(/リピーター|鍋倉|キュア鍋/i.test(s)) out.use='リピーター';
    else if(/本店パス|他店パス/i.test(s)) out.use='他店パス';
    else if(/フリー|ウォークイン|walk/i.test(s)) out.use='フリー';
    else out.use='予約';   // その他はすべて予約
  }
  if(!out.seg){
    out.seg=/ランチ|昼/i.test(s)?'ランチ':'ディナー';   // ランチ以外はすべてディナー
  }
  return out;
}
// 祝日シート（DB_祝日）：日付が入ったセルを拾って祝日集合に加える。2028年以降はここに足すだけで反映。
// ===== 目標（予実管理）とイベント情報 =====
// DB_目標（日付,店舗名,売上目標）／ DB_目標月次（年月,店舗名,PA人件費,社員人件費,仕入原価,ダイニー点数,口コミ件数）／
// DB_イベント（ID,日付,イベント名,会場,対象店舗=カンマ区切り,メモ）
const isTargetMKey=(k)=>/目標月次|目標_月次/.test(String(k));
const isTargetKey=(k)=>/^目標$|目標日別/.test(String(k).trim());
const isEventKey=(k)=>/イベント|^event/i.test(String(k));
function ingestTargets(rows){
  const hi=findHeader(rows,['店舗','目標']); const H=rows[hi].map(h=>String(h).trim());
  const iD=colAny(H,['日付','営業日']), iS=colAny(H,['店舗名','店舗']), iV=colAny(H,['売上目標','目標']);
  if(iD<0||iS<0||iV<0){ D.diag['目標']='列不足（日付・店舗名・売上目標）'; return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){ const c=rows[i]; const st=String(c[iS]||'').trim(); const t=parseDateStr(c[iD]);
    if(!st||!t) continue; recs.push({store:st,t,goal:num(c[iV])}); }
  D.targets=recs; D.diag['目標']='OK '+recs.length+'件'; return true;
}
function ingestTargetsM(rows){
  const hi=findHeader(rows,['店舗','人件費']); const H=rows[hi].map(h=>String(h).trim());
  const iM=colAny(H,['年月']), iS=colAny(H,['店舗名','店舗']),
        iPA=colAny(H,['PA人件費率','アルバイト人件費率','PA人件費','アルバイト人件費']), iEmp=colAny(H,['社員人件費率','社員人件費']),
        iC=colAny(H,['仕入原価率','仕入原価','仕入率','原価率','仕入','原価']), iDn=colAny(H,['ダイニー点数','ダイニー']), iRv=colAny(H,['口コミ件数','口コミ']);
  if(iM<0||iS<0){ D.diag['目標月次']='列不足（年月・店舗名）'; return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){ const c=rows[i]; const st=String(c[iS]||'').trim(); const t=parseDateStr(c[iM])||parseYm(c[iM]);
    if(!st||!t) continue;
    recs.push({store:st,t, pa:iPA>=0?num(c[iPA]):0, emp:iEmp>=0?num(c[iEmp]):0, cost:iC>=0?num(c[iC]):0,
      dinii:iDn>=0?num(c[iDn]):0, review:iRv>=0?num(c[iRv]):0});
  }
  D.targetsM=recs; D.diag['目標月次']='OK '+recs.length+'件'; return true;
}
function ingestEvents(rows){
  const hi=findHeader(rows,['イベント','日付']); const H=rows[hi].map(h=>String(h).trim());
  const iId=colAny(H,['ID','id']), iD=colAny(H,['日付']), iN=colAny(H,['イベント名','イベント']),
        iVn=colAny(H,['会場']), iSt=colAny(H,['対象店舗','店舗']), iMemo=colAny(H,['メモ']);
  if(iD<0||iN<0){ D.diag['イベント']='列不足（日付・イベント名）'; return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){ const c=rows[i]; const t=parseDateStr(c[iD]); const nm=String(c[iN]||'').trim();
    if(!t||!nm) continue;
    const stores=String(iSt>=0?c[iSt]||'':'').split(/[,、]/).map(s=>s.trim()).filter(Boolean);
    recs.push({id:String(iId>=0?c[iId]||'':'').trim(), t, name:nm, venue:String(iVn>=0?c[iVn]||'':'').trim(), stores, memo:String(iMemo>=0?c[iMemo]||'':'').trim()});
  }
  D.events=recs; D.diag['イベント']='OK '+recs.length+'件'; return true;
}
// 対象日・対象店舗のイベントを返す（対象店舗のチェックが入っている店舗のみ表示。空＝全店向け）
function eventsFor(t, storeNames){
  const set=new Set(storeNames||[]);
  return D.events.filter(e=>e.t===t && (e.stores.length===0 || e.stores.some(s=>set.has(s))));
}
// イベントを1行の短い文字列にまとめる（会場：イベント名 を「／」区切り）
function eventLineText(evs){
  return evs.map(e=>(e.venue?e.venue+'：':'')+e.name).join('／');
}
// 媒体別売上(分析_媒体別日次)を営業区分（ランチ/ディナー）で集計。営業区分別売上パネルと同じロジック。
function segSplit(scopeSet, a, b, selName){
  let ln=0,dn=0,lg=0,dg=0;
  for(const r of D.media){ const inScope=selName?(r.store===selName):scopeSet.has(r.store); if(!inScope)continue; if(r.t<a||r.t>b)continue;
    if(mediaClassOf(r.media).seg==='ランチ'){ ln+=r.net; lg+=r.guests; } else { dn+=r.net; dg+=r.guests; } }
  return { ln, dn, lg, dg, hasNet:(ln+dn)>0, hasG:(lg+dg)>0 };
}
const isHolidayKey=(k)=>/祝日|祝祭日|holiday/i.test(String(k));
function ingestHoliday(rows){
  const set=new Set(); let n=0;
  if(Array.isArray(rows)){
    for(let i=0;i<rows.length;i++){
      const row=rows[i]; if(!Array.isArray(row)) continue;
      for(const cell of row){
        const t=parseDateStr(cell)||parseYm(cell);   // 「2028/1/1」「2028-01-01」「2028年1月1日」等
        if(t){ const d=new Date(t); set.add(d.getFullYear()+'-'+(d.getMonth()+1)+'/'+d.getDate()); n++; break; } // 1行1日付（最初の日付列を採用）
      }
    }
  }
  D.holidays=set; D.diag['祝日']='OK '+n+'件';
  return true;
}
// 店舗親子シート（左＝子店舗/サブブランド名 / 右＝親店舗＝売上側の店舗）を取り込む → { 子:親 }
const isStoreParentKey=(k)=>/店舗親子|サブブランド|親子|店舗グループ|storeparent|storegroup/i.test(String(k));
function ingestStoreParent(rows){
  const map={};
  if(!Array.isArray(rows)||rows.length<1) return map;
  const h0=(rows[0]||[]).map(x=>String(x==null?'':x).trim());
  let ci=0, pi=1, start=0;
  if(h0.some(c=>/子|親|サブ|ブランド|まとめ|店舗|名/.test(c)) && !h0.join('').match(/[0-9]{3,}/)){
    let a=h0.findIndex(c=>/子|サブ|ブランド|別|表示/.test(c));
    let b=h0.findIndex(c=>/親|まとめ|売上|統合|正/.test(c));
    if(a>=0)ci=a; if(b>=0&&b!==ci)pi=b; if(ci===pi)pi=ci===0?1:0;
    start=1;
  }
  for(let i=start;i<rows.length;i++){ const r=rows[i]||[]; const c=String(r[ci]||'').trim(), p=String(r[pi]||'').trim(); if(c&&p&&c!==p) map[c]=p; }
  return map;
}
function ingestSheets(sheets, partial){
  if(!partial){ D.extra={}; D.diag={}; D.receivedKeys=Object.keys(sheets); D.ad=[]; D.adSrc=''; D.adfx=[]; D.tanka={}; D.rsv=[]; D.pl=[]; D.dinii=[]; D.targets=[]; D.targetsM=[]; D.events=[]; D.storeAlias={}; D.storeParent={}; D.adMediaMaster=[]; D.adPlanMaster={}; D.adStoreMaster=[]; }  // 広告・PL・ダイニー・目標・対応表・親子はフル受信のたびに入れ替え
  else { D.receivedKeys=(D.receivedKeys||[]).concat(Object.keys(sheets)); }
  const known=['daily','media','deposit','review','ad','広告'];
  if(!partial){ known.forEach(k=>{ if(!(k in sheets)) D.diag[k]='シート未受信（接続設定のシート名を確認）'; }); }
  for(const key in sheets){
    const rows=sheets[key];
    if(!Array.isArray(rows)||!rows.length){ if(known.includes(key)) D.diag[key]='空（データ0行）'; continue; }
    if(key==='daily') ingestDaily(rows);
    else if(key==='media') ingestMedia(rows);
    else if(key==='deposit') ingestDeposit(rows);
    else if(key==='review') ingestReview(rows);
    else if(key==='ad'||key==='広告'){ if(ingestAd(rows)) D.adSrc='sheet'; }
    else if(isAdFxKey(key)) ingestAdFx(rows);
    else if(isTankaKey(key)) ingestTanka(rows);
    else if(isRsvKey(key)) ingestRsv(rows);
    else if(isPLKey(key)) ingestPL(rows);
    else if(isDiniiKey(key)) ingestDinii(rows);
    else if(isMediaClassKey(key)) ingestMediaClass(rows);
    else if(isTargetMKey(key)) ingestTargetsM(rows);
    else if(isTargetKey(key)) ingestTargets(rows);
    else if(isEventKey(key)) ingestEvents(rows);
    else if(isHolidayKey(key)) ingestHoliday(rows);
    else if(key==='媒体マスタ') ingestMediaMaster(rows);
    else if(key==='プランマスタ') ingestPlanMaster(rows);
    else if(key==='広告店舗マスタ') ingestAdStoreMaster(rows);
    else if(isStoreParentKey(key)){ D.storeParent=ingestStoreParent(rows); D.diag[key]='OK '+Object.keys(D.storeParent).length+'件の親子'; }
    else if(isStoreMapKey(key)){ D.storeAlias=ingestStoreMap(rows); D.diag[key]='OK '+Object.keys(D.storeAlias).length+'件の対応'; }
    else if(isRoleDefKey(key)) ingestRoleDef(rows);
    else if(isWkTplKey(key)) ingestWkTemplate(rows);
    else if(isWkAnsKey(key)) ingestWkAnswers(rows);   // 「回答」を先に判定（週報にも前方一致するため）
    else if(isWkFbKey(key)) ingestWkFb(rows);
    else if(isWkRepKey(key)) ingestWkReports(rows);
    else D.extra[key]=rows;
  }
}
function loadSampleData(){
  if(window.__DAILY_CSV)   ingestDaily(csvToRows(window.__DAILY_CSV));
  if(window.__SALES_CSV)   ingestMedia(csvToRows(window.__SALES_CSV));
  if(window.__DEPOSIT_CSV) ingestDeposit(csvToRows(window.__DEPOSIT_CSV));
  if(window.__REVIEW_CSV)  ingestReview(csvToRows(window.__REVIEW_CSV));
  // 広告はサンプルを入れない（実データ＝DB_広告のみ表示）。未接続時は「未接続」表示になる。
  if(!D.refDate) D.refDate=new Date();
}

/* ---------------- 店舗・権限 ---------------- */
function allStores(){
  const inData={}; D.daily.forEach(r=>inData[r.store]=1);
  const list=CANON_STORES.filter(n=>inData[n]);
  Object.keys(inData).forEach(n=>{ if(!list.includes(n)) list.push(n); });
  return list.length?list:CANON_STORES.slice();
}
function scopeStores(){
  const acc=S.auth&&S.auth.account; const all=allStores();
  if(!acc) return all;
  const sp=String(acc.stores||'').trim();
  if(!sp||sp==='全店') return all;
  const names=sp.split(/[,、]/).map(s=>s.trim()).filter(Boolean);
  const inScope=all.filter(n=>names.includes(n));
  return inScope.length?inScope:names;
}
// アカウントの「表示タブ」指定をパース。'dash,pl' でも 'ダッシュボード、PL' でもOK。空・不正はnull（＝権限の既定を使う）
function parseTabsSpec(s){
  s=String(s==null?'':s).trim(); if(!s) return null;
  const keys=Object.keys(TAB_LABELS); const out=[];
  s.split(/[,、\/\s]+/).forEach(t=>{
    t=t.trim(); if(!t) return;
    const k=keys.includes(t)?t:keys.find(k2=>TAB_LABELS[k2]===t||TAB_LABELS[k2].indexOf(t)===0);
    if(k&&!out.includes(k)) out.push(k);
  });
  return out.length?out:null;
}
function myTabs(){
  const acc=S.auth&&S.auth.account;
  // 既定はシート（DB_権限定義）→ 無ければコード内の既定
  const base=parseTabsSpec(roleDefOf('tabs'))||ROLE_TABS[acc&&acc.role]||ROLE_TABS['店舗'];
  const ov=parseTabsSpec(acc&&acc.tabs);
  if(!ov) return base;
  const admin=acc&&(acc.role==='社長'||acc.role==='本部');
  // 個別指定があればそれを表示（順序は正規順）。アカウント管理は社長・本部のみ常に表示
  const tabs=Object.keys(TAB_LABELS).filter(k=>k==='accounts'?admin:ov.includes(k));
  return tabs.length?tabs:base;
}
function isAdminRole(){ const a=S.auth&&S.auth.account; return a&&(a.role==='社長'||a.role==='本部'); }
// アカウントの「使える機能」指定をパース。'plInput,adInput' でも '経費を入力、広告費を入力' でもOK。
// 空＝権限の既定に追従（null）／'なし' 等＝1つも許可しない（空配列）を区別する。
function parseFeatureSpec(s){
  s=String(s==null?'':s).trim(); if(!s) return null;
  if(/^(なし|無し|none|-)$/i.test(s)) return [];
  const out=[];
  s.split(/[,、\/\s]+/).forEach(t=>{
    t=t.trim(); if(!t) return;
    const k=ALL_FEATURES.includes(t)?t:ALL_FEATURES.find(k2=>FEATURE_LABELS[k2]===t||FEATURE_LABELS[k2].indexOf(t)===0);
    if(k&&!out.includes(k)) out.push(k);
  });
  return out;
}
// いま操作している人がその機能を使えるか。閲覧タブとは独立に判定する。
function myFeatures(){
  const acc=S.auth&&S.auth.account;
  const ov=parseFeatureSpec(acc&&acc.perms);            // アカウント個別が最優先
  if(ov) return ov;
  const sheet=parseFeatureSpec(roleDefOf('feats'));     // 次にシートの既定
  if(sheet) return sheet;
  return ROLE_FEATURES[acc&&acc.role]||[];
}
function canUse(feature){ return myFeatures().indexOf(feature)>=0; }
// 画面のボタンを隠すだけでなく、操作の入口でも弾く（開発者ツールから直接呼ばれた場合の保険）
function requireFeature(feature){
  if(canUse(feature)) return true;
  toast('この操作の権限がありません（管理者にご確認ください）');
  return false;
}
function selStoreName(){ return S.store==='all'?null:S.store; }

/* ---------------- 集計 ---------------- */
function stat(setNames, a, b, selName){
  const o={sales:0,guests:0,groups:0,hasGroups:false,cost:0,pa:0,emp:0,labor:0,cash:0,empBase:0,welfare:0,commute:0};
  for(const r of D.daily){
    if(r.t<a||r.t>b) continue;
    if(selName){ if(r.store!==selName) continue; }
    else if(setNames && !setNames.has(r.store)) continue;
    o.sales+=r.sales; o.guests+=r.guests; o.cost+=r.cost; o.pa+=r.pa; o.emp+=r.emp; o.labor+=r.labor; o.cash+=r.cash;
    o.empBase+=r.empBase||0; o.welfare+=r.welfare||0; o.commute+=r.commute||0;
    if(r.groups!=null){ o.groups+=r.groups; o.hasGroups=true; }
  }
  return o;
}
function periodRange(){
  const ref=D.refDate||new Date(); const st=S;
  const pI=(s)=>{ const p=String(s).split('-'); return new Date(+p[0],+p[1]-1,(p[2]?+p[2]:1)); };
  const P=S.period;
  let aref=ref;
  if(P==='day'&&st.pDay) aref=pI(st.pDay);
  else if((P==='week'||P==='month')&&st.pMonth){
    const pm=pI(st.pMonth+'-01'); const ld=new Date(pm.getFullYear(),pm.getMonth()+1,0).getDate();
    const cur=(pm.getFullYear()===ref.getFullYear()&&pm.getMonth()===ref.getMonth());
    aref=new Date(pm.getFullYear(),pm.getMonth(),cur?Math.min(ld,ref.getDate()):ld);
  } else if(P==='year'&&st.pYear){ const yy=+st.pYear; aref=(yy===ref.getFullYear())?ref:new Date(yy,11,31); }
  const y=aref.getFullYear(),mo=aref.getMonth(),da=aref.getDate();
  if(P==='day') return { s:new Date(y,mo,da), e:new Date(y,mo,da), label:y+'年'+(mo+1)+'月'+da+'日（'+WD[aref.getDay()]+'）' };
  if(P==='week'){
    const idx=(st.pWeekIdx!=null)?st.pWeekIdx:Math.min(4,Math.floor((da-1)/7));
    const ld=new Date(y,mo+1,0).getDate();
    const sd=idx*7+1, ed=idx<4?Math.min(idx*7+7,ld):ld;
    const cur=(y===ref.getFullYear()&&mo===ref.getMonth()&&ref.getDate()>=sd&&ref.getDate()<=ed);
    return { s:new Date(y,mo,sd), e:new Date(y,mo,cur?Math.min(ed,ref.getDate()):ed), label:y+'年 '+(mo+1)+'月 第'+(idx+1)+'週（'+sd+'日〜'+ed+'日）', weekIdx:idx };
  }
  if(P==='month'){
    const ld=new Date(y,mo+1,0).getDate();
    const cur=(y===ref.getFullYear()&&mo===ref.getMonth());
    return { s:new Date(y,mo,1), e:new Date(y,mo,cur?Math.min(ld,da):ld), label:y+'年 '+(mo+1)+'月度' };
  }
  if(P==='year') return { s:new Date(y,0,1), e:new Date(y,mo,da), label:y+'年（累計）' };
  const cS=st.cStart?pI(st.cStart):addD(aref,-29), cE=st.cEnd?pI(st.cEnd):aref;
  const s2=dayMs(cS)<=dayMs(cE)?cS:cE, e2=dayMs(cS)<=dayMs(cE)?cE:cS;
  return { s:s2, e:e2, label:(s2.getMonth()+1)+'/'+s2.getDate()+'〜'+(e2.getMonth()+1)+'/'+e2.getDate() };
}
function prevRange(r){
  if(S.period==='day') return { s:addD(r.s,-364), e:addD(r.e,-364) };  // 昨年同曜日
  return { s:sub1y(r.s), e:sub1y(r.e) };
}
// 「直前の同種期間」= 前日／前週／前月／前年／前期間（前年ではなく“ひとつ前”）
function prevPeriodRange(r){
  const P=S.period;
  if(P==='day') return { s:addD(r.s,-1), e:addD(r.s,-1) };
  if(P==='month') return { s:new Date(r.s.getFullYear(),r.s.getMonth()-1,1), e:new Date(r.s.getFullYear(),r.s.getMonth(),0) };
  if(P==='year') return { s:new Date(r.s.getFullYear()-1,0,1), e:new Date(r.e.getFullYear()-1,r.e.getMonth(),r.e.getDate()) };
  const len=Math.round((dayMs(r.e)-dayMs(r.s))/86400000);   // 週・期間指定：直前の同じ長さ
  const e=addD(r.s,-1); return { s:addD(e,-len), e };
}
const prevPeriodLabel=()=>({day:'前日',week:'前週',month:'前月',year:'前年',custom:'前期間'})[S.period]||'前期間';
// 前年比の表示（accounting: ▲=マイナス）
function yoyStr(cur,prev,suffix){
  if(!(prev>0)) return { t:'前年 —', cls:'mut' };
  const d=(cur-prev)/prev*100;
  return { t:(suffix||'前年比 ')+(d>=0?'+':'▲')+Math.abs(d).toFixed(1)+'%', cls:d>=0?'up':'dn' };
}
function ptStr(curR,prevR,badWhenUp){
  if(!(prevR>0)) return { t:'前年 —', cls:'mut' };  // 前年データが無い時は比較しない
  const d=(curR-prevR)*100;
  const good=badWhenUp?d<=0:d>=0;
  return { t:'前年 '+(d>=0?'+':'▲')+Math.abs(d).toFixed(1)+'pt', cls:good?'up':'dn' };
}

/* ---------------- SVGチャート ---------------- */
function barChart(cat, series, opts){
  const W=1240,H=260,padT=18,padB=(opts&&opts.twoLine)?46:34,padL=12,padR=12;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  let max=0; series.forEach(s=>s.data.forEach(v=>{if(v>max)max=v;})); max=max*1.14||1;
  const n=cat.length, ns=series.length, groupW=plotW/Math.max(n,1);
  const innerPad=groupW*0.16, gap=Math.max(2,groupW*0.04);
  const barW=Math.max(3,(groupW-innerPad*2-gap*(ns-1))/ns);
  let els='';
  for(let g=0;g<=4;g++){ const y=padT+plotH*g/4; els+=`<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#efe9dd"/>`; }
  cat.forEach((c,i)=>{
    const gx=padL+groupW*i+innerPad;
    series.forEach((s,j)=>{
      const v=s.data[i]||0, bh=plotH*(v/max), x=gx+j*(barW+gap), y=padT+plotH-bh;
      if(bh>0.5) els+=`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2.5" fill="${s.color}"/>`;
      if(v>0&&n<=14) els+=`<text x="${(x+barW/2).toFixed(1)}" y="${(y-4).toFixed(1)}" fill="${j===0?'#3d4a3a':'#9a8f7c'}" font-size="8.5" text-anchor="middle" font-family="Zen Kaku Gothic New">${compact(v)}</text>`;
    });
    const lines=String(c).split('\n');
    els+=`<text x="${(padL+groupW*i+groupW/2).toFixed(1)}" y="${H-(lines[1]?16:9)}" fill="#8c8375" font-size="11" text-anchor="middle" font-family="Zen Kaku Gothic New">${esc(lines[0])}</text>`;
    if(lines[1]) els+=`<text x="${(padL+groupW*i+groupW/2).toFixed(1)}" y="${H-4}" fill="#a99f8c" font-size="9.5" text-anchor="middle" font-family="Zen Kaku Gothic New">${esc(lines[1])}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${els}</svg>`;
}
function fmtAxis(v,M){ if(M==='guests')return cnt(v); if(v>=1e8)return (v/1e8).toFixed(1)+'億'; if(v>=1e4)return Math.round(v/1e4)+'万'; return Math.round(v); }
function lineChart(cat, series, M, opts){
  // 線の右端に系列名（今年/前年など）を直接表示して見分けやすくする
  const nameLabels=series.filter(s=>s.name&&s.data.some(v=>v!=null)).length>0;
  const W=1240,H=(opts&&opts.h)||300,padT=16,padB=34,padL=58,padR=nameLabels?92:16;
  const plotW=W-padL-padR, plotH=H-padT-padB;
  let max=0,min=Infinity;
  series.forEach(s=>s.data.forEach(v=>{ if(v==null)return; if(v>max)max=v; if(v<min)min=v; }));
  if(!isFinite(min))min=0;
  let lo=0;
  if(opts&&opts.zoom&&max>0){ lo=Math.max(0,min-(max-min)*0.3); }
  max=max+(max-lo)*0.12||1;
  const n=cat.length;
  const x=(i)=>n<=1?padL+plotW/2:padL+plotW*i/(n-1);
  const yv=(v)=>padT+plotH-plotH*((v-lo)/(max-lo||1));
  let els='';
  for(let g=0;g<=4;g++){
    const yy=padT+plotH*g/4;
    els+=`<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="#efe9dd"/>`;
    const gv=lo+(max-lo)*(4-g)/4;
    els+=`<text x="${padL-8}" y="${yy+4}" fill="#a99f8c" font-size="10" text-anchor="end" font-family="Zen Kaku Gothic New">${(opts&&opts.axisFmt)?opts.axisFmt(gv):fmtAxis(gv,M)}</text>`;
  }
  const endLbs=[];
  series.forEach(s=>{
    const pts=[];
    s.data.forEach((v,i)=>{ if(v!=null) pts.push([x(i),yv(v)]); });
    if(!pts.length) return;
    els+=`<polyline points="${pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.dash?2:2.6}" ${s.dash?'stroke-dasharray="5 4"':''} stroke-linejoin="round"/>`;
    if(n<=40) pts.forEach(p=>{ els+=`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.8" fill="${s.color}"/>`; });
    if(nameLabels&&s.name){ const last=pts[pts.length-1];
      const nm=String(s.name).length>7?String(s.name).slice(0,6)+'…':String(s.name);
      endLbs.push({ x:last[0]+7, y:last[1]+4, nm, color:s.color }); }
  });
  // ラベル同士の重なりを回避（近いものを上下にずらす）
  endLbs.sort((a2,b2)=>a2.y-b2.y);
  for(let i=1;i<endLbs.length;i++){ if(endLbs[i].y-endLbs[i-1].y<13) endLbs[i].y=endLbs[i-1].y+13; }
  endLbs.forEach(l=>{ els+=`<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" fill="${l.color}" font-size="11.5" font-weight="700" font-family="Zen Kaku Gothic New">${esc(l.nm)}</text>`; });
  const step=Math.max(1,Math.ceil(n/12));
  cat.forEach((c,i)=>{ if(i%step===0||i===n-1) els+=`<text x="${x(i).toFixed(1)}" y="${H-12}" fill="#8c8375" font-size="10.5" text-anchor="middle" font-family="Zen Kaku Gothic New">${esc(c)}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">${els}</svg>`;
}

/* ---------------- API通信 ---------------- */
function apiUrl(){ try{ return localStorage.getItem(LS.api)||DEFAULT_API_URL||''; }catch(e){ return DEFAULT_API_URL||''; } }
async function api(params){
  const url=apiUrl();
  if(!url) throw new Error('APIが未設定です');
  const r=await fetch(url,{ method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(params) });
  if(!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}
function stampNow(){ const n=new Date(); return (n.getMonth()+1)+'/'+n.getDate()+' '+String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0'); }
function monthsWindow(){ const v=localStorage.getItem(LS.months); return v==null?13:Number(v); } // 0=全期間, 既定13ヶ月(前年比の最小)
async function fetchData(silent, opts){
  if(!S.auth||!S.auth.token) return;
  opts=opts||{};
  if(!silent){ S.connState='connecting'; renderHeaderOnly(); }
  try{
    const params={ action:'data', token:S.auth.token, months:monthsWindow() };
    if(opts.only) params.keys=opts.only.join(',');
    if(opts.exclude) params.exclude=opts.exclude.join(',');
    const d=await api(params);
    if(!d.ok){
      if(String(d.error||'').includes('unauthorized')){ doLogout('セッションの有効期限が切れました。再度ログインしてください'); return; }
      throw new Error(d.error||'取得に失敗しました');
    }
    ingestSheets(d.sheets||{}, !!opts.partial);
    if(d.version) S.dataVersion=d.version;
    // daily を含む読込のときだけ接続状態を判定（媒体別だけの追い読みでは変えない）
    if(!opts.only || opts.only.indexOf('daily')>=0){
      S.connState=(D.diag.daily&&D.diag.daily.indexOf('OK')===0)?'live':'livewarn';
    }
    S.lastSync=stampNow();
    render();
  }catch(e){
    if(!opts.partial){ S.connState='error'; if(!silent) toast('データ取得エラー: '+e.message); render(); }
  }
}
// 初回・更新で「本当に重い」データだけ（実測：media=12s/dinii=6.3s/deposit=5.4s/予約=3.3s）。
// 広告・広告効果・単価設定は実測200〜250msと軽いためフェーズ1に含める（除外すると広告管理タブが
// 裏読み完了前に開かれた場合「未接続」と誤診断されてしまうため）。
// フェーズ1では重いものだけ読まず、表示後に裏で優先順に先読みする。
const HEAVY_KEYS=['media','deposit','dinii','予約'];
let prefetchRun=0;
// 初回・更新時：まずダッシュボードに必要な軽いデータだけ出し、重い/他タブ用は裏で先読み
async function fetchDataFast(){
  D.mediaPending=true; D.media=[];                       // サンプル媒体データを一旦クリア
  await fetchData(true, { exclude:HEAVY_KEYS });         // 軽い必須のみ → すぐ表示
  render();
  // data は version を返さないので、初回に署名を取得（次の自動更新のムダ取得を防ぐ）
  fetchVersion().then(v=>{ if(v!==null) S.dataVersion=v; });
  // フェーズ2：裏で先読み。優先順＝ダッシュボード関連(口コミ明細・媒体別)→他タブ(入金・予約)
  const myRun=++prefetchRun;
  (async()=>{
    const groups=[['dinii','media'], ['deposit','予約']];
    for(const g of groups){
      if(myRun!==prefetchRun) return;                    // 新しい読込が始まったら中断（多重先読み防止）
      try{ await fetchData(true, { only:g, partial:true }); }catch(e){}
      if(g.indexOf('media')>=0){ D.mediaPending=false; render(); }
    }
    D.mediaPending=false; render();
  })();
}
// 軽量版：まず署名(version)だけ取り、変化があるときだけフル取得
async function fetchVersion(){
  try{ const v=await api({ action:'version', token:S.auth.token }); if(v&&v.ok) return v.version||''; }catch(e){}
  return null; // 未対応GAS/失敗時は null
}
function touchSyncBadge(){ S.lastSync=stampNow(); const el=document.querySelector('.sync-info'); if(el) el.innerHTML=connBadge(); }
async function syncIfChanged(){
  if(!S.auth||!S.auth.token) return;
  const v=await fetchVersion();
  // 確実に「変化なし」と分かった時だけ重い読込をスキップ。versionが取れない古いGASでは従来通りフル取得。
  if(v!==null && v!=='' && S.dataVersion && v===S.dataVersion){ touchSyncBadge(); return; }
  await fetchDataFast();   // 変化があったら段階読み込みで再取得（軽いものを先に反映）
}
function startPolling(){
  stopPolling();
  if(!S.auth||!S.auth.token) return;
  const sec=Math.max(20, Number(localStorage.getItem(LS.poll)||60));
  pollTimer=setInterval(syncIfChanged, sec*1000);
}
function stopPolling(){ if(pollTimer){ clearInterval(pollTimer); pollTimer=null; } }
document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&S.auth&&S.auth.token) syncIfChanged(); });

/* ---------------- 認証 ---------------- */
function demoAccounts(){
  try{
    const raw=localStorage.getItem(LS.acc);
    if(raw){ const a=JSON.parse(raw); if(Array.isArray(a)&&a.length) return a; }
  }catch(e){}
  return DEMO_ACCOUNTS.map(a=>({...a}));
}
function saveDemoAccounts(list){ try{ localStorage.setItem(LS.acc, JSON.stringify(list)); }catch(e){} }

async function doLogin(){
  const id=($('li-id').value||'').trim(), pw=$('li-pw').value||'';
  if(!id||!pw){ S.loginErr='IDとパスワードを入力してください'; render(); return; }
  S.loginErr='';
  if(apiUrl()){
    try{
      $('li-btn').textContent='認証中…';
      const d=await api({ action:'login', id, pw });
      if(!d.ok){ S.loginErr=d.error||'ログインに失敗しました'; render(); return; }
      S.auth={ token:d.token, account:d.account };
      try{ localStorage.setItem(LS.sess, JSON.stringify(S.auth)); }catch(e){}
      afterLogin();
      // 認証はここで完了 → 先にダッシュボードを表示し、重いデータ取得は裏で行う
      S.connState='connecting';
      render();
      fetchDataFast().then(()=>startPolling());
      return;
    }catch(e){ S.loginErr='API接続エラー: '+e.message+'（接続設定を確認してください）'; render(); return; }
  }
  // デモモード（API未設定）
  const acc=demoAccounts().find(a=>a.id===id&&a.pw===pw);
  if(!acc){ S.loginErr='IDまたはパスワードが違います'; render(); return; }
  if(acc.active===false){ S.loginErr='このアカウントは無効化されています'; render(); return; }
  S.auth={ token:null, account:{ id:acc.id, name:acc.name, role:acc.role, stores:acc.stores, tabs:acc.tabs||'' } };
  try{ localStorage.setItem(LS.sess, JSON.stringify(S.auth)); }catch(e){}
  afterLogin();
  render();
}
function afterLogin(){
  const tabs=myTabs();
  S.tab=tabs[0];
  const sc=scopeStores();
  S.store=(sc.length===1)?sc[0]:'all';
  S.loginErr='';
}
function doLogout(msg){
  if(S.auth&&S.auth.token){ api({action:'logout',token:S.auth.token}).catch(()=>{}); }
  S.auth=null; stopPolling();
  try{ localStorage.removeItem(LS.sess); }catch(e){}
  if(msg) S.loginErr=msg;
  render();
}

/* ---------------- エクスポート ---------------- */
function downloadCsv(){
  if(!EXPORT.length){ toast('このページにはエクスポート対象がありません'); return; }
  let out='';
  EXPORT.forEach(t=>{
    out+=t.title+'\n';
    out+=t.headers.map(csvCell).join(',')+'\n';
    t.rows.forEach(r=>{ out+=r.map(csvCell).join(',')+'\n'; });
    out+='\n';
  });
  const acc=S.auth&&S.auth.account;
  const meta='鳥一代グループ ダッシュボード,'+TAB_LABELS[S.tab]+',出力: '+new Date().toLocaleString('ja-JP')+(acc?','+acc.name:'')+'\n\n';
  const blob=new Blob([new Uint8Array([0xEF,0xBB,0xBF]), meta+out],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  const d=new Date(), ds=d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
  a.download=TAB_LABELS[S.tab]+'_'+ds+'.csv';
  a.click(); URL.revokeObjectURL(a.href);
  toast('CSVをダウンロードしました');
}
// EXPORT の中からタイトルが prefix で始まる表だけをCSV化して単独ダウンロード（各パネルの ⬇CSV ボタン用）
function downloadCsvSection(prefix){
  const tabs=EXPORT.filter(t=>t.title&&t.title.indexOf(prefix)===0);
  if(!tabs.length){ toast('この表のエクスポート対象がありません'); return; }
  let out='';
  tabs.forEach(t=>{ out+=t.title+'\n'+t.headers.map(csvCell).join(',')+'\n'; t.rows.forEach(r=>{ out+=r.map(csvCell).join(',')+'\n'; }); out+='\n'; });
  const blob=new Blob([new Uint8Array([0xEF,0xBB,0xBF]), out],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  const d=new Date(), ds=d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
  a.download=prefix+'_'+ds+'.csv'; a.click(); URL.revokeObjectURL(a.href);
  toast('CSVをダウンロードしました');
}
function csvCell(v){ const s=String(v==null?'':v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function downloadPdf(){ window.print(); }

/* =====================================================================
 * 描画
 * ===================================================================== */
function render(){
  const root=$('root');
  if(S.invite||S.inviteDone){ root.innerHTML=viewRegister(); return; }
  if(!S.auth){ root.innerHTML=viewLogin(); return; }
  if(S.reportMode){ root.innerHTML=viewReport(S.reportMode.kind, S.reportMode.date, S.reportMode.stores, S.reportMode.group); return; }
  EXPORT=[];
  const tabs=myTabs();
  if(!tabs.includes(S.tab)) S.tab=tabs[0];
  let body='';
  if(S.tab==='dash') body=viewDash();
  else if(S.tab==='target') body=viewTarget();
  else if(S.tab==='detail') body=viewDetail();
  else if(S.tab==='analysis') body=viewAnalysis();
  else if(S.tab==='deposit') body=viewDeposit();
  else if(S.tab==='pl') body=viewPL();
  else if(S.tab==='ad') body=viewAd();
  else if(S.tab==='review') body=viewReview();
  else if(S.tab==='weekly') body=viewWeekly();
  else if(S.tab==='weeklyAdmin') body=viewWeeklyAdmin();
  else if(S.tab==='ai') body=viewAI();
  else if(S.tab==='accounts') body=viewAccounts();
  root.innerHTML=`<div class="app">${viewHeader()}${diagBanner()}${viewNav()}${body}</div>${ctxBarHtml()}${S.modal?viewModal():''}`;
}
function renderHeaderOnly(){ /* 軽量更新は全再描画で十分 */ }

// スマホ用：画面下に「いま見ている店舗と期間」を常時表示（タップで先頭へ戻る）
function ctxBarHtml(){
  if(!S.auth||S.reportMode) return '';
  const selName=selStoreName(); const sc=scopeStores();
  const storeLb=selName||(sc.length===allStores().length?'全店':'担当店舗 合算');
  let periodLb='';
  try{
    if(S.tab==='dash') periodLb=periodRange().label;
    else if(S.tab==='analysis'){
      if(S.aView==='dow'){ const m0=anaDowMonth(); periodLb=m0.getFullYear()+'年 '+(m0.getMonth()+1)+'月（曜日別）'; }
      else periodLb=({'30':'直近30日','90':'直近90日','year':'年初来'})[S.aRange]||(S.cStart&&S.cEnd?S.cStart+'〜'+S.cEnd:'期間指定');
    }
    else if(S.tab==='deposit'){ const m0=depMonthDate(); periodLb=m0.getFullYear()+'年 '+(m0.getMonth()+1)+'月'; }
    else if(S.tab==='pl'){
      const P=S.plPeriod||'month';
      if(P==='year') periodLb=(S.plYear||(D.refDate||new Date()).getFullYear())+'年';
      else if(P==='custom') periodLb=(S.plStart||'')+'〜'+(S.plEnd||'');
      else { const m0=plMonthDate(); periodLb=m0.getFullYear()+'年 '+(m0.getMonth()+1)+'月'; }
    }
    else if(S.tab==='ad'){ const ref=D.refDate||new Date(); const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1); periodLb=m0.getFullYear()+'年 '+(m0.getMonth()+1)+'月'; }
    else if(S.tab==='review') periodLb=({week:'週',month:'月',year:'年間',custom:'期間指定'})[S.revPeriod||'month']||'';
  }catch(e){ periodLb=''; }
  if(!periodLb&&!storeLb) return '';
  return `<div class="ctx-bar no-print" onclick="window.scrollTo({top:0,behavior:'smooth'})">
    <span class="cb-store">🏪 ${esc(storeLb)}</span>${periodLb?`<span class="cb-sep">｜</span><span class="cb-period">📅 ${esc(periodLb)}</span>`:''}
    <span class="cb-up">▲ 上へ</span></div>`;
}

function connBadge(){
  if(S.connState==='live') return `<span class="st-live">● スプレッドシート連携中</span>（自動更新）<br>最終同期 ${esc(S.lastSync)}`;
  if(S.connState==='livewarn') return `<span style="color:#b5502f">● 連携中（データ未取込）</span><br>最終同期 ${esc(S.lastSync)}`;
  if(S.connState==='connecting') return `<span style="color:#a2803f">● 同期中…</span>`;
  if(S.connState==='error') return `<span style="color:#b5502f">● 同期エラー</span><br>最終同期 ${esc(S.lastSync||'—')}`;
  return `<span class="st-demo">● サンプルデータ表示中</span><br>接続設定からAPIを登録してください`;
}
// 取込診断バナー（実データが入らなかった時に何が原因か表示）
function diagBanner(){
  if(S.connState!=='livewarn') return '';
  const labels={daily:'分析_日別店舗',media:'分析_媒体別日次',deposit:'入金DB',review:'口コミ推移ログ'};
  let rows='';
  Object.keys(labels).forEach(k=>{
    const st=D.diag[k]||'—';
    const ok=st.indexOf('OK')===0;
    rows+=`<tr><td style="padding:3px 12px 3px 0;white-space:nowrap">${labels[k]}（キー:${k}）</td><td style="padding:3px 0;color:${ok?'#4c7d5c':'#b5502f'}">${esc(st)}</td></tr>`;
  });
  return `<div style="background:#faf0ec;border:1px solid #e8cfc2;border-radius:12px;padding:14px 18px;margin:14px 0;font-size:12.5px;color:#5c5348;line-height:1.7">
    <b style="color:#b5502f">⚠ スプレッドシートには接続できていますが、実データを取り込めていません（サンプル表示のままです）。</b><br>
    下の表で「列が見つかりません」「シート未受信」が出ている箇所を、スプレッドシートの「接続設定」タブのシート名／各シートの1行目の列名で調整してください。<br>
    <table style="margin:8px 0 2px;font-variant-numeric:tabular-nums">${rows}</table>
    <span style="color:#a99f8c">受信したシート: ${esc((D.receivedKeys||[]).join(' , ')||'なし')}</span>
  </div>`;
}

function viewHeader(){
  const acc=S.auth.account;
  const sc=scopeStores();
  const scopeLabel=(String(acc.stores||'')==='全店'||sc.length===allStores().length)?'全店（'+sc.length+'店舗）':sc.length+'店舗担当';
  const r=periodRange();
  return `
  <div class="print-head"><h1>鳥一代グループ 経営ダッシュボード — ${TAB_LABELS[S.tab]}</h1>
    <p>${esc(r.label)} ／ ${esc(acc.name)}（${esc(acc.role)}） ／ 出力: ${new Date().toLocaleString('ja-JP')}</p></div>
  <header class="top">
    <div class="logo-sq">鳥</div>
    <div class="brand"><h1>鳥一代グループ 経営ダッシュボード</h1><p>TORI-ICHIDAI GROUP SALES MONITOR</p></div>
    <div class="top-right">
      <div class="sync-info">${connBadge()}</div>
      <button class="icon-btn" onclick="App.refresh()" title="手動更新">↻ 更新</button>
      ${acc.role==='社長'?`<button class="icon-btn" onclick="App.openConnect()">⚙ 接続設定</button>`:''}
      <button class="icon-btn" onclick="App.csv()">⬇ CSV</button>
      <button class="icon-btn" onclick="App.pdf()">🖨 PDF</button>
      <div class="role-chip">
        <div class="avatar">${esc(acc.role.substring(0,2))}</div>
        <div><div class="nm">${esc(acc.name)}</div><div class="sc">${esc(acc.role)} ／ ${esc(acc.role==='店舗'?sc[0]||'':scopeLabel)}</div></div>
      </div>
      <button class="icon-btn" onclick="App.logout()">ログアウト</button>
    </div>
  </header>`;
}
function viewNav(){
  const tabs=myTabs();
  return `<nav class="tabs">`+tabs.map(t=>{
    const label=(t==='ad'&&!D.ad.length)?TAB_LABELS[t]+'（未接続）':TAB_LABELS[t];
    return `<button class="${S.tab===t?'on':''}" onclick="App.tab('${t}')">${label}</button>`;
  }).join('')+`</nav>`;
}

/* ---------------- ログイン画面 ---------------- */
function viewLogin(){
  const live=!!apiUrl();
  return `
  <div class="login-wrap"><div class="login-card">
    <div class="login-head">
      <div class="login-logo">鳥</div>
      <h1>鳥一代グループ</h1><p>SALES DASHBOARD</p>
    </div>
    <div class="login-body">
      ${S.loginErr?`<div class="login-err">${esc(S.loginErr)}</div>`:''}
      <label>ログインID</label>
      <input id="li-id" type="text" autocomplete="username" placeholder="ID を入力" onkeydown="if(event.key==='Enter')$('li-pw').focus()">
      <label>パスワード</label>
      <input id="li-pw" type="password" autocomplete="current-password" placeholder="パスワードを入力" onkeydown="if(event.key==='Enter')App.login()">
      <button id="li-btn" class="btn-login" onclick="App.login()">ログイン</button>
      ${live?'':`<div class="login-note">
        <b>デモアカウント（API未接続時）</b><br>
        社長: <b>shacho / tori2026</b>　本部: <b>honbu / torihq</b><br>
        マネージャー: <b>yokohama / toriarea</b>　店舗: <b>shiba / torishiba</b>
      </div>`}
    </div>
    <div class="login-foot">
      <span class="conn-pill ${live?'on':''}"><span class="dot"></span>${live?'スプレッドシートAPI 接続済み':'サンプルデータモード'}</span>
      ${(!live || /接続|ネットワーク|fetch|failed/i.test(S.loginErr||''))?`<button onclick="App.openConnect()">接続設定</button>`:`<span style="color:var(--mut2);font-size:11px">接続設定は社長のみ</span>`}
    </div>
  </div></div>${S.modal==='connect'?viewModal():''}`;
}

/* ---------------- ダッシュボード ---------------- */
function storeSegHtml(){
  const sc=scopeStores();
  if(sc.length<=1) return '';
  const allLabel=sc.length===allStores().length?'全店':'担当店舗 合算';
  const opts=[`<option value="all" ${S.store==='all'?'selected':''}>${esc(allLabel)}</option>`]
    .concat(sc.map(n=>`<option value="${esc(n)}" ${S.store===n?'selected':''}>${esc(n)}</option>`)).join('');
  return `<div class="store-pick no-print">
    <span class="sp-lb">🏪 店舗</span>
    <select onchange="App.store(this.value)">${opts}</select>
  </div>`;
}
// 年/月プルダウン＋「今月」ボタン（各画面の月選択を統一）。key=状態キー(depMonth等)、y=年,m=月(0始まり)
// todayCall: 今月ボタンのonclick（省略時は App.ymToday(key)）。todayLabel: ボタン表記
function ymSelect(key, y, m, todayCall, todayLabel){
  const ref=D.refDate||new Date();
  const ys=[].concat(
    D.daily.map(x=>new Date(x.t).getFullYear()),
    (D.ad||[]).map(x=>new Date(x.t).getFullYear())
  ).filter(v=>v>2000);
  ys.push(ref.getFullYear(), y);
  const minY=Math.min(...ys), maxY=Math.max(...ys);
  const years=[]; for(let v=minY;v<=maxY;v++) years.push(v);   // 連続範囲で選びやすく
  const yOpts=years.map(v=>`<option value="${v}" ${v===y?'selected':''}>${v}年</option>`).join('');
  const mOpts=Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i===m?'selected':''}>${i+1}月</option>`).join('');
  return `<span class="ym-pick">
    <select onchange="App.setYm('${key}','y',this.value)">${yOpts}</select>
    <select onchange="App.setYm('${key}','m',this.value)">${mOpts}</select>
    <button class="icon-btn" onclick="${todayCall||("App.ymToday('"+key+"')")}">${todayLabel||'今月'}</button>
  </span>`;
}
// 年/月/日プルダウン（期間指定用）。key=状態キー(cStart等・値は'YYYY-MM-DD')、fallback=未設定時の既定日
function ymdSelect(key, val, fallback){
  const ref=D.refDate||new Date();
  const base=(val||fallback||'').split('-');
  const y=+base[0]||ref.getFullYear(), m=+base[1]||(ref.getMonth()+1), d=+base[2]||ref.getDate();
  const iso=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
  const ys=D.daily.map(x=>new Date(x.t).getFullYear()).filter(v=>v>2000); ys.push(ref.getFullYear(), y);
  const minY=Math.min(...ys), maxY=Math.max(...ys); const years=[]; for(let v=minY;v<=maxY;v++) years.push(v);
  const dim=new Date(y,m,0).getDate();
  const yO=years.map(v=>`<option value="${v}" ${v===y?'selected':''}>${v}年</option>`).join('');
  const mO=Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i+1===m?'selected':''}>${i+1}月</option>`).join('');
  const dO=Array.from({length:dim},(_,i)=>`<option value="${i+1}" ${i+1===d?'selected':''}>${i+1}日</option>`).join('');
  return `<span class="ymd-pick">
    <select onchange="App.setYmd('${key}','y',this.value,'${iso}')">${yO}</select>
    <select onchange="App.setYmd('${key}','m',this.value,'${iso}')">${mO}</select>
    <select onchange="App.setYmd('${key}','d',this.value,'${iso}')">${dO}</select>
  </span>`;
}
function periodCtrlHtml(){
  const r=periodRange();
  const P=S.period;
  const ref=D.refDate||new Date();
  const defMonth=ref.getFullYear()+'-'+String(ref.getMonth()+1).padStart(2,'0');
  const defDay=defMonth+'-'+String(ref.getDate()).padStart(2,'0');
  const pm=(S.pMonth||defMonth).split('-'); const py=+pm[0], pmo=+pm[1]-1;
  let picker='';
  if(P==='day') picker=`<input type="date" value="${S.pDay||defDay}" onchange="App.set('pDay',this.value)"><button class="icon-btn" onclick="App.thisMonth()">今日</button>`;
  else if(P==='week'){
    const wk=r.weekIdx;
    picker=`${ymSelect('pMonth', py, pmo, 'App.thisMonth()')}
      <span class="seg">${[0,1,2,3,4].map(i=>`<button class="${wk===i?'on':''}" onclick="App.setWeek(${i})">第${i+1}週</button>`).join('')}</span>`;
  }
  else if(P==='month') picker=ymSelect('pMonth', py, pmo, 'App.thisMonth()');
  else if(P==='year'){
    const ys=D.daily.map(x=>new Date(x.t).getFullYear()).filter(v=>v>2000); ys.push(ref.getFullYear());
    const minY=Math.min(...ys), maxY=Math.max(...ys); const years=[]; for(let v=minY;v<=maxY;v++) years.push(v);
    picker=`<select class="ym-pick" onchange="App.set('pYear',this.value)">${years.map(y=>`<option value="${y}" ${String(S.pYear||ref.getFullYear())===String(y)?'selected':''}>${y}年</option>`).join('')}</select>
      <button class="icon-btn" onclick="App.thisMonth()">今年</button>`;
  }
  else picker=`${ymdSelect('cStart',S.cStart,defDay)} 〜 ${ymdSelect('cEnd',S.cEnd,defDay)}`;
  return `
  <div class="ctrl-bar no-print">
    <div class="seg">
      ${[['day','日次'],['week','週次'],['month','月次'],['year','年間'],['custom','期間指定']].map(([k,l])=>`<button class="${P===k?'on':''}" onclick="App.period('${k}')">${l}</button>`).join('')}
    </div>
    ${picker}
    <span class="period-label">${esc(r.label)}</span>
  </div>`;
}

function mediaTableRows(a,b,pa,pb,scopeSet,selName,mode){
  // mode: 'media'=媒体名そのまま ／ 'use'=入店用途（予約/フリー/外販…）／ 'seg'=営業区分（ランチ/ディナー…）
  const keyOf=(r)=>mode==='use'?mediaClassOf(r.media).use:(mode==='seg'?mediaClassOf(r.media).seg:r.media);
  const agg={},prevAgg={};
  for(const r of D.media){
    const inScope=selName?(r.store===selName):scopeSet.has(r.store);
    if(!inScope) continue;
    if(r.t<a&&r.t<pa) continue;
    const k=keyOf(r);
    if(r.t>=a&&r.t<=b){ const o=agg[k]||(agg[k]={net:0,g:0}); o.net+=r.net; o.g+=r.guests; }
    if(r.t>=pa&&r.t<=pb){ prevAgg[k]=(prevAgg[k]||0)+r.net; }
  }
  const total=Object.values(agg).reduce((s,o)=>s+o.net,0);
  return { total, rows:Object.keys(agg).map(m=>({media:m,...agg[m],prev:prevAgg[m]||0})).sort((x,y)=>y.net-x.net) };
}

function viewDash(){
  const sc=scopeStores(); const scopeSet=new Set(sc); const selName=selStoreName();
  const r=periodRange(), p=prevRange(r);
  const a=dayMs(r.s), b=dayMs(r.e), pa2=dayMs(p.s), pb2=dayMs(p.e);
  const cur=stat(scopeSet,a,b,selName), prev=stat(scopeSet,pa2,pb2,selName);
  const Ssl=cur.sales;
  const foodR=Ssl>0?cur.cost/Ssl:0, laborR=Ssl>0?cur.labor/Ssl:0, flR=foodR+laborR;
  const pS=prev.sales, pFood=pS>0?prev.cost/pS:0, pLabor=pS>0?prev.labor/pS:0;
  const spend=cur.guests>0?Ssl/cur.guests:0, pSpend=prev.guests>0?pS/prev.guests:0;

  // 口コミ（対象店舗のスナップショット加重平均）— 期間末時点と前期間末時点を比較
  const revOf=(nm,limit)=>{ let latest=null; for(const rr of D.review){ if(rr.store!==nm)continue; if(limit&&rr.t>limit)continue; if(!latest||rr.t>latest.t)latest=rr; } return latest; };
  const targetStores=selName?[selName]:sc;
  // 同じ実店舗にぶら下がる別名店舗（うお蔵・匠味など）も合算
  const revAt=(limit)=>{ let ws=0,cs=0; targetStores.forEach(nm=>{ reviewNamesFor(nm).forEach(rn=>{ const l=revOf(rn,limit); if(l&&l.count>0){ws+=l.star*l.count;cs+=l.count;} }); }); return cs>0?{star:ws/cs,count:cs}:null; };
  const revCur=revAt(b)||revAt(0);                            // 期間末時点（無ければ最新）
  const prevEnd=dayMs(addD(r.s,-1));                          // 前期間の末日（前月末・前週末・前日…）
  const revPrev=revAt(prevEnd);
  const prevLb=S.period==='month'?'前月':S.period==='week'?'前週':S.period==='day'?'前日':S.period==='year'?'前年':'前期間';
  const revScore=revCur?revCur.star.toFixed(2):'—', revCount=revCur?cnt(revCur.count)+'件':'—';
  let revScoreYY={t:'Google加重平均',cls:'mut'}, revCountYY={t:'累計',cls:'mut'};
  if(revCur&&revPrev){
    const dS=revCur.star-revPrev.star, dC=revCur.count-revPrev.count;
    revScoreYY={ t:prevLb+' '+(dS>=0?'+':'▲')+Math.abs(dS).toFixed(2)+'点', cls:dS>0?'up':dS<0?'dn':'mut' };
    revCountYY={ t:prevLb+' '+(dC>=0?'+':'▲')+Math.abs(dC)+'件', cls:dC>0?'up':dC<0?'dn':'mut' };
  }

  const y1=yoyStr(Ssl,pS), yG=yoyStr(cur.guests,prev.guests,'前年 '), ySp=yoyStr(spend,pSpend,'前年 ');
  const yF=ptStr(foodR,pFood,true), yL=ptStr(laborR,pLabor,true), yFL=ptStr(flR,pFood+pLabor,true);
  // 営業区分（ランチ/ディナー）の内訳。営業区分別売上パネルと同じ＝媒体別売上の営業区分でそのまま集計
  // （按分しない）。店舗別内訳は出さない＝全体のみ。組数は媒体に無いので客数比で按分。
  const seg=segSplit(scopeSet,a,b,selName);
  const grpR=seg.hasG?seg.lg/(seg.lg+seg.dg):null;
  const segSales=seg.hasNet?('🌤ランチ '+yen(seg.ln)+' ／ 🌙ディナー '+yen(seg.dn)):'';
  const segGuests=seg.hasG?('🌤ランチ '+cnt(seg.lg)+'人 ／ 🌙ディナー '+cnt(seg.dg)+'人'):'';
  const segSpend=seg.hasG?('🌤ランチ '+yen(seg.lg>0?seg.ln/seg.lg:0)+' ／ 🌙ディナー '+yen(seg.dg>0?seg.dn/seg.dg:0)):'';
  const segGroups=(gr)=> grpR==null?'':('🌤ランチ '+cnt(gr*grpR)+'組 ／ 🌙ディナー '+cnt(gr*(1-grpR))+'組');
  // 組数（会計組数）＝日別売上シート「分析_日別店舗」の組数列（レジ準拠・キャンセル除外済み）。
  let checksKpi=null;
  if(cur.hasGroups){
    const perGrp=(cur.groups>0)?Ssl/cur.groups:0;
    const grpYY=yoyStr(cur.groups,prev.groups,'前年 ');
    checksKpi={ lb:'組数', vl: cnt(cur.groups)+'組', segsub:segGroups(cur.groups), yy: (cur.groups>0)?{t:'1組平均 '+yen(perGrp)+(prev.hasGroups?' ／ '+grpYY.t:''),cls:prev.hasGroups?grpYY.cls:'mut'}:{t:'日別売上シートより',cls:'mut'} };
  }
  const kpis=[
    { lb:(S.period==='day'?'日次':S.period==='week'?'週次':S.period==='month'?'月次':S.period==='year'?'累計':'期間')+'売上', vl:yen(Ssl), segsub:segSales, yy:y1 },
    { lb:'原価率 (F)', vl:Ssl>0?(foodR*100).toFixed(1)+'%':'—', sub:Ssl>0?yen(cur.cost):'', yy:yF },
    { lb:'人件費率 (L)', vl:Ssl>0?(laborR*100).toFixed(1)+'%':'—', sub:Ssl>0?('PA '+yen(cur.pa)+' ／ 社員 '+yen(cur.emp)):'', yy:yL },
    { lb:'FL合計', vl:Ssl>0?(flR*100).toFixed(1)+'%':'—', yy:yFL },
    { lb:'客数', vl:cnt(cur.guests)+'人', segsub:segGuests, yy:yG },
    ...(checksKpi?[checksKpi]:[]),
    { lb:'客単価', vl:yen(spend), segsub:segSpend, yy:ySp },
    { lb:'口コミ点数', vl:revScore, yy:revScoreYY },
    { lb:'口コミ件数', vl:revCount, yy:revCountYY },
  ];
  // ダイニー来店アンケート「また来たいと思いますか？」の平均（接続時のみ表示）
  if(D.dinii.length){
    const ds=diniiStats(targetStores,a,b);
    const pp=prevPeriodRange(r); const dsPrev=diniiStats(targetStores,dayMs(pp.s),dayMs(pp.e));
    const plb=prevPeriodLabel();
    let dyy;
    if(ds.avg==null) dyy={t:'この期間の回答なし',cls:'mut'};   // 累計にはフォールバックしない
    else if(dsPrev.avg!=null){ const dd=ds.avg-dsPrev.avg;
      dyy={ t:plb+' '+(dd>=0?'+':'▲')+Math.abs(dd).toFixed(2)+'点 ／ '+cnt(ds.count)+'件', cls:dd>0?'up':dd<0?'dn':'mut' }; }
    else dyy={t:'期間内 '+cnt(ds.count)+'件の平均（'+plb+'は回答なし）',cls:'mut'};
    kpis.push({ lb:'ダイニー再来店意向', vl: ds.avg!=null?ds.avg.toFixed(2):'—', yy:dyy });
  }
  let h=periodCtrlHtml()+storeSegHtml();
  h+=`<div class="kpi-grid">`+kpis.map(k=>`<div class="kpi"><div class="lb">${k.lb}</div><div class="vl">${k.vl}</div>${k.sub?`<div class="yy" style="color:#5c5348;font-weight:600;margin-bottom:2px">${k.sub}</div>`:''}${k.segsub?`<div class="yy" style="color:#7a6f5c;font-size:10.5px;margin-bottom:2px">${k.segsub}</div>`:''}<div class="yy ${k.yy.cls}">${k.yy.t}</div></div>`).join('')+`</div>`;
  EXPORT.push({ title:'KPI（'+r.label+(selName?'・'+selName:'・'+(sc.length===allStores().length?'全店':'担当店舗'))+'）',
    headers:['指標','値','前年比較'], rows:kpis.map(k=>[k.lb,k.vl+(k.sub?'（'+k.sub+'）':''),k.yy.t]) });

  if(S.period==='month') h+=landingPanel(r,scopeSet,selName,sc);
  h+=dashChartPanel(r,scopeSet,selName);
  h+=`<div class="grid2">${flPanel(cur,prev)}${mediaPanel(a,b,pa2,pb2,scopeSet,selName)}</div>`;
  // 店舗を選んでいるときは「日別明細」、全店/合算のときは「店舗比較」
  h+= selName ? dailyStorePanel(r,selName) : comparePanel(r,p,sc,selName);
  return h;
}

// 月末着地見込み：残りは「前年同月の実績(週ごとの形)」に「今年の勢い(前年同期比)」を掛けて予測。
// これにより、今年の第1週が良かった/悪かったを平坦に引き延ばさず、前年の週別の起伏を反映できる。
function monthLanding(scopeSet, selName, y, m){
  const ld=new Date(y,m+1,0).getDate();
  // 経過の境界は「実際にデータのある最終日(refDate=昨日)」。未来日の空行は実績扱いしない。
  const maxT=D.refDate?dayMs(D.refDate):dayMs(new Date());
  const setArg=selName?null:scopeSet;
  // 指定年の m月 d日（前年の月末が短い場合は末日にクランプ）の1日分
  const dv=(yr,d)=>{ const lm=new Date(yr,m+1,0).getDate(), dd=Math.min(d,lm); return stat(setArg,dayMs(new Date(yr,m,dd)),dayMs(new Date(yr,m,dd)),selName); };
  // 経過日数（この月で実データのある最終日）
  let cutoffDay=0; for(let d=1; d<=ld; d++){ if(dayMs(new Date(y,m,d))>maxT) break; cutoffDay=d; }
  // 今年 MTD（＋フォールバック用の同曜日集計）
  let mtdSales=0,mtdGuests=0,mtdCost=0,mtdLabor=0;
  const wdSum=[0,0,0,0,0,0,0],wdCnt=[0,0,0,0,0,0,0],wdSumG=[0,0,0,0,0,0,0]; let weSum=0,weCnt=0;
  for(let d=1; d<=cutoffDay; d++){
    const dt=new Date(y,m,d), c=dv(y,d), wd=dt.getDay();
    mtdSales+=c.sales; mtdGuests+=c.guests; mtdCost+=c.cost; mtdLabor+=c.labor;
    wdSum[wd]+=c.sales; wdCnt[wd]++; wdSumG[wd]+=c.guests;
    if(wd===0||wd===6||isJpHoliday(dt)){ weSum+=c.sales; weCnt++; }
  }
  // 前年 同月：経過分(1..cutoff)と残り分(cutoff+1..末)を、同じ日付範囲で集計
  let lyMtd=0,lyMtdG=0,lyRem=0,lyRemG=0;
  for(let d=1; d<=ld; d++){ const c=dv(y-1,d); if(d<=cutoffDay){ lyMtd+=c.sales; lyMtdG+=c.guests; } else { lyRem+=c.sales; lyRemG+=c.guests; } }
  const remDays=ld-cutoffDay;
  let remSales=0, remGuests=0, method='done';
  if(remDays>0){
    if(lyMtd>0 && lyRem>0){
      // ★前年実績ベース × 今年の勢い（前年同期比）。残りは前年の週別の形を今年の水準に補正して予測。
      const R=mtdSales/lyMtd, Rg=lyMtdG>0?mtdGuests/lyMtdG:R;
      remSales=lyRem*R; remGuests=lyRemG*Rg; method='yoy';
    } else {
      // フォールバック：前年データが不足 → 同曜日平均で積み上げ
      const overall=cutoffDay>0?mtdSales/cutoffDay:0, overallG=cutoffDay>0?mtdGuests/cutoffDay:0;
      const wdAvg=(wd)=>wdCnt[wd]>0?wdSum[wd]/wdCnt[wd]:overall, wdAvgG=(wd)=>wdCnt[wd]>0?wdSumG[wd]/wdCnt[wd]:overallG;
      const weAvg=weCnt>0?weSum/weCnt:overall;
      for(let d=cutoffDay+1; d<=ld; d++){ const dt=new Date(y,m,d), wd=dt.getDay(); remSales+=(isJpHoliday(dt)&&wd>=1&&wd<=5)?weAvg:wdAvg(wd); remGuests+=wdAvgG(wd); }
      method='wd';
    }
  }
  const fSales=mtdSales+remSales, fGuests=mtdGuests+remGuests;
  const flRate=mtdSales>0?(mtdCost+mtdLabor)/mtdSales:0;
  const lyFull=lyMtd+lyRem;                       // 前年満月
  const pmFull=stat(setArg,dayMs(new Date(y,m-1,1)),dayMs(new Date(y,m,0)),selName).sales;
  return { ld,lastDay:cutoffDay,remDays, mtdSales,mtdGuests, remSales, fSales,fGuests, flRate, lyFull,pmFull, method, yoyR: lyMtd>0?mtdSales/lyMtd:null };
}
function landingPanel(r,scopeSet,selName,sc){
  const y=r.s.getFullYear(), m=r.s.getMonth();
  const L=monthLanding(scopeSet,selName,y,m);
  if(L.mtdSales<=0) return '';                     // 今月まだデータ無し
  const done=L.remDays<=0;
  const yoyF=(c,p)=>{ if(!(p>0)) return {t:'—',cls:'mut'}; const v=(c-p)/p*100; return {t:(v>=0?'+':'▲')+Math.abs(v).toFixed(1)+'%',cls:v>=0?'up':'dn'}; };
  const fy=yoyF(L.fSales,L.lyFull), fp=yoyF(L.fSales,L.pmFull);
  const fSpend=L.fGuests>0?L.fSales/L.fGuests:0;
  const prog=L.fSales>0?(L.mtdSales/L.fSales*100):0;
  const remNote = done ? '確定（月末まで実績）'
    : (L.method==='yoy' ? '残'+L.remDays+'日を前年実績×今年の勢いで予測'
                        : '残'+L.remDays+'日を同曜日平均で予測（前年データ不足）');
  const methodLine = done ? '月末まで実績'
    : (L.method==='yoy' ? `残りは前年同月の実績（週別の形）に今年の勢い（前年同期比 ${(L.yoyR*100).toFixed(0)}%）を掛けて予測`
                        : '前年データが不足のため同曜日平均で予測');
  const cards=[
    ['着地見込み 売上', yen(L.fSales), remNote, ''],
    ['現在（実績）', yen(L.mtdSales), '経過 '+L.lastDay+'/'+L.ld+'日 ・ 進捗 '+prog.toFixed(0)+'%', ''],
    ['前年満月比（見込み）', fy.t, '前年 '+yen(L.lyFull), fy.cls],
    ['前月比（見込み）', fp.t, '前月 '+yen(L.pmFull), fp.cls],
  ];
  let h=`<div class="panel" style="border-color:#d8cdb5;background:linear-gradient(180deg,#fffdf8,#fff)">
    <div class="panel-head"><div><h3>📈 月末着地見込み（${y}年${m+1}月${done?'・確定':''}）</h3>
    <div class="sub">${methodLine} ／ 見込み客単価 ${yen(fSpend)} ・ 見込みFL率 ${(L.flRate*100).toFixed(1)}%（MTD実績で横置き）</div></div></div>
  <div class="kpi-grid" style="margin:2px 0 0">`+cards.map(k=>`<div class="kpi"><div class="lb">${esc(k[0])}</div><div class="vl">${k[1]}</div><div class="yy ${k[3]}" style="${k[3]?'':'color:#8c8375'}">${esc(k[2])}</div></div>`).join('')+`</div>`;
  // 店舗別の着地見込み（全店/合算時）
  if(!selName && sc.length>1){
    h+=`<div class="scroll-x" style="margin-top:14px"><table class="tbl"><thead><tr><th>店舗</th><th>現在(MTD)</th><th>残り見込み</th><th>着地見込み</th><th>前年満月</th><th>前年比</th></tr></thead><tbody>`;
    const exp=[]; let tM=0,tR=0,tF=0,tLy=0;
    sc.forEach(nm=>{
      const s2=monthLanding(null,nm,y,m);
      const yy=yoyF(s2.fSales,s2.lyFull);
      tM+=s2.mtdSales; tR+=s2.remSales; tF+=s2.fSales; tLy+=s2.lyFull;
      h+=`<tr class="click" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}"><td>${shortStoreTd(nm)}</td><td>${yen(s2.mtdSales)}</td><td>${yen(s2.remSales)}</td><td style="font-weight:700">${yen(s2.fSales)}</td><td class="mut">${yen(s2.lyFull)}</td><td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t}</td></tr>`;
      exp.push([nm,Math.round(s2.mtdSales),Math.round(s2.remSales),Math.round(s2.fSales),Math.round(s2.lyFull),yy.t]);
    });
    const tyy=yoyF(tF,tLy);
    h+=`<tr class="total"><td>合計</td><td>${yen(tM)}</td><td>${yen(tR)}</td><td>${yen(tF)}</td><td>${yen(tLy)}</td><td class="${tyy.cls==='up'?'pos':'neg'}">${tyy.t}</td></tr>`;
    h+=`</tbody></table></div>`;
    exp.push(['合計',Math.round(tM),Math.round(tR),Math.round(tF),Math.round(tLy),tyy.t]);
    EXPORT.push({ title:'月末着地見込み（'+y+'年'+(m+1)+'月）', headers:['店舗','現在(MTD)','残り見込み','着地見込み','前年満月','前年比'], rows:exp });
  }
  h+=`</div>`;
  return h;
}

// 店舗選択時：1日ごとの売上・客数・客単価・PA(比率)・社員(比率)・原価(比率)・前年比・累計差異
function dailyStorePanel(r,selName){
  const days=[]; for(let d=new Date(r.s); dayMs(d)<=dayMs(r.e); d=addD(d,1)) days.push(new Date(d));
  const maxT=D.maxDate?dayMs(D.maxDate):Infinity;
  let cumCur=0, cumPrev=0, tS=0,tG=0,tCost=0,tPa=0,tEmp=0;
  // 金額＋比率（比率は売上に対する％）を1セルで表示
  const ap=(amt,sales)=>sales>0?`${yen(amt)} <span class="mut" style="font-size:11px">(${(amt/sales*100).toFixed(1)}%)</span>`:'<span class="mut">—</span>';
  let h=`<div class="panel"><div class="panel-head"><div><h3>日別 明細（${esc(selName)} ／ ${esc(r.label)}）</h3>
    <div class="sub">1日ごとの売上・客数・客単価・PA/社員/原価（金額と比率）・前年比・累計差異（${(r.s.getMonth()+1)}/${r.s.getDate()}〜${(r.e.getMonth()+1)}/${r.e.getDate()}）</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>日付</th><th>天気</th><th>売上</th><th>客数</th><th>客単価</th><th>PA（比率）</th><th>社員（比率）</th><th>原価（比率）</th><th>前年比</th><th>累計差異(対前年)</th></tr></thead><tbody>`;
  const exp=[];
  if(days.length) ensureWeather([selName], dayMs(days[0]), dayMs(days[days.length-1]));
  days.forEach(d=>{
    const t=dayMs(d);
    const c=stat(null,t,t,selName);
    const pv=stat(null,dayMs(addD(d,-364)),dayMs(addD(d,-364)),selName);
    const future=t>maxT;
    if(future){
      h+=`<tr><td class="mut">${mdwH(d)}</td><td style="white-space:nowrap">${wxCell(wxGet(selName,t))}</td>${'<td class="mut">—</td>'.repeat(8)}</tr>`;
      return;
    }
    cumCur+=c.sales; cumPrev+=pv.sales; tS+=c.sales; tG+=c.guests; tCost+=c.cost; tPa+=c.pa; tEmp+=c.emp;
    const sp=c.guests>0?c.sales/c.guests:0;
    const yy=yoyStr(c.sales,pv.sales,'');
    const cumDiff=cumCur-cumPrev;
    h+=`<tr><td style="white-space:nowrap">${mdwH(d)}</td><td style="white-space:nowrap">${wxCell(wxGet(selName,t))}</td><td>${yen(c.sales)}</td><td>${cnt(c.guests)}人</td><td>${yen(sp)}</td>
      <td>${ap(c.pa,c.sales)}</td><td>${ap(c.emp,c.sales)}</td><td>${ap(c.cost,c.sales)}</td>
      <td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t||'—'}</td>
      <td class="${cumDiff>=0?'pos':'neg'}">${(cumDiff>=0?'+':'▲')+yen(Math.abs(cumDiff)).slice(1)}</td></tr>`;
    const pct=(a2)=>c.sales>0?(a2/c.sales*100).toFixed(1)+'%':'';
    exp.push([mdw(d),wxText(wxGet(selName,t)),Math.round(c.sales),Math.round(c.guests),Math.round(sp),Math.round(c.pa),pct(c.pa),Math.round(c.emp),pct(c.emp),Math.round(c.cost),pct(c.cost),yy.t||'',Math.round(cumDiff)]);
  });
  const tSp=tG>0?tS/tG:0, tDiff=cumCur-cumPrev;
  h+=`<tr class="total"><td>合計</td><td></td><td>${yen(tS)}</td><td>${cnt(tG)}人</td><td>${yen(tSp)}</td>
    <td>${ap(tPa,tS)}</td><td>${ap(tEmp,tS)}</td><td>${ap(tCost,tS)}</td><td></td>
    <td class="${tDiff>=0?'pos':'neg'}">${(tDiff>=0?'+':'▲')+yen(Math.abs(tDiff)).slice(1)}</td></tr>`;
  h+=`</tbody></table></div></div>`;
  const tp=(a2)=>tS>0?(a2/tS*100).toFixed(1)+'%':'';
  exp.push(['合計','',Math.round(tS),Math.round(tG),Math.round(tSp),Math.round(tPa),tp(tPa),Math.round(tEmp),tp(tEmp),Math.round(tCost),tp(tCost),'',Math.round(tDiff)]);
  EXPORT.push({ title:'日別明細（'+selName+'／'+r.label+'）', headers:['日付','天気','売上','客数','客単価','PA額','PA率','社員額','社員率','原価額','原価率','前年比','累計差異(対前年)'], rows:exp });
  return h;
}

function dashChartPanel(r,scopeSet,selName){
  const P=S.period;
  const sumRange=(s,e)=>stat(scopeSet,dayMs(s),dayMs(e),selName).sales;
  let cat=[],series=[],title='',sub='';
  if(P==='day'){
    if(!selName&&scopeSet.size>1){
      const stores=[...scopeSet];
      cat=stores.map(n=>n.replace(' ','\n'));
      series=[{name:'当日',color:C_NOW,data:stores.map(n=>stat(null,dayMs(r.s),dayMs(r.e),n).sales)},
              {name:'昨年同曜日',color:C_PREV,data:stores.map(n=>stat(null,dayMs(addD(r.s,-364)),dayMs(addD(r.e,-364)),n).sales)}];
      title='店舗別 売上（'+r.label+'）'; sub='当日 / 昨年同曜日';
    }else{
      for(let i=13;i>=0;i--){ const d=addD(r.e,-i); cat.push(mdw(d)); }
      series=[{name:'今年',color:C_NOW,data:cat.map((_,i)=>sumRange(addD(r.e,i-13),addD(r.e,i-13)))},
              {name:'昨年同曜日',color:C_PREV,data:cat.map((_,i)=>sumRange(addD(r.e,i-13-364),addD(r.e,i-13-364)))}];
      title='日別 売上推移（直近14日）'; sub='今年 / 昨年同曜日';
    }
  }else if(P==='week'){
    for(let d=new Date(r.s); dayMs(d)<=dayMs(r.e); d=addD(d,1)) cat.push(mdw(d));
    const prevWeekS=addD(r.s,-7);
    series=[{name:'今週',color:C_NOW,data:cat.map((_,i)=>sumRange(addD(r.s,i),addD(r.s,i)))},
            {name:'先週',color:C_MID,data:cat.map((_,i)=>sumRange(addD(prevWeekS,i),addD(prevWeekS,i)))},
            {name:'昨年同週',color:C_PREV,data:cat.map((_,i)=>sumRange(addD(r.s,i-364),addD(r.s,i-364)))}];
    title='日別 売上（'+r.label+'）'; sub='今週 / 先週 / 昨年同週';
  }else if(P==='month'){
    const y=r.s.getFullYear(),m=r.s.getMonth(),ld=new Date(y,m+1,0).getDate();
    const rows=[];
    for(let i=0;i<5;i++){ const sd=i*7+1; if(sd>ld)break; const ed=i<4?Math.min(sd+6,ld):ld; rows.push({i,sd,ed}); }
    cat=rows.map(w=>'第'+(w.i+1)+'週\n'+(m+1)+'/'+w.sd+'〜'+w.ed);
    series=[{name:'今年',color:C_NOW,data:rows.map(w=>sumRange(new Date(y,m,w.sd),new Date(y,m,w.ed)))},
            {name:'昨年',color:C_PREV,data:rows.map(w=>sumRange(new Date(y-1,m,w.sd),new Date(y-1,m,w.ed)))}];
    title='週別 売上比較（'+r.label+'）'; sub='今年 / 昨年同週';
    EXPORT.push({ title:'週別売上（'+r.label+'）', headers:['週','今年','昨年'],
      rows:rows.map((w,i)=>['第'+(w.i+1)+'週('+(m+1)+'/'+w.sd+'〜'+w.ed+')',series[0].data[i],series[1].data[i]]) });
  }else if(P==='year'){
    const y=r.s.getFullYear();
    cat=Array.from({length:12},(_,i)=>(i+1)+'月');
    series=[{name:String(y)+'年',color:C_NOW,data:cat.map((_,i)=>sumRange(new Date(y,i,1),new Date(y,i+1,0)))},
            {name:String(y-1)+'年',color:C_PREV,data:cat.map((_,i)=>sumRange(new Date(y-1,i,1),new Date(y-1,i+1,0)))}];
    title='月次 売上推移（'+y+'年）'; sub='今年 / 昨年';
  }else{
    const span=Math.round((dayMs(r.e)-dayMs(r.s))/86400000)+1;
    if(span<=31){
      for(let d=new Date(r.s); dayMs(d)<=dayMs(r.e); d=addD(d,1)) cat.push((d.getMonth()+1)+'/'+d.getDate());
      series=[{name:'今年',color:C_NOW,data:cat.map((_,i)=>sumRange(addD(r.s,i),addD(r.s,i)))},
              {name:'昨年同期',color:C_PREV,data:cat.map((_,i)=>sumRange(sub1y(addD(r.s,i)),sub1y(addD(r.s,i))))}];
    }else{
      let m=new Date(r.s.getFullYear(),r.s.getMonth(),1); const ms=[];
      while(dayMs(m)<=dayMs(r.e)){ ms.push(new Date(m)); m=new Date(m.getFullYear(),m.getMonth()+1,1); }
      cat=ms.map(d=>(d.getMonth()+1)+'月');
      series=[{name:'今年',color:C_NOW,data:ms.map(d=>sumRange(new Date(Math.max(dayMs(d),dayMs(r.s))),new Date(Math.min(dayMs(new Date(d.getFullYear(),d.getMonth()+1,0)),dayMs(r.e)))))},
              {name:'昨年同期',color:C_PREV,data:ms.map(d=>sumRange(sub1y(new Date(Math.max(dayMs(d),dayMs(r.s)))),sub1y(new Date(Math.min(dayMs(new Date(d.getFullYear(),d.getMonth()+1,0)),dayMs(r.e))))))}];
    }
    title='期間内 売上推移（'+r.label+'）'; sub='今年 / 昨年同期';
  }
  const legend=series.map(s=>`<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  return `<div class="panel"><div class="panel-head"><div><h3>${esc(title)}</h3><div class="sub">${esc(sub)}</div></div><div class="legend">${legend}</div></div>
    ${barChart(cat,series,{twoLine:cat.some(c=>String(c).includes('\n'))})}</div>`;
}

function flPanel(cur,prev){
  const Ssl=cur.sales;
  if(!(Ssl>0)) return `<div class="panel"><h3>FL（原価・人件費）内訳</h3><div class="empty">対象期間のデータがありません</div></div>`;
  const rows=[
    { nm:'仕入（原価 F）', c:'#b5502f', amt:cur.cost, r:cur.cost/Ssl, pr:prev.sales>0?prev.cost/prev.sales:0 },
    { nm:'PA 人件費', c:'#5f7052', amt:cur.pa, r:cur.pa/Ssl, pr:prev.sales>0?prev.pa/prev.sales:0 },
    { nm:'社員 人件費', c:'#7d8b6f', amt:cur.emp, r:cur.emp/Ssl, pr:prev.sales>0?prev.emp/prev.sales:0 },
  ];
  const fl=cur.cost+cur.labor, flR=fl/Ssl, pFlR=prev.sales>0?(prev.cost+prev.labor)/prev.sales:0;
  const profit=Ssl-fl;
  let h=`<div class="panel"><div class="panel-head"><div><h3>FL（原価・人件費）内訳</h3><div class="sub">集約シート実績</div></div></div><div class="scroll-x"><table class="tbl"><thead><tr><th>項目</th><th>金額</th><th>比率</th><th>前年</th></tr></thead><tbody>`;
  rows.forEach(x=>{ const pt=ptStr(x.r,x.pr,true);
    h+=`<tr><td><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${x.c};margin-right:8px"></span>${esc(x.nm)}</td><td>${yen(x.amt)}</td><td>${(x.r*100).toFixed(1)}%</td><td class="${pt.cls==='up'?'pos':pt.cls==='dn'?'neg':'mut'}">${pt.t}</td></tr>`; });
  const ptFL=ptStr(flR,pFlR,true);
  h+=`<tr class="total"><td>FL合計</td><td>${yen(fl)}</td><td>${(flR*100).toFixed(1)}%</td><td class="${ptFL.cls==='up'?'pos':'neg'}">${ptFL.t}</td></tr>`;
  h+=`<tr><td>利益（FL後）</td><td class="${profit>=0?'pos':'neg'}">${yen(profit)}</td><td>${(profit/Ssl*100).toFixed(1)}%</td><td class="mut">—</td></tr>`;
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'FL内訳', headers:['項目','金額','比率','前年'],
    rows:rows.map(x=>[x.nm,Math.round(x.amt),(x.r*100).toFixed(1)+'%',ptStr(x.r,x.pr,true).t]).concat([['FL合計',Math.round(fl),(flR*100).toFixed(1)+'%',ptFL.t],['利益(FL後)',Math.round(profit),(profit/Ssl*100).toFixed(1)+'%','']]) });
  return h;
}

function mediaPanel(a,b,pa2,pb2,scopeSet,selName){
  const mode=S.mediaMode||'media';
  const MODES={ media:{t:'媒体別 売上',col:'媒体',sub:'予約媒体・チャネル別の実績'},
                use:{t:'入店用途別 売上',col:'入店用途',sub:'予約／フリー／外販など（DB_媒体分類で設定・未設定は自動判定）'},
                seg:{t:'営業区分別 売上',col:'営業区分',sub:'ランチ／ディナーなど（DB_媒体分類で設定・未設定は自動判定）'} };
  const M=MODES[mode]||MODES.media;
  const picker=`<select onchange="App.set('mediaMode',this.value)" style="font-weight:700">
    <option value="media" ${mode==='media'?'selected':''}>媒体別</option>
    <option value="use" ${mode==='use'?'selected':''}>入店用途</option>
    <option value="seg" ${mode==='seg'?'selected':''}>営業区分別</option>
  </select>`;
  const { total, rows }=mediaTableRows(a,b,pa2,pb2,scopeSet,selName,mode);
  if(!rows.length && D.mediaPending) return `<div class="panel"><div class="panel-head"><div><h3>${M.t}</h3><div class="sub">読み込み中…</div></div>${picker}</div><div class="empty">媒体別データを読み込んでいます…</div></div>`;
  if(!rows.length) return `<div class="panel"><div class="panel-head"><div><h3>${M.t}</h3></div>${picker}</div><div class="empty">媒体別データがありません</div></div>`;
  let h=`<div class="panel"><div class="panel-head"><div><h3>${M.t}</h3><div class="sub">${M.sub}</div></div>${picker}</div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>${M.col}</th><th>売上</th><th>構成比</th><th>客数</th><th>客単価</th><th>前年比</th></tr></thead><tbody>`;
  const shown=mode==='media'?rows.slice(0,12):rows;   // 用途・区分はグループ数が少ないので全件
  let tG=0,tPrev=0;
  shown.forEach(x=>{
    const yy=yoyStr(x.net,x.prev,'');
    h+=`<tr><td>${esc(x.media)}</td><td>${yen(x.net)}</td><td>${total>0?(x.net/total*100).toFixed(1):'—'}%</td><td>${cnt(x.g)}人</td><td>${yen(x.g>0?x.net/x.g:0)}</td><td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t.replace('前年比 ','')}</td></tr>`;
  });
  rows.forEach(x=>{ tG+=x.g; tPrev+=x.prev; });
  const tyy=yoyStr(total,tPrev,'');
  h+=`<tr class="total"><td>合計</td><td>${yen(total)}</td><td>100%</td><td>${cnt(tG)}人</td><td>${yen(tG>0?total/tG:0)}</td><td class="${tyy.cls==='up'?'pos':tyy.cls==='dn'?'neg':'mut'}">${tyy.t.replace('前年比 ','')}</td></tr>`;
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:M.t, headers:[M.col,'売上','構成比','客数','客単価','前年比'],
    rows:rows.map(x=>[x.media,Math.round(x.net),total>0?(x.net/total*100).toFixed(1)+'%':'',Math.round(x.g),Math.round(x.g>0?x.net/x.g:0),yoyStr(x.net,x.prev,'').t]) });
  return h;
}

function comparePanel(r,p,sc,selName){
  const acc=S.auth.account;
  if(sc.length<=1){
    return `<div class="panel"><h3>店舗間比較</h3><div class="empty">このアカウントは自店（${esc(sc[0]||'')}）のみの表示です。<br>他店舗との比較は本部・マネージャー権限でご確認いただけます。</div></div>`;
  }
  const a=dayMs(r.s), b=dayMs(r.e), pa2=dayMs(p.s), pb2=dayMs(p.e);
  const revOf=(nm)=>{ let latest=null; for(const rr of D.review){ if(rr.store!==nm)continue; if(!latest||rr.t>latest.t)latest=rr; } return latest; };
  // 親店舗＋別名店舗（うお蔵・匠味など）の口コミを加重合算
  const revAgg=(parent)=>{ let ws=0,cs=0; reviewNamesFor(parent).forEach(rn=>{ const l=revOf(rn); if(l&&l.count>0){ws+=l.star*l.count;cs+=l.count;} }); return cs>0?{star:ws/cs,count:cs}:null; };
  const isAll=sc.length===allStores().length;
  const title=(isAll?'全店比較':'担当店舗比較')+'（'+r.label+'・前年対比）';
  let h=`<div class="panel"><div class="panel-head"><div><h3>${esc(title)}</h3><div class="sub">全${sc.length}店舗を表示 ／ 行クリックで店舗に切替</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>売上</th><th>前年比</th><th>原価率</th><th>人件費率</th><th>FL</th><th>客数</th><th>客単価</th><th>口コミ</th><th>件数</th></tr></thead><tbody>`;
  const expRows=[];
  const agg={sales:0,cost:0,labor:0,guests:0,psales:0};
  let tws=0,tcs=0;
  sc.forEach(nm=>{
    const c=stat(null,a,b,nm), pv=stat(null,pa2,pb2,nm);
    const yy=yoyStr(c.sales,pv.sales,'');
    const fr=c.sales>0?c.cost/c.sales:0, lr=c.sales>0?c.labor/c.sales:0, fl=fr+lr;
    const sp=c.guests>0?c.sales/c.guests:0;
    const rv=revAgg(nm);
    agg.sales+=c.sales;agg.cost+=c.cost;agg.labor+=c.labor;agg.guests+=c.guests;agg.psales+=pv.sales;
    if(rv&&rv.count>0){tws+=rv.star*rv.count;tcs+=rv.count;}
    h+=`<tr class="click ${selName===nm?'sel':''}" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}">
      <td>${shortStoreTd(nm)}</td><td>${yen(c.sales)}</td>
      <td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t}</td>
      <td>${c.sales>0?(fr*100).toFixed(1)+'%':'—'}</td><td>${c.sales>0?(lr*100).toFixed(1)+'%':'—'}</td>
      <td class="${fl>0.6?'warn':''}">${c.sales>0?(fl*100).toFixed(1)+'%':'—'}</td>
      <td>${cnt(c.guests)}人</td><td>${yen(sp)}</td>
      <td>${rv?rv.star.toFixed(2):'—'}</td><td>${rv?cnt(rv.count):'—'}</td></tr>`;
    expRows.push([nm,Math.round(c.sales),yy.t,(fr*100).toFixed(1)+'%',(lr*100).toFixed(1)+'%',(fl*100).toFixed(1)+'%',Math.round(c.guests),Math.round(sp),rv?rv.star.toFixed(2):'',rv?rv.count:'']);
  });
  const tf=agg.sales>0?agg.cost/agg.sales:0, tl=agg.sales>0?agg.labor/agg.sales:0;
  const tyy=yoyStr(agg.sales,agg.psales,'');
  h+=`<tr class="total"><td>${isAll?'全店合計':'担当店舗合計'}</td><td>${yen(agg.sales)}</td>
    <td class="${tyy.cls==='up'?'pos':'neg'}">${tyy.t}</td>
    <td>${(tf*100).toFixed(1)}%</td><td>${(tl*100).toFixed(1)}%</td><td>${((tf+tl)*100).toFixed(1)}%</td>
    <td>${cnt(agg.guests)}人</td><td>${yen(agg.guests>0?agg.sales/agg.guests:0)}</td>
    <td>${tcs>0?(tws/tcs).toFixed(2):'—'}</td><td>${cnt(tcs)}</td></tr>`;
  h+=`</tbody></table></div></div>`;
  expRows.push([isAll?'全店合計':'担当合計',Math.round(agg.sales),tyy.t,(tf*100).toFixed(1)+'%',(tl*100).toFixed(1)+'%',((tf+tl)*100).toFixed(1)+'%',Math.round(agg.guests),Math.round(agg.guests>0?agg.sales/agg.guests:0),tcs>0?(tws/tcs).toFixed(2):'',tcs]);
  EXPORT.push({ title:title, headers:['店舗','売上','前年比','原価率','人件費率','FL','客数','客単価','口コミ点数','口コミ件数'], rows:expRows });
  return h;
}

/* ---------------- 推移分析 ---------------- */
function viewAnalysis(){
  if(S.aView==='dow') return viewDowCompare();
  const sc=scopeStores(); const selName=selStoreName();
  const names=selName?[selName]:sc;
  const M=S.aMetric,G=S.aGran,B=S.aBreak,RG=S.aRange;
  const ref=D.refDate||new Date();
  const pI=(s)=>{const p=String(s).split('-');return new Date(+p[0],+p[1]-1,+p[2]);};
  let s,e=new Date(ref.getFullYear(),ref.getMonth(),ref.getDate());
  if(RG==='90')s=addD(e,-89);
  else if(RG==='year')s=new Date(ref.getFullYear(),0,1);
  else if(RG==='custom'){ s=S.cStart?pI(S.cStart):addD(e,-29); e=S.cEnd?pI(S.cEnd):e; }
  else s=addD(e,-29);
  if(dayMs(s)>dayMs(e)){const t=s;s=e;e=t;}
  // バケット生成
  const buckets=[];
  if(G==='month'){ let m=new Date(s.getFullYear(),s.getMonth(),1);
    while(dayMs(m)<=dayMs(e)){ const a2=Math.max(dayMs(m),dayMs(s)),b2=Math.min(dayMs(new Date(m.getFullYear(),m.getMonth()+1,0)),dayMs(e)); buckets.push({label:(m.getMonth()+1)+'月',a:a2,b:b2}); m=new Date(m.getFullYear(),m.getMonth()+1,1);} }
  else if(G==='week'){ let m=new Date(s.getFullYear(),s.getMonth(),1);
    while(dayMs(m)<=dayMs(e)){ const ld=new Date(m.getFullYear(),m.getMonth()+1,0).getDate();
      for(let bi=0;bi<5;bi++){ const sd=bi*7+1; if(sd>ld)break; const ed=bi<4?Math.min(sd+6,ld):ld;
        const a2=Math.max(dayMs(new Date(m.getFullYear(),m.getMonth(),sd)),dayMs(s)); const b2=Math.min(dayMs(new Date(m.getFullYear(),m.getMonth(),ed)),dayMs(e));
        if(a2>b2)continue; buckets.push({label:(m.getMonth()+1)+'/'+sd,a:a2,b:b2}); }
      m=new Date(m.getFullYear(),m.getMonth()+1,1); } }
  else { for(let d=new Date(s); dayMs(d)<=dayMs(e); d=addD(d,1)) buckets.push({label:mdw(d),dt:new Date(d),a:dayMs(d),b:dayMs(d)}); }

  const nameSet=new Set(names);
  const dailyIn=D.daily.filter(x=>nameSet.has(x.store));
  const mediaIn=D.media.filter(x=>nameSet.has(x.store));
  const val=(recs,a2,b2)=>{ let sl=0,g=0; for(const x of recs){ if(x.t>=a2&&x.t<=b2){ sl+=(x.sales!=null?x.sales:x.net); g+=x.guests; } } return M==='sales'?sl:(M==='guests'?g:(g>0?sl/g:0)); };
  let groups;
  if(B==='store') groups=names.map((nm,i)=>({name:nm,color:PALETTE[i%PALETTE.length],recs:dailyIn.filter(x=>x.store===nm)}));
  else if(B==='media'){
    const magg={}; for(const x of mediaIn){ if(x.t>=dayMs(s)&&x.t<=dayMs(e)) magg[x.media]=(magg[x.media]||0)+x.net; }
    const top=Object.keys(magg).map(k=>({k,v:magg[k]})).sort((x,y)=>y.v-x.v).slice(0,6);
    groups=top.map((x,i)=>({name:x.k,color:PALETTE[i%PALETTE.length],recs:mediaIn.filter(rr=>rr.media===x.k)}));
    const tn=top.map(x=>x.k);
    groups.push({name:'その他',color:'#c7bfae',recs:mediaIn.filter(rr=>!tn.includes(rr.media))});
  }
  else groups=[{name:'合計',color:PALETTE[0],recs:dailyIn}];
  const series=groups.map(gp=>({name:gp.name,color:gp.color,data:buckets.map(bk=>val(gp.recs,bk.a,bk.b))}));
  if(B==='total'&&S.aYoY) series.push({name:'前年',color:'#c9b7a0',dash:true,data:buckets.map(bk=>val(dailyIn,dayMs(sub1y(new Date(bk.a))),dayMs(sub1y(new Date(bk.b)))))});
  const ml=M==='sales'?'売上':(M==='guests'?'客数':'客単価');
  const fmtV=(v)=>M==='guests'?cnt(v)+'人':yen(v);
  const legend=series.map(x=>`<span><span class="${x.dash?'ln':'sw'}" style="${x.dash?'border-top:2px dashed '+x.color:'background:'+x.color}"></span>${esc(x.name)}</span>`).join('');
  let h=`
  <div class="ctrl-bar no-print">
    <div class="seg">${[['trend','推移'],['dow','曜日別比較']].map(([k,l])=>`<button class="${(S.aView||'trend')===k?'on':''}" onclick="App.set('aView','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['sales','売上'],['guests','客数'],['spend','客単価']].map(([k,l])=>`<button class="${M===k?'on':''}" onclick="App.set('aMetric','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['day','日別'],['week','週別'],['month','月別']].map(([k,l])=>`<button class="${G===k?'on':''}" onclick="App.set('aGran','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['total','合計'],['store','店舗別'],['media','媒体別']].map(([k,l])=>`<button class="${B===k?'on':''}" onclick="App.set('aBreak','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['30','直近30日'],['90','直近90日'],['year','年初来'],['custom','期間指定']].map(([k,l])=>`<button class="${RG===k?'on':''}" onclick="App.set('aRange','${k}')">${l}</button>`).join('')}</div>
    ${RG==='custom'?`${ymdSelect('cStart',S.cStart,(D.refDate||new Date()).getFullYear()+'-'+String((D.refDate||new Date()).getMonth()+1).padStart(2,'0')+'-'+String((D.refDate||new Date()).getDate()).padStart(2,'0'))} 〜 ${ymdSelect('cEnd',S.cEnd,'')}`:''}
    ${B==='total'?`<button class="icon-btn" onclick="App.set('aYoY',${S.aYoY?'false':'true'})">${S.aYoY?'☑':'☐'} 前年重ね</button>`:''}
  </div>`+storeSegHtml();
  h+=`<div class="panel"><div class="panel-head"><div><h3>${ml} の推移（${G==='day'?'日別':G==='week'?'週別':'月別'}・${B==='total'?'合計':B==='store'?'店舗別':'媒体別'}）</h3>
    <div class="sub">${(s.getMonth()+1)}/${s.getDate()}〜${(e.getMonth()+1)}/${e.getDate()} ／ ${buckets.length}区間</div></div><div class="legend">${legend}</div></div>
    ${lineChart(buckets.map(b2=>b2.label),series,M)}</div>`;
  // 明細：前年重ね時は差異列＋最下段に合計差異
  const hasYoY=B==='total'&&S.aYoY&&series.length>=2;
  const diffTxt=(d2)=>`<span class="${d2>0?'pos':d2<0?'neg':'mut'}">${d2===0?'—':(d2>0?'+':'▲')+(M==='guests'?cnt(Math.abs(d2))+'人':yen(Math.abs(d2)))}</span>`;
  // 日別表示のときは、表示範囲ぶんの天気をまとめて取得（取得後に自動で再描画される）＋独立した天気列を出す
  const wxDays=buckets.filter(b2=>b2.dt).map(b2=>dayMs(b2.dt));
  const hasWx=wxDays.length>0;
  if(hasWx) ensureWeather(names, Math.min(...wxDays), Math.max(...wxDays));
  h+=`<div class="panel"><div class="panel-head"><h3>明細</h3></div><div class="scroll-x"><table class="tbl"><thead><tr><th>期間</th>${hasWx?'<th>天気</th>':''}${series.map(x=>`<th>${esc(x.name)}</th>`).join('')}${hasYoY?'<th>差異（対前年）</th>':''}</tr></thead><tbody>`;
  buckets.forEach((bk,i)=>{
    // 日別表示のときは、その日にイベントがあれば日付セルの下に小さく表示（🎪 会場：イベント名）
    let evTxt='';
    if(bk.dt){ const evs=eventsFor(dayMs(bk.dt),names); if(evs.length) evTxt=`<div style="font-size:10px;color:#7a6f9a;margin-top:2px;white-space:normal">🎪 ${esc(eventLineText(evs))}</div>`; }
    const dateCell=(bk.dt?mdwH(bk.dt):esc(bk.label))+evTxt;
    const wxTd=hasWx?`<td style="white-space:nowrap">${bk.dt?wxCell(wxGet(names[0],dayMs(bk.dt))):''}</td>`:'';
    h+=`<tr><td>${dateCell}</td>${wxTd}${series.map(x=>`<td>${fmtV(x.data[i])}</td>`).join('')}${hasYoY?`<td>${diffTxt(series[0].data[i]-series[1].data[i])}</td>`:''}</tr>`;
  });
  // 合計行（客単価は加重平均で算出）
  const totOf=(gp)=>val(gp.recs,dayMs(s),dayMs(e));
  const totals=groups.map(gp=>totOf(gp));
  const wxTotTd=hasWx?'<td></td>':'';
  if(hasYoY){
    const prevTot=val(dailyIn,dayMs(sub1y(s)),dayMs(sub1y(e)));
    h+=`<tr class="total"><td>合計</td>${wxTotTd}<td>${fmtV(totals[0])}</td><td>${fmtV(prevTot)}</td><td>${diffTxt(totals[0]-prevTot)}</td></tr>`;
  } else {
    h+=`<tr class="total"><td>合計</td>${wxTotTd}${totals.map(v=>`<td>${fmtV(v)}</td>`).join('')}</tr>`;
  }
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:ml+'の推移', headers:['期間'].concat(hasWx?['天気']:[]).concat(series.map(x=>x.name)).concat(hasYoY?['差異(対前年)']:[]),
    rows:buckets.map((bk,i)=>[bk.label].concat(hasWx?[bk.dt?wxText(wxGet(names[0],dayMs(bk.dt))):'']:[]).concat(series.map(x=>Math.round(x.data[i]))).concat(hasYoY?[Math.round(series[0].data[i]-series[1].data[i])]:[])) });
  return h;
}

/* ---------------- 曜日別比較（第N週×曜日・前年対比・祝日は別枠） ---------------- */
function anaDowMonth(){
  if(S.aDowMonth){ const p=S.aDowMonth.split('-'); return new Date(+p[0],+p[1]-1,1); }
  const ref=D.refDate||new Date(); return new Date(ref.getFullYear(),ref.getMonth(),1);
}
function viewDowCompare(){
  const sc=scopeStores(); const selName=selStoreName();
  const names=selName?[selName]:sc; const nameSet=new Set(names);
  const M=S.aMetric||'sales';
  const ml=M==='sales'?'売上':(M==='guests'?'客数':'客単価');
  const fmtV=(v)=>v==null?'—':(M==='guests'?cnt(v)+'人':yen(v));
  const m0=anaDowMonth(); const y=m0.getFullYear(), m=m0.getMonth();
  const ref=D.refDate||new Date();
  const maxT=D.maxDate?dayMs(D.maxDate):dayMs(ref);
  const mLabel=y+'年 '+(m+1)+'月';
  const defMonth=ref.getFullYear()+'-'+String(ref.getMonth()+1).padStart(2,'0');

  // 集計：日ごとに {sales,guests} を当年・前年同月で作る
  const dayAgg=(yy,mm)=>{
    const ld=new Date(yy,mm+1,0).getDate(); const out=[];
    for(let d2=1;d2<=ld;d2++){
      const t=dayMs(new Date(yy,mm,d2));
      let sl=0,g=0;
      for(const r2 of D.daily){ if(r2.t===t&&nameSet.has(r2.store)){ sl+=r2.sales; g+=r2.guests; } }
      out.push({ d:d2, dt:new Date(yy,mm,d2), t, sl, g });
    }
    return out;
  };
  const curDays=dayAgg(y,m), prvDays=dayAgg(y-1,m);
  const vOf=(o)=>o?(M==='sales'?o.sl:(M==='guests'?o.g:(o.g>0?o.sl/o.g:null))):null;

  // 曜日キー：祝日は「祝」に分離（土日でも祝日優先）
  const dowKey=(dt)=>isJpHoliday(dt)?7:dt.getDay();   // 0-6=日〜土, 7=祝
  const DOW_LB=['日','月','火','水','木','金','土','祝'];
  const ORDER=[1,2,3,4,5,6,0,7];                       // 月→日→祝 の表示順

  // ① 曜日別サマリー（当月 vs 前年同月）
  const sum9=()=>({sl:0,g:0,n:0});
  const curBy={},prvBy={};
  // 実績のある日だけ集計（定休日・未来日・データ未取込日は日数に含めない）
  curDays.forEach(o=>{ if(o.t>maxT||(o.sl===0&&o.g===0))return; const k=dowKey(o.dt); (curBy[k]=curBy[k]||sum9()); curBy[k].sl+=o.sl; curBy[k].g+=o.g; curBy[k].n++; });
  prvDays.forEach(o=>{ if(o.sl===0&&o.g===0)return; const k=dowKey(o.dt); (prvBy[k]=prvBy[k]||sum9()); prvBy[k].sl+=o.sl; prvBy[k].g+=o.g; prvBy[k].n++; });
  const aggV=(o)=>o?(M==='sales'?o.sl:(M==='guests'?o.g:(o.g>0?o.sl/o.g:null))):null;
  const avgV=(o)=>o&&o.n>0?(M==='spend'?aggV(o):(aggV(o)||0)/o.n):null;

  let h=`
  <div class="ctrl-bar no-print">
    <div class="seg">${[['trend','推移'],['dow','曜日別比較']].map(([k,l])=>`<button class="${(S.aView||'trend')===k?'on':''}" onclick="App.set('aView','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['sales','売上'],['guests','客数'],['spend','客単価']].map(([k,l])=>`<button class="${M===k?'on':''}" onclick="App.set('aMetric','${k}')">${l}</button>`).join('')}</div>
    ${ymSelect('aDowMonth', y, m)}
    <span class="period-label">${mLabel} vs 前年同月（${y-1}年${m+1}月）</span>
  </div>`+storeSegHtml();

  h+=`<div class="panel"><div class="panel-head"><div><h3>曜日別 ${ml}比較（${mLabel}）</h3>
    <div class="sub">祝日は曜日に含めず「祝」として別集計 ／ 1日平均で前年同月と比較</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>曜日</th><th>今年 合計</th><th>日数</th><th>今年 1日平均</th><th>前年 1日平均</th><th>前年比</th></tr></thead><tbody>`;
  const expDow=[];
  ORDER.forEach(k=>{
    const c=curBy[k], p=prvBy[k];
    if(!c&&!p) return;
    const ca=avgV(c), pa=avgV(p);
    const yy=(ca!=null&&pa>0)?yoyStr(ca,pa,''):{t:'—',cls:'mut'};
    const red=k===0||k===6||k===7;
    h+=`<tr><td><span class="${red?'wd-hol':''}" style="font-weight:700">${DOW_LB[k]}</span></td>
      <td>${c?fmtV(aggV(c)):'—'}</td><td>${c?c.n+'日':'—'}</td>
      <td style="font-weight:700">${ca!=null?fmtV(ca):'—'}</td><td class="mut">${pa!=null?fmtV(pa):'—'}</td>
      <td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t}</td></tr>`;
    expDow.push([DOW_LB[k],c?Math.round(aggV(c)||0):'',c?c.n:'',ca!=null?Math.round(ca):'',pa!=null?Math.round(pa):'',yy.t]);
  });
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'曜日別'+ml+'比較（'+mLabel+'）', headers:['曜日','今年合計','日数','今年1日平均','前年1日平均','前年比'], rows:expDow });

  // ② 第N週 × 曜日 マトリクス（前年は同月同週・同曜日ブロックと比較）
  const wkIdx=(d2)=>Math.min(4,Math.floor((d2-1)/7));
  const cellPut=(map,o)=>{ if(o.sl===0&&o.g===0)return; const k=wkIdx(o.d)+'|'+dowKey(o.dt); (map[k]=map[k]||{sl:0,g:0,n:0}); map[k].sl+=o.sl; map[k].g+=o.g; map[k].n++; };
  const curCell={},prvCell={};
  curDays.forEach(o=>{ if(o.t<=maxT) cellPut(curCell,o); });
  prvDays.forEach(o=>cellPut(prvCell,o));
  h+=`<div class="panel"><div class="panel-head"><div><h3>週×曜日 ${ml}マトリクス（${mLabel}）</h3>
    <div class="sub">上段=今年 ／ 下段=前年比（前年同月の同じ週・同じ曜日と比較）。祝日は「祝」列。第N週=1-7 / 8-14 / 15-21 / 22-28 / 29-末</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>週</th>${ORDER.map(k=>`<th><span class="${k===0||k===6||k===7?'wd-hol':''}">${DOW_LB[k]}</span></th>`).join('')}</tr></thead><tbody>`;
  const expMx=[];
  for(let w=0;w<5;w++){
    const sd=w*7+1, ld=new Date(y,m+1,0).getDate();
    if(sd>ld) break;
    const ed=w<4?Math.min(sd+6,ld):ld;
    let row=`<tr><td style="font-weight:700;white-space:nowrap">第${w+1}週<br><span class="mut" style="font-size:10px">${m+1}/${sd}〜${ed}</span></td>`;
    const expRow=['第'+(w+1)+'週('+(m+1)+'/'+sd+'〜'+ed+')'];
    ORDER.forEach(k=>{
      const c=curCell[w+'|'+k], p=prvCell[w+'|'+k];
      const cv=aggV(c), pv2=aggV(p);
      if(cv==null&&pv2==null){ row+='<td class="mut">—</td>'; expRow.push(''); return; }
      const yy=(cv!=null&&pv2>0)?yoyStr(cv,pv2,''):null;
      row+=`<td>${cv!=null?fmtV(cv):'<span class="mut">—</span>'}${yy?`<br><span class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}" style="font-size:10.5px">${yy.t}</span>`:(pv2!=null?`<br><span class="mut" style="font-size:10.5px">前年 ${fmtV(pv2)}</span>`:'')}</td>`;
      expRow.push((cv!=null?Math.round(cv):'')+(yy?' ('+yy.t+')':''));
    });
    h+=row+'</tr>'; expMx.push(expRow);
  }
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'週×曜日'+ml+'マトリクス（'+mLabel+'）', headers:['週'].concat(ORDER.map(k=>DOW_LB[k])), rows:expMx });
  return h;
}

/* ---------------- 明細分析（BigQuery連携：時間帯別・商品別） ---------------- */
// D.extra の中から、キー名に候補語を含むシート（生の2次元配列）を取り出す
function extraSheet(...cands){
  for(const key in (D.extra||{})){
    if(cands.some(c=>String(key).indexOf(c)>=0)) return D.extra[key];
  }
  return null;
}
// 見出し行があれば飛ばして {header, rows} を返す（col1が数値なら見出し無しとみなす）
function parseGrid(rows){
  if(!Array.isArray(rows)||!rows.length) return {header:[], data:[]};
  const first=rows[0].map(x=>String(x==null?'':x).trim());
  const looksHeader = first.length>1 && isNaN(Number(String(first[1]).replace(/[,¥]/g,'')));
  return { header:looksHeader?first:[], data:looksHeader?rows.slice(1):rows };
}
// 見出し配列から候補名の列インデックスを返す（見つからなければ-1）
function hcol(header, ...names){ if(!header)return -1; for(const nm of names){ const i=header.findIndex(x=>String(x).trim().toLowerCase()===String(nm).toLowerCase()); if(i>=0)return i; } return -1; }
// 明細分析の対象期間（S.dPeriod等）→ {from,to,label}
function detailRange(){
  const ref=D.refDate||new Date();
  const pI=(s)=>{const p=String(s).split('-');return new Date(+p[0],+p[1]-1,(p[2]?+p[2]:1));};
  const fmt=(d)=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  const P=S.dPeriod||'month';
  let s,e,label;
  if(P==='day'){ const d=S.dDay?pI(S.dDay):new Date(ref.getFullYear(),ref.getMonth(),ref.getDate()); s=d;e=d; label=mdw(d); }
  else if(P==='week'){
    const m0=S.dMonth?pI(S.dMonth+'-01'):new Date(ref.getFullYear(),ref.getMonth(),1);
    const y=m0.getFullYear(),m=m0.getMonth(),ld=new Date(y,m+1,0).getDate();
    const idx=(S.dWeekIdx!=null)?S.dWeekIdx:0; const sd=idx*7+1, ed=idx<4?Math.min(sd+6,ld):ld;
    s=new Date(y,m,sd); e=new Date(y,m,ed); label=y+'年'+(m+1)+'月 第'+(idx+1)+'週';
  }
  else if(P==='month'){ const m0=S.dMonth?pI(S.dMonth+'-01'):new Date(ref.getFullYear(),ref.getMonth(),1);
    s=new Date(m0.getFullYear(),m0.getMonth(),1); e=new Date(m0.getFullYear(),m0.getMonth()+1,0); label=m0.getFullYear()+'年'+(m0.getMonth()+1)+'月'; }
  else if(P==='year'){ const y=+(S.dYear||ref.getFullYear()); s=new Date(y,0,1); e=(y===ref.getFullYear())?new Date(ref.getFullYear(),ref.getMonth(),ref.getDate()):new Date(y,11,31); label=y+'年'; }
  else { s=S.dStart?pI(S.dStart):addD(ref,-29); e=S.dEnd?pI(S.dEnd):new Date(ref.getFullYear(),ref.getMonth(),ref.getDate()); if(dayMs(s)>dayMs(e)){const t=s;s=e;e=t;} label=(s.getMonth()+1)+'/'+s.getDate()+'〜'+(e.getMonth()+1)+'/'+e.getDate(); }
  return { from:fmt(s), to:fmt(e), label };
}
// BQに明細（期間・店舗絞り）を問い合わせ。キーで重複取得を防ぎ、取得後にrender。
async function fetchDetail(){
  if(!S.auth||!S.auth.token) return;
  const r=detailRange(); const key=[r.from,r.to,S.dStore,S.dBasis||'checkout'].join('|');
  if(D.detailKey===key && D.detailData) return;
  if(D.detailLoading===key) return;
  D.detailLoading=key;
  try{
    const d=await api({ action:'bqDetail', token:S.auth.token, from:r.from, to:r.to, store:S.dStore, basis:S.dBasis||'checkout' });
    if(d&&d.ok){ D.detailData={ hour:d.hour||[], item:d.item||[], store:d.store||[], hourItem:d.hourItem||[] }; D.detailKey=key; }
    else { D.detailData={ hour:[], item:[], store:[], hourItem:[], err:(d&&d.error)||'取得失敗' }; D.detailKey=key; }
  }catch(e){ D.detailData={ hour:[], item:[], store:[], hourItem:[], err:String(e.message||e) }; D.detailKey=key; }
  D.detailLoading=''; render();
}
function viewDetail(){
  // 権限：全店アクセスでないアカウントは担当店舗のみ。担当が複数あるマネージャー等は
  // 'all'（担当店舗合算）も選べる。担当が1店だけのアカウントはその1店に固定する。
  const allowed=scopeStores();
  const fullAccess=allowed.length>=allStores().length;
  const canAgg=fullAccess||allowed.length>1;   // 合算（全店／担当店舗合算）を選べるか
  if(S.dStore==='all'){ if(!canAgg) S.dStore=allowed[0]||'all'; }
  else if(!fullAccess && !allowed.includes(S.dStore)) S.dStore=canAgg?'all':(allowed[0]||'all');
  const stores=fullAccess?allStores():allowed;
  const taxExcl=(S.detailTax||'excl')==='excl'; const taxLb=taxExcl?'税別':'税込';
  const r=detailRange(); const key=[r.from,r.to,S.dStore,S.dBasis||'checkout'].join('|');
  fetchDetail(); // 必要なら取得（キー一致なら何もしない）
  const ref=D.refDate||new Date();
  const defMonth=ref.getFullYear()+'-'+String(ref.getMonth()+1).padStart(2,'0');
  const P=S.dPeriod||'month';
  const pm=(S.dMonth||defMonth).split('-'); const py=+pm[0], pmo=+pm[1]-1;
  let picker='';
  if(P==='day') picker=`<input type="date" value="${S.dDay||defMonth+'-'+String(ref.getDate()).padStart(2,'0')}" onchange="App.set('dDay',this.value)">`;
  else if(P==='week') picker=`${ymSelect('dMonth',py,pmo)}<span class="seg">${[0,1,2,3,4].map(i=>`<button class="${(S.dWeekIdx||0)===i?'on':''}" onclick="App.set('dWeekIdx',${i})">第${i+1}週</button>`).join('')}</span>`;
  else if(P==='month') picker=ymSelect('dMonth',py,pmo);
  else if(P==='year'){ const ys=D.daily.map(x=>new Date(x.t).getFullYear()).filter(v=>v>2000); ys.push(ref.getFullYear()); const mn=Math.min(...ys),mx=Math.max(...ys); const yy=[]; for(let v=mn;v<=mx;v++)yy.push(v); picker=`<select class="ym-pick" onchange="App.set('dYear',this.value)">${yy.map(v=>`<option value="${v}" ${String(S.dYear||ref.getFullYear())===String(v)?'selected':''}>${v}年</option>`).join('')}</select>`; }
  else picker=`<input type="date" value="${S.dStart}" onchange="App.set('dStart',this.value)"> 〜 <input type="date" value="${S.dEnd}" onchange="App.set('dEnd',this.value)">`;
  const aggOpt=fullAccess?`<option value="all" ${S.dStore==='all'?'selected':''}>全店</option>`
    :(allowed.length>1?`<option value="all" ${S.dStore==='all'?'selected':''}>担当店舗（一覧）</option>`:'');
  const storeOpts=aggOpt+stores.map(s=>`<option ${S.dStore===s?'selected':''}>${esc(s)}</option>`).join('');
  let h=`<div class="ctrl-bar no-print">
    <select onchange="App.set('dStore',this.value)" style="font-weight:700">${storeOpts}</select>
    <div class="seg">${[['day','日'],['week','週'],['month','月'],['year','年'],['custom','期間指定']].map(([k,l])=>`<button class="${P===k?'on':''}" onclick="App.set('dPeriod','${k}')">${l}</button>`).join('')}</div>
    ${picker}
    <div class="seg">${[['excl','税別'],['incl','税込']].map(([k,l])=>`<button class="${(S.detailTax||'excl')===k?'on':''}" onclick="App.set('detailTax','${k}')">${l}</button>`).join('')}</div>
    <span class="period-label">${esc(r.label)} ／ ${S.dStore==='all'?(fullAccess?'全店':'担当店舗（一覧）'):esc(S.dStore)}（${taxLb}）</span>
  </div>
  <div class="note-box no-print" style="margin:4px 0 2px;padding:9px 13px;font-size:11.5px">ℹ️ POS明細の積み上げ（傾向・構成比を見る用／金額の正は日別売上）。客数はお通し数ベースの推定です。</div>`;
  // その日のイベント（「日」表示かつ特定店舗を選んでいるときだけ・その店舗対象のイベントのみ）。
  // 月/年/全店では出さない（多すぎ・対象外店舗のイベントが混じるため）。
  if(S.dPeriod==='day' && S.dStore && S.dStore!=='all'){
    const wt=dayMs(new Date(r.from));
    ensureWeather([S.dStore],wt,wt);
    const wx=wxGet(S.dStore,wt);
    if(wx){ const al=wxAlertOf(wx), a=al?WX_ALERT[al]:null, c=WX_CODES[wx.code]||{i:'',t:''};
      h+=`<div class="panel" style="border-left:3px solid ${a?a.bd:'#9dbcd6'};padding:12px 16px;margin:4px 0">
        <div style="font-size:12px;font-weight:700;color:#5c5348;margin-bottom:4px">${a?a.i:c.i} この日の天気${wx.future?'（予報）':''}</div>
        <div style="font-size:12.5px;color:#5c5348">${a?`<b style="color:${a.fg}">${esc(a.t)}</b> ／ `:''}${c.i} ${esc(c.t)}
          ${wx.tmax!=null?` ／ 最高 ${Math.round(wx.tmax)}℃`:''}${wx.tmin!=null?` ・最低 ${Math.round(wx.tmin)}℃`:''}
          ${wx.prec>0?` ／ 降水 ${wx.prec.toFixed(1)}mm`:''}${wx.wind>0?` ／ 最大風速 ${wx.wind.toFixed(1)}m/s`:''}${wx.gust>0?`（瞬間 ${wx.gust.toFixed(1)}m/s）`:''}</div></div>`; }
    const evs=eventsFor(dayMs(new Date(r.from)),[S.dStore]);
    if(evs.length){ h+=`<div class="panel" style="border-left:3px solid #7a6f9a;padding:12px 16px;margin:4px 0"><div style="font-size:12px;font-weight:700;color:#5c5348;margin-bottom:4px">🎪 この日のイベント</div>`+
      evs.map(e=>`<div style="font-size:12.5px;color:#5c5348;padding:2px 0">${e.venue?esc(e.venue)+'：':''}${esc(e.name)}${e.memo?' <span class="mut" style="font-size:11px">'+esc(e.memo)+'</span>':''}</div>`).join('')+`</div>`; } }
  if(!S.auth){ return h+`<div class="panel"><div class="empty">ログイン後、BigQueryの明細が表示されます</div></div>`; }
  if(D.detailKey!==key || !D.detailData){ return h+`<div class="panel"><div class="empty">読み込み中…（BigQuery集計）</div></div>`; }
  const dd=D.detailData;
  if(dd.err){ return h+`<div class="panel"><div class="empty">取得エラー: ${esc(dd.err)}</div></div>`; }
  const salesAt=(H,row)=>{ const ie=hcol(H,'sales_excl'),is=hcol(H,'sales'); return num(row[taxExcl?(ie>=0?ie:is):(is>=0?is:ie)]); };

  // 店舗別（全店選択時）
  if(dd.store&&dd.store.length>1){ const H=dd.store[0]; const iChk=hcol(H,'checks'),iG=hcol(H,'guests'),iDr=hcol(H,'drink'),iKa=hcol(H,'karaoke'),iFo=hcol(H,'food');
    const hasBk=(iDr>=0&&iFo>=0);
    const recs=dd.store.slice(1).map(row=>({store:String(row[0]||'').trim(),sales:salesAt(H,row),checks:num(row[iChk]),guests:num(row[iG]),drink:num(row[iDr]),karaoke:num(row[iKa]),food:num(row[iFo])})).filter(x=>x.store).sort((a,b)=>b.sales-a.sales);
    if(recs.length){ const tot=recs.reduce((s,x)=>s+x.sales,0);
      const shr=(v,b)=>b>0?`<span style="color:#8c8375;font-size:10px">(${(v/b*100).toFixed(0)}%)</span>`:'';   // その店の売上に対する構成比
      const bkHead=hasBk?`<th>ドリンク</th><th>フード</th><th>カラオケ</th>`:'';
      h+=`<div class="panel"><div class="panel-head"><div><h3>店舗別 売上（${taxLb}）</h3>${hasBk?`<div class="sub">ドリンク/フード/カラオケは明細から推定（税別・コース1800円=ドリンク／サービス料50%案分）。( )内は各店売上に対する比率</div>`:''}</div></div><div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>売上</th>${bkHead}<th>会計数</th><th>客数</th><th>客単価</th><th>構成比</th></tr></thead><tbody>`;
      recs.forEach(x=>{ const bk=hasBk?`<td>${yen(x.drink)} ${shr(x.drink,x.sales)}</td><td>${yen(x.food)} ${shr(x.food,x.sales)}</td><td>${yen(x.karaoke)} ${shr(x.karaoke,x.sales)}</td>`:''; h+=`<tr><td>${shortStoreTd(x.store)}</td><td>${yen(x.sales)}</td>${bk}<td>${cnt(x.checks)}組</td><td>${cnt(x.guests)}人</td><td>${yen(x.guests>0?x.sales/x.guests:0)}</td><td>${tot>0?(x.sales/tot*100).toFixed(1):'—'}%</td></tr>`; });
      const sumD=recs.reduce((s,x)=>s+x.drink,0),sumF=recs.reduce((s,x)=>s+x.food,0),sumK=recs.reduce((s,x)=>s+x.karaoke,0);
      const bkTot=hasBk?`<td>${yen(sumD)} ${shr(sumD,tot)}</td><td>${yen(sumF)} ${shr(sumF,tot)}</td><td>${yen(sumK)} ${shr(sumK,tot)}</td>`:'';
      h+=`<tr class="total"><td>${fullAccess?'全店合計':'担当店舗 合計'}</td><td>${yen(tot)}</td>${bkTot}<td>${cnt(recs.reduce((s,x)=>s+x.checks,0))}組</td><td>${cnt(recs.reduce((s,x)=>s+x.guests,0))}人</td><td></td><td>100%</td></tr></tbody></table></div></div>`;
      const bkH=hasBk?['ドリンク','ドリンク比','フード','フード比','カラオケ','カラオケ比']:[];
      EXPORT.push({ title:'店舗別('+taxLb+')', headers:['店舗','売上',...bkH,'会計数','客数','客単価','構成比'], rows:recs.map(x=>[x.store,Math.round(x.sales),...(hasBk?[Math.round(x.drink),(x.sales>0?(x.drink/x.sales*100).toFixed(0)+'%':''),Math.round(x.food),(x.sales>0?(x.food/x.sales*100).toFixed(0)+'%':''),Math.round(x.karaoke),(x.sales>0?(x.karaoke/x.sales*100).toFixed(0)+'%':'')]:[]),Math.round(x.checks),Math.round(x.guests),Math.round(x.guests>0?x.sales/x.guests:0),tot>0?(x.sales/tot*100).toFixed(1)+'%':'']) });
    }
  }
  // 時間帯別（客数入り）
  if(dd.hour&&dd.hour.length>1){ const H=dd.hour[0]; const iH=hcol(H,'hour'),iChk=hcol(H,'checks'),iG=hcol(H,'guests'),iQ=hcol(H,'qty');
    const recs=dd.hour.slice(1).map(row=>({hour:parseInt(String(row[iH]).replace(/[^0-9]/g,''),10),sales:salesAt(H,row),checks:num(row[iChk]),guests:num(row[iG]),qty:num(row[iQ])})).filter(x=>!isNaN(x.hour));
    const ord=(x)=>(x.hour+18)%24; recs.sort((a,b)=>ord(a)-ord(b));
    const cat=recs.map(x=>x.hour+'時');
    const tS=recs.reduce((s,x)=>s+x.sales,0),tC=recs.reduce((s,x)=>s+x.checks,0),tG=recs.reduce((s,x)=>s+x.guests,0),tQ=recs.reduce((s,x)=>s+x.qty,0);
    const peak=recs.reduce((m,x)=>x.sales>m.sales?x:m,{sales:-1});
    h+=`<div class="kpi-grid">
      <div class="kpi"><div class="lb">売上（${taxLb}）</div><div class="vl">${yen(tS)}</div><div class="yy">${esc(r.label)}</div></div>
      <div class="kpi"><div class="lb">会計数 / 客数</div><div class="vl" style="font-size:19px">${cnt(tC)}組 / ${cnt(tG)}人</div><div class="yy">客数=お通し推定</div></div>
      <div class="kpi"><div class="lb">客単価</div><div class="vl">${yen(tG>0?tS/tG:0)}</div><div class="yy">${taxLb}・売上÷客数</div></div>
      <div class="kpi"><div class="lb">ピーク時間帯</div><div class="vl">${peak.sales>=0?peak.hour+'時台':'—'}</div><div class="yy">${peak.sales>=0?yen(peak.sales):''}</div></div>
    </div>`;
    const series=[{name:'売上',color:C_NOW,data:recs.map(x=>x.sales)}];
    const basisNow=(S.dBasis==='order'||S.dBasis==='arrival')?S.dBasis:'checkout';
    const basisSeg=`<div class="seg no-print">${[['checkout','会計時'],['arrival','来店時'],['order','オーダー時']].map(([k,l])=>`<button class="${basisNow===k?'on':''}" onclick="App.set('dBasis','${k}')">${l}</button>`).join('')}</div>`;
    const basisLb={checkout:'会計時（会計日時）',arrival:'来店時（伝票の最初のオーダー）',order:'オーダー時（各明細のオーダー日時）'}[basisNow];
    h+=`<div class="panel"><div class="panel-head"><div><h3>時間帯別 売上（${taxLb}）</h3><div class="sub">営業日順（夕方→深夜）／ 棒＝売上／ 集計基準＝${basisLb}</div></div>${basisSeg}</div>${barChart(cat,series,{})}
      <div class="scroll-x"><table class="tbl"><thead><tr><th>時間帯</th><th>売上</th><th>出数</th><th>会計数</th><th>客数</th><th>客単価</th><th>構成比</th></tr></thead><tbody>`;
    recs.forEach(x=>{ h+=`<tr><td>${x.hour}時台</td><td>${yen(x.sales)}</td><td>${cnt(x.qty)}点</td><td>${cnt(x.checks)}組</td><td>${cnt(x.guests)}人</td><td>${yen(x.guests>0?x.sales/x.guests:0)}</td><td>${tS>0?(x.sales/tS*100).toFixed(1):'—'}%</td></tr>`; });
    h+=`<tr class="total"><td>合計</td><td>${yen(tS)}</td><td>${cnt(tQ)}点</td><td>${cnt(tC)}組</td><td>${cnt(tG)}人</td><td>${yen(tG>0?tS/tG:0)}</td><td>100%</td></tr></tbody></table></div></div>`;
    EXPORT.push({ title:'時間帯別('+taxLb+')', headers:['時間帯','売上','出数','会計数','客数','客単価','構成比'], rows:recs.map(x=>[x.hour+'時台',Math.round(x.sales),Math.round(x.qty),Math.round(x.checks),Math.round(x.guests),Math.round(x.guests>0?x.sales/x.guests:0),tS>0?(x.sales/tS*100).toFixed(1)+'%':'']) });
  }
  // 時間帯×商品 出数（0円商品も含む・出数上位40商品）
  if(dd.hourItem&&dd.hourItem.length>1){ const H=dd.hourItem[0]; const iH=hcol(H,'hour'),iM=hcol(H,'menu'),iQ=hcol(H,'qty');
    const cells=dd.hourItem.slice(1).map(row=>({hour:parseInt(String(row[iH]).replace(/[^0-9]/g,''),10),menu:String(row[iM]||'').trim(),qty:num(row[iQ])})).filter(x=>!isNaN(x.hour)&&x.menu);
    if(cells.length){
      const ord=(hh)=>(hh+18)%24;
      const hours=[...new Set(cells.map(c=>c.hour))].sort((a,b)=>ord(a)-ord(b));
      const byMenu={}; cells.forEach(c=>{ (byMenu[c.menu]=byMenu[c.menu]||{tot:0,h:{}}); byMenu[c.menu].tot+=c.qty; byMenu[c.menu].h[c.hour]=(byMenu[c.menu].h[c.hour]||0)+c.qty; });
      const menus=Object.keys(byMenu).sort((a,b)=>byMenu[b].tot-byMenu[a].tot);
      const colTot={}; hours.forEach(hh=>colTot[hh]=cells.filter(c=>c.hour===hh).reduce((s,c)=>s+c.qty,0));
      const grand=cells.reduce((s,c)=>s+c.qty,0);
      const mx=Math.max(...cells.map(c=>c.qty),1);
      const cellBg=(v)=>v>0?`background:rgba(76,125,92,${(0.10+0.55*v/mx).toFixed(2)})`:'';
      h+=`<div class="panel"><div class="panel-head"><div><h3>時間帯×商品 出数</h3><div class="sub">何時にどの商品が何点出たか（0円商品も含む・出数上位40商品／濃いほど多い）</div></div></div>
        <div class="scroll-x"><table class="tbl"><thead><tr><th class="stick-l">商品</th>${hours.map(hh=>`<th>${hh}時</th>`).join('')}<th>合計</th></tr></thead><tbody>`;
      menus.forEach(m=>{ const row=byMenu[m]; h+=`<tr><td class="stick-l">${shortMenuTd(m)}</td>${hours.map(hh=>{ const v=row.h[hh]||0; return `<td style="text-align:center;${cellBg(v)}">${v>0?cnt(v):''}</td>`; }).join('')}<td style="text-align:right;font-weight:700">${cnt(row.tot)}</td></tr>`; });
      h+=`<tr class="total"><td class="stick-l">合計</td>${hours.map(hh=>`<td style="text-align:center">${cnt(colTot[hh])}</td>`).join('')}<td style="text-align:right">${cnt(grand)}</td></tr></tbody></table></div></div>`;
      EXPORT.push({ title:'時間帯×商品出数', headers:['商品',...hours.map(hh=>hh+'時'),'合計'], rows:menus.map(m=>[m,...hours.map(hh=>byMenu[m].h[hh]||0),byMenu[m].tot]) });
    }
  }
  // 商品別（3モード：売上/出数/ABC）
  if(dd.item&&dd.item.length>1){ const H=dd.item[0]; const iQ=hcol(H,'qty');
    let recs=dd.item.slice(1).map(row=>({menu:String(row[0]||'').trim(),sales:salesAt(H,row),qty:num(row[iQ])})).filter(x=>x.menu);
    const mode=S.dRankMode||'sales';
    const modeSel=`<select onchange="App.set('dRankMode',this.value)" style="font-weight:700">
      <option value="sales" ${mode==='sales'?'selected':''}>売上ランキング</option>
      <option value="qty" ${mode==='qty'?'selected':''}>出数ランキング</option>
      <option value="abc" ${mode==='abc'?'selected':''}>ABC分析</option></select>`;
    if(mode==='qty') recs.sort((a,b)=>b.qty-a.qty); else recs.sort((a,b)=>b.sales-a.sales);
    if(mode==='abc'){
      const totS=recs.reduce((s,x)=>s+x.sales,0); let cum=0;
      recs=recs.map(x=>{ cum+=x.sales; const cp=totS>0?cum/totS*100:0; return {...x,cumPct:cp,cls:cp<=70?'A':cp<=90?'B':'C'}; });
      const cnts={A:0,B:0,C:0}; recs.forEach(x=>cnts[x.cls]++);
      h+=`<div class="panel"><div class="panel-head"><div><h3>商品別 ABC分析（${taxLb}）</h3><div class="sub">売上構成比の累計で A(〜70%)/B(〜90%)/C(残り)。A=${cnts.A}品 B=${cnts.B}品 C=${cnts.C}品</div></div>${modeSel}</div>
        <div class="scroll-x"><table class="tbl"><thead><tr><th>順位</th><th>商品</th><th>売上</th><th>出数</th><th>累計構成比</th><th>区分</th></tr></thead><tbody>`;
      recs.slice(0,200).forEach((x,i)=>{ const bc=x.cls==='A'?'ok':x.cls==='B'?'mid':'zero'; h+=`<tr><td>${i+1}</td><td>${shortMenuTd(x.menu)}</td><td>${yen(x.sales)}</td><td>${cnt(x.qty)}点</td><td>${x.cumPct.toFixed(1)}%</td><td><span class="badge ${bc}">${x.cls}</span></td></tr>`; });
      h+=`</tbody></table></div></div>`;
      EXPORT.push({ title:'商品ABC('+taxLb+')', headers:['順位','商品','売上','出数','累計構成比','区分'], rows:recs.map((x,i)=>[i+1,x.menu,Math.round(x.sales),Math.round(x.qty),x.cumPct.toFixed(1)+'%',x.cls]) });
    } else {
      const val=(x)=>mode==='qty'?x.qty:x.sales; const maxV=recs.length?val(recs[0]):1;
      h+=`<div class="panel"><div class="panel-head"><div><h3>商品別 ${mode==='qty'?'出数':'売上'}ランキング（${taxLb}）</h3></div>${modeSel}</div>
        <div class="scroll-x"><table class="tbl"><thead><tr><th>順位</th><th>商品</th><th>売上</th><th>出数</th><th></th></tr></thead><tbody>`;
      recs.slice(0,50).forEach((x,i)=>{ const pct=Math.round(val(x)/(maxV||1)*100); h+=`<tr><td>${i+1}</td><td>${shortMenuTd(x.menu)}</td><td>${yen(x.sales)}</td><td>${cnt(x.qty)}点</td><td style="min-width:120px"><div style="height:7px;background:#efe9dd;border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${mode==='qty'?'#3d5163':'#5f7052'}"></div></div></td></tr>`; });
      h+=`</tbody></table></div></div>`;
      EXPORT.push({ title:'商品'+(mode==='qty'?'出数':'売上')+'('+taxLb+')', headers:['順位','商品','売上','出数'], rows:recs.map((x,i)=>[i+1,x.menu,Math.round(x.sales),Math.round(x.qty)]) });
    }
  }
  // 取込カバレッジ（全期間・参考）
  const covRaw=extraSheet('明細カバレッジ');
  if(covRaw){ const g=parseGrid(covRaw); const H=g.header;
    const iMo=hcol(H,'month'),iSt=hcol(H,'stores'),iDy=hcol(H,'days'),iRw=hcol(H,'rows');
    const recs=g.data.map(row=>({month:String(row[iMo>=0?iMo:0]||'').trim(),stores:num(row[iSt>=0?iSt:1]),days:num(row[iDy>=0?iDy:2]),rows:num(row[iRw>=0?iRw:3])})).filter(x=>x.month);
    if(recs.length){ const maxSt=Math.max(...recs.map(x=>x.stores));
      h+=`<div class="panel"><div class="panel-head"><div><h3>取込カバレッジ（月別・参考）</h3><div class="sub">店舗数が少ない月は取りこぼし/導入前。気になる月は再取得を依頼できます（最大${maxSt}店）</div></div></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>月</th><th>店舗数</th><th>日数</th><th>明細行数</th><th>状態</th></tr></thead><tbody>`;
      recs.forEach(x=>{ const full=x.stores>=maxSt; h+=`<tr><td>${esc(x.month)}</td><td class="${full?'':'neg'}">${x.stores}店</td><td>${x.days}日</td><td>${cnt(x.rows)}</td><td>${full?'<span class="badge ok">充足</span>':'<span class="badge ng">'+(maxSt-x.stores)+'店 不足?</span>'}</td></tr>`; });
      h+=`</tbody></table></div></div>`;
    }
  }
  return h;
}

/* ---------------- 入金管理 ---------------- */
// 店舗名のゆらぎを吸収して照合するための正規化。
// 意味のある文字（英数・ひらがな・カタカナ・漢字）だけ残し、
// 空白・記号・ゼロ幅スペースなどの「見えない文字」は全て除去する（自動取込の混入対策）。
function normStore(s){ return String(s==null?'':s).normalize('NFKC').replace(/[^0-9A-Za-z぀-ヿ㐀-鿿豈-﫿]/g,'').toLowerCase(); }
function depMonthDate(){
  if(S.depMonth){ const p=S.depMonth.split('-'); return new Date(+p[0],+p[1]-1,1); }
  const ref=D.refDate||new Date(); return new Date(ref.getFullYear(),ref.getMonth(),1);
}
function viewDeposit(){
  const sc=scopeStores(); const selName=selStoreName();
  const m0=depMonthDate();
  const y=m0.getFullYear(), m=m0.getMonth(), lastDay=new Date(y,m+1,0).getDate();
  const mS=dayMs(new Date(y,m,1)), mE=dayMs(new Date(y,m,lastDay));
  const targets=selName?[selName]:sc; const tSet=new Set(targets); const tKey=new Set(targets.map(normStore));
  const maxT=D.maxDate?dayMs(D.maxDate):Infinity;

  // 入金記録が始まった日より前の現金売上は未入金の対象にしない
  let depStart=Infinity;
  for(const r of D.deposit){ if(r.t<depStart) depStart=r.t; }
  if(!isFinite(depStart)) depStart=mS;

  // 繰越（入金記録開始日〜月初前日の 現金売上−入金）
  let carry=0;
  for(const r of D.daily){ if(tKey.has(normStore(r.store))&&r.t>=depStart&&r.t<mS) carry+=r.cash||0; }
  for(const r of D.deposit){ if(tKey.has(normStore(r.store))&&r.t<mS) carry-=r.amount||0; }

  // 日別集計
  const days=[]; let cum=carry, tC=0,tD=0;
  for(let d=1;d<=lastDay;d++){
    const t=dayMs(new Date(y,m,d));
    let cash=0,dep=0;
    for(const r of D.daily){ if(tKey.has(normStore(r.store))&&r.t===t) cash+=r.cash||0; }
    for(const r of D.deposit){ if(tKey.has(normStore(r.store))&&r.t===t) dep+=r.amount||0; }
    const diff=cash-dep;
    const future=t>maxT;
    if(!future){ cum+=diff; tC+=cash; tD+=dep; }
    days.push({ d, dt:new Date(y,m,d), cash, dep, diff, cum, future });
  }
  const isAll=!selName&&sc.length===allStores().length;
  const scopeLabel=selName||(isAll?'全店合算':'担当店舗合算');
  const mLabel=y+'年 '+(m+1)+'月';

  let h=`
  <div class="ctrl-bar no-print">
    ${ymSelect('depMonth', y, m)}
    ${canUse('depositImport')?`<button class="icon-btn primary" onclick="App.openDepositImport()">⬆ 口座CSVを取込</button>`:''}
    <span class="period-label">現金売上（入金予定）と ATM入金の照合 ／ ${esc(scopeLabel)}</span>
  </div>`+storeSegHtml();

  // 🔧 診断モード（URLに ?debug=1 を付けた時だけ表示）
  if(typeof location!=='undefined' && new URLSearchParams(location.search).has('debug')){
    const dm=D.deposit.filter(r=>r.t>=mS&&r.t<=mE).sort((a,b)=>a.t-b.t);
    h+=`<div class="panel"><div class="panel-head"><div><h3>🔧 診断：今月の入金データ（生）</h3><div class="sub">入金総件数 ${D.deposit.length} 件 ／ 診断 ${esc(D.diag.deposit||'(なし)')}</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>日付</th><th>店舗（生）</th><th>正規化</th><th>スコープ内</th><th>金額</th></tr></thead><tbody>`;
    dm.forEach(r=>{ const dt=new Date(r.t); h+=`<tr><td>${dt.getMonth()+1}/${dt.getDate()}</td><td>${esc(JSON.stringify(r.store))}</td><td>${esc(normStore(r.store))}</td><td>${tKey.has(normStore(r.store))?'○':'×'}</td><td>${yen(r.amount)}</td></tr>`; });
    h+=`</tbody></table></div><div class="sub">スコープ内の店舗: ${esc([...tKey].join(' / '))}</div></div>`;
  }

  // サマリーカード
  const unpaid=tC-tD;
  h+=`<div class="kpi-grid">
    <div class="kpi"><div class="lb">繰越未入金（前月まで）</div><div class="vl" style="color:${carry>0?'#b5502f':'#3d3a33'}">${yen(carry)}</div><div class="yy">入金記録開始以降の累計</div></div>
    <div class="kpi"><div class="lb">当月 入金予定（現金売上）</div><div class="vl">${yen(tC)}</div><div class="yy">${mLabel}実績分</div></div>
    <div class="kpi"><div class="lb">当月 入金済（ATM）</div><div class="vl">${yen(tD)}</div><div class="yy">${mLabel}実績分</div></div>
    <div class="kpi"><div class="lb">当月 未入金</div><div class="vl ${unpaid>0?'':''}" style="color:${unpaid>0?'#b5502f':'#4c7d5c'}">${yen(unpaid)}</div><div class="yy" style="font-weight:700;font-size:13px;color:${(days.length?(days[days.length-1].future?cum:days[days.length-1].cum):carry)>0?'#b5502f':'#4c7d5c'}">累計残 ${yen(days.length?days[days.length-1].future?cum:days[days.length-1].cum:carry)}</div></div>
  </div>`;

  // 店舗別サマリー（合算表示時のみ）
  if(!selName&&sc.length>1){
    h+=`<div class="panel"><div class="panel-head"><div><h3>店舗別 入金状況（${mLabel}）</h3><div class="sub">行クリックで店舗の日別明細へ</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>入金予定(現金売上)</th><th>入金(ATM)</th><th>未入金(当月)</th><th>累計未入金</th><th>状態</th></tr></thead><tbody>`;
    const expS=[];
    sc.forEach(nm=>{
      let c=0,dp=0,cAll=0,dAll=0; const cashByDay={};
      for(const r of D.daily){ if(normStore(r.store)!==normStore(nm))continue; if(r.t>=mS&&r.t<=mE&&r.t<=maxT){ c+=r.cash||0; cashByDay[r.t]=(cashByDay[r.t]||0)+(r.cash||0); } if(r.t>=depStart&&r.t<=Math.min(mE,maxT))cAll+=r.cash||0; }
      for(const r of D.deposit){ if(normStore(r.store)!==normStore(nm))continue; if(r.t>=mS&&r.t<=mE)dp+=r.amount||0; if(r.t<=mE)dAll+=r.amount||0; }
      const u=c-dp, cu=cAll-dAll;
      // 完了判定：各日の入金予定を千円未満切捨てした合計以上が入っていれば「完了」（端数は許容）
      const cFloor=Object.values(cashByDay).reduce((s2,v)=>s2+Math.floor(v/1000)*1000,0);
      const okDone=dp>=cFloor;
      const badge=okDone?(c>0||dp>0?'<span class="badge ok">完了</span>':'<span class="badge zero">—</span>'):'<span class="badge ng">未入金あり</span>';
      h+=`<tr class="click" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}"><td>${shortStoreTd(nm)}</td><td>${yen(c)}</td><td>${yen(dp)}</td>
        <td class="${u>0?'neg':u<0?'pos':'mut'}">${yen(u)}</td><td class="${cu>0?'neg':'mut'}">${yen(cu)}</td><td>${badge}</td></tr>`;
      expS.push([nm,Math.round(c),Math.round(dp),Math.round(u),Math.round(cu),okDone?'完了':'未入金あり']);
    });
    h+=`</tbody></table></div></div>`;
    EXPORT.push({ title:'店舗別入金状況（'+mLabel+'）', headers:['店舗','入金予定(現金売上)','入金(ATM)','未入金(当月)','累計未入金','状態'], rows:expS });
  }

  // 日別明細
  h+=`<div class="panel"><div class="panel-head"><div><h3>日別 入金明細（${mLabel} ／ ${esc(scopeLabel)}）</h3>
    <div class="sub">1日〜${lastDay}日の入金予定・入金・未入金</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>日付</th><th>入金予定(現金売上)</th><th>入金(ATM)</th><th>未入金(日)</th><th>累計未入金</th><th>状態</th></tr></thead><tbody>`;
  const expD=[];
  days.forEach(x=>{
    if(x.future){
      h+=`<tr><td class="mut">${mdwH(x.dt)}</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td><span class="badge zero">データ待ち</span></td></tr>`;
      return;
    }
    // 完了判定：入金予定の千円未満切捨て額（例 81,500→81,000）以上が入っていれば「完了」
    const dayOk=x.dep>=Math.floor(x.cash/1000)*1000;
    const badge=(x.cash===0&&x.dep===0)?'<span class="badge zero">—</span>':(dayOk?'<span class="badge ok">完了</span>':'<span class="badge ng">未入金</span>');
    h+=`<tr><td>${mdwH(x.dt)}</td><td>${yen(x.cash)}</td><td>${yen(x.dep)}</td>
      <td class="${x.diff>0?'neg':x.diff<0?'pos':'mut'}">${yen(x.diff)}</td>
      <td class="${x.cum>0?'neg':'mut'}">${yen(x.cum)}</td><td>${badge}</td></tr>`;
    expD.push([(m+1)+'/'+x.d,Math.round(x.cash),Math.round(x.dep),Math.round(x.diff),Math.round(x.cum),(x.cash===0&&x.dep===0)?'':(x.diff<=0?'完了':'未入金')]);
  });
  h+=`<tr class="total"><td>合計</td><td>${yen(tC)}</td><td>${yen(tD)}</td><td class="${unpaid>0?'neg':'pos'}">${yen(unpaid)}</td><td class="${cum>0?'neg':''}">${yen(days.filter(x=>!x.future).length?days.filter(x=>!x.future).slice(-1)[0].cum:carry)}</td><td></td></tr>`;
  h+=`</tbody></table></div></div>`;
  expD.push(['合計',Math.round(tC),Math.round(tD),Math.round(unpaid),'','']);
  EXPORT.push({ title:'日別入金明細（'+mLabel+'／'+scopeLabel+'）※繰越 '+Math.round(carry)+'円', headers:['日付','入金予定(現金売上)','入金(ATM)','未入金(日)','累計未入金','状態'], rows:expD });
  return h;
}

/* ---------------- 広告管理 ---------------- */
// 媒体名の正規化：DB_広告とDB_媒体別売上で表記が違っても自動で突合できるようにする
// 例: 鶏HP・黒HP・ホットペッパー → ホットペッパー ／ 匠味GN → ぐるなび ／ うおTL → 食べログ
function canonMedia(m){
  const s=String(m||'').trim(); if(!s) return '';
  const u=s.toUpperCase();
  if(u.indexOf('RETTY')>=0||/RT$/.test(u)) return 'Retty';
  if(u.indexOf('ホットペッパー')>=0||u.indexOf('HP')>=0) return 'ホットペッパー';
  if(u.indexOf('ぐるなび')>=0||u.indexOf('GN')>=0) return 'ぐるなび';
  if(u.indexOf('食べログ')>=0||u.indexOf('TL')>=0) return '食べログ';
  if(u.indexOf('LP')>=0) return '自社LP';
  if(u.indexOf('インスタ')>=0||u.indexOf('INSTAGRAM')>=0) return 'Instagram';
  if(u.indexOf('GOOGLE')>=0||u.indexOf('グーグル')>=0||u.indexOf('マップ')>=0) return 'Google';
  return s;
}
function adAgg(scopeSet, a, b){
  const byStore={}, byMedia={}, byStoreMedia={}, unmatched={}, ownParent={};
  let ad=0;
  const pairSet=new Set();   // 表示店舗(own)|媒体（正規化後）
  const globalSet=new Set(); // 店舗未指定の広告の媒体
  const rcache={};
  for(const r of D.ad){
    if(r.t<a||r.t>b) continue;
    const md=canonMedia(r.media)||'（媒体未指定）';
    if(!r.store){                       // 店舗未指定 → 全体（媒体のみ）
      ad+=r.cost;
      (byMedia[md]=byMedia[md]||{cost:0,net:0,guests:0}).cost+=r.cost;
      globalSet.add(md);
      continue;
    }
    // 広告DBの店舗名を { own:表示名, parent:売上側の親店舗 } に解決（子店舗は親の下に別行で表示）
    const res = (r.store in rcache)?rcache[r.store]:(rcache[r.store]=resolveStoreEx(r.store));
    if(!res || !scopeSet.has(res.parent)){
      if(!res) unmatched[r.store]=(unmatched[r.store]||0)+r.cost;  // どの店舗にも一致せず＝要確認
      continue;
    }
    const own=res.own; ownParent[own]=res.parent;
    ad+=r.cost;
    (byStore[own]=byStore[own]||{cost:0,net:0,guests:0}).cost+=r.cost;
    (byMedia[md]=byMedia[md]||{cost:0,net:0,guests:0}).cost+=r.cost;
    (byStoreMedia[own]=byStoreMedia[own]||{})[md]=(byStoreMedia[own][md]||0)+r.cost;
    pairSet.add(own+'|'+md);
  }
  // 媒体経由売上：媒体別売上（分析_媒体別日次）と店舗×媒体（正規化後）で自動突合
  let medNet=0;
  for(const r of D.media){
    if(!scopeSet.has(r.store)) continue;
    if(r.t<a||r.t>b) continue;
    const cm=canonMedia(r.media);
    const pair=pairSet.has(r.store+'|'+cm), glob=globalSet.has(cm);
    if(!pair&&!glob) continue;
    medNet+=r.net;
    if(pair&&byStore[r.store]){ byStore[r.store].net+=r.net; byStore[r.store].guests+=r.guests; }
    if(byMedia[cm]){ byMedia[cm].net+=r.net; byMedia[cm].guests+=r.guests; }
  }
  return { ad, medNet, byStore, byMedia, byStoreMedia, unmatched, ownParent };
}
function roasBadge(cost, net){
  if(!(cost>0)) return '<span class="badge zero">—</span>';
  if(!(net>0)) return '<span class="badge zero">売上未突合</span>';
  const v=net/cost;
  const cls=v<1?'ng':(v<3?'mid':'ok');
  return `<span class="badge ${cls}">${v.toFixed(1)}倍</span>`;
}
// 広告効果（アクセス・ネット予約）を店舗解決つきで集計。単価設定から予想売上も算出
function adFxAgg(scopeSet,a,b){
  const mk=()=>({access:0,grp:0,ppl:0,tel:0,exp:0,telGrp:0,telPpl:0});
  const byMedia={}, byStore={}, rc={}, tot=mk(), noTanka=new Set(); let rows=0;
  for(const r of D.adfx){
    if(r.t<a||r.t>b) continue;
    const cm=canonMedia(r.media)||'（媒体未指定）';
    let own='';
    if(r.store){
      const res=(r.store in rc)?rc[r.store]:(rc[r.store]=resolveStoreEx(r.store));
      if(!res||!scopeSet.has(res.parent)) continue;
      own=res.own;
    }
    const tk=tankaOf(own,r.media?cm:'');
    const cv2=tankaCvOf(own,r.media?cm:''), avg2=tankaAvgOf(own,r.media?cm:'');
    const telGrp=r.tel*cv2, telPpl=telGrp*avg2;             // 電話数×電話CV＝組数、×平均1組人数＝人数
    const exp=(r.ppl+telPpl)*tk;                            // 予想売上＝(ネット予約人数＋電話由来人数)×設定単価
    if((r.ppl>0||telPpl>0)&&!(tk>0)) noTanka.add((own||'全店')+'×'+cm);
    rows++;
    const add=(o)=>{ o.access+=r.access;o.grp+=r.grp;o.ppl+=r.ppl;o.tel+=r.tel;o.exp+=exp;o.telGrp+=telGrp;o.telPpl+=telPpl; };
    add(tot);
    add(byMedia[cm]=byMedia[cm]||mk());
    if(own) add(byStore[own]=byStore[own]||mk());
  }
  return {byMedia,byStore,tot,noTanka,rows};
}
function viewAd(){
  const sc=scopeStores(); const selN=selStoreName();          // 店舗タブで選択中の店舗（全店なら null）
  const scopeSet=new Set(selN?[selN]:sc);
  if(!D.ad.length){
    const live=!!(S.auth&&S.auth.token);
    const received=(D.receivedKeys||[]).includes('広告')||(D.receivedKeys||[]).includes('ad');
    const diag=D.diag&&D.diag['広告'];
    let diagBox='';
    if(live){
      if(received && diag && diag.indexOf('OK')!==0){
        // シートは受信できたが取り込めていない＝原因を明示
        diagBox=`<div class="note-box" style="border-color:#e8cfc2;background:#faf0ec;color:#5c5348">
          <b style="color:#b5502f">⚠ 「DB_広告」シートは受信していますが、表示できる行がありません。</b><br>
          取込結果：<b>${esc(diag)}</b><br>
          よくある原因：①「日付」または「年月」列が空／形式が違う（例 2026/07/01 や 2026/07）　②広告費が数値でない　③「確認」列を使う運用で1行もチェックが無い（※チェックが1つも無ければ全行表示に変更済みです）<br>
          「日付」と「広告費」列を確認してください。</div>`;
      } else if(!received){
        diagBox=`<div class="note-box" style="border-color:#e8cfc2;background:#faf0ec;color:#5c5348">
          <b style="color:#b5502f">⚠ 「DB_広告」シートを受信できていません。</b><br>
          チェック：①シート名が正確に <code>DB_広告</code>（アンダーバー付き）か　②別名なら「接続設定」タブに <code>ad</code> キーで実シート名を登録し「有効」を <code>TRUE</code> に　③GASを最新にして再デプロイ済みか　④更新後1分ほど待つ／「↻更新」<br>
          受信済みキー：${esc((D.receivedKeys||[]).join(' , ')||'なし')}</div>`;
      }
    }
    return storeSegHtml()+`<div class="ctrl-bar no-print">
      ${canUse('adInput')?`<button class="icon-btn primary" onclick="App.openAdInput()">✎ 広告費を入力</button>`:''}
      ${canUse('rsvImport')?`<button class="icon-btn" onclick="App.openRsvImport()">⬆ 予約CSVを取込</button>`:''}
    </div><div class="panel"><div class="panel-head"><div><h3>広告管理</h3><div class="sub">実データ（DB_広告シート）のみ表示・サンプルは入っていません</div></div></div>
    ${diagBox||`<div class="note-box">
      広告データはまだ接続されていません。スプレッドシートに <code>DB_広告</code> という名前のシートを作り、
      <code>日付</code>（例 2026/07/01）／ <code>店舗名</code> ／ <code>媒体</code> ／ <code>広告費</code> を入力すると、このタブに自動表示されます。<br>
      店舗別・媒体別のROAS（売上÷広告費）・広告費率・12ヶ月推移を表示します。
    </div>`}</div>`+extraSheetsHtml();
  }
  const ref=D.refDate||new Date();
  const P=S.adPeriod||'month';
  // 期間：月次（前月比較）／年間（前年比較）／期間指定（前期間比較）。mS〜mE=対象、pS〜pE=比較用。
  let mS,mE,pS,pE,mLabel,prevName='前月',ctrlHtml='';
  let y,m,yy,cS,cE;   // y/m=月次用、yy=年間用、cS/cE=期間指定の開始・終了日
  if(P==='year'){
    yy=+(S.adYear||ref.getFullYear());
    const endD=(yy===ref.getFullYear())?new Date(ref.getFullYear(),ref.getMonth()+1,0):new Date(yy,11,31);
    mS=dayMs(new Date(yy,0,1)); mE=dayMs(endD);
    pS=dayMs(new Date(yy-1,0,1)); pE=dayMs(sub1y(endD));
    prevName='前年';
    mLabel=yy+'年';
    const years=[...new Set(D.ad.map(r=>new Date(r.t).getFullYear()).concat(D.daily.map(x=>new Date(x.t).getFullYear())))].filter(v=>v>2000).sort();
    if(!years.length) years.push(ref.getFullYear());
    ctrlHtml=`<select onchange="App.set('adYear',this.value)">${years.map(v=>`<option ${String(yy)===String(v)?'selected':''}>${v}</option>`).join('')}</select>`;
  } else if(P==='custom'){
    const pI=(s2)=>{const p2=String(s2).split('-');return new Date(+p2[0],+p2[1]-1,+p2[2]);};
    cS=S.adStart?pI(S.adStart):new Date(ref.getFullYear(),ref.getMonth()-2,1);
    cE=S.adEnd?pI(S.adEnd):new Date(ref.getFullYear(),ref.getMonth()+1,0);
    if(dayMs(cS)>dayMs(cE)){ const t=cS;cS=cE;cE=t; }
    mS=dayMs(cS); mE=dayMs(cE);
    const span=Math.round((mE-mS)/86400000)+1;
    pS=dayMs(addD(cS,-span)); pE=dayMs(addD(cS,-1));
    prevName='前期間';
    mLabel=(cS.getFullYear())+'/'+(cS.getMonth()+1)+'/'+cS.getDate()+'〜'+(cE.getMonth()+1)+'/'+cE.getDate();
    ctrlHtml=`${ymdSelect('adStart',S.adStart,'')} 〜 ${ymdSelect('adEnd',S.adEnd,'')}`;
  } else {
    const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
    y=m0.getFullYear(); m=m0.getMonth();
    mS=dayMs(new Date(y,m,1)); mE=dayMs(new Date(y,m+1,0));
    pS=dayMs(new Date(y,m-1,1)); pE=dayMs(new Date(y,m,0));
    mLabel=y+'年 '+(m+1)+'月';
    ctrlHtml=ymSelect('adMonth', y, m);
  }
  const cur=adAgg(scopeSet,mS,mE), prv=adAgg(scopeSet,pS,pE);
  const totalSales=stat(scopeSet,mS,mE,null).sales;
  const roas=cur.ad>0?cur.medNet/cur.ad:0;
  const pRoas=prv.ad>0?prv.medNet/prv.ad:0;
  const adRate=totalSales>0?cur.ad/totalSales*100:0;
  const profit=cur.medNet-cur.ad;
  const mom=(c,p,invert)=>{ if(!(p>0)) return {t:prevName+' —',cls:'mut'}; const d=(c-p)/p*100; const up=d>=0; return { t:prevName+'比 '+(up?'+':'▲')+Math.abs(d).toFixed(1)+'%', cls:(invert?!up:up)?'up':'dn' }; };
  let h=storeSegHtml();
  h+=`<div class="ctrl-bar no-print">
    <div class="seg">${[['month','月'],['year','年'],['custom','期間指定']].map(([k,l])=>`<button class="${P===k?'on':''}" onclick="App.set('adPeriod','${k}')">${l}</button>`).join('')}</div>
    ${ctrlHtml}
    ${canUse('adInput')?`<button class="icon-btn primary" onclick="App.openAdInput()">✎ 広告費を入力</button>`:''}
    ${canUse('adSales')?`<button class="icon-btn primary" onclick="App.openAdSales()">✎ 売上を入力</button>`:''}
    ${canUse('rsvImport')?`<button class="icon-btn" onclick="App.openRsvImport()">⬆ 予約CSVを取込</button>`:''}
    <span class="period-label">広告費用対効果（${mLabel}${selN?' ／ '+esc(selN):''}）</span></div>`;
  // データの出どころを見える化：この画面の数字がどこから来ているかを表示
  let a0=0,a1=0; for(const r of D.ad){ if(!a0||r.t<a0)a0=r.t; if(r.t>a1)a1=r.t; }
  const fmtD=(t)=>{ const d=new Date(t); return d.getFullYear()+'/'+(d.getMonth()+1)+'/'+d.getDate(); };
  const srcLine=D.adSrc==='sheet'
    ?`<span style="color:#4c7d5c;font-weight:700">● スプレッドシート（管理シート💾広告費DB／DB_広告）の実データを表示中</span>（全${cnt(D.ad.length)}件 ／ データ期間 ${fmtD(a0)}〜${fmtD(a1)} ／ 最終同期 ${esc(S.lastSync||'—')}）`
    :`<span style="color:#a2803f;font-weight:700">⚠ サンプル（架空）データを表示中</span> — 管理シートの「💾広告費DB」に実データが入ると自動で置き換わります`;
  h+=`<div class="panel no-print"><div class="panel-head"><div><h3>この画面の数字の出どころ</h3>
    <div class="sub">${srcLine}</div></div></div>
    <div class="note-box">
      <b>広告費</b> ← 広告費用対効果_管理シートの「💾広告費DB」を自動取込（転記・IMPORTRANGE不要）。管理シートが空のときはダッシュボード側「DB_広告」シート（確認列チェック行のみ）<br>
      <b>媒体経由売上・来店人数</b> ← 媒体別売上シート（分析_媒体別日次）と媒体名で自動突合（例: 鶏HP→ホットペッパー、匠味GN→ぐるなび）<br>
      <b>総売上（広告費率の分母）</b> ← 日別売上シート（分析_日別店舗）<br>
      <b>アクセス数・ネット予約（CVR／CPA／予想売上）</b> ← 管理シートの「💾売上DB」を自動取込　<b>設定単価</b> ← 管理シートの「⚙単価設定」タブ（GAS更新で自動作成）。どちらも管理シートが空のときはDB_広告効果／DB_単価設定を使用<br>
      <b>予約分析（曜日別・当日予約の時刻）</b> ← 管理シートの「💾予約DB」タブ（予約一覧CSVをそのまま貼り付け。タブはGAS更新で自動作成）
    </div></div>`;
  // KPIカード
  const kA=mom(cur.ad,prv.ad,true), kN=mom(cur.medNet,prv.medNet,false);
  const kR=pRoas>0?{t:'前月 '+pRoas.toFixed(1)+'倍',cls:roas>=pRoas?'up':'dn'}:{t:'前月 —',cls:'mut'};
  const kP={t:'差引利益 '+(profit>=0?'':'▲')+yen(Math.abs(profit)).slice(1)+'円',cls:profit>=0?'up':'dn'};
  h+=`<div class="kpi-grid">
    <div class="kpi"><div class="lb">広告費（${esc(mLabel)}）</div><div class="vl">${yen(cur.ad)}</div><div class="yy ${kA.cls}">${kA.t}</div></div>
    <div class="kpi"><div class="lb">媒体経由売上</div><div class="vl">${yen(cur.medNet)}</div><div class="yy ${kN.cls}">${kN.t}</div></div>
    <div class="kpi"><div class="lb">ROAS（売上÷広告費）</div><div class="vl">${cur.ad>0?roas.toFixed(1)+'倍':'—'}</div><div class="yy ${kR.cls}">${kR.t}</div></div>
    <div class="kpi"><div class="lb">広告費率（対総売上）</div><div class="vl">${totalSales>0?adRate.toFixed(1)+'%':'—'}</div><div class="yy ${kP.cls}">${kP.t}</div></div>
  </div>`;
  // 店舗別（子店舗＝サブブランドは親の下に別行で表示）
  const parentOf=(nm)=>cur.ownParent[nm]||nm;
  const isChild=(nm)=>cur.ownParent[nm]&&cur.ownParent[nm]!==nm;
  h+=`<div class="panel"><div class="panel-head"><div><h3>${selN?esc(selN)+'の':'店舗別 '}広告費用対効果（${mLabel}）</h3>
    <div class="sub">ROAS: 3倍以上=良好 ／ 1〜3倍=要改善 ／ 1倍未満=広告費割れ　※同一店舗のサブブランドは親店舗の下に別行で表示</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>広告費</th><th>媒体経由売上</th><th>ROAS</th><th>総売上（当月）</th><th>広告費率</th></tr></thead><tbody>`;
  const expA=[];
  // 親でグループ化 → 親を先頭、その下に子。グループは広告費合計の多い順
  const grpCost={}; Object.keys(cur.byStore).forEach(nm=>{ const p=parentOf(nm); grpCost[p]=(grpCost[p]||0)+cur.byStore[nm].cost; });
  const ordered=Object.keys(cur.byStore).sort((x,y)=>{
    const px=parentOf(x), py=parentOf(y);
    if(px!==py) return (grpCost[py]-grpCost[px])||(px<py?-1:1);
    const cx=isChild(x)?1:0, cy=isChild(y)?1:0; if(cx!==cy) return cx-cy;   // 親→子
    return cur.byStore[y].cost-cur.byStore[x].cost;
  });
  ordered.forEach(nm=>{
    const o=cur.byStore[nm];
    const sl=stat(null,mS,mE,nm).sales;
    const rate=sl>0?o.cost/sl*100:0;
    const tag=isChild(nm)?` <span class="mut" style="font-size:11px">（${esc(parentOf(nm))}）</span>`:'';
    h+=`<tr><td style="${isChild(nm)?'padding-left:22px':''}">${shortStoreTd(nm)}${tag}</td><td>${yen(o.cost)}</td><td>${yen(o.net)}</td><td>${roasBadge(o.cost,o.net)}</td><td>${sl>0?yen(sl):'—'}</td><td class="${rate>10?'warn':''}">${sl>0?rate.toFixed(1)+'%':'—'}</td></tr>`;
    expA.push([nm+(isChild(nm)?'（'+parentOf(nm)+'）':''),Math.round(o.cost),Math.round(o.net),o.cost>0&&o.net>0?(o.net/o.cost).toFixed(2):'',Math.round(sl),sl>0?rate.toFixed(1)+'%':'']);
  });
  h+=`<tr class="total"><td>合計</td><td>${yen(cur.ad)}</td><td>${yen(cur.medNet)}</td><td>${roasBadge(cur.ad,cur.medNet)}</td><td>${yen(totalSales)}</td><td>${totalSales>0?adRate.toFixed(1)+'%':'—'}</td></tr></tbody></table></div></div>`;
  EXPORT.push({ title:'店舗別広告費用対効果（'+mLabel+'）', headers:['店舗','広告費','媒体経由売上','ROAS','総売上','広告費率'], rows:expA });
  // 店舗名が売上側と一致しなかった広告（＝広告費率・ROASが出せない）を警告（全店表示時のみ）
  const umKeys=selN?[]:Object.keys(cur.unmatched||{});
  if(umKeys.length){
    h+=`<div class="panel"><div class="panel-head"><div><h3 style="color:#b5502f">⚠ 売上店舗と一致しなかった広告店舗名（${mLabel}）</h3>
      <div class="sub">下の店舗名は「分析_日別店舗」の店舗名と一致せず、売上と突き合わせできていません（この広告費は上の集計に含まれていません）</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>広告DBの店舗名</th><th>広告費（当月）</th></tr></thead><tbody>`;
    umKeys.sort((a2,b2)=>cur.unmatched[b2]-cur.unmatched[a2]).forEach(nm=>{ h+=`<tr><td>${esc(nm||'（空欄）')}</td><td>${yen(cur.unmatched[nm])}</td></tr>`; });
    h+=`</tbody></table></div>
    <div class="note-box" style="margin-top:12px"><b>スプレッドシートで紐づけできます（コード不要）。用途で2つのタブを使い分け:</b><br>
      ①同じ店舗の表記ゆれ（例 トリイチ本店＝鳥一代 本店）→ <code>DB_店舗名対応</code>（A列=広告の店舗名／B列=売上の店舗名）。売上店舗に<b>統合</b>されます。<br>
      ②別ブランドで同じ場所（例 匠味 新横浜は鶏武者 新横浜の下）→ <code>DB_店舗親子</code>（A列=子店舗／B列=親店舗）。親の下に<b>別行</b>で表示されます。<br>
      どちらも1行目は見出しでOK。保存して同期（最大1分／「↻更新」）で反映。<span style="color:var(--mut2)">※スペース・全角/半角差は自動吸収済み。</span></div></div>`;
    EXPORT.push({ title:'未突合の広告店舗名（要対応表）', headers:['広告DBの店舗名','広告費'], rows:umKeys.map(nm=>[nm,Math.round(cur.unmatched[nm])]) });
  }
  // 媒体別
  const medKeys=Object.keys(cur.byMedia);
  if(medKeys.length){
    h+=`<div class="panel"><div class="panel-head"><div><h3>媒体別 広告費用対効果（${mLabel}）</h3>
      <div class="sub">媒体別売上（DB_媒体別売上）と媒体名で自動突合</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>媒体</th><th>広告費</th><th>構成比</th><th>媒体経由売上</th><th>来店人数</th><th>ROAS</th></tr></thead><tbody>`;
    const expM=[];
    medKeys.sort((a2,b2)=>cur.byMedia[b2].cost-cur.byMedia[a2].cost).forEach(k=>{
      const o=cur.byMedia[k];
      h+=`<tr><td>${esc(k)}</td><td>${yen(o.cost)}</td><td>${cur.ad>0?(o.cost/cur.ad*100).toFixed(1)+'%':'—'}</td><td>${yen(o.net)}</td><td>${o.guests>0?cnt(o.guests)+'人':'—'}</td><td>${roasBadge(o.cost,o.net)}</td></tr>`;
      expM.push([k,Math.round(o.cost),cur.ad>0?(o.cost/cur.ad*100).toFixed(1)+'%':'',Math.round(o.net),Math.round(o.guests),o.cost>0&&o.net>0?(o.net/o.cost).toFixed(2):'']);
    });
    h+=`</tbody></table></div></div>`;
    EXPORT.push({ title:'媒体別広告費用対効果（'+mLabel+'）', headers:['媒体','広告費','構成比','媒体経由売上','来店人数','ROAS'], rows:expM });
  }
  // ネット予約ベースの費用対効果（DB_広告効果 × DB_単価設定）— 成果＝その月の広告に対するネット予約
  const fx=adFxAgg(scopeSet,mS,mE);
  if(D.adfx.length){
    const fmt0=(v)=>v>0?cnt(Math.round(v)):'—';
    const pct=(x2,z2)=>z2>0?(x2/z2*100).toFixed(1)+'%':'—';
    const cpa=(cost,n)=>(cost>0&&n>0)?yen(Math.round(cost/n)):'—';
    const mset=new Set(Object.keys(fx.byMedia)); Object.keys(cur.byMedia).forEach(k=>mset.add(k));
    const mks=Array.from(mset).sort((x2,z2)=>((fx.byMedia[z2]||{}).exp||0)-((fx.byMedia[x2]||{}).exp||0)||(((cur.byMedia[z2]||{}).cost||0)-((cur.byMedia[x2]||{}).cost||0)));
    h+=`<div class="panel"><div class="panel-head"><div><h3>ネット予約ベースの費用対効果（${mLabel}${selN?' ／ '+esc(selN):''}）</h3>
      <div class="sub">成果＝その月の広告へのネット予約。CVR＝予約組数÷アクセス ／ CPA＝広告費÷予約 ／ 予想売上＝ネット予約人数×設定単価 ＋ 電話数×電話CV×平均1組人数×設定単価（⚙単価設定）／ レジ実績は参考値</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>媒体</th><th>広告費</th><th>アクセス</th><th>予約組数</th><th>予約人数</th><th>電話</th><th>CVR</th><th>CPA(組)</th><th>CPA(人)</th><th>予想売上</th><th>想定ROAS</th><th>参考:レジ実績</th></tr></thead><tbody>`;
    const expF=[];
    mks.forEach(k=>{
      const o=fx.byMedia[k]||{access:0,grp:0,ppl:0,tel:0,exp:0};
      const cost=(cur.byMedia[k]||{}).cost||0, reg=(cur.byMedia[k]||{}).net||0;
      h+=`<tr><td>${esc(k)}</td><td>${cost>0?yen(cost):'—'}</td><td>${fmt0(o.access)}</td><td>${fmt0(o.grp)}</td><td>${fmt0(o.ppl)}</td><td>${fmt0(o.tel)}</td><td>${pct(o.grp,o.access)}</td><td>${cpa(cost,o.grp)}</td><td>${cpa(cost,o.ppl)}</td><td>${o.exp>0?yen(o.exp):'—'}</td><td>${roasBadge(cost,o.exp)}</td><td class="mut">${reg>0?yen(reg):'—'}</td></tr>`;
      expF.push([k,Math.round(cost),Math.round(o.access),Math.round(o.grp),Math.round(o.ppl),Math.round(o.tel),o.access>0?(o.grp/o.access*100).toFixed(1)+'%':'',cost>0&&o.grp>0?Math.round(cost/o.grp):'',cost>0&&o.ppl>0?Math.round(cost/o.ppl):'',Math.round(o.exp),cost>0&&o.exp>0?(o.exp/cost).toFixed(2):'',Math.round(reg)]);
    });
    const T=fx.tot;
    h+=`<tr class="total"><td>合計</td><td>${yen(cur.ad)}</td><td>${fmt0(T.access)}</td><td>${fmt0(T.grp)}</td><td>${fmt0(T.ppl)}</td><td>${fmt0(T.tel)}</td><td>${pct(T.grp,T.access)}</td><td>${cpa(cur.ad,T.grp)}</td><td>${cpa(cur.ad,T.ppl)}</td><td>${T.exp>0?yen(T.exp):'—'}</td><td>${roasBadge(cur.ad,T.exp)}</td><td class="mut">${cur.medNet>0?yen(cur.medNet):'—'}</td></tr></tbody></table></div>`;
    if(fx.noTanka.size){
      h+=`<div class="note-box" style="margin-top:12px"><b style="color:#b5502f">⚠ 設定単価が未登録のため予想売上に入っていない組合せ：</b>${Array.from(fx.noTanka).slice(0,8).map(esc).join('、')}${fx.noTanka.size>8?' ほか':''}<br>
      <code>⚙単価設定</code> タブ（店舗名／媒体／設定単価／平均1組人数／電話CV）に行を追加してください（店舗名空欄＝全店共通）。</div>`;
    }
    h+=`</div>`;
    EXPORT.push({ title:'ネット予約ベース費用対効果（'+mLabel+'）', headers:['媒体','広告費','アクセス','予約組数','予約人数','電話','CVR','CPA組','CPA人','予想売上','想定ROAS','参考レジ実績'], rows:expF });
  } else {
    h+=`<div class="panel no-print"><div class="panel-head"><div><h3>ネット予約ベースの費用対効果（未設定）</h3>
      <div class="sub">アクセス数・ネット予約を入れると CVR／CPA（一人当たり獲得費用）／予想売上／想定ROAS を自動計算します</div></div></div>
    <div class="note-box">広告費用対効果_管理シートに入力すると、この場所に自動表示されます（転記・IMPORTRANGE不要）：<br>
      ① <code>💾売上DB</code> ＝ 年月／店舗／媒体／アクセス数／予約件数／来店人数／電話数<br>
      ② <code>⚙単価設定</code> ＝ 店舗名／媒体／設定単価／平均1組人数／電話CV（予想売上＝ネット予約人数×設定単価 ＋ 電話数×電話CV×平均1組人数×設定単価。タブはGAS更新で自動作成）<br>
      ※GAS（Code.gs）を最新版に更新してください。ダッシュボード側の <code>DB_広告効果</code>／<code>DB_単価設定</code> は予備の入力先として残ります。</div></div>`;
  }
  // 予約分析（曜日別×当日予約の申込時刻）— 管理シート「💾予約DB」（予約一覧CSV貼り付け）
  if((D.rsv||[]).length){
    const rsv=D.rsv.filter(r=>{
      if(r.t<mS||r.t>mE) return false;
      if(r.store){ const res=resolveStoreEx(r.store); if(res&&!scopeSet.has(res.parent)) return false; }
      return true;
    });
    if(rsv.length){
      const isCxl=(st)=>/キャンセル/.test(st);
      const wnames=['日','月','火','水','木','金','土'];
      const wd=Array.from({length:7},()=>({grp:0,ppl:0,net:0,same:0,cxl:0}));
      let tGrp=0,tPpl=0,tNet=0,tSame=0,tCxl=0,tWalk=0;
      const hist=new Array(24).fill(0); const sameWin={};
      for(const r of rsv){
        const w=new Date(r.t).getDay(); const o=wd[w]; const cx=isCxl(r.st); const walk=/ウォークイン/.test(r.win);
        o.grp++; tGrp++;
        if(!cx){ o.ppl+=r.n; tPpl+=r.n; }
        if(cx){ o.cxl++; tCxl++; }
        if(/ネット/.test(r.win)){ o.net++; tNet++; }
        if(walk) tWalk++;
        if(!cx&&!walk&&r.ct&&r.ct===r.t){
          o.same++; tSame++;
          if(r.ch>=0&&r.ch<24) hist[Math.floor(r.ch)]++;
          const wk=r.win||'（不明）'; sameWin[wk]=(sameWin[wk]||0)+1;
        }
      }
      const pc=(x2,z2)=>z2>0?(x2/z2*100).toFixed(0)+'%':'—';
      const maxGrp=Math.max.apply(null,wd.map(o=>o.grp).concat([1]));
      h+=`<div class="panel"><div class="panel-head"><div><h3>予約分析：曜日別（${mLabel}${selN?' ／ '+esc(selN):''}）</h3>
        <div class="sub">出典：管理シート「💾予約DB」全${cnt(rsv.length)}件 ／ 当日予約率 ${pc(tSame,Math.max(tGrp-tCxl-tWalk,0))}（ウォークイン・キャンセル除く）／ キャンセル率 ${pc(tCxl,tGrp)}</div></div></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>曜日</th><th>予約組数</th><th></th><th>人数</th><th>ネット予約</th><th>当日予約</th><th>キャンセル</th><th>キャンセル率</th></tr></thead><tbody>`;
      const expW=[];
      [1,2,3,4,5,6,0].forEach(w=>{
        const o=wd[w];
        h+=`<tr><td>${wnames[w]}</td><td>${cnt(o.grp)}</td><td style="min-width:120px"><div style="background:#4c7d5c;height:10px;border-radius:3px;width:${Math.round(o.grp/maxGrp*100)}%"></div></td><td>${cnt(o.ppl)}</td><td>${cnt(o.net)}</td><td>${cnt(o.same)}</td><td>${cnt(o.cxl)}</td><td>${pc(o.cxl,o.grp)}</td></tr>`;
        expW.push([wnames[w],o.grp,o.ppl,o.net,o.same,o.cxl,o.grp>0?(o.cxl/o.grp*100).toFixed(1)+'%':'']);
      });
      h+=`<tr class="total"><td>合計</td><td>${cnt(tGrp)}</td><td></td><td>${cnt(tPpl)}</td><td>${cnt(tNet)}</td><td>${cnt(tSame)}</td><td>${cnt(tCxl)}</td><td>${pc(tCxl,tGrp)}</td></tr></tbody></table></div></div>`;
      EXPORT.push({ title:'予約分析 曜日別（'+mLabel+'）', headers:['曜日','予約組数','人数','ネット予約','当日予約','キャンセル','キャンセル率'], rows:expW });
      const hmax=Math.max.apply(null,hist.concat([1])), hTot=hist.reduce((a2,b3)=>a2+b3,0);
      if(hTot>0){
        let lo=hist.findIndex(v=>v>0), hi2=23; while(hi2>0&&!hist[hi2])hi2--;
        lo=Math.min(lo,10); hi2=Math.max(hi2,21);
        const winTxt=Object.keys(sameWin).sort((a2,b3)=>sameWin[b3]-sameWin[a2]).map(k=>esc(k)+' '+sameWin[k]+'件').join('、');
        h+=`<div class="panel"><div class="panel-head"><div><h3>当日予約：申込時刻の分布（${mLabel}）</h3>
          <div class="sub">作成日＝来店日の予約 ${cnt(hTot)}件（ウォークイン・キャンセル除く）が何時に入ったか ／ 窓口内訳：${winTxt}</div></div></div>
        <div style="display:flex;align-items:flex-end;gap:4px;height:130px;padding:8px 4px 0">`;
        for(let hh2=lo;hh2<=hi2;hh2++){
          h+=`<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px;height:100%"><div style="font-size:10px;color:#8a7f6f">${hist[hh2]||''}</div><div style="width:70%;background:${hist[hh2]===hmax?'#b23b2e':'#4c7d5c'};border-radius:3px 3px 0 0;height:${Math.max(hist[hh2]/hmax*80,2)}px"></div><div style="font-size:10px;color:#8a7f6f">${hh2}時</div></div>`;
        }
        h+=`</div><div class="note-box" style="margin-top:8px">当日予約のピークは <b>${hist.indexOf(hmax)}時台</b>。その少し前の時間帯に空席情報の更新・SNS投稿・掲載枠の見直しを行うと当日集客に効きやすくなります。</div></div>`;
        EXPORT.push({ title:'当日予約 申込時刻分布（'+mLabel+'）', headers:['時台','件数'], rows:hist.map((v,i2)=>[i2+'時',v]).filter(r2=>r2[1]>0) });
      }
    } else {
      let r0=0,r1=0; for(const r of D.rsv){ if(!r0||r.t<r0)r0=r.t; if(r.t>r1)r1=r.t; }
      h+=`<div class="panel no-print"><div class="panel-head"><div><h3>予約分析（${mLabel}：データなし）</h3>
        <div class="sub">予約データの期間：${fmtD(r0)}〜${fmtD(r1)}（‹ › で月を切り替えると表示されます）</div></div></div></div>`;
    }
  } else {
    h+=`<div class="panel no-print"><div class="panel-head"><div><h3>予約分析（曜日別・当日予約の時刻）— 未接続</h3>
      <div class="sub">予約一覧CSVを貼り付けると曜日別の予約傾向と当日予約の申込時刻分布を自動表示します</div></div></div>
    <div class="note-box">管理シートの <code>💾予約DB</code> タブ（GAS更新で自動作成）に、食べログ等の管理画面からエクスポートした<b>予約一覧CSVをそのまま貼り付け</b>るだけでOK（ヘッダー行ごと・列の並びは自由・列名で自動判定）。<br>
      使う列：<code>来店日</code>／<code>来店時間</code>／<code>人数</code>／<code>ステータス</code>／<code>受付窓口</code>／<code>作成日</code>／<code>作成時間</code>（複数店舗ぶんを貼る場合は<code>店舗名</code>列を追加）<br>
      ※GAS（Code.gs）を最新版に更新してください。</div></div>`;
  }
  // 広告費・媒体経由売上の月次推移。期間に合わせて対象月を決める：
  //  月＝直近12ヶ月／年＝その年の1〜12月／期間指定＝開始月〜終了月
  const chartMonths=[];
  if(P==='year'){ for(let mm=0;mm<12;mm++) chartMonths.push(new Date(yy,mm,1)); }
  else if(P==='custom'){ let d=new Date(cS.getFullYear(),cS.getMonth(),1); const end=new Date(cE.getFullYear(),cE.getMonth(),1); while(dayMs(d)<=dayMs(end)){ chartMonths.push(new Date(d)); d=new Date(d.getFullYear(),d.getMonth()+1,1); } }
  else { for(let i=11;i>=0;i--) chartMonths.push(new Date(y,m-i,1)); }
  const chartTitle=P==='year'?('（'+yy+'年'+(selN?'・'+esc(selN):'')+'）'):P==='custom'?('（'+esc(mLabel)+(selN?'・'+esc(selN):'')+'）'):('（直近12ヶ月'+(selN?'・'+esc(selN):'')+'）');
  const cat=[],adArr=[],netArr=[],roasArr=[];
  chartMonths.forEach(d=>{
    const a2=dayMs(d), b2=dayMs(new Date(d.getFullYear(),d.getMonth()+1,0));
    const g=adAgg(scopeSet,a2,b2);
    cat.push(String(d.getFullYear()).slice(2)+'/'+(d.getMonth()+1));
    adArr.push(g.ad||null); netArr.push(g.medNet||null); roasArr.push(g.ad>0?g.medNet/g.ad:null);
  });
  const series=[{name:'媒体経由売上',color:'#4c7d5c',data:netArr},{name:'広告費',color:'#b23b2e',data:adArr}];
  const legend=series.map(s=>`<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  h+=`<div class="panel"><div class="panel-head"><div><h3>広告費と媒体経由売上の推移${chartTitle}</h3>
    <div class="sub">月次推移${P==='month'?'／〜'+mLabel:''}</div></div><div class="legend">${legend}</div></div>
    ${lineChart(cat,series,'sales')}
  <div class="scroll-x"><table class="tbl"><thead><tr><th>月</th><th>広告費</th><th>媒体経由売上</th><th>ROAS</th></tr></thead><tbody>`;
  const expT=[];
  cat.forEach((c,i)=>{
    h+=`<tr><td>${c}</td><td>${adArr[i]!=null?yen(adArr[i]):'—'}</td><td>${netArr[i]!=null?yen(netArr[i]):'—'}</td><td>${roasArr[i]!=null?roasArr[i].toFixed(1)+'倍':'—'}</td></tr>`;
    expT.push([c,adArr[i]!=null?Math.round(adArr[i]):'',netArr[i]!=null?Math.round(netArr[i]):'',roasArr[i]!=null?roasArr[i].toFixed(2):'']);
  });
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'広告費・媒体経由売上 12ヶ月推移', headers:['月','広告費','媒体経由売上','ROAS'], rows:expT });
  // PL連携（店舗×媒体マトリクス）
  const plMedia=medKeys.slice().sort((a2,b2)=>cur.byMedia[b2].cost-cur.byMedia[a2].cost);
  if(plMedia.length){
    h+=`<div class="panel"><div class="panel-head"><div><h3>PL連携用 広告費内訳（${mLabel}）</h3>
      <div class="sub">店舗×媒体の広告費マトリクス。右上の ⬇CSV でPL取込用にダウンロードできます</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th>${plMedia.map(k=>`<th>${esc(k)}</th>`).join('')}<th>合計</th></tr></thead><tbody>`;
    const expP=[];
    Object.keys(cur.byStoreMedia).sort((a2,b2)=>cur.byStore[b2].cost-cur.byStore[a2].cost).forEach(nm=>{
      const row=cur.byStoreMedia[nm];
      h+=`<tr><td>${esc(nm)}</td>${plMedia.map(k=>`<td>${row[k]?yen(row[k]):'—'}</td>`).join('')}<td>${yen(cur.byStore[nm].cost)}</td></tr>`;
      expP.push([nm].concat(plMedia.map(k=>Math.round(row[k]||0))).concat([Math.round(cur.byStore[nm].cost)]));
    });
    h+=`<tr class="total"><td>合計</td>${plMedia.map(k=>`<td>${yen(cur.byMedia[k].cost)}</td>`).join('')}<td>${yen(cur.ad)}</td></tr></tbody></table></div></div>`;
    EXPORT.push({ title:'PL連携_店舗×媒体 広告費（'+mLabel+'）', headers:['店舗'].concat(plMedia).concat(['合計']), rows:expP });
  }
  h+=extraSheetsHtml();
  return h;
}
function extraSheetsHtml(){
  // 内部処理用シートは表示しない（BQ明細＝明細分析タブ専用、店舗ID対応＝BQ店舗名変換用の裏方）
  const hide=(k)=>/^明細/.test(String(k))||/店舗ID対応|店舗名対応|店舗マッピング|店舗対応|storemap|storealias/i.test(String(k));
  const keys=Object.keys(D.extra).filter(k=>!hide(k));
  if(!keys.length) return '';
  let h='';
  keys.forEach(k=>{
    const rows=D.extra[k]; if(!rows||!rows.length)return;
    const H=rows[0], body=rows.slice(1,51);
    h+=`<div class="panel"><div class="panel-head"><div><h3>接続シート: ${esc(k)}</h3><div class="sub">スプレッドシートから自動取得（先頭50行）</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr>${H.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>`;
    body.forEach(r2=>{ h+=`<tr>${H.map((_,i)=>`<td>${esc(r2[i])}</td>`).join('')}</tr>`; });
    h+=`</tbody></table></div></div>`;
    EXPORT.push({ title:'接続シート:'+k, headers:H, rows:rows.slice(1) });
  });
  return h;
}

/* ---------------- 目標管理（予実） ---------------- */
// 昨年同週同曜日 = 364日前（52週前の同じ曜日）
const LY_MS=364*86400000;
function dailySalesOf(storeSet, t){ let s=0; for(const r of D.daily){ if(r.t===t&&storeSet.has(r.store)) s+=r.sales; } return s; }
function tgtMonthDate(){ if(S.tMonth){ const p=S.tMonth.split('-'); return new Date(+p[0],+p[1]-1,1); } const ref=D.refDate||new Date(); return new Date(ref.getFullYear(),ref.getMonth(),1); }
// 口コミ件数の増加数（期間末スナップショット − 期間開始前スナップショット）
function reviewIncrease(storeNames, a, b){
  let end=0, start=0, has=false;
  storeNames.forEach(nm=>{ reviewNamesFor(nm).forEach(rn=>{
    let le=null, ls=null;
    for(const r of D.review){ if(r.store!==rn) continue;
      if(r.t<=b && (!le||r.t>le.t)) le=r;
      if(r.t<a && (!ls||r.t>ls.t)) ls=r; }
    if(le){ end+=le.count; has=true; }
    if(ls) start+=ls.count;
  }); });
  return has?Math.max(0,end-start):null;
}
function viewTarget(){
  const sc=scopeStores();
  const stores=sc;
  if(S.tStore && !stores.includes(S.tStore)) S.tStore='';
  const selN=S.tStore||null;
  const scopeSet=new Set(selN?[selN]:stores);
  const scopeNames=selN?[selN]:stores;
  const m0=tgtMonthDate(); const y=m0.getFullYear(), m=m0.getMonth();
  const mS=dayMs(new Date(y,m,1)), mE=dayMs(new Date(y,m+1,0));
  const lastDay=new Date(y,m+1,0).getDate();
  const mLabel=y+'年 '+(m+1)+'月';
  const ref=D.refDate||new Date(); const today=dayMs(ref);
  const canEdit=true; // 全ロール入力可（担当店舗の範囲内のみ）
  let h=`<div class="ctrl-bar no-print">
    <select onchange="App.set('tStore',this.value)" style="font-weight:700">
      <option value="" ${!selN?'selected':''}>${stores.length>1?'担当店舗 合算':'全店'}</option>
      ${stores.map(s=>`<option ${selN===s?'selected':''}>${esc(s)}</option>`).join('')}
    </select>
    ${ymSelect('tMonth', y, m)}
    ${canEdit?`<button class="icon-btn primary" onclick="App.openTargetInput()">✎ 目標を入力</button>
    <button class="icon-btn" onclick="App.openEventInput('')">＋ イベント追加</button>`:''}
    <span class="period-label">目標と実績（${mLabel} ／ ${selN?esc(selN):'合算'}）</span>
  </div>`;
  // 目標データ
  const goalByDay={}; let goalM=0;
  for(const r of D.targets){ if(r.t<mS||r.t>mE) continue; if(!scopeSet.has(r.store)) continue; goalByDay[r.t]=(goalByDay[r.t]||0)+r.goal; goalM+=r.goal; }
  const tm={pa:0,emp:0,cost:0,dinii:null,review:0,diniiN:0};
  for(const r of D.targetsM){ const d2=new Date(r.t); if(d2.getFullYear()!==y||d2.getMonth()!==m) continue; if(!scopeSet.has(r.store)) continue;
    tm.pa+=r.pa; tm.emp+=r.emp; tm.cost+=r.cost; tm.review+=r.review; if(r.dinii>0){ tm.dinii=(tm.dinii||0)+r.dinii; tm.diniiN++; } }
  if(tm.dinii!=null&&tm.diniiN>0) tm.dinii=tm.dinii/tm.diniiN;   // 複数店舗は平均
  // 実績
  const cur=stat(scopeSet,mS,Math.min(mE,today),null);
  const elapsedGoal=Object.keys(goalByDay).filter(t=>+t<=today).reduce((s,t)=>s+goalByDay[t],0);
  const ds=diniiStats(scopeNames,mS,Math.min(mE,today));
  const revInc=reviewIncrease(scopeNames,mS,Math.min(mE,today));
  const rate=(a2,b2)=>b2>0?(a2/b2*100):null;
  const pctTxt=(v)=>v==null?'—':v.toFixed(1)+'%';
  const bar=(v,invert)=>{ if(v==null) return ''; const w=Math.min(120,v); const ok=invert?v<=100:v>=100;
    return `<div style="height:7px;background:#efe9dd;border-radius:4px;overflow:hidden;margin-top:6px"><div style="height:100%;width:${Math.min(100,w)}%;background:${ok?'#4c7d5c':(v>=(invert?100:80)?'#b23b2e':'#c9a86a')}"></div></div>`; };
  if(!D.targets.length&&!D.targetsM.length){
    h+=`<div class="note-box no-print">目標がまだ入力されていません。「✎ 目標を入力」から、店舗・月を選んで日別売上目標と月次目標（人件費率・仕入原価率＝売上に対する％／ダイニー点数・口コミ件数）を設定してください。入力時には<b>昨年の同じ週の同じ曜日の売上</b>が指標として表示されます。</div>`;
  }
  // KPIカード（売上・達成率）
  const achM=rate(cur.sales,goalM), achPace=rate(cur.sales,elapsedGoal);
  h+=`<div class="kpi-grid">
    <div class="kpi"><div class="lb">売上目標（${m+1}月）</div><div class="vl">${goalM>0?yen(goalM):'—'}</div><div class="yy">${goalM>0?'日別目標の合計':'未設定'}</div></div>
    <div class="kpi"><div class="lb">売上実績（累計）</div><div class="vl">${yen(cur.sales)}</div><div class="yy">対月間目標 ${pctTxt(achM)}</div>${bar(achM)}</div>
    <div class="kpi"><div class="lb">進捗達成率（対経過日目標）</div><div class="vl" style="color:${achPace==null?'inherit':(achPace>=100?'#4c7d5c':'#b5502f')}">${pctTxt(achPace)}</div><div class="yy">経過日目標 ${elapsedGoal>0?yen(elapsedGoal):'—'}</div>${bar(achPace)}</div>
    <div class="kpi"><div class="lb">残り必要売上</div><div class="vl">${goalM>0?yen(Math.max(0,goalM-cur.sales)):'—'}</div><div class="yy">${goalM>0&&mE>today?('残り'+Math.round((mE-today)/86400000)+'日 ／ 日あたり '+yen(Math.max(0,goalM-cur.sales)/Math.max(1,Math.round((mE-today)/86400000)))):''}</div></div>
  </div>`;
  // その他目標。人件費・仕入は「売上に対する％」で設定（金額でなく率）。点数・口コミは実数。
  const salesAct=cur.sales;
  const items=[
    {lb:'アルバイト人件費率', pct:true, goalPct:tm.pa, actAmt:cur.pa, invert:true},
    {lb:'社員人件費率', pct:true, goalPct:tm.emp, actAmt:cur.emp, invert:true},
    {lb:'仕入原価率', pct:true, goalPct:tm.cost, actAmt:cur.cost, invert:true},
    {lb:'ダイニー点数', goal:tm.dinii, act:ds.avg, fmt:(v)=>v==null?'—':Number(v).toFixed(2), invert:false, isScore:true},
    {lb:'Google口コミ件数（月間増加）', goal:tm.review, act:revInc, fmt:(v)=>v==null?'—':cnt(v)+'件', invert:false},
  ];
  h+=`<div class="panel"><div class="panel-head"><div><h3>目標項目別 予実（${mLabel}）</h3><div class="sub">人件費・仕入は売上に対する％で設定（費用系は目標以下が◯）／ダイニー点数・口コミは目標以上が◯</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>項目</th><th>目標</th><th>実績（累計）</th><th>達成率</th><th></th></tr></thead><tbody>`;
  const expI=[];
  items.forEach(it=>{
    let goalTxt,actTxt,r2,ok;
    if(it.pct){
      const hasGoal=it.goalPct!=null&&it.goalPct>0;
      const actualPct=salesAct>0?it.actAmt/salesAct*100:null;
      goalTxt=hasGoal?(it.goalPct.toFixed(1)+'%'+(goalM>0?' <span class="mut" style="font-size:10px">('+yen(goalM*it.goalPct/100)+')</span>':'')):'—';
      actTxt=actualPct!=null?(actualPct.toFixed(1)+'% <span class="mut" style="font-size:10px">('+yen(it.actAmt)+')</span>'):'—';
      // 費用系（invert）は「低いほど良い」ので 達成率＝目標÷実績×100（100%以上で達成）。売上系は実績÷目標。
      r2=(hasGoal&&actualPct!=null)?(it.invert?(actualPct>0?it.goalPct/actualPct*100:null):actualPct/it.goalPct*100):null;
      ok=r2==null?null:r2>=100;
      expI.push([it.lb, hasGoal?it.goalPct+'%':'', actualPct!=null?actualPct.toFixed(1)+'%':'', pctTxt(r2)]);
    } else {
      const hasGoal=it.goal!=null&&it.goal>0;
      r2=it.isScore?(hasGoal&&it.act!=null?it.act/it.goal*100:null):(hasGoal&&it.act!=null?rate(it.act,it.goal):null);
      ok=r2==null?null:(it.invert?r2<=100:r2>=100);
      goalTxt=hasGoal?it.fmt(it.goal):'—'; actTxt=it.act!=null?it.fmt(it.act):'—';
      expI.push([it.lb, hasGoal?String(it.fmt(it.goal)).replace(/[¥,]/g,''):'', it.act!=null?String(it.fmt(it.act)).replace(/[¥,]/g,''):'', pctTxt(r2)]);
    }
    h+=`<tr><td>${esc(it.lb)}</td><td>${goalTxt}</td><td>${actTxt}</td>
      <td class="${ok==null?'mut':ok?'pos':'neg'}">${pctTxt(r2)}</td><td style="min-width:130px">${bar(r2)}</td></tr>`;
  });
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'目標項目別予実（'+mLabel+'）', headers:['項目','目標','実績','達成率'], rows:expI });
  // イベント一覧（当月・対象店舗のみ）
  const monthEvents=D.events.filter(e=>e.t>=mS&&e.t<=mE&&(e.stores.length===0||e.stores.some(s=>scopeSet.has(s)))).sort((a2,b2)=>a2.t-b2.t);
  if(monthEvents.length||canEdit){
    h+=`<div class="panel"><div class="panel-head"><div><h3>📅 イベント情報（${mLabel}）</h3><div class="sub">対象店舗にチェックが入っているイベントだけが、その店舗の画面に表示されます（会場例：横浜アリーナ・日産スタジアム）</div></div></div>`;
    if(monthEvents.length){
      h+=`<div class="scroll-x"><table class="tbl"><thead><tr><th>日付</th><th>イベント名</th><th>会場</th><th>対象店舗</th><th>メモ</th>${canEdit?'<th></th>':''}</tr></thead><tbody>`;
      monthEvents.forEach(e=>{ const d2=new Date(e.t);
        h+=`<tr><td>${mdw(d2)}</td><td style="text-align:left">${esc(e.name)}</td><td>${esc(e.venue||'—')}</td>
          <td style="max-width:260px;white-space:normal;font-size:11px">${e.stores.length?esc(e.stores.map(shortStore).join('・')):'全店'}</td>
          <td class="mut" style="white-space:normal">${esc(e.memo||'')}</td>
          ${canEdit?`<td><button class="icon-btn" onclick="App.openEventInput(this.dataset.i)" data-i="${esc(e.id)}">編集</button></td>`:''}</tr>`; });
      h+=`</tbody></table></div>`;
    } else h+=`<div class="empty" style="padding:18px">この月のイベントはまだ登録されていません</div>`;
    h+=`</div>`;
  }
  // 日別 予実テーブル
  const dayEdit=canEdit&&!!selN;   // 単一店舗を選んでいるときだけ、日別の目標を直接編集できる
  h+=`<div class="panel"><div class="panel-head"><div><h3>日別 予実（${mLabel} ／ ${selN?esc(selN):'合算'}）</h3><div class="sub">昨年同週同曜日＝364日前（52週前の同じ曜日）の売上実績${dayEdit?'／「編集」で各日の目標を修正できます':'（店舗を1つ選ぶと各日の目標を編集できます）'}</div></div>
      <button class="icon-btn no-print" onclick="App.csvSection('日別予実')">⬇ CSV</button></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>日付</th><th>天気</th><th>イベント</th><th>目標</th><th>実績</th><th>差異</th><th>達成率</th><th>昨年同週同曜日</th><th>昨年比</th></tr></thead><tbody>`;
  ensureWeather(scopeNames, dayMs(new Date(y,m,1)), dayMs(new Date(y,m,lastDay)));
  const expD=[]; let tG=0,tA=0,tL=0;
  for(let d2=1;d2<=lastDay;d2++){
    const t=dayMs(new Date(y,m,d2)); const dt=new Date(y,m,d2);
    const g=goalByDay[t]||0; const future=t>today;
    const act=future?null:dailySalesOf(scopeSet,t);
    const ly=dailySalesOf(scopeSet,t-LY_MS);
    const evs=eventsFor(t,scopeNames);
    const evTxt=evs.map(e=>(e.venue?e.venue+':':'')+e.name).join('／');
    tG+=g; if(act!=null)tA+=act; tL+=ly;
    const diff=act!=null&&g>0?act-g:null; const r2=act!=null&&g>0?act/g*100:null;
    const yoy=act!=null&&ly>0?((act/ly-1)*100):null;
    const wx=wxGet(scopeNames[0]||selN,t);
    h+=`<tr${isHolidayOrSunday(dt)?' style="background:#fbf6f3"':''}><td style="white-space:nowrap">${mdw(dt)}</td>
      <td style="white-space:nowrap">${wxCell(wx)}</td>
      <td style="max-width:200px;white-space:normal;font-size:11px;color:#7a6f9a">${evTxt?('🎪 '+esc(evTxt)):''}</td>
      <td style="white-space:nowrap">${g>0?yen(g):'<span class="mut">—</span>'}${dayEdit?` <button class="icon-btn no-print" style="padding:1px 7px;font-size:10px;margin-left:3px" data-st="${esc(selN)}" data-dt="${y}-${String(m+1).padStart(2,'0')}-${String(d2).padStart(2,'0')}" onclick="App.openTargetDay(this.dataset.st,this.dataset.dt)">編集</button>`:''}</td><td>${act!=null?yen(act):'<span class="mut">—</span>'}</td>
      <td class="${diff==null?'mut':diff>=0?'pos':'neg'}">${diff==null?'—':(diff>=0?'+':'▲')+yen(Math.abs(diff)).slice(1)}</td>
      <td class="${r2==null?'mut':r2>=100?'pos':'neg'}">${r2==null?'—':r2.toFixed(0)+'%'}</td>
      <td class="mut">${ly>0?yen(ly):'—'}</td>
      <td class="${yoy==null?'mut':yoy>=0?'pos':'neg'}">${yoy==null?'—':(yoy>=0?'+':'▲')+Math.abs(yoy).toFixed(1)+'%'}</td></tr>`;
    const wxTxt=wxText(wx);
    expD.push([(m+1)+'/'+d2+'('+WD[dt.getDay()]+')',wxTxt,evTxt,Math.round(g),act!=null?Math.round(act):'',r2!=null?r2.toFixed(0)+'%':'',Math.round(ly)]);
  }
  h+=`<tr class="total"><td>合計</td><td></td><td></td><td>${yen(tG)}</td><td>${yen(tA)}</td>
    <td class="${tA-tG>=0?'pos':'neg'}">${tG>0?((tA-tG>=0?'+':'▲')+yen(Math.abs(tA-tG)).slice(1)):'—'}</td>
    <td>${tG>0?(tA/tG*100).toFixed(1)+'%':'—'}</td><td>${yen(tL)}</td><td></td></tr>`;
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'日別予実（'+mLabel+'）', headers:['日付','天気','イベント','目標','実績','達成率','昨年同週同曜日'], rows:expD });
  return h;
}
function isHolidayOrSunday(dt){ try{ const key=dt.getFullYear()+'-'+(dt.getMonth()+1)+'/'+dt.getDate(); return dt.getDay()===0||dt.getDay()===6||(D.holidays&&D.holidays.has(key))||JP_HOLIDAYS.has(key); }catch(e){ return dt.getDay()===0; } }

/* ---------------- PL（損益） ---------------- */
// 対象期間・対象店舗のPL経費（DB_PL）を費目別に集計。店舗名は売上側へ自動照合、子ブランドは親に合算。
// 店舗名が空欄の行＝全社共通経費（全店/合算表示のときのみ算入）
// 区分別に集計: byCat[区分][勘定科目]=金額, catTotal[区分]=合計（F=仕入れ/L=人件費/A=広告/R=家賃/O=他）
function plAgg(scopeSet, selN, a, b){
  const byCat={F:{},L:{},A:{},R:{},O:{}}, catTotal={F:0,L:0,A:0,R:0,O:0}, unmatched={};
  let total=0, common=0;
  const rc={};
  const add=(r)=>{ const k=r.cat||'O'; byCat[k][r.item]=(byCat[k][r.item]||0)+r.amount; catTotal[k]+=r.amount; total+=r.amount; };
  for(const r of D.pl){
    if(r.t<a||r.t>b) continue;
    if(!r.store){
      if(selN) continue;                       // 店舗選択時は共通経費を含めない
      add(r); common+=r.amount;
      continue;
    }
    const res=(r.store in rc)?rc[r.store]:(rc[r.store]=resolveStoreEx(r.store));
    if(!res){ unmatched[r.store]=(unmatched[r.store]||0)+r.amount; continue; }
    if(!scopeSet.has(res.parent)) continue;
    add(r);
  }
  return { byCat, catTotal, total, common, unmatched };
}
function plMonthDate(){
  if(S.plMonth){ const p=S.plMonth.split('-'); return new Date(+p[0],+p[1]-1,1); }
  const ref=D.refDate||new Date(); return new Date(ref.getFullYear(),ref.getMonth(),1);
}
function viewPL(){
  const sc=scopeStores(); const selN=selStoreName();
  const scopeSet=new Set(selN?[selN]:sc);
  const P=S.plPeriod||'month';
  const ref=D.refDate||new Date();
  // 期間の計算：月次（前月・前年同月比較）／年間（前年比較）／期間指定（直前の同じ長さ・前年同期比較）
  let mS,mE,pS,pE,yS,yE,mLabel,prevName='前月',showYoY=true,ctrlHtml='';
  if(P==='year'){
    const yy=+(S.plYear||ref.getFullYear());
    const endD=(yy===ref.getFullYear())?ref:new Date(yy,11,31);
    mS=dayMs(new Date(yy,0,1)); mE=dayMs(endD);
    pS=dayMs(new Date(yy-1,0,1)); pE=dayMs(sub1y(endD));
    yS=pS; yE=pE; showYoY=false; prevName='前年';
    mLabel=yy+'年（1/1〜'+(endD.getMonth()+1)+'/'+endD.getDate()+'）';
    const years=[...new Set(D.daily.map(x=>new Date(x.t).getFullYear()))].sort();
    if(!years.length) years.push(ref.getFullYear());
    ctrlHtml=`<select onchange="App.set('plYear',this.value)">${years.map(v=>`<option ${String(yy)===String(v)?'selected':''}>${v}</option>`).join('')}</select>`;
  } else if(P==='custom'){
    const pI=(s2)=>{const p2=String(s2).split('-');return new Date(+p2[0],+p2[1]-1,+p2[2]);};
    let s0=S.plStart?pI(S.plStart):addD(ref,-29), e0=S.plEnd?pI(S.plEnd):new Date(ref.getFullYear(),ref.getMonth(),ref.getDate());
    if(dayMs(s0)>dayMs(e0)){ const t=s0;s0=e0;e0=t; }
    mS=dayMs(s0); mE=dayMs(e0);
    const span=Math.round((mE-mS)/86400000)+1;
    pS=dayMs(addD(s0,-span)); pE=dayMs(addD(s0,-1));
    yS=dayMs(sub1y(s0)); yE=dayMs(sub1y(e0));
    prevName='前期間';
    mLabel=(s0.getMonth()+1)+'/'+s0.getDate()+'〜'+(e0.getMonth()+1)+'/'+e0.getDate();
    ctrlHtml=`${ymdSelect('plStart',S.plStart,'')} 〜 ${ymdSelect('plEnd',S.plEnd,'')}`;
  } else {
    const m0=plMonthDate(); const y=m0.getFullYear(), m=m0.getMonth();
    mS=dayMs(new Date(y,m,1)); mE=dayMs(new Date(y,m+1,0));
    pS=dayMs(new Date(y,m-1,1)); pE=dayMs(new Date(y,m,0));
    yS=dayMs(new Date(y-1,m,1)); yE=dayMs(new Date(y-1,m+1,0));
    mLabel=y+'年 '+(m+1)+'月';
    ctrlHtml=ymSelect('plMonth', y, m);
  }
  const isAll=!selN&&sc.length===allStores().length;
  const scopeLabel=selN||(isAll?'全店合算':'担当店舗合算');

  // 自動項目（売上・原価・人件費・広告）
  const cur=stat(scopeSet,mS,mE,null), prv=stat(scopeSet,pS,pE,null), lyr=stat(scopeSet,yS,yE,null);
  const adCur=adAgg(scopeSet,mS,mE).ad, adPrv=adAgg(scopeSet,pS,pE).ad, adLyr=adAgg(scopeSet,yS,yE).ad;
  // 手入力経費（DB_PL・月次）※期間指定のときは「月初日が期間内の月」の分を計上
  const exCur=plAgg(scopeSet,selN,mS,mE), exPrv=plAgg(scopeSet,selN,pS,pE), exLyr=plAgg(scopeSet,selN,yS,yE);

  // 区分の合成：F=自動仕入＋DB_PLのF行 ／ L=自動人件費＋L行 ／ A=DB_広告＋A行 ／ R=家賃 ／ O=他
  const costT=cur.cost+exCur.catTotal.F,  costP=prv.cost+exPrv.catTotal.F,  costL=lyr.cost+exLyr.catTotal.F;
  const laborT=cur.labor+exCur.catTotal.L, laborP=prv.labor+exPrv.catTotal.L, laborL=lyr.labor+exLyr.catTotal.L;
  const adT=adCur+exCur.catTotal.A,        adP=adPrv+exPrv.catTotal.A,        adL=adLyr+exLyr.catTotal.A;
  const gross=cur.sales-costT;
  const sga=laborT+adT+exCur.catTotal.R+exCur.catTotal.O;                   // 販管費計（人件費＋広告＋家賃＋他）
  const op=cur.sales-costT-sga;                                             // 営業利益
  const opPrv=prv.sales-costP-(laborP+adP+exPrv.catTotal.R+exPrv.catTotal.O);
  const opLyr=lyr.sales-costL-(laborL+adL+exLyr.catTotal.R+exLyr.catTotal.O);
  const pct=(n)=>cur.sales>0?(n/cur.sales*100).toFixed(1)+'%':'—';
  const mom=(c,p)=>{ if(!(Math.abs(p)>0)) return {t:prevName+' —',cls:'mut'}; const d2=(c-p)/Math.abs(p)*100; return { t:prevName+'比 '+(d2>=0?'+':'▲')+Math.abs(d2).toFixed(1)+'%', cls:d2>=0?'up':'dn' }; };

  let h=`<div class="ctrl-bar no-print">
    <div class="seg">${[['month','月次'],['year','年間'],['custom','期間指定']].map(([k,l])=>`<button class="${P===k?'on':''}" onclick="App.set('plPeriod','${k}')">${l}</button>`).join('')}</div>
    ${ctrlHtml}
    ${canUse('plInput')?`<button class="icon-btn primary" onclick="App.openPlInput()">✎ 経費を入力</button>`:''}
    <span class="period-label">損益（${mLabel} ／ ${esc(scopeLabel)}）</span></div>`+storeSegHtml();

  // KPIカード
  h+=`<div class="kpi-grid">
    <div class="kpi"><div class="lb">売上高</div><div class="vl">${yen(cur.sales)}</div><div class="yy ${mom(cur.sales,prv.sales).cls}">${mom(cur.sales,prv.sales).t}</div></div>
    <div class="kpi"><div class="lb">売上総利益（粗利）</div><div class="vl">${yen(gross)}</div><div class="yy">${pct(gross)}</div></div>
    <div class="kpi"><div class="lb">販管費計（人件費＋広告＋家賃＋他）</div><div class="vl">${yen(sga)}</div><div class="yy">${pct(sga)}</div></div>
    <div class="kpi"><div class="lb">営業利益</div><div class="vl" style="color:${op>=0?'#4c7d5c':'#b5502f'}">${yen(op)}</div><div class="yy ${mom(op,opPrv).cls}">${pct(op)} ／ ${mom(op,opPrv).t}</div></div>
  </div>`;

  // DB_PL未接続/当月データなしの案内（未受信か・受信したが取り込めないかを明示）
  const plReceived=(D.receivedKeys||[]).some(k=>isPLKey(k));
  const plLive=!!(S.auth&&S.auth.token);
  if(!D.pl.length){
    const diag=D.diag&&D.diag['PL'];
    let cause='';
    if(plLive&&plReceived&&diag&&diag.indexOf('OK')!==0){
      cause=`<b style="color:#b5502f">⚠ 「DB_PL」シートは受信しましたが取り込めていません。</b> 取込結果：${esc(diag)}<br>
        1行目の見出しに <code>年月</code>・<code>勘定科目</code>・<code>金額</code> が含まれているか、2行目以降の年月が <code>2026/07</code> 形式かを確認してください。<br>`;
    } else if(plLive&&!plReceived){
      cause=`<b style="color:#b5502f">⚠ 「DB_PL」シートを受信できていません。</b><br>
        チェック：①タブ名が正確に <code>DB_PL</code>（DBのあとに半角アンダーバー「_」、PLは半角大文字）か　②別名のタブなら「接続設定」に <code>pl</code> キーで実シート名を登録し「有効」を<code>TRUE</code>に　③保存後1分待つ／「↻更新」<br>
        受信済みキー：${esc((D.receivedKeys||[]).join(' , ')||'なし')}<br>`;
    } else {
      cause=`<b>経費（家賃・水光熱費など）はまだ未接続です。</b>下のPLは自動取得できる項目（売上・原価・人件費・広告費）のみで計算しています。<br>`;
    }
    h+=`<div class="note-box no-print" style="${plLive&&(!plReceived||(diag&&diag.indexOf('OK')!==0))?'border-color:#e8cfc2;background:#faf0ec':''}">
      ${cause}
      スプレッドシートの <code>DB_PL</code> タブに、1行目 <code>年月 / 店舗名 / 勘定科目 / 区分 / 金額 / メモ</code>、2行目以降に
      <code>2026/07 ｜ 鳥一代 本店 ｜ 家賃 ｜ R ｜ 450000</code> のように月次経費を入力すると自動で反映されます。<br>
      区分: <b>F</b>=仕入れ ／ <b>L</b>=人件費 ／ <b>A</b>=広告 ／ <b>R</b>=家賃 ／ <b>O</b>=他（店舗名空欄＝全社共通経費）</div>`;
  } else if(!exCur.total){
    h+=`<div class="note-box no-print">${mLabel}分の経費（DB_PL）はまだ入力されていません。売上・原価・人件費・広告費のみで計算しています。</div>`;
  }

  // ---- 月別損益（年間・45日超の期間指定のとき：合計ではなく月別で見せる） ----
  const spanDays=Math.round((mE-mS)/86400000)+1;
  if(P==='year'||(P==='custom'&&spanDays>45)){
    const mrows=[]; let mCur=new Date(new Date(mS).getFullYear(),new Date(mS).getMonth(),1);
    const multiYear=new Date(mS).getFullYear()!==new Date(mE).getFullYear();
    while(dayMs(mCur)<=mE){
      const a2=Math.max(dayMs(mCur),mS), b2=Math.min(dayMs(new Date(mCur.getFullYear(),mCur.getMonth()+1,0)),mE);
      const c2=stat(scopeSet,a2,b2,null);
      const p2=plAgg(scopeSet,selN,a2,b2);
      const ad2=adAgg(scopeSet,a2,b2).ad+p2.catTotal.A;
      const cost2=c2.cost+p2.catTotal.F, labor2=c2.labor+p2.catTotal.L;
      const g2=c2.sales-cost2, rent2=p2.catTotal.R, oth2=p2.catTotal.O;
      mrows.push({ label:(multiYear?String(mCur.getFullYear()).slice(2)+'/':'')+(mCur.getMonth()+1)+'月',
        sales:c2.sales, cost:cost2, gross:g2, labor:labor2, ad:ad2, rent:rent2, oth:oth2, op:g2-labor2-ad2-rent2-oth2 });
      mCur=new Date(mCur.getFullYear(),mCur.getMonth()+1,1);
    }
    h+=`<div class="panel"><div class="panel-head"><div><h3>月別損益（${mLabel} ／ ${esc(scopeLabel)}）</h3>
      <div class="sub">売上高〜営業利益を月ごとに表示（区分F/L/Aの手入力分も各月に合算）</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>月</th><th>売上高</th><th>原価(F)</th><th>粗利</th><th>人件費(L)</th><th>広告費(A)</th><th>家賃(R)</th><th>他(O)</th><th>営業利益</th><th>利益率</th></tr></thead><tbody>`;
    const expM=[];
    const vfmt=(n)=>n===0?'—':(n<0?'▲'+yen(-n).slice(1):yen(n));
    mrows.forEach(r2=>{
      const orate=r2.sales>0?(r2.op/r2.sales*100).toFixed(1)+'%':'—';
      h+=`<tr><td>${esc(r2.label)}</td><td>${vfmt(r2.sales)}</td><td>${vfmt(r2.cost)}</td><td>${vfmt(r2.gross)}</td><td>${vfmt(r2.labor)}</td><td>${vfmt(r2.ad)}</td><td>${vfmt(r2.rent)}</td><td>${vfmt(r2.oth)}</td>
        <td class="${r2.op>=0?'pos':'neg'}" style="font-weight:700">${r2.op<0?'▲'+yen(-r2.op).slice(1):yen(r2.op)}</td><td class="${r2.op>=0?'pos':'neg'}">${orate}</td></tr>`;
      expM.push([r2.label,Math.round(r2.sales),Math.round(r2.cost),Math.round(r2.gross),Math.round(r2.labor),Math.round(r2.ad),Math.round(r2.rent),Math.round(r2.oth),Math.round(r2.op),orate]);
    });
    const tt=mrows.reduce((o,r2)=>{ o.sales+=r2.sales;o.cost+=r2.cost;o.gross+=r2.gross;o.labor+=r2.labor;o.ad+=r2.ad;o.rent+=r2.rent;o.oth+=r2.oth;o.op+=r2.op; return o; },{sales:0,cost:0,gross:0,labor:0,ad:0,rent:0,oth:0,op:0});
    h+=`<tr class="total"><td>合計</td><td>${yen(tt.sales)}</td><td>${yen(tt.cost)}</td><td>${yen(tt.gross)}</td><td>${yen(tt.labor)}</td><td>${yen(tt.ad)}</td><td>${yen(tt.rent)}</td><td>${yen(tt.oth)}</td>
      <td class="${tt.op>=0?'pos':'neg'}">${tt.op<0?'▲'+yen(-tt.op).slice(1):yen(tt.op)}</td><td>${tt.sales>0?(tt.op/tt.sales*100).toFixed(1)+'%':'—'}</td></tr>`;
    h+=`</tbody></table></div></div>`;
    EXPORT.push({ title:'月別損益（'+mLabel+'／'+scopeLabel+'）', headers:['月','売上高','原価(F)','粗利','人件費(L)','広告費(A)','家賃(R)','他(O)','営業利益','利益率'], rows:expM });
  }

  // ---- PL表（区分ごとにセクション表示: F=原価 / L=人件費 / A=広告 / R=家賃 / O=他） ----
  const rows=[];   // {name, c, p, l, indent, bold, line, profit}
  // 区分内の勘定科目を行として追加（当期・前期・前年同期を突き合わせ）
  const pushCatItems=(cat)=>{
    const keys=[...new Set([].concat(Object.keys(exCur.byCat[cat]),Object.keys(exPrv.byCat[cat]),Object.keys(exLyr.byCat[cat])))]
      .sort((a2,b2)=>(exCur.byCat[cat][b2]||0)-(exCur.byCat[cat][a2]||0));
    keys.forEach(it=>rows.push({name:it, c:-(exCur.byCat[cat][it]||0), p:-(exPrv.byCat[cat][it]||0), l:-(exLyr.byCat[cat][it]||0), indent:true, editItem:it}));
    return keys.length;
  };
  rows.push({name:'売上高', c:cur.sales, p:prv.sales, l:lyr.sales, bold:true});
  rows.push({name:'仕入（自動連携）', c:-cur.cost, p:-prv.cost, l:-lyr.cost, indent:true});
  const nF=pushCatItems('F');
  rows.push({name:'売上原価計（F）', c:-costT, p:-costP, l:-costL, bold:nF>0, line:false});
  rows.push({name:'売上総利益（粗利）', c:gross, p:prv.sales-costP, l:lyr.sales-costL, bold:true, line:true});
  if(D.hasLaborSplit){
    rows.push({name:'人件費（社員給与・賞与）', c:-cur.empBase, p:-prv.empBase, l:-lyr.empBase, indent:true});
    rows.push({name:'法定福利費（自動連携）', c:-cur.welfare, p:-prv.welfare, l:-lyr.welfare, indent:true});
    rows.push({name:'通勤手当（自動連携）', c:-cur.commute, p:-prv.commute, l:-lyr.commute, indent:true});
  } else {
    rows.push({name:'人件費（社員・自動連携）', c:-cur.emp, p:-prv.emp, l:-lyr.emp, indent:true});
  }
  rows.push({name:'人件費（アルバイト・自動連携）', c:-cur.pa, p:-prv.pa, l:-lyr.pa, indent:true});
  pushCatItems('L');
  rows.push({name:'人件費計（L）', c:-laborT, p:-laborP, l:-laborL, bold:true});
  rows.push({name:'広告費（DB_広告・自動連携）', c:-adCur, p:-adPrv, l:-adLyr, indent:true});
  const nA=pushCatItems('A');
  rows.push({name:'広告宣伝費計（A）', c:-adT, p:-adP, l:-adL, bold:true});
  const nR=pushCatItems('R');
  rows.push({name:'家賃計（R）', c:-exCur.catTotal.R, p:-exPrv.catTotal.R, l:-exLyr.catTotal.R, bold:true});
  const nO=pushCatItems('O');
  rows.push({name:'その他経費計（O）', c:-exCur.catTotal.O, p:-exPrv.catTotal.O, l:-exLyr.catTotal.O, bold:true});
  rows.push({name:'販管費計（L＋A＋R＋O）', c:-sga, p:-(laborP+adP+exPrv.catTotal.R+exPrv.catTotal.O), l:-(laborL+adL+exLyr.catTotal.R+exLyr.catTotal.O), bold:true, line:true});
  rows.push({name:'営業利益', c:op, p:opPrv, l:opLyr, bold:true, line:true, profit:true});

  const plTitle=(P==='year'?'年間PL':P==='custom'?'期間PL':'月次PL');
  // 最右列は常に「前年比」。月次/期間指定は前年同期(r2.l)、年間は前年(r2.p)を基準にする
  const yoyBase=(r2)=>showYoY?r2.l:r2.p;
  const cmp=(c,base)=>{ if(!(Math.abs(base)>0)) return {t:'—',cls:'mut'}; const d2=(c-base)/Math.abs(base)*100; return {t:(d2>=0?'+':'▲')+Math.abs(d2).toFixed(1)+'%', cls:d2>=0?'up':'dn'}; };
  h+=`<div class="panel"><div class="panel-head"><div><h3>${plTitle}（${mLabel} ／ ${esc(scopeLabel)}）</h3>
    <div class="sub">売上・原価・人件費＝分析_日別店舗 ／ 広告費＝DB_広告 ／ その他経費＝DB_PL（自動連携）${P==='custom'?' ※経費は月単位のため、月初日が期間内の月分を計上':''}</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>項目</th><th>当期</th><th>売上比</th><th>${prevName}</th>${showYoY?'<th>前年同期</th>':''}<th>前年比</th></tr></thead><tbody>`;
  const expP=[];
  rows.forEach(r2=>{
    const v=(n)=>n===0?'—':(n<0?'▲'+yen(-n).slice(1):yen(n));
    const yc=cmp(r2.c,yoyBase(r2));
    const color=r2.profit?(r2.c>=0?'color:#4c7d5c;font-weight:700':'color:#b5502f;font-weight:700'):'';
    h+=`<tr class="${r2.line?'total':''}"><td style="${r2.indent?'padding-left:24px;':''}${r2.bold?'font-weight:700':''}">${esc(r2.name)}${r2.editItem&&P==='month'?` <button class="icon-btn no-print" style="padding:1px 7px;font-size:10px;margin-left:6px" data-i="${esc(r2.editItem)}" onclick="App.openPlItemEdit(this.dataset.i)">編集</button>`:''}</td>
      <td style="${color}">${v(r2.c)}</td><td class="mut">${pct(Math.abs(r2.c))}</td>
      <td class="mut">${v(r2.p)}</td>${showYoY?`<td class="mut">${v(r2.l)}</td>`:''}
      <td class="${yc.cls==='up'?'pos':yc.cls==='dn'?'neg':'mut'}">${yc.t}</td></tr>`;
    expP.push(showYoY?[r2.name,Math.round(r2.c),cur.sales>0?(Math.abs(r2.c)/cur.sales*100).toFixed(1)+'%':'',Math.round(r2.p),Math.round(r2.l)]
                     :[r2.name,Math.round(r2.c),cur.sales>0?(Math.abs(r2.c)/cur.sales*100).toFixed(1)+'%':'',Math.round(r2.p)]);
  });
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:plTitle+'（'+mLabel+'／'+scopeLabel+'）', headers:showYoY?['項目','当期','売上比',prevName,'前年同期']:['項目','当期','売上比',prevName], rows:expP });

  // ---- 店舗別PL比較（全店/合算表示のときのみ） ----
  if(!selN&&sc.length>1){
    h+=`<div class="panel"><div class="panel-head"><div><h3>店舗別 損益比較（${mLabel}）</h3><div class="sub">行クリックで店舗のPLへ ／ 共通経費（店舗名空欄）は含みません</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>売上高</th><th>粗利</th><th>人件費</th><th>広告費</th><th>家賃・他経費</th><th>営業利益</th><th>利益率</th></tr></thead><tbody>`;
    const expC=[]; let tS=0,tG=0,tL=0,tA=0,tE=0,tO=0;
    sc.forEach(nm=>{
      const s1=new Set([nm]);
      const c1=stat(s1,mS,mE,null);
      const p1=plAgg(s1,nm,mS,mE);
      const a1=adAgg(s1,mS,mE).ad + p1.catTotal.A;           // 広告費 = DB_広告 + DB_PLのA区分
      const l1=c1.labor + p1.catTotal.L;                     // 人件費 = 自動 + L区分
      const g1=c1.sales - (c1.cost + p1.catTotal.F);         // 粗利 = 売上 - (自動仕入 + F区分)
      const e1=p1.catTotal.R + p1.catTotal.O;                // 経費 = 家賃 + 他
      const o1=g1-l1-a1-e1;
      tS+=c1.sales;tG+=g1;tL+=l1;tA+=a1;tE+=e1;tO+=o1;
      const orate=c1.sales>0?(o1/c1.sales*100).toFixed(1)+'%':'—';
      h+=`<tr class="click" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}"><td>${shortStoreTd(nm)}</td><td>${yen(c1.sales)}</td><td>${yen(g1)}</td><td>${yen(l1)}</td><td>${yen(a1)}</td><td>${yen(e1)}</td>
        <td class="${o1>=0?'pos':'neg'}" style="font-weight:700">${o1<0?'▲'+yen(-o1).slice(1):yen(o1)}</td><td class="${o1>=0?'pos':'neg'}">${orate}</td></tr>`;
      expC.push([nm,Math.round(c1.sales),Math.round(g1),Math.round(l1),Math.round(a1),Math.round(e1),Math.round(o1),orate]);
    });
    h+=`<tr class="total"><td>合計</td><td>${yen(tS)}</td><td>${yen(tG)}</td><td>${yen(tL)}</td><td>${yen(tA)}</td><td>${yen(tE)}</td>
      <td class="${tO>=0?'pos':'neg'}">${tO<0?'▲'+yen(-tO).slice(1):yen(tO)}</td><td>${tS>0?(tO/tS*100).toFixed(1)+'%':'—'}</td></tr>`;
    h+=`</tbody></table></div></div>`;
    EXPORT.push({ title:'店舗別損益比較（'+mLabel+'）', headers:['店舗','売上高','粗利','人件費','広告費','経費','営業利益','利益率'], rows:expC });
  }

  // ---- 未突合のPL店舗名 ----
  const umKeys=Object.keys(exCur.unmatched);
  if(umKeys.length){
    h+=`<div class="panel"><div class="panel-head"><div><h3 style="color:#b5502f">⚠ 売上店舗と一致しなかったPL店舗名（${mLabel}）</h3>
      <div class="sub">下の店舗名は売上側と一致せず、上のPLに含まれていません。DB_店舗名対応（統合）または DB_店舗親子（サブブランド）で紐づけできます</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>DB_PLの店舗名</th><th>金額（当月）</th></tr></thead><tbody>`;
    umKeys.sort((a2,b2)=>exCur.unmatched[b2]-exCur.unmatched[a2]).forEach(nm=>{ h+=`<tr><td>${esc(nm)}</td><td>${yen(exCur.unmatched[nm])}</td></tr>`; });
    h+=`</tbody></table></div></div>`;
  }
  return h;
}

/* ---------------- 口コミ ---------------- */
/* =====================================================================
 * 週報（火曜〜翌月曜。提出＝翌火16時 / FB＝翌水16時）
 * 数値（売上・ダイニー）は自動反映。フォーマットは DB_週報テンプレート で変えられる。
 * ===================================================================== */
const WK_DUE_HOUR=16;
// 日付を含む「火曜始まりの週」の火曜日
function wkStart(d){ const x=new Date(d.getFullYear(),d.getMonth(),d.getDate()); x.setDate(x.getDate()-((x.getDay()-2+7)%7)); return x; }
function wkEnd(s){ return addD(s,6); }                       // 月曜
function wkSubmitDue(s){ const d=addD(s,7); d.setHours(WK_DUE_HOUR,0,0,0); return d; }   // 翌火16:00
function wkFbDue(s){ const d=addD(s,8); d.setHours(WK_DUE_HOUR,0,0,0); return d; }       // 翌水16:00
function wkLabel(s){ const e=wkEnd(s); return `${s.getMonth()+1}/${s.getDate()}(火)〜${e.getMonth()+1}/${e.getDate()}(月)`; }
// いま対象にすべき週（締切前は先週、締切後は今週を書く運用に合わせ「直近の完了した週」を既定にする）
function wkCurrent(){
  if(S.wkWeek){ const p=S.wkWeek.split('-'); return new Date(+p[0],+p[1]-1,+p[2]); }
  const ref=D.refDate||new Date();
  return addD(wkStart(ref),-7);
}
function wkMyPosition(){ const a=S.auth&&S.auth.account; return (a&&a.position)||''; }
// 役職に対応するテンプレート（未設定なら「社員」→最初に見つかったもの、の順で探す）
// 役職が一致したときだけフォーマットを返す。役職が未設定の人（社長など）は提出対象にしない。
// ここで「社員」等に自動フォールバックすると、提出しない立場の人にも入力欄が出てしまう。
function wkTemplateFor(pos){
  const t=D.wkTpl||{};
  return (pos&&t[pos])?t[pos]:[];
}
// 週報に自動で載せる数値（その人の店舗・その週）
function wkAutoStats(store,s){
  const a=dayMs(s), b=dayMs(wkEnd(s));
  const names=store?[store]:scopeStores();
  const set=new Set(names);
  const cur=stat(store?null:set,a,b,store||null);
  const pv=stat(store?null:set,dayMs(sub1y(s)),dayMs(sub1y(wkEnd(s))),store||null);
  const dn=D.dinii.length?diniiStats(names,a,b):{avg:null,count:0};
  return { sales:cur.sales, prevSales:pv.sales, guests:cur.guests,
    spend:cur.guests>0?cur.sales/cur.guests:0,
    fl:cur.sales>0?(cur.cost+cur.labor)/cur.sales:null, dinii:dn.avg, diniiCount:dn.count };
}
// 自分が見られる週報（同じ店舗なら全員／マネージャーは担当店舗／社長・本部は全店）
function wkVisibleReports(weekT){
  const acc=S.auth&&S.auth.account; if(!acc) return [];
  const admin=isAdminRole();
  const mine=new Set(scopeStores());
  return (D.wkRep||[]).filter(r=>{
    if(weekT&&r.week!==weekT) return false;
    if(admin) return true;
    if(r.userId===acc.id) return true;
    return r.store?mine.has(normStore(r.store))||mine.has(r.store):false;
  });
}
function viewWeekly(){
  const s=wkCurrent(), weekT=dayMs(s);
  const acc=S.auth.account;
  const tpl=wkTemplateFor(wkMyPosition());
  const mine=(D.wkRep||[]).find(r=>r.userId===acc.id&&r.week===weekT);
  const nav=`<div class="ctrl-bar no-print">
    <div class="mini-nav"><button onclick="App.wkNav(-1)">‹</button><span class="lbl">${wkLabel(s)}</span><button onclick="App.wkNav(1)">›</button></div>
    <button class="icon-btn" onclick="App.wkNav(0)">今週へ</button>
    <span class="period-label">週報（火曜〜月曜）／ 提出期限 ${wkSubmitDue(s).getMonth()+1}/${wkSubmitDue(s).getDate()} 16:00 ・ FB期限 ${wkFbDue(s).getMonth()+1}/${wkFbDue(s).getDate()} 16:00</span>
  </div>`;
  let h=nav;
  if(isAdminRole()) h+=wkAdminPanel(s,weekT);
  // 自分の役職にフォーマットがある人（＝提出対象者）だけ入力欄を出す。
  // 社長など提出しない立場の人は一覧とフィードバックだけ見えるようにして画面を軽くする。
  if(tpl.length) h+=wkMyForm(s,weekT,tpl,mine);
  else h+=`<div class="note-box no-print" style="margin:10px 0">あなたの役職（${esc(wkMyPosition()||'未設定')}）は週報の提出対象ではありません。下の一覧を確認してフィードバックできます。${isAdminRole()?'提出状況の全体像は「週報管理」タブで見られます。':''}</div>`;
  h+=wkListPanel(s,weekT);
  return h;
}
// 自分の週報（入力フォーム）
function wkMyForm(s,weekT,tpl,mine){
  const acc=S.auth.account;
  const store=selStoreName()||scopeStores()[0]||'';
  const st=wkAutoStats(store,s);
  const yy=(c,p)=>p>0?((c-p)/p*100>=0?'+':'▲')+Math.abs((c-p)/p*100).toFixed(1)+'%':'—';
  const auto=`<div class="kpi-grid" style="margin:2px 0 12px">
    <div class="kpi"><div class="lb">週売上</div><div class="vl">${yen(st.sales)}</div><div class="yy">前年比 ${yy(st.sales,st.prevSales)}</div></div>
    <div class="kpi"><div class="lb">客数</div><div class="vl">${cnt(st.guests)}人</div><div class="yy">客単価 ${yen(st.spend)}</div></div>
    <div class="kpi"><div class="lb">FL率</div><div class="vl">${st.fl!=null?(st.fl*100).toFixed(1)+'%':'—'}</div><div class="yy">原価＋人件費</div></div>
    <div class="kpi"><div class="lb">ダイニー再来店</div><div class="vl">${st.dinii!=null?st.dinii.toFixed(2):'—'}</div><div class="yy">${cnt(st.diniiCount)}件</div></div>
  </div>`;
  if(!tpl.length){
    return `<div class="panel"><div class="panel-head"><div><h3>今週の自分の週報</h3></div></div>${auto}
      <div class="note-box">あなたの役職（${esc(wkMyPosition()||'未設定')}）のフォーマットが見つかりません。スプレッドシートの <code>DB_週報テンプレート</code> に行を追加するか、アカウント管理で役職を設定してください。</div></div>`;
  }
  const ansMap={}; (D.wkAns[mine&&mine.id]||[]).forEach(a=>{ ansMap[a.label]=a.value; });
  const overdue=!mine&&Date.now()>wkSubmitDue(s).getTime();
  const badge=mine?'<span class="badge ok">提出済み</span>':(overdue?'<span class="badge ng">期限切れ・未提出</span>':'<span class="badge mid">未提出</span>');
  let f=`<div class="panel"><div class="panel-head"><div><h3>今週の自分の週報 ${badge}</h3>
    <div class="sub">${esc(acc.name||acc.id)}${wkMyPosition()?' ／ '+esc(wkMyPosition()):''}${store?' ／ '+esc(store):''}${mine?' ／ 提出済みの内容を編集できます':''}</div></div></div>${auto}`;
  tpl.forEach((it,i)=>{
    const v=esc(ansMap[it.label]||'');
    f+=`<label style="display:block;font-size:12px;color:#5c5348;font-weight:700;margin:12px 0 5px">${esc(it.label)}${it.required?' <span style="color:#b5502f">*</span>':''}</label>`;
    f+= it.type==='短文'||it.type==='数値'
      ? `<input type="text" id="wk-${i}" style="width:100%" value="${v}">`
      : `<textarea id="wk-${i}" rows="4" style="width:100%;font-family:var(--sans);font-size:13px;color:var(--ink);background:#fff;border:1px solid var(--line2);border-radius:8px;padding:9px 11px;outline:none">${v}</textarea>`;
  });
  f+=`<div id="wk-msg" style="font-size:12px;color:#b5502f;margin:10px 0 0"></div>
    <div style="margin-top:12px"><button class="icon-btn primary" onclick="App.saveWeekly()">${mine?'週報を更新':'週報を提出'}</button></div></div>`;
  return f;
}
// 本部・社長向け：提出状況のまとめ
function wkAdminPanel(s,weekT){
  const reps=(D.wkRep||[]).filter(r=>r.week===weekT);
  const submitted=reps.length;
  const withFb=reps.filter(r=>(D.wkFb[r.id]||[]).length>0).length;
  const now=Date.now();
  const subOver=now>wkSubmitDue(s).getTime(), fbOver=now>wkFbDue(s).getTime();
  // 店舗別の提出数
  const byStore={};
  reps.forEach(r=>{ const k=r.store||'（店舗未設定）'; byStore[k]=byStore[k]||{n:0,fb:0}; byStore[k].n++; if((D.wkFb[r.id]||[]).length) byStore[k].fb++; });
  let h=`<div class="kpi-grid" style="margin:8px 0">
    <div class="kpi"><div class="lb">提出数</div><div class="vl">${cnt(submitted)}件</div><div class="yy">${subOver?'提出期限すぎ':'期限まで受付中'}</div></div>
    <div class="kpi"><div class="lb">FB済み</div><div class="vl">${cnt(withFb)}件</div><div class="yy ${submitted&&withFb<submitted?'dn':''}">未FB ${cnt(submitted-withFb)}件${fbOver?'（期限すぎ）':''}</div></div>
    <div class="kpi"><div class="lb">FB率</div><div class="vl">${submitted?Math.round(withFb/submitted*100)+'%':'—'}</div><div class="yy">提出に対するFBの割合</div></div>
    <div class="kpi"><div class="lb">対象週</div><div class="vl" style="font-size:16px">${wkLabel(s)}</div><div class="yy">提出 ${wkSubmitDue(s).getMonth()+1}/${wkSubmitDue(s).getDate()}16時まで</div></div>
  </div>`;
  const keys=Object.keys(byStore).sort();
  if(keys.length){
    h+=`<div class="panel"><div class="panel-head"><div><h3>店舗別 提出状況（${wkLabel(s)}）</h3><div class="sub">提出された週報のうち、フィードバックが付いた件数</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>提出</th><th>FB済み</th><th>未FB</th></tr></thead><tbody>`;
    keys.forEach(k=>{ const v=byStore[k];
      h+=`<tr><td>${esc(k)}</td><td>${cnt(v.n)}件</td><td>${cnt(v.fb)}件</td><td class="${v.n-v.fb>0?'neg':'mut'}">${cnt(v.n-v.fb)}件</td></tr>`; });
    h+=`</tbody></table></div></div>`;
  }
  return h;
}
// 週報の一覧（同じ店舗なら全員見える）
function wkListPanel(s,weekT,filtered){
  let list=wkVisibleReports(weekT).slice().sort((a,b)=>(a.store||'').localeCompare(b.store||'')||(a.userName||'').localeCompare(b.userName||''));
  const total=list.length;
  if(filtered){
    const q=String(S.wkFQ||'').trim().toLowerCase();
    list=list.filter(r=>{
      if(S.wkFStore&&!(String(r.store||'').split(/[,、]/).map(x=>x.trim()).includes(S.wkFStore))) return false;
      if(S.wkFPos&&r.position!==S.wkFPos) return false;
      if(S.wkFState==='nofb'&&(D.wkFb[r.id]||[]).length) return false;
      if(S.wkFState==='late'&&!(r.submittedAt&&r.submittedAt>wkSubmitDue(s).getTime())) return false;
      if(q){
        const hay=[r.userName,r.userId,r.store,r.position].concat((D.wkAns[r.id]||[]).map(a=>a.label+' '+a.value))
          .concat((D.wkFb[r.id]||[]).map(f=>f.userName+' '+f.body)).join(' ').toLowerCase();
        if(hay.indexOf(q)<0) return false;
      }
      return true;
    });
  }
  const title=filtered?'週報一覧':'みんなの週報';
  if(!list.length) return `<div class="panel"><div class="panel-head"><div><h3>${title}（${wkLabel(s)}）</h3></div></div><div class="empty">${total?'条件に合う週報がありません':'まだ提出がありません'}</div></div>`;
  let h=`<div class="panel"><div class="panel-head"><div><h3>${title}（${wkLabel(s)}）</h3><div class="sub">${filtered?(list.length===total?`${total}件`:`${list.length}件を表示（全${total}件）`):'同じ店舗のメンバーとフィードバックが見られます ／ '+list.length+'件'}</div></div></div>`;
  list.forEach(r=>{
    const ans=D.wkAns[r.id]||[]; const fbs=D.wkFb[r.id]||[];
    const late=r.submittedAt&&r.submittedAt>wkSubmitDue(s).getTime();
    h+=`<div style="border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0;background:#fff">
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <b style="font-size:14px">${esc(r.userName||r.userId)}</b>
        <span class="mut" style="font-size:11.5px">${esc(r.position||'')}${r.store?' ／ '+esc(r.store):''}</span>
        ${late?'<span class="badge ng">期限後の提出</span>':'<span class="badge ok">期限内</span>'}
        <span class="mut" style="font-size:11px;margin-left:auto">${fbs.length?'FB '+fbs.length+'件':'<span style="color:#b5502f">FB未実施</span>'}</span>
      </div>`;
    ans.forEach(a=>{ h+=`<div style="margin-top:9px"><div style="font-size:11.5px;color:#8c8375;font-weight:700">${esc(a.label)}</div>
      <div style="font-size:13px;white-space:pre-wrap;line-height:1.7">${esc(a.value)||'<span class="mut">—</span>'}</div></div>`; });
    if(fbs.length){
      h+=`<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:9px">`;
      fbs.forEach(f=>{ h+=`<div style="background:#f7f4ec;border-radius:8px;padding:8px 11px;margin-top:6px">
        <div style="font-size:11px;color:#8c8375">💬 ${esc(f.userName||f.userId)}</div>
        <div style="font-size:12.5px;white-space:pre-wrap;line-height:1.7">${esc(f.body)}</div></div>`; });
      h+=`</div>`;
    }
    h+=`<div style="margin-top:10px;display:flex;gap:8px">
      <input type="text" id="fb-${esc(r.id)}" placeholder="フィードバックを入力…" style="flex:1">
      <button class="icon-btn" onclick="App.saveFeedback(this.dataset.i)" data-i="${esc(r.id)}">送信</button></div></div>`;
  });
  return h+`</div>`;
}
/* ---- 週報管理（社長・本部・マネージャー向け。提出状況の把握とフィードバック） ---- */
// 週報の提出対象者。アカウント一覧のうち、有効かつ役職テンプレートがある人。
function wkExpectedMembers(){
  const list=(S.accounts||[]).filter(a=>a.active!==false);
  const admin=isAdminRole();
  const mine=new Set(scopeStores());
  return list.filter(a=>{
    if(!wkTemplateFor(a.position||'').length) return false;   // 提出フォーマットが無い人は対象外
    if(String(a.stores||'')==='全店') return false;            // 全店担当（社長・本部）は提出対象にしない
    if(admin) return true;
    return String(a.stores||'').split(/[,、]/).some(x=>mine.has(x.trim()));
  });
}
function viewWeeklyAdmin(){
  const live=!!(S.auth&&S.auth.token);
  if(live&&S.accounts===null){ loadAccounts(); }
  const s=wkCurrent(), weekT=dayMs(s);
  const reps=wkVisibleReports(weekT);
  const members=wkExpectedMembers();
  const repByUser={}; reps.forEach(r=>{ repByUser[r.userId]=r; });
  const notYet=members.filter(m=>!repByUser[m.id]);
  const now=Date.now(), subOver=now>wkSubmitDue(s).getTime(), fbOver=now>wkFbDue(s).getTime();
  const withFb=reps.filter(r=>(D.wkFb[r.id]||[]).length>0);
  const noFb=reps.filter(r=>!(D.wkFb[r.id]||[]).length);
  const rate=members.length?Math.round(reps.length/members.length*100):null;

  let h=`<div class="ctrl-bar no-print">
    <div class="mini-nav"><button onclick="App.wkNav(-1)">‹</button><span class="lbl">${wkLabel(s)}</span><button onclick="App.wkNav(1)">›</button></div>
    <button class="icon-btn" onclick="App.wkNav(0)">今週へ</button>
    <span class="period-label">提出期限 ${wkSubmitDue(s).getMonth()+1}/${wkSubmitDue(s).getDate()} 16:00 ・ FB期限 ${wkFbDue(s).getMonth()+1}/${wkFbDue(s).getDate()} 16:00</span>
  </div>`;
  h+=`<div class="kpi-grid">
    <div class="kpi"><div class="lb">提出率</div><div class="vl">${rate!=null?rate+'%':'—'}</div><div class="yy">${cnt(reps.length)} / ${cnt(members.length)}人</div></div>
    <div class="kpi"><div class="lb">未提出</div><div class="vl" style="color:${notYet.length?'#b5502f':'#3d3a33'}">${cnt(notYet.length)}人</div><div class="yy">${subOver?'提出期限すぎ':'期限まで受付中'}</div></div>
    <div class="kpi"><div class="lb">未フィードバック</div><div class="vl" style="color:${noFb.length?'#b5502f':'#3d3a33'}">${cnt(noFb.length)}件</div><div class="yy">${fbOver?'FB期限すぎ':'期限まで受付中'}</div></div>
    <div class="kpi"><div class="lb">FB率</div><div class="vl">${reps.length?Math.round(withFb.length/reps.length*100)+'%':'—'}</div><div class="yy">提出に対するFBの割合</div></div>
  </div>`;
  if(!live){ h+=`<div class="note-box">API未接続のため、提出対象者（アカウント一覧）を読み込めません。未提出者の判定は本番環境でのみ動作します。</div>`; }

  // 未提出者
  if(notYet.length){
    h+=`<div class="panel" style="border-color:#e8cfc2"><div class="panel-head"><div><h3 style="color:#b5502f">未提出 ${notYet.length}人（${wkLabel(s)}）</h3>
      <div class="sub">提出期限 ${wkSubmitDue(s).getMonth()+1}/${wkSubmitDue(s).getDate()} 16:00${subOver?' ／ <b style="color:#b5502f">期限を過ぎています</b>':''}</div></div></div>
      <div class="chk-stores">${notYet.map(m=>`<span style="background:#faf0ec;border:1px solid #e8cfc2;border-radius:8px;padding:6px 10px;font-size:12px">${esc(m.name||m.id)}<span class="mut" style="font-size:10.5px"> ／ ${esc(m.position||'')}${m.stores?' ／ '+esc(m.stores):''}</span></span>`).join('')}</div></div>`;
  } else if(members.length){
    h+=`<div class="panel" style="border-color:#cfe0d2"><div class="panel-head"><div><h3 style="color:#4c7d5c">全員提出済み（${cnt(members.length)}人）</h3></div></div></div>`;
  }

  // 検索・フィルター
  const stores=[...new Set(members.concat(reps.map(r=>({stores:r.store}))).map(x=>String(x.stores||'')).flatMap(x=>x.split(/[,、]/)).map(x=>x.trim()).filter(Boolean))].sort();
  const positions=[...new Set(reps.map(r=>r.position).concat(members.map(m=>m.position)).filter(Boolean))].sort();
  h+=`<div class="panel"><div class="panel-head"><div><h3>週報を探す</h3><div class="sub">店舗・役職・キーワードで絞り込めます（本文も検索対象）</div></div></div>
    <div class="form-grid">
      <div><label>店舗</label><select id="wa-store" onchange="App.set('wkFStore',this.value)"><option value="">すべて</option>${stores.map(n=>`<option ${S.wkFStore===n?'selected':''}>${esc(n)}</option>`).join('')}</select></div>
      <div><label>役職</label><select id="wa-pos" onchange="App.set('wkFPos',this.value)"><option value="">すべて</option>${positions.map(n=>`<option ${S.wkFPos===n?'selected':''}>${esc(n)}</option>`).join('')}</select></div>
      <div><label>状態</label><select id="wa-state" onchange="App.set('wkFState',this.value)">
        <option value="">すべて</option>
        <option value="nofb" ${S.wkFState==='nofb'?'selected':''}>FB未実施のみ</option>
        <option value="late" ${S.wkFState==='late'?'selected':''}>期限後の提出のみ</option>
      </select></div>
      <div><label>キーワード（名前・本文）</label><input type="text" id="wa-q" value="${esc(S.wkFQ||'')}" oninput="App.wkSearch(this.value)" placeholder="例: 田中 / 客単価"></div>
    </div></div>`;

  h+=wkListPanel(s,weekT,true);
  return h;
}
function viewReview(){
  const sc=scopeStores(); const selName=selStoreName();
  const baseStores=selName?[selName]:sc;
  if(!D.review.length&&!D.dinii.length) return storeSegHtml()+`<div class="panel"><h3>口コミ推移</h3><div class="empty">口コミデータがありません</div></div>`;

  // ---- 期間選択（週 / 月 / 年間 / 期間指定） ----
  const P=S.revPeriod||'month';
  const ref=D.refDate||new Date();
  const defMonth=ref.getFullYear()+'-'+String(ref.getMonth()+1).padStart(2,'0');
  let s,e,label,ctrlHtml='';
  if(P==='week'){
    const pm=S.revMonth||defMonth;
    const py=+pm.split('-')[0], pmn=+pm.split('-')[1];
    const ld=new Date(py,pmn,0).getDate();
    const isCur=(py===ref.getFullYear()&&pmn-1===ref.getMonth());
    let idx=S.revWeekIdx; if(idx==null) idx=isCur?Math.min(4,Math.floor((ref.getDate()-1)/7)):0;
    const sd=idx*7+1, ed=idx<4?Math.min(sd+6,ld):ld;
    s=new Date(py,pmn-1,Math.min(sd,ld)); e=new Date(py,pmn-1,ed);
    if(isCur&&dayMs(e)>dayMs(ref)) e=new Date(ref.getFullYear(),ref.getMonth(),ref.getDate());
    label=py+'年'+pmn+'月 第'+(idx+1)+'週（'+sd+'日〜'+ed+'日）';
    ctrlHtml=`<input type="month" value="${pm}" onchange="App.set('revMonth',this.value)">
      <span class="seg">${[0,1,2,3,4].map(i2=>`<button class="${idx===i2?'on':''}" onclick="App.setRevWeek(${i2})">第${i2+1}週</button>`).join('')}</span>`;
  } else if(P==='year'){
    const yy=+(S.revYear||ref.getFullYear());
    s=new Date(yy,0,1); e=(yy===ref.getFullYear())?new Date(ref.getFullYear(),ref.getMonth(),ref.getDate()):new Date(yy,11,31);
    label=yy+'年（1/1〜'+(e.getMonth()+1)+'/'+e.getDate()+'）';
    // 年の選択肢は売上・口コミ・ダイニー全データの年から生成
    const years=[...new Set([].concat(
      D.daily.map(x=>new Date(x.t).getFullYear()),
      D.review.map(x=>new Date(x.t).getFullYear()),
      D.dinii.filter(x=>x.t>0).map(x=>new Date(x.t).getFullYear())
    ).filter(v=>v>2000))].sort();
    if(!years.length) years.push(ref.getFullYear());
    ctrlHtml=`<select onchange="App.set('revYear',this.value)">${years.map(v=>`<option ${String(yy)===String(v)?'selected':''}>${v}</option>`).join('')}</select>`;
  } else if(P==='custom'){
    const pI=(s2)=>{const p2=String(s2).split('-');return new Date(+p2[0],+p2[1]-1,+p2[2]);};
    let s0=S.revStart?pI(S.revStart):addD(ref,-29), e0=S.revEnd?pI(S.revEnd):new Date(ref.getFullYear(),ref.getMonth(),ref.getDate());
    if(dayMs(s0)>dayMs(e0)){ const t=s0;s0=e0;e0=t; }
    s=s0; e=e0;
    label=(s.getMonth()+1)+'/'+s.getDate()+'〜'+(e.getMonth()+1)+'/'+e.getDate();
    ctrlHtml=`${ymdSelect('revStart',S.revStart,'')} 〜 ${ymdSelect('revEnd',S.revEnd,'')}`;
  } else {
    const pm=S.revMonth||defMonth;
    const py=+pm.split('-')[0], pmn=+pm.split('-')[1];
    s=new Date(py,pmn-1,1);
    const isCur=(py===ref.getFullYear()&&pmn-1===ref.getMonth());
    e=isCur?new Date(ref.getFullYear(),ref.getMonth(),ref.getDate()):new Date(py,pmn,0);
    label=py+'年 '+pmn+'月';
    ctrlHtml=ymSelect('revMonth', py, pmn-1);
  }
  const a=dayMs(s), b=dayMs(e);

  let h=`<div class="ctrl-bar no-print">
    <div class="seg">${[['week','週'],['month','月'],['year','年間'],['custom','期間指定']].map(([k,l])=>`<button class="${P===k?'on':''}" onclick="App.set('revPeriod','${k}')">${l}</button>`).join('')}</div>
    ${ctrlHtml}
    <span class="period-label">口コミ（${label}）</span></div>`+storeSegHtml();

  // 親店舗＋ぶら下がる別名店舗（口コミデータに存在するもののみ）を対象にする
  const revStores=new Set(D.review.map(r=>r.store));
  const targets=[];
  baseStores.forEach(nm=>{ reviewNamesFor(nm).forEach(rn=>{ if((rn===nm||revStores.has(rn))&&!targets.includes(rn)) targets.push(rn); }); });
  const parentTag=(nm)=>parentOfStore(nm)?` <span class="mut" style="font-size:11px">（${esc(parentOfStore(nm))}）</span>`:'';
  const snapAt=(nm,limit)=>{ let latest=null; for(const r of D.review){ if(r.store!==nm)continue; if(r.t>limit)continue; if(!latest||r.t>latest.t)latest=r; } return latest; };

  // 期間に応じたバケット（45日以内=日別 / それ以上・年間=月別）
  const span=Math.round((b-a)/86400000)+1;
  const buckets=[];
  if(P==='year'||span>45){
    let m=new Date(s.getFullYear(),s.getMonth(),1);
    while(dayMs(m)<=b){ buckets.push({label:(m.getMonth()+1)+'月', end:Math.min(dayMs(new Date(m.getFullYear(),m.getMonth()+1,0)),b), start:Math.max(dayMs(m),a)}); m=new Date(m.getFullYear(),m.getMonth()+1,1); }
  } else {
    for(let d=new Date(s); dayMs(d)<=b; d=addD(d,1)) buckets.push({label:(d.getMonth()+1)+'/'+d.getDate(), end:dayMs(d), start:dayMs(d)});
  }

  if(D.review.length){
    const series=targets.map((nm,i)=>({ name:nm, color:PALETTE[i%PALETTE.length], data:buckets.map(bk=>{ const sn=snapAt(nm,bk.end); return sn?sn.star:null; }) }));
    const legend=series.map(s2=>`<span><span class="sw" style="background:${s2.color}"></span>${esc(s2.name)}</span>`).join('');
    const _kids=selName?childrenOfStore(selName):[];
    const subNote=(_kids.length)?`各時点の最新スナップショット ／ ${esc(selName)}に紐づく店舗（${_kids.map(esc).join('・')}）も表示`:'各時点の最新スナップショット';
    h+=`<div class="panel"><div class="panel-head"><div><h3>Google口コミ 平均星 推移（${esc(label)}）</h3><div class="sub">${subNote}</div></div><div class="legend">${legend}</div></div>
    ${lineChart(buckets.map(bk=>bk.label),series,'star',{zoom:true,axisFmt:(v)=>v.toFixed(2)})}</div>`;

    // 期間サマリー表
    h+=`<div class="panel"><div class="panel-head"><div><h3>口コミサマリー（${esc(label)}）</h3><div class="sub">平均星と件数は期間末時点、増加は期間内の増減</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>平均星（期間末）</th><th>星の変化（期間）</th><th>累計件数</th><th>期間内 増加</th><th>最終取得日</th></tr></thead><tbody>`;
    const expR=[];
    targets.forEach(nm=>{
      const endSnap=snapAt(nm,b)||snapAt(nm,Infinity);
      const preSnap=snapAt(nm,a-1);
      if(!endSnap){ h+=`<tr><td>${esc(nm)}${parentTag(nm)}</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td></tr>`; return; }
      let inc=null;
      if(preSnap) inc=endSnap.count-preSnap.count;
      else { inc=0; for(const r of D.review){ if(r.store===nm&&r.t>=a&&r.t<=b) inc+=r.delta||0; } }
      const starDiff=preSnap?(endSnap.star-preSnap.star):null;
      const dt=new Date(endSnap.t);
      h+=`<tr><td>${esc(nm)}${parentTag(nm)}</td><td>${endSnap.star.toFixed(2)}</td>
        <td class="${starDiff>0?'pos':starDiff<0?'neg':'mut'}">${starDiff==null?'—':(starDiff>=0?'+':'')+starDiff.toFixed(2)}</td>
        <td>${cnt(endSnap.count)}件</td><td class="${inc>0?'pos':'mut'}">${inc>0?'+'+inc:(inc===0?'—':inc)}</td>
        <td class="mut">${dt.getFullYear()}/${mdwH(dt)}</td></tr>`;
      expR.push([nm,endSnap.star.toFixed(2),starDiff==null?'':starDiff.toFixed(2),endSnap.count,inc==null?'':inc,dt.getFullYear()+'/'+(dt.getMonth()+1)+'/'+dt.getDate()]);
    });
    h+=`</tbody></table></div></div>`;
    EXPORT.push({ title:'口コミサマリー（'+label+'）', headers:['店舗','平均星(期間末)','星の変化','累計件数','期間内増加','最終取得日'], rows:expR });
  }

  // ---- ダイニー来店アンケート（また来たいと思いますか？） ----
  if(D.dinii.length){
    // 期間内平均の高い順にランキング（回答なしは最後）
    const ranked=(selName?[selName]:sc).map(nm=>({nm, tot:diniiStats([nm],a,b)}))
      .sort((x,y)=>{ const ax=x.tot.count>0?x.tot.avg:-1, ay=y.tot.count>0?y.tot.avg:-1; return ay-ax || y.tot.count-x.tot.count; });
    const baseTargets=ranked.map(r2=>r2.nm);
    const multi=baseTargets.length>1;
    const rankTag=(i)=>multi?`<span class="mut" style="font-size:10.5px;margin-right:6px">${i+1}位</span>`:'';
    const monthly=(P==='year'||span>45);   // 年間・長い期間指定 → 月ごとの点数推移マトリクス
    if(monthly){
      h+=`<div class="panel"><div class="panel-head"><div><h3>ダイニー「また来たいと思いますか？」月別推移（${esc(label)}）</h3>
        <div class="sub">各月の回答平均（下段は回答数）／ 来店日時ベース${multi?' ／ 期間平均の高い順':''}</div></div></div>
      <div class="scroll-x"><table class="tbl"><thead><tr>${multi?'<th>順位</th>':''}<th>店舗</th>${buckets.map(bk=>`<th>${esc(bk.label)}</th>`).join('')}<th>期間計</th></tr></thead><tbody>`;
      const expDn=[];
      ranked.forEach((r2,i)=>{
        const nm=r2.nm, tot=r2.tot;
        const cells=buckets.map(bk=>diniiStats([nm],bk.start,bk.end));
        h+=`<tr>${multi?`<td style="font-weight:700">${i+1}</td>`:''}<td>${esc(nm)}</td>${cells.map(c2=>`<td>${c2.count>0?c2.avg.toFixed(2)+'<br><span class="mut" style="font-size:10px">'+cnt(c2.count)+'件</span>':'<span class="mut">—</span>'}</td>`).join('')}
          <td style="font-weight:700">${tot.count>0?tot.avg.toFixed(2)+'<br><span class="mut" style="font-size:10px;font-weight:400">'+cnt(tot.count)+'件</span>':'—'}</td></tr>`;
        expDn.push([multi?i+1:'',nm].concat(cells.map(c2=>c2.count>0?c2.avg.toFixed(2)+'('+c2.count+'件)':'')).concat([tot.count>0?tot.avg.toFixed(2)+'('+tot.count+'件)':'']));
      });
      if(multi){
        const tCells=buckets.map(bk=>diniiStats(baseTargets,bk.start,bk.end));
        const tTot=diniiStats(baseTargets,a,b);
        h+=`<tr class="total"><td></td><td>${sc.length===allStores().length?'全店平均':'担当店舗平均'}</td>
          ${tCells.map(c2=>`<td>${c2.count>0?c2.avg.toFixed(2)+'<br><span class="mut" style="font-size:10px;font-weight:400">'+cnt(c2.count)+'件</span>':'—'}</td>`).join('')}
          <td>${tTot.count>0?tTot.avg.toFixed(2)+'<br><span class="mut" style="font-size:10px;font-weight:400">'+cnt(tTot.count)+'件</span>':'—'}</td></tr>`;
        expDn.push(['','全体'].concat(tCells.map(c2=>c2.count>0?c2.avg.toFixed(2)+'('+c2.count+'件)':'')).concat([tTot.count>0?tTot.avg.toFixed(2)+'('+tTot.count+'件)':'']));
      }
      h+=`</tbody></table></div></div>`;
      EXPORT.push({ title:'ダイニー月別推移（'+label+'）', headers:['順位','店舗'].concat(buckets.map(bk=>bk.label)).concat(['期間計']), rows:expDn });
    } else {
      h+=`<div class="panel"><div class="panel-head"><div><h3>ダイニー来店アンケート「また来たいと思いますか？」（${esc(label)}）</h3>
        <div class="sub">期間内の回答点数を店舗ごとに平均（来店日時ベース・全${cnt(D.dinii.length)}件）${multi?' ／ 期間平均の高い順':''}</div></div></div>
      <div class="scroll-x"><table class="tbl"><thead><tr>${multi?'<th>順位</th>':''}<th>店舗</th><th>期間内 平均</th><th>期間内 回答数</th><th>累計 平均</th><th>累計 回答数</th></tr></thead><tbody>`;
      const expDn=[]; let tSP=0,tNP=0,tSA=0,tNA=0;
      ranked.forEach((r2,i)=>{
        const nm=r2.nm, sp=r2.tot;
        const sAll=diniiStats([nm],0,Infinity);
        tSP+=(sp.avg||0)*sp.count; tNP+=sp.count; tSA+=(sAll.avg||0)*sAll.count; tNA+=sAll.count;
        h+=`<tr>${multi?`<td style="font-weight:700">${i+1}</td>`:''}<td>${esc(nm)}</td><td>${sp.avg!=null?sp.avg.toFixed(2):'—'}</td><td>${cnt(sp.count)}件</td>
          <td>${sAll.avg!=null?sAll.avg.toFixed(2):'—'}</td><td>${cnt(sAll.count)}件</td></tr>`;
        expDn.push([multi?i+1:'',nm,sp.avg!=null?sp.avg.toFixed(2):'',sp.count,sAll.avg!=null?sAll.avg.toFixed(2):'',sAll.count]);
      });
      if(multi){
        h+=`<tr class="total"><td></td><td>${sc.length===allStores().length?'全店平均':'担当店舗平均'}</td>
          <td>${tNP>0?(tSP/tNP).toFixed(2):'—'}</td><td>${cnt(tNP)}件</td>
          <td>${tNA>0?(tSA/tNA).toFixed(2):'—'}</td><td>${cnt(tNA)}件</td></tr>`;
      }
      h+=`</tbody></table></div></div>`;
      EXPORT.push({ title:'ダイニー来店アンケート（'+label+'）', headers:['順位','店舗','期間内平均','期間内回答数','累計平均','累計回答数'], rows:expDn });
    }
    // 期間内の推移（回答に日付がある場合のみ・口コミと同じバケット）
    if(D.dinii.some(r2=>r2.t>0)){
      const dseries=baseTargets.map((nm,i)=>({ name:nm, color:PALETTE[i%PALETTE.length],
        data:buckets.map(bk=>{ const st=diniiStats([nm],bk.start,bk.end); return st.avg; }) }));
      const dlegend=dseries.map(s2=>`<span><span class="sw" style="background:${s2.color}"></span>${esc(s2.name)}</span>`).join('');
      h+=`<div class="panel"><div class="panel-head"><div><h3>ダイニー「また来たい」推移（${esc(label)}）</h3><div class="sub">${P==='year'||span>45?'各月':'各日'}の回答平均</div></div><div class="legend">${dlegend}</div></div>
      ${lineChart(buckets.map(bk=>bk.label),dseries,'star',{zoom:true,axisFmt:(v)=>v.toFixed(2)})}</div>`;
    }
    // ダイニーアンケートの回答一覧（期間内・新しい順）。設問（自由記述・カテゴリ）を横に全部展開。
    const rc2={};
    const cmts=D.dinii.filter(r2=>{
      if(!r2.ans||!Object.keys(r2.ans).length) return false;   // 何か回答のある行だけ
      if(r2.t>0&&(r2.t<a||r2.t>b)) return false;
      const res=(r2.store in rc2)?rc2[r2.store]:(rc2[r2.store]=resolveStoreEx(r2.store));
      const p2=res?res.parent:r2.store;
      return baseTargets.includes(p2);
    }).sort((x2,y2)=>y2.t-x2.t);
    if(cmts.length){
      const LIMIT=80;
      const shown=cmts.slice(0,LIMIT);
      // 期間内で1件でも回答のある設問列だけを表示（空の設問列は出さない）
      const cols=(D.diniiCols||[]).filter(q=>shown.some(r2=>r2.ans&&r2.ans[q.name]));
      h+=`<div class="panel"><div class="panel-head"><div><h3>ダイニーアンケート 回答一覧（${esc(label)}）</h3>
        <div class="sub">回答のあった ${cnt(cmts.length)}件${cmts.length>LIMIT?'（新しい順に'+LIMIT+'件表示）':''} ／ 設問${cols.length}項目を横に展開（右にスクロール）</div></div></div>
      <div class="scroll-x"><table class="tbl dinii-ans freeze2"><thead><tr>
        <th>来店日</th><th>店舗</th><th>再来店</th>${cols.map(q=>`<th>${esc(q.name)}</th>`).join('')}
      </tr></thead><tbody>`;
      const expCm=[];
      shown.forEach(r2=>{
        const dt2=r2.t>0?new Date(r2.t):null;
        const scoreCls=r2.score>=80?'pos':r2.score<50?'neg':'';
        h+=`<tr><td style="white-space:nowrap">${dt2?mdwH(dt2):'<span class="mut">—</span>'}</td><td style="white-space:nowrap">${esc(r2.store)}</td>
          <td class="${scoreCls}" style="font-weight:700">${r2.score}</td>
          ${cols.map(q=>{ const v=r2.ans[q.name]||''; return `<td class="ans-cell">${v?esc(v):'<span class="mut">—</span>'}</td>`; }).join('')}</tr>`;
        expCm.push([dt2?mdw(dt2):'',r2.store,r2.score].concat(cols.map(q=>r2.ans[q.name]||'')));
      });
      h+=`</tbody></table></div></div>`;
      EXPORT.push({ title:'ダイニー回答一覧（'+label+'）', headers:['来店日','店舗','再来店点数'].concat(cols.map(q=>q.name)), rows:expCm });
    }
  }
  return h;
}

/* ---------------- 日報/週報/月報カード（Lark配信用・1枚画像レイアウト） ---------------- */
// 対象期間のレポートデータを生成（店舗別・売上降順）
// 単店舗レポート用：期間の推移（10日以内は日次、それ以上は7日バケットで前年同曜日区間と比較）
function reportTrend(store, s, e){
  const days=Math.round((dayMs(e)-dayMs(s))/86400000)+1;
  const chunkLen=days<=10?1:7;
  const pts=[]; let cur=new Date(s);
  while(dayMs(cur)<=dayMs(e)){
    const chunkEnd=new Date(Math.min(dayMs(addD(cur,chunkLen-1)),dayMs(e)));
    const c=stat(null,dayMs(cur),dayMs(chunkEnd),store);
    const p=stat(null,dayMs(addD(cur,-364)),dayMs(addD(chunkEnd,-364)),store);
    const oneDay=dayMs(cur)===dayMs(chunkEnd);
    const label=oneDay?(cur.getMonth()+1)+'/'+cur.getDate():(cur.getMonth()+1)+'/'+cur.getDate()+'〜'+(chunkEnd.getMonth()+1)+'/'+chunkEnd.getDate();
    pts.push({ label, sales:c.sales, prevSales:p.sales });
    cur=addD(chunkEnd,1);
  }
  return pts;
}
// 単店舗レポート用：口コミの星・累計件数のスナップショット（別名店舗があれば加重平均で合算）
function reviewStatsAt(store, limit){
  let ws=0, cs=0, latestT=0;
  reviewNamesFor(store).forEach(rn=>{
    let latest=null;
    for(const r of D.review){ if(r.store!==rn) continue; if(limit!=null&&r.t>limit) continue; if(!latest||r.t>latest.t) latest=r; }
    if(latest&&latest.count>0){ ws+=latest.star*latest.count; cs+=latest.count; if(latest.t>latestT) latestT=latest.t; }
  });
  return cs>0?{ star:ws/cs, count:cs, t:latestT }:null;
}
function reportData(kind, dateStr, storeFilter, group){
  const ref0=D.refDate||new Date();
  const pI=(s2)=>{const p2=String(s2).split('-');return new Date(+p2[0],+p2[1]-1,+p2[2]);};
  const ref=dateStr?pI(dateStr):new Date(ref0.getFullYear(),ref0.getMonth(),ref0.getDate());
  // 店舗フィルタ（配信先グループごとに対象店舗を絞れる）。表記ゆれはresolveStoreで吸収
  let stores=allStores();
  if(storeFilter&&storeFilter.length){
    const wanted=new Set(storeFilter.map(n=>resolveStore(String(n).trim())||String(n).trim()));
    const filtered=stores.filter(n=>wanted.has(n));
    if(filtered.length) stores=filtered;
  }
  const isFiltered=stores.length!==allStores().length;
  let s,e,ps,pe,title,sub;
  if(kind==='weekly'){
    // 月内ブロック週（1-7 / 8-14 / 15-21 / 22-28 / 29-末）のうち
    // ref時点で「直近に完了した週」を対象にする（8日→1-7, 15日→8-14 … 1日→前月末週）
    let wy=ref.getFullYear(), wm=ref.getMonth();
    const d=ref.getDate();
    const ends=[7,14,21,28,new Date(wy,wm+1,0).getDate()];   // 月内各ブロックの末日
    const done=ends.filter(x=>x<=d);                          // 完了済みブロックの末日
    let bs,be;
    if(done.length){
      be=done[done.length-1];
      bs=(be>=29)?29:{7:1,14:8,21:15,28:22}[be];
    } else {
      // 今月はまだ1週も完了していない（d<7）→ 前月の最終ブロック
      const pm=new Date(wy,wm,0); wy=pm.getFullYear(); wm=pm.getMonth();
      const pld=pm.getDate(); bs=(pld>=29)?29:22; be=pld;
    }
    s=new Date(wy,wm,bs); e=new Date(wy,wm,be);
    ps=sub1y(s); pe=sub1y(e);
    const wk={1:1,8:2,15:3,22:4,29:5}[bs]||5;
    title='週報'; sub=wy+'年'+(wm+1)+'月 第'+wk+'週（'+(wm+1)+'/'+bs+'〜'+(wm+1)+'/'+be+'）';
  } else if(kind==='monthly'){
    // ref時点で「直近に完了した月」を対象（当月がまだ途中なら前月＝月初に走らせても前月分になる）
    let ty=ref.getFullYear(), tm=ref.getMonth();
    const lastDay=new Date(ty,tm+1,0).getDate();
    if(ref.getDate()<lastDay){ const pm=new Date(ty,tm,0); ty=pm.getFullYear(); tm=pm.getMonth(); }
    s=new Date(ty,tm,1); e=new Date(ty,tm+1,0);
    ps=sub1y(s); pe=sub1y(e);
    title='月報'; sub=ty+'年'+(tm+1)+'月度（'+(tm+1)+'/1〜'+(tm+1)+'/'+e.getDate()+'）';
  } else {
    s=ref; e=ref;
    ps=addD(ref,-364); pe=ps;                       // 前年同曜日
    title='日報'; sub=ref.getFullYear()+'年'+(ref.getMonth()+1)+'月'+ref.getDate()+'日（'+WD[ref.getDay()]+'）';
  }
  const a=dayMs(s), b=dayMs(e), pa=dayMs(ps), pb=dayMs(pe);
  // 月間累計（期間末日まで）
  const mcS=new Date(e.getFullYear(),e.getMonth(),1);
  // ダイニー点数の集計範囲：日報＝その月の頭〜当日 ／ 週報・月報＝その期間内
  const dnS=(kind==='daily')?dayMs(mcS):a, dnE=b;
  const hasDinii=D.dinii.length>0;
  const rows=stores.map(nm=>{
    const c=stat(null,a,b,nm), pv=stat(null,pa,pb,nm);
    const cum=stat(null,dayMs(mcS),b,nm), cumPv=stat(null,dayMs(sub1y(mcS)),dayMs(sub1y(e)),nm);
    const dn=hasDinii?diniiStats([nm],dnS,dnE):{avg:null,count:0};
    return { store:nm, sales:c.sales, prevSales:pv.sales, guests:c.guests,
      spend:c.guests>0?c.sales/c.guests:0, cost:c.cost, labor:c.labor,
      fr:c.sales>0?c.cost/c.sales:null, lr:c.sales>0?c.labor/c.sales:null,
      fl:c.sales>0?(c.cost+c.labor)/c.sales:null, dinii:dn.avg, diniiCount:dn.count,
      cum:cum.sales, cumPrev:cumPv.sales };
  }).sort((x,y)=>y.sales-x.sales);
  const tot=rows.reduce((o,r)=>{o.sales+=r.sales;o.prevSales+=r.prevSales;o.guests+=r.guests;o.cost+=r.cost;o.labor+=r.labor;o.cum+=r.cum;o.cumPrev+=r.cumPrev;return o;},
    {sales:0,prevSales:0,guests:0,cost:0,labor:0,cum:0,cumPrev:0});
  tot.fl=tot.sales>0?(tot.cost+tot.labor)/tot.sales:null;
  tot.fr=tot.sales>0?tot.cost/tot.sales:null;
  tot.lr=tot.sales>0?tot.labor/tot.sales:null;
  const dnTot=hasDinii?diniiStats(stores,dnS,dnE):{avg:null,count:0};
  tot.dinii=dnTot.avg; tot.diniiCount=dnTot.count;
  const diniiRangeLabel=(kind==='daily')?(e.getMonth()+1)+'月（1日〜'+e.getDate()+'日）':'期間内';
  const salesLabel=kind==='monthly'?'月売上':kind==='weekly'?'週売上':'売上';
  const pad=(n)=>String(n).padStart(2,'0');
  const grp=String(group||'').replace(/[^a-zA-Z0-9_-]/g,'');
  const fileKey=kind+'-'+e.getFullYear()+pad(e.getMonth()+1)+pad(e.getDate())+(grp?'-'+grp:'');   // 例 daily-20260707-tori
  const singleStore=stores.length===1?stores[0]:null;
  if(isFiltered&&!singleStore) sub+='（'+stores.length+'店舗）';
  // 単店舗のときは店舗比較の代わりにランチ/ディナー内訳・媒体別売上・直近推移・累計F/L率・口コミ増加を付ける
  let seg=null, trend=null, cumRate=null, review=null, media=null;
  if(singleStore){
    const s1=segSplit(null,a,b,singleStore), s0=segSplit(null,pa,pb,singleStore);
    seg={ ln:s1.ln, dn:s1.dn, lg:s1.lg, dg:s1.dg, hasNet:s1.hasNet, hasG:s1.hasG,
      prevLn:s0.ln, prevDn:s0.dn, prevLg:s0.lg, prevDg:s0.dg };
    trend=reportTrend(singleStore, kind==='daily'?addD(e,-6):s, e);
    // 累計F率・L率（月間累計＝月初〜期間末日、月報のときは期間そのものと同じなので出さない）
    const cumStat=stat(null,dayMs(mcS),b,singleStore);
    cumRate={ fr:cumStat.sales>0?cumStat.cost/cumStat.sales:null, lr:cumStat.sales>0?cumStat.labor/cumStat.sales:null,
      fl:cumStat.sales>0?(cumStat.cost+cumStat.labor)/cumStat.sales:null };
    // Google口コミ：現在の星・累計件数と、レポート期間内の増加件数
    const revEnd=reviewStatsAt(singleStore,b), revStart=reviewStatsAt(singleStore,dayMs(addD(s,-1)));
    if(revEnd) review={ star:revEnd.star, count:revEnd.count, inc:revStart?(revEnd.count-revStart.count):null };
    // 媒体別売上（正規化した媒体名で集計・売上降順）
    const mediaAgg={};
    for(const r of D.media){
      if(r.store!==singleStore||r.t<a||r.t>b) continue;
      const key=canonMedia(r.media)||'(不明)';
      if(!mediaAgg[key]) mediaAgg[key]={ media:key, sales:0, guests:0 };
      mediaAgg[key].sales+=r.net; mediaAgg[key].guests+=r.guests;
    }
    media=Object.values(mediaAgg).filter(x=>x.sales>0||x.guests>0).sort((x,y)=>y.sales-x.sales);
  }
  const data={ kind, title, sub, salesLabel, fileKey, rows, tot, hasDinii, diniiRangeLabel, isFiltered, singleStore, seg, trend, cumRate, review, media,
    gen:new Date().toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) };
  try{ window.__REPORT_JSON=data; }catch(err){}
  return data;
}
function viewReport(kind, dateStr, storeFilter, group){
  if(!D.daily.length) return `<div style="padding:60px;text-align:center;color:#8c8375;font-size:15px" id="report-loading">データ読込中…</div>`;
  const d=reportData(kind||'daily', dateStr, storeFilter, group);
  const yoy=(c,p)=>{ if(!(p>0)) return {t:'—',cls:''}; const v=(c-p)/p*100; return {t:(v>=0?'+':'▲')+Math.abs(v).toFixed(1)+'%', cls:v>=0?'#4c7d5c':'#b5502f'}; };
  const totYoy=yoy(d.tot.sales,d.tot.prevSales), cumYoy=yoy(d.tot.cum,d.tot.cumPrev);
  const spend=d.tot.guests>0?d.tot.sales/d.tot.guests:0;
  const fl=d.tot.sales>0?((d.tot.cost+d.tot.labor)/d.tot.sales*100).toFixed(1)+'%':'—';
  const showFl=(kind!=='daily'||d.tot.cost>0||d.tot.labor>0);
  const salesLabel=kind==='monthly'?'月売上':kind==='weekly'?'週売上':'売上';
  // 単店舗：店舗比較チャートの代わりに直近推移チャート／全店・複数店舗：店舗別バーチャート（売上降順）
  let chart='', chartLabel='';
  if(d.singleStore&&d.trend&&d.trend.length){
    chart=barChart(d.trend.map(p=>p.label),
      [{name:'当期',color:'#3d5163',data:d.trend.map(p=>p.sales)},{name:'前年',color:'#c9b7a0',data:d.trend.map(p=>p.prevSales)}]);
    chartLabel=(kind==='monthly'?'週別 推移':'直近の推移')+'（■当期 ■前年）';
  } else {
    const chartRows=d.rows.filter(r=>r.sales>0||r.prevSales>0);
    chart=chartRows.length?barChart(chartRows.map(r=>r.store.replace(/[\s　]/,'\n')),
      [{name:'当期',color:'#3d5163',data:chartRows.map(r=>r.sales)},{name:'前年',color:'#c9b7a0',data:chartRows.map(r=>r.prevSales)}],{twoLine:true}):'';
    chartLabel='店舗別 '+salesLabel+'（■当期 ■前年）';
  }
  const brandLine=d.singleStore?esc(d.singleStore):'鳥一代グループ';
  let h=`<div id="report-card" style="width:1080px;margin:0 auto;background:#faf9f5;border:1px solid #e5ddcc;font-family:'Zen Kaku Gothic New',sans-serif;color:#3d3a33">
    <div style="background:#2a2420;padding:22px 32px;display:flex;align-items:center;gap:16px">
      <div style="width:44px;height:44px;border-radius:10px;background:#3a332c;display:flex;align-items:center;justify-content:center;font-family:'Shippori Mincho',serif;font-size:24px;color:#c9a86a">鳥</div>
      <div><div style="font-family:'Shippori Mincho',serif;font-size:21px;color:#f3ede1;letter-spacing:.1em">${brandLine} ${esc(d.title)}</div>
      <div style="font-size:13px;color:#9a8f7c;margin-top:3px">${esc(d.sub)}</div></div>
      <div style="margin-left:auto;font-size:11px;color:#9a8f7c">自動生成 ${esc(d.gen)}</div>
    </div>
    ${(()=>{
      const pctTxt=(v)=>v!=null?(v*100).toFixed(1)+'%':'—';
      const dnTxt=d.tot.dinii!=null?d.tot.dinii.toFixed(2):'—';
      const cards=[
        [(d.singleStore?'':'全店')+salesLabel,yen(d.tot.sales),'前年比 '+totYoy.t,totYoy.cls],
        ['客数',cnt(d.tot.guests)+'人','客単価 '+yen(spend),''],
        ['F率（原価）',pctTxt(d.tot.fr),'FL計 '+pctTxt(d.tot.fl),''],
        ['L率（人件費）',pctTxt(d.tot.lr),'FL計 '+pctTxt(d.tot.fl),''],
      ];
      if(d.hasDinii) cards.push(['ダイニー再来店',dnTxt,d.diniiRangeLabel+'・'+cnt(d.tot.diniiCount)+'件','']);
      cards.push([(kind==='monthly'?'年間累計':'累計売上（月間）'),yen(kind==='monthly'?d.tot.sales:d.tot.cum),'前年比 '+(kind==='monthly'?totYoy.t:cumYoy.t),(kind==='monthly'?totYoy.cls:cumYoy.cls)]);
      if(d.singleStore&&d.cumRate&&kind!=='monthly'){
        cards.push(['累計F率（月間）',pctTxt(d.cumRate.fr),'FL計 '+pctTxt(d.cumRate.fl),'']);
        cards.push(['累計L率（月間）',pctTxt(d.cumRate.lr),'FL計 '+pctTxt(d.cumRate.fl),'']);
      }
      if(d.singleStore&&d.review){
        const incTxt=d.review.inc==null?'—':(d.review.inc>=0?'+':'')+d.review.inc+'件';
        const periodLb=kind==='monthly'?'今月':kind==='weekly'?'今週':'本日';
        cards.push(['Google口コミ','★'+d.review.star.toFixed(2)+'（'+cnt(d.review.count)+'件）',periodLb+' '+incTxt,d.review.inc>0?'#4c7d5c':'']);
      }
      const cardCols=d.singleStore?Math.min(cards.length,4):cards.length;
      return `<div style="display:grid;grid-template-columns:repeat(${cardCols},1fr);gap:10px;padding:20px 32px 4px">`+
        cards.map(k=>`<div style="background:#fff;border:1px solid #efe9dd;border-radius:12px;padding:13px 14px">
          <div style="font-size:11.5px;color:#8c8375">${esc(k[0])}</div>
          <div style="font-size:21px;font-weight:700;margin:4px 0 2px">${k[1]}</div>
          <div style="font-size:11px;color:${k[3]||'#a99f8c'}">${k[2]}</div></div>`).join('')+`</div>`;
    })()}
    <div style="padding:14px 32px 0">${chart?`<div style="background:#fff;border:1px solid #efe9dd;border-radius:12px;padding:14px 16px 6px">
      <div style="font-size:12.5px;color:#8c8375;margin-bottom:6px">${esc(chartLabel)}</div>${chart}</div>`:''}</div>`;
  if(d.singleStore){
    const sg=d.seg||{ln:0,dn:0,lg:0,dg:0,hasNet:false,hasG:false,prevLn:0,prevDn:0,prevLg:0,prevDg:0};
    const segRows=(sg.hasNet||sg.hasG)?[['🌤 ランチ',sg.ln,sg.prevLn,sg.lg],['🌙 ディナー',sg.dn,sg.prevDn,sg.dg]]:[];
    h+=`<div style="padding:14px 32px 20px">`;
    if(segRows.length){
      h+=`<div style="font-size:12.5px;color:#8c8375;margin-bottom:6px">ランチ/ディナー内訳</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #efe9dd;border-radius:12px;overflow:hidden">
        <thead><tr style="background:#efe9dd">
          <th style="text-align:left;padding:9px 12px;font-size:11.5px;color:#5c5348">区分</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">売上</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">前年比</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">客数</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">客単価</th>
        </tr></thead><tbody>`;
      let tS=0,tP=0,tG=0;
      segRows.forEach(([label,sales,prev,guests],i)=>{
        const ry=yoy(sales,prev), sp=guests>0?sales/guests:0;
        tS+=sales; tP+=prev; tG+=guests;
        h+=`<tr style="border-top:1px solid #efe9dd${i%2?';background:#fbf9f4':''}">
          <td style="padding:8px 12px;font-size:13px;font-weight:500">${label}</td>
          <td style="padding:8px 12px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">${yen(sales)}</td>
          <td style="padding:8px 12px;font-size:12.5px;text-align:right;color:${ry.cls||'#a99f8c'}">${ry.t}</td>
          <td style="padding:8px 12px;font-size:13px;text-align:right">${cnt(guests)}人</td>
          <td style="padding:8px 12px;font-size:13px;text-align:right">${yen(sp)}</td>
        </tr>`;
      });
      const tYoy=yoy(tS,tP), tSp=tG>0?tS/tG:0;
      h+=`<tr style="border-top:2px solid #d8cfbd;background:#efe9dd;font-weight:700">
          <td style="padding:9px 12px;font-size:13px">合計</td>
          <td style="padding:9px 12px;font-size:13px;text-align:right">${yen(tS)}</td>
          <td style="padding:9px 12px;font-size:12.5px;text-align:right;color:${tYoy.cls||'#5c5348'}">${tYoy.t}</td>
          <td style="padding:9px 12px;font-size:13px;text-align:right">${cnt(tG)}人</td>
          <td style="padding:9px 12px;font-size:13px;text-align:right">${yen(tSp)}</td>
        </tr></tbody></table>`;
    } else {
      h+=`<div style="padding:24px;text-align:center;color:#a99f8c;font-size:12.5px;background:#fff;border:1px solid #efe9dd;border-radius:12px">媒体別売上データが未登録のため、ランチ/ディナー内訳は表示できません</div>`;
    }
    // 媒体別 売上（正規化した媒体名・売上降順・上位8＋その他）
    const mrows=d.media||[];
    if(mrows.length){
      const MAXM=8;
      const shown=mrows.slice(0,MAXM), rest=mrows.slice(MAXM);
      const mTot=mrows.reduce((s2,r)=>s2+r.sales,0);
      h+=`<div style="font-size:12.5px;color:#8c8375;margin:14px 0 6px">媒体別 売上${rest.length?'（上位'+MAXM+'・他'+rest.length+'媒体は「その他」に集約）':''}</div>
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #efe9dd;border-radius:12px;overflow:hidden">
        <thead><tr style="background:#efe9dd">
          <th style="text-align:left;padding:9px 12px;font-size:11.5px;color:#5c5348">媒体</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">売上</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">構成比</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">客数</th>
        </tr></thead><tbody>`;
      shown.forEach((r,i)=>{
        const pct=mTot>0?(r.sales/mTot*100).toFixed(1)+'%':'—';
        h+=`<tr style="border-top:1px solid #efe9dd${i%2?';background:#fbf9f4':''}">
          <td style="padding:8px 12px;font-size:13px;font-weight:500">${esc(r.media)}</td>
          <td style="padding:8px 12px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">${yen(r.sales)}</td>
          <td style="padding:8px 12px;font-size:12.5px;text-align:right;color:#8c8375">${pct}</td>
          <td style="padding:8px 12px;font-size:13px;text-align:right">${cnt(r.guests)}人</td>
        </tr>`;
      });
      if(rest.length){
        const restSales=rest.reduce((s2,r)=>s2+r.sales,0), restG=rest.reduce((s2,r)=>s2+r.guests,0);
        const pct=mTot>0?(restSales/mTot*100).toFixed(1)+'%':'—';
        h+=`<tr style="border-top:1px solid #efe9dd">
          <td style="padding:8px 12px;font-size:13px;color:#8c8375">その他（${rest.length}媒体）</td>
          <td style="padding:8px 12px;font-size:13px;text-align:right;color:#8c8375">${yen(restSales)}</td>
          <td style="padding:8px 12px;font-size:12.5px;text-align:right;color:#8c8375">${pct}</td>
          <td style="padding:8px 12px;font-size:13px;text-align:right;color:#8c8375">${cnt(restG)}人</td>
        </tr>`;
      }
      h+=`</tbody></table>`;
    } else {
      h+=`<div style="font-size:12.5px;color:#8c8375;margin:14px 0 6px">媒体別 売上</div>
      <div style="padding:24px;text-align:center;color:#a99f8c;font-size:12.5px;background:#fff;border:1px solid #efe9dd;border-radius:12px">媒体別売上データがありません</div>`;
    }
    h+=`<div style="font-size:11px;color:#a99f8c;margin-top:10px;text-align:right">${brandLine} ／ ${esc(d.gen)} 自動生成</div>
    </div></div>
    <div class="no-print" style="text-align:center;padding:14px"><button class="icon-btn" onclick="App.reportExit()">← ダッシュボードに戻る</button></div>`;
    return h;
  }
  h+=`<div style="padding:14px 32px 20px">
      <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #efe9dd;border-radius:12px;overflow:hidden">
        <thead><tr style="background:#efe9dd">
          <th style="text-align:left;padding:9px 12px;font-size:11.5px;color:#5c5348">店舗</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">${salesLabel}</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">前年比</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">F率</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">L率</th>
          ${d.hasDinii?`<th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">ダイニー</th>`:''}
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">客数</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">客単価</th>
          ${kind!=='monthly'?`<th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">月間累計</th>
          <th style="text-align:right;padding:9px 12px;font-size:11.5px;color:#5c5348">累計前年比</th>`:''}
        </tr></thead><tbody>`;
  const rateCell=(v)=>v==null?'<span style="color:#a99f8c">—</span>':(v*100).toFixed(1)+'%';
  const dnCell=(r)=>r.dinii==null?'<span style="color:#a99f8c">—</span>':`${r.dinii.toFixed(2)}<span style="color:#a99f8c;font-size:10px"> /${cnt(r.diniiCount)}</span>`;
  d.rows.forEach((r,i)=>{
    const ry=yoy(r.sales,r.prevSales);
    h+=`<tr style="border-top:1px solid #efe9dd${i%2?';background:#fbf9f4':''}">
      <td style="padding:8px 12px;font-size:13px;font-weight:500">${esc(r.store)}</td>
      <td style="padding:8px 12px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">${yen(r.sales)}</td>
      <td style="padding:8px 12px;font-size:12.5px;text-align:right;color:${ry.cls||'#a99f8c'}">${ry.t}</td>
      <td style="padding:8px 12px;font-size:13px;text-align:right">${rateCell(r.fr)}</td>
      <td style="padding:8px 12px;font-size:13px;text-align:right">${rateCell(r.lr)}</td>
      ${d.hasDinii?`<td style="padding:8px 12px;font-size:13px;text-align:right">${dnCell(r)}</td>`:''}
      <td style="padding:8px 12px;font-size:13px;text-align:right">${cnt(r.guests)}人</td>
      <td style="padding:8px 12px;font-size:13px;text-align:right">${yen(r.spend)}</td>
      ${kind!=='monthly'?`<td style="padding:8px 12px;font-size:13px;text-align:right">${yen(r.cum)}</td>
      <td style="padding:8px 12px;font-size:12.5px;text-align:right;color:${yoy(r.cum,r.cumPrev).cls||'#a99f8c'}">${yoy(r.cum,r.cumPrev).t}</td>`:''}
    </tr>`;
  });
  h+=`<tr style="border-top:2px solid #d8cfbd;background:#efe9dd;font-weight:700">
      <td style="padding:9px 12px;font-size:13px">全店合計</td>
      <td style="padding:9px 12px;font-size:13px;text-align:right">${yen(d.tot.sales)}</td>
      <td style="padding:9px 12px;font-size:12.5px;text-align:right;color:${totYoy.cls||'#5c5348'}">${totYoy.t}</td>
      <td style="padding:9px 12px;font-size:13px;text-align:right">${d.tot.fr!=null?(d.tot.fr*100).toFixed(1)+'%':'—'}</td>
      <td style="padding:9px 12px;font-size:13px;text-align:right">${d.tot.lr!=null?(d.tot.lr*100).toFixed(1)+'%':'—'}</td>
      ${d.hasDinii?`<td style="padding:9px 12px;font-size:13px;text-align:right">${d.tot.dinii!=null?d.tot.dinii.toFixed(2):'—'}<span style="font-weight:400;color:#8c8375;font-size:10px"> /${cnt(d.tot.diniiCount)}</span></td>`:''}
      <td style="padding:9px 12px;font-size:13px;text-align:right">${cnt(d.tot.guests)}人</td>
      <td style="padding:9px 12px;font-size:13px;text-align:right">${yen(spend)}</td>
      ${kind!=='monthly'?`<td style="padding:9px 12px;font-size:13px;text-align:right">${yen(d.tot.cum)}</td>
      <td style="padding:9px 12px;font-size:12.5px;text-align:right;color:${cumYoy.cls||'#5c5348'}">${cumYoy.t}</td>`:''}
    </tr></tbody></table>
    <div style="font-size:11px;color:#a99f8c;margin-top:10px;text-align:right">鳥一代グループ 経営ダッシュボード ／ ${esc(d.gen)} 自動生成</div>
    </div></div>
    <div class="no-print" style="text-align:center;padding:14px"><button class="icon-btn" onclick="App.reportExit()">← ダッシュボードに戻る</button></div>`;
  return h;
}

/* ---------------- AI検索 ---------------- */
// 質問文から店舗を推定（scope内のみ）
function detectStore(q, allowed){
  const norm=s=>String(s).replace(/[\s　]/g,'');
  const nq=norm(q);
  for(const nm of allowed){ if(nq.includes(norm(nm))) return nm; }       // 店名フル一致
  const tokenMap={};                                                     // 一意に定まるトークン
  allowed.forEach(nm=>{ nm.split(/[\s　]/).forEach(tok=>{ if(tok.length>=2){ (tokenMap[tok]=tokenMap[tok]||[]).push(nm); } }); });
  for(const tok in tokenMap){ if(tokenMap[tok].length===1 && nq.includes(tok)) return tokenMap[tok][0]; }
  return null;
}
// 質問文から期間を推定
function parsePeriod(q, ref){
  const y=ref.getFullYear(),mo=ref.getMonth(),da=ref.getDate();
  const mk=(s,e,label)=>({s,e,label});
  if(/去年|昨年|前年/.test(q)) return mk(new Date(y-1,0,1),new Date(y-1,11,31),(y-1)+'年');
  if(/今年|本年|年間|今期/.test(q)) return mk(new Date(y,0,1),new Date(y,mo,da),y+'年(累計)');
  if(/先月/.test(q)){ let m=mo-1,yy=y; if(m<0){m=11;yy=y-1;} return mk(new Date(yy,m,1),new Date(yy,m+1,0),(m+1)+'月'); }
  if(/今月/.test(q)) return mk(new Date(y,mo,1),new Date(y,mo,da),(mo+1)+'月');
  const mm=q.match(/(\d{1,2})\s*月/);
  if(mm){ const m=+mm[1]-1; const yy=(m>mo)?y-1:y; return mk(new Date(yy,m,1),new Date(yy,m+1,0),(m+1)+'月'); }
  if(/今週/.test(q)){ const idx=Math.min(4,Math.floor((da-1)/7)); const sd=idx*7+1, ld=new Date(y,mo+1,0).getDate(), ed=idx<4?Math.min(sd+6,ld):ld; return mk(new Date(y,mo,sd),new Date(y,mo,Math.min(ed,da)),(mo+1)+'月第'+(idx+1)+'週'); }
  if(/先週/.test(q)){ const idx=Math.min(4,Math.floor((da-1)/7)); let pi=idx-1,pm=mo,py=y; if(pi<0){pm=mo-1; if(pm<0){pm=11;py=y-1;} pi=Math.min(4,Math.floor((new Date(py,pm+1,0).getDate()-1)/7)); } const ld=new Date(py,pm+1,0).getDate(); const sd=pi*7+1, ed=pi<4?Math.min(sd+6,ld):ld; return mk(new Date(py,pm,sd),new Date(py,pm,ed),(pm+1)+'月第'+(pi+1)+'週'); }
  return mk(new Date(y,mo,1),new Date(y,mo,da),(mo+1)+'月');
}
function aiTrendChart(per, nameSet, media, metric){
  const span=Math.round((dayMs(per.e)-dayMs(per.s))/86400000)+1;
  const buckets=[];
  if(span<=45){ for(let d=new Date(per.s); dayMs(d)<=dayMs(per.e); d=addD(d,1)) buckets.push({label:(d.getMonth()+1)+'/'+d.getDate(),a:dayMs(d),b:dayMs(d)}); }
  else { let m=new Date(per.s.getFullYear(),per.s.getMonth(),1); while(dayMs(m)<=dayMs(per.e)){ const a2=Math.max(dayMs(m),dayMs(per.s)),b2=Math.min(dayMs(new Date(m.getFullYear(),m.getMonth()+1,0)),dayMs(per.e)); buckets.push({label:(m.getMonth()+1)+'月',a:a2,b:b2}); m=new Date(m.getFullYear(),m.getMonth()+1,1);} }
  const val=(a,b)=>{
    if(media){ let net=0,g=0; for(const r of D.media){ if(!nameSet.has(r.store)||r.media!==media)continue; if(r.t>=a&&r.t<=b){net+=r.net;g+=r.guests;} } return metric==='guests'?g:(metric==='spend'?(g>0?net/g:0):net); }
    let s=0,g=0; for(const r of D.daily){ if(!nameSet.has(r.store))continue; if(r.t>=a&&r.t<=b){s+=r.sales;g+=r.guests;} } return metric==='guests'?g:(metric==='spend'?(g>0?s/g:0):s);
  };
  const nm=metric==='guests'?'客数':metric==='spend'?'客単価':'売上';
  const series=[{name:nm,color:C_NOW,data:buckets.map(bk=>val(bk.a,bk.b))}];
  return lineChart(buckets.map(b=>b.label),series,metric==='guests'?'guests':'sales',{zoom:metric==='spend'});
}
function answerQuery(q){
  if(!q||!q.trim()) return { text:'質問を入力してください（例：鳥一代 本店 今年のランチの単価は？ 推移も）' };
  const allowed=scopeStores();
  const ref=D.refDate||new Date();
  const store=detectStore(q,allowed);
  const scopeNames=store?[store]:allowed;
  const nameSet=new Set(scopeNames);
  const per=parsePeriod(q,ref);
  const a=dayMs(per.s), b=dayMs(per.e), pa2=dayMs(sub1y(per.s)), pb2=dayMs(sub1y(per.e));
  const mediaNames=[...new Set(D.media.map(r=>r.media))];
  let media=null;
  for(const mn of mediaNames){ if(mn && q.includes(mn)){ media=mn; break; } }
  if(!media && /ランチ/.test(q)){ const f=mediaNames.find(m=>/ランチ/.test(m)); if(f) media=f; }
  if(!media && /ディナー|夜/.test(q)){ const f=mediaNames.find(m=>/ディナー/.test(m)); if(f) media=f; }
  const scopeLabel=store?store:(allowed.length===allStores().length?'全店':'担当店舗');
  const want=re=>re.test(q);
  const yy=(c,p)=>p>0?((c-p>=0?'前年比 +':'前年比 ▲')+Math.abs((c-p)/p*100).toFixed(1)+'%'):'前年比 —';
  const lines=[scopeLabel+' ／ '+per.label+(media?' 【'+media+'】':'')];

  // 口コミ
  if(want(/口コミ|評価|星/)){
    let ws=0,cs=0;
    scopeNames.forEach(nm=>{ reviewNamesFor(nm).forEach(rn=>{ let latest=null; for(const r of D.review){ if(r.store!==rn)continue; if(r.t>b)continue; if(!latest||r.t>latest.t)latest=r; } if(latest&&latest.count>0){ws+=latest.star*latest.count;cs+=latest.count;} }); });
    lines.push('　口コミ点数：'+(cs>0?(ws/cs).toFixed(2):'—')+'（Google加重平均）');
    lines.push('　口コミ件数：'+cnt(cs)+'件（累計）');
    return { text:lines.join('\n') };
  }

  // 媒体指定（ランチ単価など）
  if(media){
    let net=0,g=0,pnet=0,pg=0;
    for(const r of D.media){ if(!nameSet.has(r.store)||r.media!==media)continue; if(r.t>=a&&r.t<=b){net+=r.net;g+=r.guests;} if(r.t>=pa2&&r.t<=pb2){pnet+=r.net;pg+=r.guests;} }
    const sp=g>0?net/g:0, psp=pg>0?pnet/pg:0;
    if(want(/客数/)) lines.push('　客数：'+cnt(g)+'人（'+yy(g,pg)+'）');
    if(want(/単価/)) lines.push('　客単価：'+yen(sp)+'（'+yy(sp,psp)+'）');
    if(want(/売上/)||!want(/単価|客数/)) lines.push('　売上：'+yen(net)+'（'+yy(net,pnet)+'）');
    const metric=want(/単価/)?'spend':(want(/客数/)?'guests':'sales');
    return { text:lines.join('\n'), chart: want(/推移|グラフ/)?aiTrendChart(per,nameSet,media,metric):null };
  }

  // 財務（日別集計ベース）
  let o={sales:0,guests:0,cost:0,labor:0,cash:0}, po={sales:0,guests:0};
  for(const r of D.daily){ if(!nameSet.has(r.store))continue; if(r.t>=a&&r.t<=b){o.sales+=r.sales;o.guests+=r.guests;o.cost+=r.cost;o.labor+=r.labor;o.cash+=r.cash;} if(r.t>=pa2&&r.t<=pb2){po.sales+=r.sales;po.guests+=r.guests;} }
  const S2=o.sales, sp=o.guests>0?S2/o.guests:0, psp=po.guests>0?po.sales/po.guests:0;
  const pct=n=>S2>0?(n/S2*100).toFixed(1)+'%':'—';
  let hit=false, metric='sales';
  if(want(/売上/)){ lines.push('　売上：'+yen(S2)+'（'+yy(S2,po.sales)+'）'); hit=true; metric='sales'; }
  if(want(/客数/)){ lines.push('　客数：'+cnt(o.guests)+'人（'+yy(o.guests,po.guests)+'）'); hit=true; metric='guests'; }
  if(want(/単価/)){ lines.push('　客単価：'+yen(sp)+'（'+yy(sp,psp)+'）'); hit=true; metric='spend'; }
  if(want(/原価|仕入/)){ lines.push('　原価率：'+pct(o.cost)+'（仕入 '+yen(o.cost)+'）'); hit=true; }
  if(want(/人件費/)){ lines.push('　人件費率：'+pct(o.labor)); hit=true; }
  if(want(/FL/i)){ lines.push('　FL率：'+pct(o.cost+o.labor)); hit=true; }
  if(want(/利益/)){ lines.push('　利益(FL後)：'+yen(S2-o.cost-o.labor)+'（'+pct(S2-o.cost-o.labor)+'）'); hit=true; }
  if(want(/未入金|入金/)){ let dep=0; for(const r of D.deposit){ if(nameSet.has(r.store)&&r.t>=a&&r.t<=b)dep+=r.amount; } lines.push('　現金売上：'+yen(o.cash)+' ／ 入金：'+yen(dep)+' ／ 未入金：'+yen(o.cash-dep)); hit=true; }
  if(!hit){
    lines.push('　売上：'+yen(S2)+'（'+yy(S2,po.sales)+'）');
    lines.push('　客数：'+cnt(o.guests)+'人 ／ 客単価：'+yen(sp));
    lines.push('　原価率：'+pct(o.cost)+' ／ 人件費率：'+pct(o.labor)+' ／ FL：'+pct(o.cost+o.labor));
    lines.push('　利益(FL後)：'+yen(S2-o.cost-o.labor));
  }
  return { text:lines.join('\n'), chart: want(/推移|グラフ/)?aiTrendChart(per,nameSet,null,metric):null };
}
function viewAI(){
  const examples=[
    '鳥一代 本店 今年のランチの単価は？ 推移も',
    '全店 今月の売上と前年比',
    '黒霧屋 新横浜 先月のFLと利益',
    '鶏武者 川崎店 今年の客数の推移',
    '芝の鳥一代 6月の原価率と人件費率',
  ];
  const r=S.aiResult;
  let h=`<div class="panel"><div class="panel-head"><div><h3>AI検索</h3><div class="sub">ダッシュボード内のデータから、店舗・期間・媒体・指標を読み取って回答します（社内データのみで計算・外部送信なし）</div></div></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
    <input id="ai-q" type="text" value="${esc(S.aiQ||'')}" placeholder="例：鳥一代 本店 今年のランチの単価は？ 推移も" style="flex:1;min-width:260px;padding:11px 13px" onkeydown="if(event.key==='Enter')App.aiRun()">
    <button class="icon-btn primary" onclick="App.aiRun()">検索</button>
  </div>
  <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:4px">
    ${examples.map(e=>`<button onclick="App.aiFill(this.dataset.q)" data-q="${esc(e)}" style="padding:6px 12px;border-radius:999px;background:#fbf8f1;border:1px solid var(--line2);font-size:11.5px;color:var(--ink2);cursor:pointer">${esc(e)}</button>`).join('')}
  </div>`;
  if(r){
    h+=`<div style="background:#fbf8f1;border:1px solid var(--line2);border-radius:12px;padding:16px 18px;margin-top:12px">
      <div style="white-space:pre-wrap;font-size:14px;line-height:1.95;color:var(--ink)">${esc(r.text)}</div>
      ${r.chart?'<div style="margin-top:12px">'+r.chart+'</div>':''}</div>`;
  }
  h+=`<div class="sub" style="margin-top:12px">対応語の例：期間＝今日/今週/先週/今月/先月/◯月/今年/去年　指標＝売上・客数・単価・原価率・人件費率・FL・利益・口コミ・未入金　「推移」を付けるとグラフ表示</div></div>`;
  return h;
}

/* ---------------- アカウント管理 ---------------- */
function viewAccounts(){
  if(!isAdminRole()) return `<div class="panel"><div class="empty">アカウント管理の権限がありません</div></div>`;
  const live=!!(S.auth&&S.auth.token);
  if(live&&S.accounts===null){ loadAccounts(); }
  const list=live?(S.accounts||[]):demoAccounts();
  let h=`<div class="ctrl-bar no-print">
    <button class="icon-btn primary" onclick="App.editAccount('')">＋ 新規アカウント発行</button>
    <button class="icon-btn primary" onclick="App.openInvite()">🔗 招待リンクを発行</button>
    <span class="period-label">${live?'スプレッドシート「アカウント」シートと連動しています':'デモモード：このブラウザ内にのみ保存されます（API接続後はシート管理）'}</span>
  </div>`;
  if(S.accErr) h+=`<div class="login-err" style="margin:10px 0">${esc(S.accErr)}</div>`;
  h+=`<div class="panel"><div class="panel-head"><div><h3>発行済みアカウント</h3><div class="sub">権限: 社長・本部＝全店＋アカウント管理 ／ マネージャー＝担当店舗 ／ 店舗＝自店のみ</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>ログインID</th><th>表示名</th><th>権限</th><th>役職</th><th>担当店舗</th><th>表示タブ</th><th>使える機能</th><th>状態</th><th>メモ</th><th></th></tr></thead><tbody>`;
  list.forEach(a=>{
    const ovTabs=parseTabsSpec(a.tabs);
    const ovPerms=parseFeatureSpec(a.perms);
    const permCell=ovPerms
      ? (ovPerms.length?esc(ovPerms.map(k=>FEATURE_LABELS[k].replace(/（.*$/,'')).join('・')):'<span class="mut">なし</span>')
      : ((ROLE_FEATURES[a.role]||[]).length?'<span class="mut">既定（全部）</span>':'<span class="mut">既定（なし）</span>');
    h+=`<tr><td>${esc(a.id)}</td><td style="text-align:right">${esc(a.name)}</td><td>${esc(a.role)}</td>
    <td>${a.position?esc(a.position):'<span class="mut">—</span>'}</td>
    <td style="max-width:280px;white-space:normal">${esc(a.stores)}</td>
    <td style="max-width:220px;white-space:normal;font-size:11px">${ovTabs?esc(ovTabs.map(k=>TAB_LABELS[k]).join('・')):'<span class="mut">既定</span>'}</td>
    <td style="max-width:200px;white-space:normal;font-size:11px">${permCell}</td>
    <td>${a.active!==false?'<span class="badge ok">有効</span>':'<span class="badge ng">無効</span>'}</td>
    <td class="mut" style="white-space:normal">${esc(a.memo||'')}</td>
    <td><button class="icon-btn" onclick="App.editAccount(this.dataset.i)" data-i="${esc(a.id)}">編集</button></td></tr>`;
  });
  h+=`</tbody></table></div></div>`;
  h+=`<div class="note-box no-print">パスワードはセキュリティのため一覧に表示されません。変更する場合は「編集」からパスワード欄に新しい値を入力してください（空欄のままなら変更されません）。${live?'アカウントの実体はスプレッドシートの「アカウント」シートにあり、シート上で直接編集することもできます。':''}</div>`;
  return h;
}
async function loadAccounts(){
  try{
    const d=await api({ action:'accounts', token:S.auth.token });
    if(d.ok){ S.accounts=d.accounts; S.accErr=''; }
    else { S.accounts=[]; S.accErr=d.error||'取得に失敗しました'; }
  }catch(e){ S.accounts=[]; S.accErr='通信エラー: '+e.message; }
  if(S.tab==='accounts') render();
}

/* ---------------- モーダル ---------------- */
function viewModal(){
  if(S.modal==='connect') return connectModal();
  if(S.modal&&S.modal.type==='account') return accountModal();
  if(S.modal&&S.modal.type==='invite') return inviteModal();
  if(S.modal&&S.modal.type==='target') return targetModal();
  if(S.modal&&S.modal.type==='targetDay') return targetDayModal();
  if(S.modal&&S.modal.type==='depImport') return depImportModal();
  if(S.modal&&S.modal.type==='plInput') return plInputModal();
  if(S.modal&&S.modal.type==='adInput') return adInputModal();
  if(S.modal&&S.modal.type==='adSales') return adSalesModal();
  if(S.modal&&S.modal.type==='rsvImport') return rsvImportModal();
  if(S.modal&&S.modal.type==='event') return eventModal();
  return '';
}
/* ---- 目標入力モーダル：日別売上（昨年同週同曜日を指標表示）＋月次目標 ---- */
function targetModal(){
  const m=S.modal;
  const stores=scopeStores();
  const st=m.store&&stores.includes(m.store)?m.store:stores[0];
  const [y,mo]=(m.month||'').split('-').map(Number);
  const lastDay=new Date(y,mo,0).getDate();
  const stSet=new Set([st]);
  const goals={}; for(const r of D.targets){ if(r.store!==st) continue; const d2=new Date(r.t); if(d2.getFullYear()===y&&d2.getMonth()===mo-1) goals[d2.getDate()]=r.goal; }
  const tmEx=D.targetsM.find(r=>{ const d2=new Date(r.t); return r.store===st&&d2.getFullYear()===y&&d2.getMonth()===mo-1; })||{};
  let grid='', initTotal=0, lyTotal=0;
  for(let d2=1;d2<=lastDay;d2++){
    const dt=new Date(y,mo-1,d2); const t=dayMs(dt);
    const ly=dailySalesOf(stSet,t-LY_MS);
    if(goals[d2]!=null&&goals[d2]>0) initTotal+=Math.round(goals[d2]);
    if(ly>0) lyTotal+=ly;
    grid+=`<tr${isHolidayOrSunday(dt)?' style="background:#fbf6f3"':''}><td style="white-space:nowrap">${mdw(dt)}</td>
      <td class="mut" style="white-space:nowrap">${ly>0?yen(ly):'—'}</td>
      <td><input type="number" id="tg-d-${d2}" data-ly="${ly}" oninput="App.tgtRecalc()" value="${goals[d2]!=null&&goals[d2]>0?Math.round(goals[d2]):''}" placeholder="${ly>0?Math.round(ly):''}" style="width:110px;text-align:right;padding:5px 8px"></td></tr>`;
  }
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal" style="max-width:560px">
    <h3>目標入力（${y}年${mo}月）</h3>
    <div class="sub">「昨年同週同曜日」＝364日前（52週前の同じ曜日）の売上実績。空欄の日は目標なし扱いです。</div>
    <div style="margin-top:10px;padding:10px 14px;background:#f3f5f0;border:1px solid #d7ddcf;border-radius:10px;display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:6px">
      <span style="font-size:12.5px;color:#5c5348;font-weight:700">月間売上目標 合計</span>
      <span><b id="tg-total" data-ly="${lyTotal}" style="font-size:19px;color:#3d5163">${yen(initTotal)}</b>
        <span class="mut" style="font-size:11px" id="tg-total-cmp">${lyTotal>0?'／ 昨年同曜日合計 '+yen(lyTotal)+'（'+(initTotal>0?(initTotal/lyTotal*100).toFixed(0)+'%）':'—）'):''}</span></span>
    </div>
    <div class="form-grid" style="margin-top:10px">
      <div><label>店舗</label><select id="tg-store" onchange="App.tgtSwitch()">${stores.map(s=>`<option ${st===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
      <div><label>対象月</label><input type="month" id="tg-month" value="${m.month}" onchange="App.tgtSwitch()"></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <span style="font-size:12px;color:#8c8375">一括入力：昨年同曜日 ×</span>
      <input type="number" id="tg-pct" value="105" style="width:64px;text-align:right;padding:5px 8px">%
      <button class="icon-btn" onclick="App.tgtFill()">全日に反映</button>
      <button class="icon-btn" onclick="App.tgtClear()">クリア</button>
    </div>
    <div class="scroll-x" style="max-height:300px;overflow-y:auto;border:1px solid var(--line2);border-radius:10px">
      <table class="tbl"><thead><tr><th>日付</th><th>昨年同週同曜日</th><th>売上目標</th></tr></thead><tbody>${grid}</tbody></table>
    </div>
    <div style="margin-top:14px;font-weight:700;font-size:13px">月次目標（この月・この店舗）</div>
    <div class="sub" style="margin:2px 0 6px">人件費・仕入は「売上に対する％」で入力（例 20 → 売上の20%）。点数・件数は実数。</div>
    <div class="form-grid" style="margin-top:4px">
      <div><label>アルバイト人件費率（%）</label><input type="number" step="0.1" id="tg-pa" value="${tmEx.pa>0?tmEx.pa:''}" placeholder="例 15"></div>
      <div><label>社員人件費率（%）</label><input type="number" step="0.1" id="tg-emp" value="${tmEx.emp>0?tmEx.emp:''}" placeholder="例 12"></div>
      <div><label>仕入原価率（%）</label><input type="number" step="0.1" id="tg-cost" value="${tmEx.cost>0?tmEx.cost:''}" placeholder="例 30"></div>
      <div><label>ダイニー点数（例 4.5）</label><input type="number" step="0.1" id="tg-dinii" value="${tmEx.dinii>0?tmEx.dinii:''}"></div>
      <div><label>Google口コミ件数（月間増加数）</label><input type="number" id="tg-review" value="${tmEx.review>0?Math.round(tmEx.review):''}"></div>
    </div>
    <div id="tg-msg" style="font-size:12px;color:#b5502f;margin:6px 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" onclick="App.saveTargetInput()">保存</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div>
  </div></div>`;
}
/* ---- 日別 目標の1日修正モーダル（日別予実の「編集」から）---- */
function targetDayModal(){
  const m=S.modal; const store=m.store, date=m.date;
  const [y,mo,da]=date.split('-').map(Number);
  const dt=new Date(y,mo-1,da); const t=dayMs(dt); const stSet=new Set([store]);
  const cur=D.targets.find(r=>r.store===store && dayMs(new Date(r.t))===t);
  const goal=cur?Math.round(cur.goal):'';
  const ly=dailySalesOf(stSet,t-LY_MS);
  const act=t<=dayMs(D.refDate||new Date())?dailySalesOf(stSet,t):null;
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal" style="max-width:380px">
    <h3>目標の修正</h3>
    <div class="sub">${esc(store)} ／ ${mdw(dt)}</div>
    <div style="margin:10px 0;font-size:12.5px;color:#5c5348;line-height:1.7">
      昨年同週同曜日：<b>${ly>0?yen(ly):'—'}</b><br>
      売上実績：<b>${act!=null?yen(act):'—（未確定）'}</b>
    </div>
    <div><label style="font-size:12px;color:#8c8375">売上目標（円）</label>
      <input type="number" id="td-goal" value="${goal}" placeholder="${ly>0?Math.round(ly):'例 300000'}" style="width:100%;text-align:right;padding:7px 10px;margin-top:3px"></div>
    <div class="sub" style="margin-top:5px">空欄にして保存すると、この日の目標を削除します。</div>
    <div id="td-msg" style="font-size:12px;color:#b5502f;margin:8px 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" onclick="App.saveTargetDay()">保存</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div>
  </div></div>`;
}
/* ---- 口座CSVインポートモーダル（入金管理）----
 * 銀行の入出金明細CSVを選ぶ→入金行(入金額>0)を抽出してプレビュー→取込実行で
 * GAS経由で 売上DBスプレッドシートの入金DB と ダッシュボードの入金DB の両方に追記する。
 * 店舗はプルダウンで選んだ1店舗に紐付け（口座＝店舗単位のため）。重複行はサーバー側でスキップ。 */
let DEP_IMPORT={rows:[],file:''};
function depImportModal(){
  const stores=scopeStores();
  const cur=selStoreName()&&stores.includes(selStoreName())?selStoreName():stores[0];
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal" style="max-width:560px">
    <h3>口座CSVの取込（入金）</h3>
    <div class="sub">銀行からダウンロードした入出金明細CSVを選ぶと、入金行だけを抽出して取り込みます（文字コードはShift_JIS/UTF-8どちらでも可）。取り込んだ内容はスプレッドシート（売上DBの入金DB）にも自動反映されます。</div>
    <div class="form-grid" style="margin-top:12px">
      <div><label>この口座（CSV）の店舗</label>
        <select id="dp-store">${stores.map(s=>`<option ${s===cur?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
      <div><label>CSVファイル</label>
        <input type="file" id="dp-file" accept=".csv,text/csv" onchange="App.depFileChosen(this)" style="width:100%;font-size:12px;padding:6px 0"></div>
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;margin:10px 0 4px;cursor:pointer">
      <input type="checkbox" id="dp-atm" checked onchange="App.depPreview()"> ATM入金のみ取り込む（摘要に「ATM」を含む行だけ）
    </label>
    <div id="dp-preview" style="margin-top:6px"><div class="empty" style="padding:14px;font-size:12.5px">CSVファイルを選択してください</div></div>
    <div id="dp-msg" style="font-size:12px;color:#b5502f;margin:8px 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" id="dp-run" onclick="App.runDepositImport()" disabled>取込実行</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div>
  </div></div>`;
}
// 銀行CSVのテキストから入金行を抽出。売上DB側の既存スクリプトと同じ2形式＋汎用で判別する：
//  形式A（ローソン/ゆうちょ等）: 「お預り金額」「摘要」＋ 年/月/日・時/分/秒 の分割列 → 取引時刻で識別
//  形式B（GMOあおぞら等）: 「日付」「摘要」「入金金額」「出金金額」「残高」 → 残高で識別（同日同額を区別）
//  それ以外の銀行: 汎用フォールバック（見出しキーワードで自動判定）
// 返り値の各行 {t,amt,desc,tm,bal}。識別トークン（＝入金DBのE列）は depTokenize で決定する。
function depParseCsv(text){
  const rows=csvToRows(text);
  const toInt=(v)=>parseInt(String(v==null?'':v).replace(/[,"¥\s]/g,'').trim(),10)||0;
  let hi=-1, fmt='';
  for(let i=0;i<Math.min(rows.length,15);i++){
    const s=rows[i].join(',');
    if(s.indexOf('お預り')>=0 && s.indexOf('摘要')>=0){ hi=i; fmt='A'; break; }
    if(s.indexOf('入金金額')>=0 && s.indexOf('摘要')>=0 && s.indexOf('日付')>=0){ hi=i; fmt='B'; break; }
    if(/入金|預入/.test(s)&&/日|取引/.test(s)){ hi=i; fmt='G'; break; }
  }
  if(hi<0) return { error:'CSVの見出し行が見つかりません（「入金」「お預り」等を含む列が必要です）' };
  const H=rows[hi].map(h2=>String(h2).trim());
  const col=(kw)=>H.findIndex(h2=>h2.indexOf(kw)>=0);
  const out=[];
  if(fmt==='A'){
    const cY=col('操作日(年)')>=0?col('操作日(年)'):col('年');
    const cM=col('操作日(月)')>=0?col('操作日(月)'):col('月');
    const cD=col('操作日(日)')>=0?col('操作日(日)'):col('日');
    const cTekiyo=col('摘要'), cDep=col('お預り'), cPay=col('お支払');
    const cH=col('時'), cMi=col('分'), cS=col('秒'), cSeq=col('取引順');
    if(cY<0||cM<0||cD<0||cTekiyo<0||cDep<0) return { error:'必要な列(年/月/日/摘要/お預り金額)が見つかりません。見出し: '+H.join(' / ') };
    for(let i=hi+1;i<rows.length;i++){
      const r=rows[i]; if(!r) continue;
      const y=parseInt(r[cY],10), mo=parseInt(r[cM],10), d=parseInt(r[cD],10);
      if(!y||!mo||!d) continue;
      if(cPay>=0&&toInt(r[cPay])>0) continue;            // 支払い(出金)は除外
      const dep=toInt(r[cDep]); if(dep<=0) continue;
      const desc=String(r[cTekiyo]||'').trim();
      const hh=cH>=0?String(r[cH]||'').trim().padStart(2,'0'):'';
      const mm=cMi>=0?String(r[cMi]||'').trim().padStart(2,'0'):'';
      const sscc=cS>=0?String(r[cS]||'').trim().padStart(2,'0'):'';
      const tm=(hh||mm||sscc)?`${hh}:${mm}:${sscc}`:(cSeq>=0?String(r[cSeq]||'').trim():'');
      out.push({ t:new Date(y,mo-1,d).getTime(), amt:dep, desc, tm, bal:null });
    }
  } else if(fmt==='B'){
    const cDate=col('日付'), cTekiyo=col('摘要'), cDep=col('入金金額'), cPay=col('出金金額'), cBal=col('残高');
    if(cDate<0||cTekiyo<0||cDep<0) return { error:'必要な列(日付/摘要/入金金額)が見つかりません。見出し: '+H.join(' / ') };
    for(let i=hi+1;i<rows.length;i++){
      const r=rows[i]; if(!r) continue;
      const t=depParseYmd(r[cDate]); if(!t) continue;
      if(cPay>=0&&toInt(r[cPay])>0) continue;            // 出金(手数料/振込)は除外
      const dep=toInt(r[cDep]); if(dep<=0) continue;
      const desc=String(r[cTekiyo]||'').trim();
      const bal=(cBal>=0&&String(r[cBal]||'').trim()!=='')?toInt(r[cBal]):null;
      out.push({ t, amt:dep, desc, tm:'', bal });
    }
  } else {   // 汎用（その他の銀行）
    const iD=colAny(H,['取引日','取扱日','操作日','日付','年月日','日時']);
    const iA=H.findIndex(h2=>/入金|預入/.test(h2)&&!/出金|引出/.test(h2));
    const iDesc=colAny(H,['摘要','取引内容','内容','明細','備考']);
    const iTime=H.findIndex(h2=>/時刻|時間/.test(h2));
    const iBal=colAny(H,['残高']);
    const iPay=H.findIndex(h2=>/出金|引出|お支払/.test(h2));
    if(iD<0||iA<0) return { error:'必要な列が見つかりません（日付列と入金列）。見出し: '+H.join(' / ') };
    for(let i=hi+1;i<rows.length;i++){
      const c=rows[i]; if(!c) continue;
      const rawD=String(c[iD]==null?'':c[iD]).trim();
      const t=depParseYmd(rawD); if(!t) continue;
      if(iPay>=0&&toInt(c[iPay])>0) continue;
      const amt=toInt(c[iA]); if(amt<=0) continue;
      const desc=iDesc>=0?String(c[iDesc]||'').trim():'';
      let tm=iTime>=0?String(c[iTime]||'').trim():'';
      if(!tm){ const mt=rawD.match(/(\d{1,2}:\d{2}(?::\d{2})?)/); if(mt) tm=mt[1]; }  // 日時列に時刻が含まれる形式
      const bal=(iBal>=0&&String(c[iBal]||'').trim()!=='')?toInt(c[iBal]):null;
      out.push({ t, amt, desc, tm, bal });
    }
  }
  if(!out.length) return { error:'入金行（入金額>0）が見つかりませんでした' };
  out.sort((a,b)=>a.t-b.t);
  return { rows:out, fmt };
}
// 日付パース: YYYYMMDD / 2026/6/17 / 2026-06-17 など
function depParseYmd(v){
  const s=String(v==null?'':v).trim(); if(!s) return 0;
  let t=parseDateStr(s);
  if(!t){ const digits=s.replace(/[^0-9]/g,''); if(/^\d{8}$/.test(digits)) t=new Date(+digits.slice(0,4),+digits.slice(4,6)-1,+digits.slice(6,8)).getTime(); }
  return t||0;
}
// 各行に識別トークン（入金DBのE列＝取引時刻）を付与。売上DB側スクリプトと同一ルール：
//   取引時刻があればそれ／無ければ 残高{n}／それも無ければ 同日同額の #出現順。
// occ は「実際に取り込む行集合」内で数える（＝ATMフィルタ後の集合。既存スクリプトと同じ）。
function depTokenize(rows){
  const occ={};
  return rows.map(r=>{
    let token;
    if(r.tm) token=String(r.tm);
    else if(r.bal!=null) token='残高'+r.bal;
    else { const dt=new Date(r.t); const k=dt.getFullYear()+'/'+(dt.getMonth()+1)+'/'+dt.getDate()+'_'+r.amt; occ[k]=(occ[k]||0)+1; token='#'+occ[k]; }
    return Object.assign({}, r, { token });
  });
}
/* ---- PL経費入力モーダル ----
 * 年月×店舗の手入力経費を丸ごと編集（差し替え保存）。保存先は
 * ①PL管理システムの「✍ 販管費入力」（手入力の本体） ②ダッシュボードのDB_PL（即時反映用）の両方。
 * 媒体販促費（自動計上）はPL側トリガーが管理するためここでは触らない。 */
const PL_ITEM_CAT={
  '役員報酬':'L','法定福利費':'L','通勤手当':'L','旅費交通費':'L','賞与積立':'L','退職金等':'L',
  '家賃':'R','リース料':'R','家賃更新按分':'R','広告宣伝費':'A','販売促進費':'A',
  '水道光熱費':'O','通信費':'O','消耗品・備品費':'O','修繕費':'O','衛生管理費':'O','カード手数料':'O','支払手数料':'O','支払報酬料':'O','採用教育費':'O','接待交際費':'O','会議費':'O','慶弔見舞費':'O','保険料':'O','租税公課':'O','減価償却費':'O','福利厚生費':'O','諸会費':'O','雑費':'O','本部経費（按分）':'O',
  'その他売上':'S','銀行返済':'X','仕入（食材・飲料）':'F'
};
function plRowHtml(item,cat,amt,memo){
  const cats=[['F','F 仕入'],['L','L 人件費'],['A','A 広告'],['R','R 家賃'],['O','O 他'],['S','S 売上'],['X','X PL外']];
  return `<tr>
    <td><input class="pli-item" list="pl-items" value="${esc(item||'')}" placeholder="勘定科目" style="width:150px;padding:5px 7px" onchange="App.plGuessCat(this)"></td>
    <td><select class="pli-cat" style="padding:5px 4px">${cats.map(c=>`<option value="${c[0]}" ${cat===c[0]?'selected':''}>${c[1]}</option>`).join('')}</select></td>
    <td><input type="number" class="pli-amt" value="${amt>0?Math.round(amt):''}" placeholder="金額" style="width:100px;text-align:right;padding:5px 7px"></td>
    <td><input class="pli-memo" value="${esc(memo||'')}" placeholder="メモ" style="width:120px;padding:5px 7px"></td>
  </tr>`;
}
function plInputModal(){
  const m=S.modal;
  const stores=scopeStores();
  const canCommon=S.auth&&(S.auth.account.role==='社長'||S.auth.account.role==='本部');
  const isCommon=m.store==='__common__';
  const st=isCommon?'__common__':(m.store&&stores.includes(m.store)?m.store:stores[0]);
  const [y,mo]=(m.ym||'').split('-').map(Number);
  const t0=new Date(y,mo-1,1).getTime();
  // この月×店舗の既存手入力行（媒体販促費（自動）はPL側トリガー管理のため除外）
  const rows=D.pl.filter(r=>r.t===t0 && (isCommon? !String(r.store).trim() : normStore(r.store)===normStore(st)) && r.memo!=='媒体販促費（自動計上）' && r.item!=='媒体販促費（自動）');
  const items=[...new Set(Object.keys(PL_ITEM_CAT).concat(D.pl.map(r=>r.item)))];
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal" style="max-width:640px">
    <h3>経費の入力・修正（${y}年${mo}月）</h3>
    <div class="sub">保存すると<b>この月×この店舗の手入力経費を丸ごと差し替え</b>ます（行を消す＝金額を空欄に）。PL管理システム（✍販管費入力）とダッシュボードのDB_PLの両方に反映されます。媒体販促費（自動）はここでは編集できません。</div>
    <div class="form-grid" style="margin-top:10px">
      <div><label>対象月</label><input type="month" id="pli-ym" value="${m.ym}" onchange="App.plSwitch()"></div>
      <div><label>店舗</label><select id="pli-store" onchange="App.plSwitch()">
        ${stores.map(s=>`<option value="${esc(s)}" ${st===s?'selected':''}>${esc(s)}</option>`).join('')}
        ${canCommon?`<option value="__common__" ${isCommon?'selected':''}>全社共通（店舗に紐付けない経費）</option>`:''}
      </select></div>
    </div>
    <div class="scroll-x" style="max-height:300px;overflow-y:auto;border:1px solid var(--line2);border-radius:10px;margin-top:8px">
      <table class="tbl"><thead><tr><th>勘定科目</th><th>区分</th><th>金額(円)</th><th>メモ</th></tr></thead>
      <tbody id="pli-rows">${rows.map(r=>plRowHtml(r.item,r.cat,r.amount,r.memo)).join('')||plRowHtml('','O','','')}</tbody></table>
    </div>
    <button class="icon-btn" style="margin-top:6px" onclick="App.plAddRow()">＋ 行を追加</button>
    <datalist id="pl-items">${items.map(i2=>`<option value="${esc(i2)}">`).join('')}</datalist>
    <div id="pli-msg" style="font-size:12px;color:#b5502f;margin:8px 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" onclick="App.savePlInput()">保存（この月×店舗を差し替え）</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div>
    <div style="margin-top:14px;border-top:1px dashed var(--line2);padding-top:12px">
      <div style="font-weight:700;font-size:13px">📅 期間一括計上（毎月同じ経費をまとめて入力）</div>
      <div class="sub" style="margin:3px 0 8px">例：家賃 500,000円を 2026/01〜2026/12 に一括計上。期間内の各月に同じ科目の行を作成します（既にある同じ科目の行は上書き／<b>金額を空欄にして実行すると期間内のその科目を削除</b>）。店舗は上で選択中の「${isCommon?'全社共通':esc(st)}」に計上します。</div>
      <div class="form-grid">
        <div><label>開始月</label><input type="month" id="plb-ym1" value="${m.ym}"></div>
        <div><label>終了月</label><input type="month" id="plb-ym2" value="${m.ym}"></div>
        <div><label>勘定科目</label><input id="plb-item" list="pl-items" placeholder="例 家賃" onchange="const c=PL_ITEM_CAT[this.value.trim()];if(c)$('plb-cat').value=c;"></div>
        <div><label>区分</label><select id="plb-cat">${[['F','F 仕入'],['L','L 人件費'],['A','A 広告'],['R','R 家賃'],['O','O 他'],['S','S 売上'],['X','X PL外']].map(c=>`<option value="${c[0]}" ${c[0]==='R'?'selected':''}>${c[1]}</option>`).join('')}</select></div>
        <div><label>金額（円／月）</label><input type="number" id="plb-amt" placeholder="例 500000" style="text-align:right"></div>
        <div><label>メモ（任意）</label><input id="plb-memo"></div>
      </div>
      <div id="plb-msg" style="font-size:12px;color:#b5502f;margin:6px 0"></div>
      <button class="icon-btn primary" style="margin-top:4px" onclick="App.savePlBulk()">📅 期間一括で計上</button>
    </div>
  </div></div>`;
}
/* ---- 広告費入力モーダル ----
 * 管理シートの💾広告費DB（キー=年月_店舗_媒体_プラン・同一キー上書き）へ1件ずつupsert。
 * ダッシュボードの広告データは💾広告費DB由来なので、保存後の再取得で自動反映される。 */
function adInputModal(){
  const m=S.modal; const stores=adStoreOptions();   // 広告側の店舗（⚙️店舗マスタ）＋売上側の店舗
  const st=m.store&&stores.includes(m.store)?m.store:stores[0];
  const [y,mo]=(m.ym||'').split('-').map(Number);
  const t0=new Date(y,mo-1,1).getTime(), t1=new Date(y,mo,1).getTime();
  const ex=D.ad.filter(r=>r.t>=t0&&r.t<t1&&normStore(r.store)===normStore(st));
  const byMedia={}; ex.forEach(r=>{ const k=r.media||'（媒体未設定）'; byMedia[k]=(byMedia[k]||0)+r.cost; });
  // 媒体の選択肢＝⚙️媒体マスタ（無ければ既定＋実データから）。マスタに行を足せば自動で増える
  const medias=D.adMediaMaster.length?D.adMediaMaster.slice()
    :[...new Set(['ホットペッパー','ぐるなび','食べログ','Google広告','Instagram','LINE','チラシ'].concat(D.ad.map(r=>r.media).filter(Boolean)))];
  const selMedia=m.media&&medias.includes(m.media)?m.media:medias[0];
  // プランの選択肢＝⚙️プランマスタ（C列＝プラン名）の該当媒体分だけ（標準料金付き）。
  // マスタに無い媒体は「一式」と直接入力のみ（マスタ由来でない候補は出さない）
  const planRows=(D.adPlanMaster[selMedia]||[]).slice();
  const planNames=planRows.map(p=>p.plan);
  const masterOk=D.adMediaMaster.length>0;
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal" style="max-width:540px">
    <h3>広告費の入力・修正（${y}年${mo}月）</h3>
    <div class="sub">広告費用対効果_管理シートの<b>💾広告費DB</b>に保存します（同じ 年月×店舗×媒体×プラン は上書き／金額を空欄にして保存すると削除）。<br>
      ${masterOk?`媒体・プランの選択肢は管理シートの<b>⚙️媒体マスタ（C列＝媒体名）／⚙️プランマスタ（C列＝プラン名）</b>から取得しています（${esc(D.diag['媒体マスタ']||'')} ／ ${esc(D.diag['プランマスタ']||'')}）。マスタに行を足せば選択肢が自動で増えます。`
        :`<b style="color:#b5502f">⚠ ⚙️媒体マスタを受信できていません</b>（GASを最新に再デプロイし「↻更新」してください）。いまは実データと既定値から候補を作っています。`}</div>
    <div class="form-grid" style="margin-top:10px">
      <div><label>対象月（開始）</label><input type="month" id="adi-ym" value="${m.ym}" onchange="App.adSwitch()"></div>
      <div><label>終了月（任意・期間一括）</label><input type="month" id="adi-ym2" value="${m.ym2||''}" placeholder="空欄＝1ヶ月のみ"></div>
      <div><label>店舗</label><select id="adi-store" onchange="App.adSwitch()">${stores.map(s=>`<option ${st===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
      <div><label>媒体</label><select id="adi-media" onchange="App.adMediaChanged()">
        ${medias.map(x=>`<option ${x===selMedia?'selected':''}>${esc(x)}</option>`).join('')}
        <option value="__free__">その他（直接入力）</option></select>
        <input id="adi-media-free" placeholder="媒体名を入力" style="display:none;margin-top:4px;width:100%"></div>
      <div><label>プラン${planRows.length?'':'（この媒体はプランマスタ未登録）'}</label><select id="adi-plan" onchange="App.adPlanChanged()">
        ${planNames.map(p2=>{ const pr=planRows.find(x=>x.plan===p2); return `<option value="${esc(p2)}" data-fee="${pr?pr.fee:0}">${esc(p2)}${pr&&pr.fee>0?'（標準 '+yen(pr.fee)+'）':''}</option>`; }).join('')}
        <option value="一式">一式（プラン区分なし）</option>
        <option value="__free__">その他（直接入力）</option></select>
        <input id="adi-plan-free" placeholder="プラン名を入力" style="display:none;margin-top:4px;width:100%"></div>
      <div><label>広告費（円／月あたり）</label><input type="number" id="adi-cost" placeholder="例 90000" style="text-align:right"></div>
      <div><label>備考（任意）</label><input id="adi-memo" placeholder="例 半額"></div>
    </div>
    ${Object.keys(byMedia).length?`<div style="margin-top:10px;font-size:12px;color:#5c5348"><b>この月の登録済み広告費（媒体別合計）</b><br>${Object.entries(byMedia).map(([k,v])=>esc(k)+'：'+yen(v)).join('　／　')}<br><span class="mut" style="font-size:11px">※プラン単位の内訳は管理シートの💾広告費DBで確認できます</span></div>`:''}
    <div id="adi-msg" style="font-size:12px;color:#b5502f;margin:8px 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" id="adi-run" onclick="App.saveAdInput()">保存</button>
      <button class="icon-btn" onclick="App.closeModal()">閉じる</button>
    </div>
  </div></div>`;
}
/* ---- 売上入力モーダル（広告管理）----
 * 管理シートの💾売上DB（年月×店舗×媒体）へupsert。既存の「📝売上入力→③売上DBへ反映」と同じ置き場所。
 * ダッシュボードで使う項目（アクセス数・NET件数・NET人数・電話数）は変更せず、
 * 予想売上の計算ロジック（(ネット予約人数＋電話数×電話CV×平均1組人数)×設定単価）もそのまま。 */
const AD_SALES_FIELDS=[
  {k:'access', lb:'アクセス数'},
  {k:'netGrp', lb:'NET件数'},
  {k:'netPpl', lb:'NET人数'},
  {k:'telCnt', lb:'TEL件数'},
  {k:'telPpl', lb:'TEL人数'},
  {k:'totGrp', lb:'総組数'},
  {k:'totPpl', lb:'総人数'},
  {k:'totSales', lb:'総売上（円）'}
];
function adSalesModal(){
  const m=S.modal; const stores=adStoreOptions();   // 広告側の店舗（⚙️店舗マスタ）＋売上側の店舗
  const st=m.store&&stores.includes(m.store)?m.store:stores[0];
  const [y,mo]=(m.ym||'').split('-').map(Number);
  const t0=new Date(y,mo-1,1).getTime(), t1=new Date(y,mo,1).getTime();
  const medias=D.adMediaMaster.length?D.adMediaMaster.slice()
    :[...new Set(D.adfx.map(r=>r.media).filter(Boolean).concat(D.ad.map(r=>r.media).filter(Boolean)))];
  const selMedia=m.media&&medias.includes(m.media)?m.media:(medias[0]||'');
  // 既存値（この年月×店舗×媒体）があればプリセット
  const ex=D.adfx.find(r=>r.t>=t0&&r.t<t1&&normStore(r.store)===normStore(st)&&String(r.media).trim()===selMedia);
  const v=(k)=>{ if(!ex) return '';
    const map={access:ex.access, netGrp:ex.grp, netPpl:ex.ppl, telCnt:ex.telCnt||ex.tel, telPpl:ex.telPpl, totGrp:ex.tGrp, totPpl:ex.tPpl, totSales:ex.tSales};
    return map[k]>0?Math.round(map[k]):''; };
  // この月×店舗の登録済み媒体（参考表示）
  const done=D.adfx.filter(r=>r.t>=t0&&r.t<t1&&normStore(r.store)===normStore(st)).map(r=>r.media).filter(Boolean);
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal" style="max-width:560px">
    <h3>売上・反響の入力（${y}年${mo}月）</h3>
    <div class="sub">広告費用対効果_管理シートの<b>💾売上DB</b>に保存します（同じ 年月×店舗×媒体 は上書き）。既存の「📝売上入力 →③売上DBへ反映」と同じ場所に入ります。<br>
      ダッシュボードの表示項目・予想売上の計算式（ネット予約人数と電話数から算出）は<b>変更していません</b>。</div>
    <div class="form-grid" style="margin-top:10px">
      <div><label>対象月</label><input type="month" id="as-ym" value="${m.ym}" onchange="App.adSalesSwitch()"></div>
      <div><label>店舗</label><select id="as-store" onchange="App.adSalesSwitch()">${stores.map(s=>`<option ${st===s?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
      <div><label>媒体</label><select id="as-media" onchange="App.adSalesSwitch()">
        ${medias.map(x=>`<option ${x===selMedia?'selected':''}>${esc(x)}</option>`).join('')}
        ${medias.length?'':'<option value="">（媒体マスタ未受信）</option>'}</select></div>
      <div><label>集客手数料（円・任意）</label><input type="number" id="as-fee" value="${ex&&ex.fee>0?Math.round(ex.fee):''}" style="text-align:right"></div>
    </div>
    <div class="scroll-x" style="margin-top:10px;border:1px solid var(--line2);border-radius:10px">
      <table class="tbl"><thead><tr><th>項目</th><th style="width:150px">数値</th></tr></thead><tbody>
      ${AD_SALES_FIELDS.map(f=>`<tr><td>${f.lb}</td><td><input type="number" id="as-${f.k}" value="${v(f.k)}" placeholder="0" style="width:130px;text-align:right;padding:5px 8px"></td></tr>`).join('')}
      </tbody></table>
    </div>
    ${ex?`<div class="mut" style="font-size:11px;margin-top:4px">※この 年月×店舗×媒体 は登録済みのため、保存すると上書きされます</div>`:''}
    ${done.length?`<div style="margin-top:8px;font-size:11.5px;color:#5c5348"><b>この月の登録済み媒体：</b>${esc([...new Set(done)].join('・'))}</div>`:''}
    <div id="as-msg" style="font-size:12px;color:#b5502f;margin:8px 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" id="as-run" onclick="App.saveAdSales()">保存</button>
      <button class="icon-btn" onclick="App.closeModal()">閉じる</button>
    </div>
  </div></div>`;
}
/* ---- 予約CSV取込モーダル ----
 * 食べログ等の予約一覧CSVを選び、管理シートの💾予約DBへ追記（全項目一致の行はスキップ）。
 * 店舗はプルダウンで選択（CSVに店舗名列が無いため）。経路（受付窓口）ごとに取込対象を選べる。 */
let RSV_IMPORT={rows:[],file:''};
function rsvParseCsv(text){
  const rows=csvToRows(text);
  let hi=-1;
  for(let i=0;i<Math.min(rows.length,10);i++){ if(/来店日/.test(rows[i].join(','))){hi=i;break;} }
  if(hi<0) return { error:'見出し行（来店日）が見つかりません。予約一覧CSV（食べログ等）を選んでください' };
  const H=rows[hi].map(h2=>String(h2).trim());
  const iNo=colAny(H,['予約No','予約番号','予約ID']);
  const iD=colOf(H,'来店日'), iT=colOf(H,'来店時間');
  let iP=H.findIndex(h2=>h2==='人数'); if(iP<0)iP=H.findIndex(h2=>/人数/.test(h2)&&!/子/.test(h2));
  const iSt=colOf(H,'ステータス'), iW=colAny(H,['受付窓口','経路','媒体']);
  const iC=colOf(H,'作成日'), iCT=colAny(H,['作成時間','作成時刻']);
  if(iD<0) return { error:'来店日列がありません。見出し: '+H.filter(Boolean).join(' / ') };
  const ymd=(v)=>{ const t=parseDateStr(v); if(!t)return ''; const d=new Date(t); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; if(!c) continue;
    const d=ymd(c[iD]); if(!d) continue;
    out.push({ no:iNo>=0?String(c[iNo]||'').trim():'', d, tm:iT>=0?String(c[iT]||'').trim():'', n:iP>=0?num(c[iP])||0:0,
      st:iSt>=0?String(c[iSt]||'').trim():'', win:iW>=0?String(c[iW]||'').trim():'', cd:iC>=0?ymd(c[iC]):'', ct:iCT>=0?String(c[iCT]||'').trim():'' });
  }
  if(!out.length) return { error:'予約行が見つかりませんでした' };
  return { rows:out };
}
function rsvImportModal(){
  const stores=scopeStores();
  const cur=selStoreName()&&stores.includes(selStoreName())?selStoreName():stores[0];
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal" style="max-width:560px">
    <h3>予約CSVの取込</h3>
    <div class="sub">食べログ等の管理画面からエクスポートした<b>予約一覧CSV</b>を選ぶと、広告費用対効果_管理シートの<b>💾予約DB</b>に追記します（同じ予約はスキップ）。曜日別・当日予約の分析に自動反映されます。</div>
    <div class="form-grid" style="margin-top:12px">
      <div><label>このCSVの店舗</label>
        <select id="rv-store">${stores.map(s=>`<option ${s===cur?'selected':''}>${esc(s)}</option>`).join('')}</select></div>
      <div><label>CSVファイル</label>
        <input type="file" id="rv-file" accept=".csv,text/csv" onchange="App.rsvFileChosen(this)" style="width:100%;font-size:12px;padding:6px 0"></div>
    </div>
    <div id="rv-wins" style="margin:8px 0 2px"></div>
    <div id="rv-preview" style="margin-top:6px"><div class="empty" style="padding:14px;font-size:12.5px">CSVファイルを選択してください</div></div>
    <div id="rv-msg" style="font-size:12px;color:#b5502f;margin:8px 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" id="rv-run" onclick="App.runRsvImport()" disabled>取込実行</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div>
  </div></div>`;
}
/* ---- イベント入力モーダル：会場・イベント名・対象店舗チェックリスト ---- */
function eventModal(){
  const m=S.modal;
  const ev=m.id?D.events.find(e=>e.id===m.id):null;
  const stores=scopeStores();
  const checked=ev?ev.stores:(S.tStore?[S.tStore]:[]);
  const ref=D.refDate||new Date();
  const defDate=ev?(()=>{const d2=new Date(ev.t);return d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0')+'-'+String(d2.getDate()).padStart(2,'0');})():(S.tMonth?S.tMonth+'-01':ref.getFullYear()+'-'+String(ref.getMonth()+1).padStart(2,'0')+'-'+String(ref.getDate()).padStart(2,'0'));
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal">
    <h3>${ev?'イベント編集':'イベント追加'}</h3>
    <div class="sub">対象店舗にチェックを入れた店舗の画面にだけ表示されます（全店向けなら全部チェック、または未チェック＝全店扱い）。</div>
    <div class="form-grid" style="margin-top:10px">
      <div><label>日付</label><input type="date" id="ev-date" value="${defDate}"></div>
      <div><label>会場（例 横浜アリーナ・日産スタジアム）</label><input type="text" id="ev-venue" value="${esc(ev?ev.venue:'')}" list="ev-venues"></div>
      <datalist id="ev-venues"><option value="横浜アリーナ"><option value="日産スタジアム"><option value="Kアリーナ横浜"><option value="ぴあアリーナMM"><option value="東京ドーム"><option value="国立競技場"></datalist>
    </div>
    <label style="font-size:11px;color:#8c8375">イベント名</label>
    <input type="text" id="ev-name" value="${esc(ev?ev.name:'')}" placeholder="例：◯◯ライブ／サッカー日本代表戦" style="width:100%;margin-bottom:10px">
    <label style="font-size:11px;color:#8c8375">対象店舗（チェックした店舗の画面に表示）</label>
    <div class="chk-stores" id="ev-stores">
      ${stores.map(n=>`<label class="${checked.includes(n)?'on':''}"><input type="checkbox" ${checked.includes(n)?'checked':''} value="${esc(n)}" onchange="this.parentElement.classList.toggle('on',this.checked)">${esc(shortStore(n))}</label>`).join('')}
    </div>
    <label style="font-size:11px;color:#8c8375;display:block;margin-top:10px">メモ（任意）</label>
    <input type="text" id="ev-memo" value="${esc(ev?ev.memo:'')}" style="width:100%">
    <div id="ev-msg" style="font-size:12px;color:#b5502f;margin:6px 0"></div>
    <div class="modal-btns">
      ${ev?`<button class="icon-btn" style="margin-right:auto;color:#b5502f" onclick="App.deleteEventBtn('${esc(ev.id)}')">削除</button>`:''}
      <button class="icon-btn primary" onclick="App.saveEventInput()">保存</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div>
  </div></div>`;
}
function connectModal(){
  const url=apiUrl();
  const poll=Number(localStorage.getItem(LS.poll)||60);
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal">
    <h3>スプレッドシート接続設定</h3>
    <div class="sub">Google Apps Script（GAS）で公開したウェブアプリのURLを登録すると、スプレッドシートの更新が自動でダッシュボードに反映されます。ログインもシートの「アカウント」タブで管理されます。</div>
    <label style="font-size:11px;color:#8c8375">GAS ウェブアプリURL（…/exec）</label>
    <input type="url" id="cn-url" value="${esc(url)}" placeholder="https://script.google.com/macros/s/…/exec">
    <label style="font-size:11px;color:#8c8375">自動更新間隔</label><br>
    <select id="cn-poll" style="margin:6px 0 12px">
      ${[30,60,120,300].map(s=>`<option value="${s}" ${poll===s?'selected':''}>${s<60?s+'秒':(s/60)+'分'}ごと</option>`).join('')}
    </select>
    <br><label style="font-size:11px;color:#8c8375">読み込む期間（短いほど軽い・前年比には13ヶ月以上必要）</label><br>
    <select id="cn-months" style="margin:6px 0 12px">
      ${[[13,'直近13ヶ月（推奨・速い）'],[24,'直近24ヶ月'],[36,'直近36ヶ月'],[0,'全期間（重い）']].map(([m,l])=>`<option value="${m}" ${monthsWindow()===m?'selected':''}>${l}</option>`).join('')}
    </select>
    <div id="cn-msg" style="font-size:12px;margin:4px 0"></div>
    <div class="modal-btns">
      ${url?`<button class="icon-btn" onclick="App.disconnect()" style="margin-right:auto;color:#b5502f">接続解除</button>`:''}
      <button class="icon-btn" onclick="App.testConnect()">接続テスト</button>
      <button class="icon-btn primary" onclick="App.saveConnect()">保存</button>
      <button class="icon-btn" onclick="App.closeModal()">閉じる</button>
    </div>
  </div></div>`;
}
function inviteModal(){
  const d=S.modal.data;
  if(d){
    const urls=d.urls||[];
    const many=urls.length>1;
    return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal">
      <h3>招待リンクを${urls.length}件発行しました</h3>
      <div class="sub"><b>1リンクにつき1人だけ</b>登録できます（使うと無効）。${many?'それぞれ別の方に送ってください。':''}期限は ${esc(d.expires)} です。</div>
      <div class="note-box" style="margin-bottom:10px;font-size:12px">
        権限：<b>${esc(d.role)}</b>${d.position?' ／ 役職：<b>'+esc(d.position)+'</b>':''}<br>担当店舗：${esc(d.stores)}
      </div>
      <textarea id="iv-url" rows="${Math.min(urls.length+1,8)}" readonly onclick="this.select()"
        style="width:100%;font-family:var(--sans);font-size:12px;color:var(--ink);background:#fff;border:1px solid var(--line2);border-radius:8px;padding:9px 11px;outline:none">${esc(urls.join('\n'))}</textarea>
      <div class="sub" style="margin-top:6px">本人がリンクを開くと、ログインIDとパスワードを自分で設定して登録します。登録後はアカウント管理に表示され、退職時はそこで無効化できます。</div>
      <div class="modal-btns">
        <button class="icon-btn primary" onclick="App.copyInvite()">${many?'すべてコピー':'リンクをコピー'}</button>
        <button class="icon-btn" onclick="App.closeModal()">閉じる</button>
      </div></div></div>`;
  }
  const all=allStores();
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal">
    <h3>招待リンクを発行</h3>
    <div class="sub">権限・役職・担当店舗を決めてリンクを発行します。本人がリンクから自分でID・パスワードを登録します。</div>
    <div class="form-grid">
      <div><label>権限</label><select id="iv-role">${['店舗','マネージャー','本部','社長'].map(r=>`<option>${r}</option>`).join('')}</select></div>
      <div><label>役職（週報フォーマットの出し分けに使用）</label><input type="text" id="iv-pos" placeholder="例: 店長 / 社員" value="社員"></div>
      <div><label>リンクの有効期限</label><select id="iv-days"><option value="3">3日</option><option value="7" selected>7日</option><option value="14">14日</option><option value="30">30日</option></select></div>
      <div><label>発行枚数（1リンク＝1人）</label><select id="iv-count">${[1,2,3,4,5,6,8,10,15,20].map(n=>`<option value="${n}">${n}枚</option>`).join('')}</select></div>
    </div>
    <label style="font-size:11px;color:#8c8375;display:block;margin-top:10px">担当店舗（社長・本部は自動的に全店）</label>
    <div class="chk-stores" id="iv-stores">
      <label><input type="checkbox" value="全店" onchange="App.toggleZen(this)">全店</label>
      ${all.map(n=>`<label><input type="checkbox" value="${esc(n)}" onchange="this.parentElement.classList.toggle('on',this.checked)">${esc(n)}</label>`).join('')}
    </div>
    <div id="iv-msg" style="font-size:12px;color:#b5502f;margin:10px 0 0"></div>
    <div class="modal-btns">
      <button class="icon-btn primary" onclick="App.createInvite()">リンクを発行</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div></div></div>`;
}
// 招待リンクを開いた従業員向けの登録画面（未ログインで表示される）
function viewRegister(){
  if(S.inviteDone){
    return `<div class="login-wrap"><div class="login-card">
      <div class="login-head"><div class="login-logo">鳥</div><h1>登録が完了しました</h1></div>
      <div class="login-body"><div class="note-box" style="margin-bottom:14px">アカウントを作成しました。設定したIDとパスワードでログインしてください。</div>
      <button class="btn-login" onclick="location.href=location.pathname">ログイン画面へ</button></div></div></div>`;
  }
  const iv=S.invite;
  if(!iv) return '';
  if(iv.error){
    return `<div class="login-wrap"><div class="login-card">
      <div class="login-head"><div class="login-logo">鳥</div><h1>リンクが使えません</h1></div>
      <div class="login-body"><div class="login-err">${esc(iv.error)}</div>
      <div class="login-note">お手数ですが、担当者に新しい招待リンクの発行を依頼してください。</div></div></div></div>`;
  }
  return `<div class="login-wrap"><div class="login-card">
    <div class="login-head"><div class="login-logo">鳥</div><h1>アカウント登録</h1><p>鳥一代グループ ダッシュボード</p></div>
    <div class="login-body">
      <div class="note-box" style="margin-bottom:14px;font-size:12px">
        権限：<b>${esc(iv.role)}</b>${iv.position?' ／ 役職：<b>'+esc(iv.position)+'</b>':''}<br>担当店舗：${esc(iv.stores||'—')}
      </div>
      <label>お名前（表示名）</label><input type="text" id="rg-name" placeholder="例: 山田 太郎">
      <label>ログインID（半角英数字）</label><input type="text" id="rg-id" placeholder="例: yamada">
      <label>パスワード（8文字以上）</label><input type="password" id="rg-pw">
      <label>パスワード（確認）</label><input type="password" id="rg-pw2">
      <div id="rg-msg" style="font-size:12px;color:#b5502f;margin:2px 0 10px"></div>
      <button class="btn-login" onclick="App.doRegister()">登録する</button>
    </div></div></div>`;
}
function accountModal(){
  const m=S.modal;
  const a=m.data||{ id:'', name:'', role:'店舗', stores:'', active:true, memo:'', tabs:'', perms:'', position:'' };
  const isNew=!m.id;
  const all=allStores();
  const tabKeys=Object.keys(TAB_LABELS).filter(k=>k!=='accounts');
  const curTabs=(parseTabsSpec(a.tabs)||ROLE_TABS[a.role]||ROLE_TABS['店舗']).filter(k=>k!=='accounts');
  const curPerms=parseFeatureSpec(a.perms)||ROLE_FEATURES[a.role]||[];
  const selected=String(a.stores||'')==='全店'?all.slice():String(a.stores||'').split(/[,、]/).map(s=>s.trim()).filter(Boolean);
  const isZen=String(a.stores||'')==='全店';
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal">
    <h3>${isNew?'新規アカウント発行':'アカウント編集'}</h3>
    <div class="sub">権限に応じて閲覧範囲と機能が自動で切り替わります。</div>
    <div class="form-grid">
      <div><label>ログインID ${isNew?'':'（変更不可）'}</label><input type="text" id="ac-id" value="${esc(a.id)}" ${isNew?'':'disabled'}></div>
      <div><label>表示名</label><input type="text" id="ac-name" value="${esc(a.name)}"></div>
      <div><label>パスワード${isNew?'':'（空欄＝変更なし）'}</label><input type="text" id="ac-pw" value="" placeholder="${isNew?'必須':'変更する場合のみ入力'}"></div>
      <div><label>役職（週報フォーマットの出し分け）</label><input type="text" id="ac-position" value="${esc(a.position||'')}" placeholder="例: 店長 / 社員"></div>
      <div><label>権限</label><select id="ac-role" onchange="App.roleHint(this.value)">
        ${['社長','本部','マネージャー','店舗'].map(r2=>`<option ${a.role===r2?'selected':''}>${r2}</option>`).join('')}
      </select></div>
    </div>
    <div id="ac-role-hint" class="sub" style="margin:-4px 0 10px">${roleHintText(a.role)}</div>
    <label style="font-size:11px;color:#8c8375">担当店舗（社長・本部は自動的に全店）</label>
    <div class="chk-stores" id="ac-stores">
      <label class="${isZen?'on':''}"><input type="checkbox" ${isZen?'checked':''} value="全店" onchange="App.toggleZen(this)">全店</label>
      ${all.map(n=>`<label class="${!isZen&&selected.includes(n)?'on':''}"><input type="checkbox" ${!isZen&&selected.includes(n)?'checked':''} value="${esc(n)}" onchange="this.parentElement.classList.toggle('on',this.checked)">${esc(n)}</label>`).join('')}
    </div>
    <label style="font-size:11px;color:#8c8375;display:block;margin-top:14px">表示するタブ（チェックした項目だけメニューに表示。権限を変えると既定に戻ります／アカウント管理は社長・本部のみ自動表示）</label>
    <div class="chk-stores" id="ac-tabs">
      ${tabKeys.map(k=>`<label class="${curTabs.includes(k)?'on':''}"><input type="checkbox" ${curTabs.includes(k)?'checked':''} value="${k}" onchange="this.parentElement.classList.toggle('on',this.checked)">${esc(TAB_LABELS[k])}</label>`).join('')}
    </div>
    <label style="font-size:11px;color:#8c8375;display:block;margin-top:14px">使える機能（データを入力・取り込む操作。チェックを外すとボタン自体が表示されません／既定は 社長・本部＝全部、マネージャー・店舗＝なし）</label>
    <div class="chk-stores" id="ac-perms">
      ${ALL_FEATURES.map(k=>`<label class="${curPerms.includes(k)?'on':''}"><input type="checkbox" ${curPerms.includes(k)?'checked':''} value="${k}" onchange="this.parentElement.classList.toggle('on',this.checked)">${esc(FEATURE_LABELS[k])}</label>`).join('')}
    </div>
    <div class="form-grid" style="margin-top:14px">
      <div><label>状態</label><select id="ac-active"><option value="TRUE" ${a.active!==false?'selected':''}>有効</option><option value="FALSE" ${a.active===false?'selected':''}>無効</option></select></div>
      <div><label>メモ</label><input type="text" id="ac-memo" value="${esc(a.memo||'')}"></div>
    </div>
    <div id="ac-msg" style="font-size:12px;color:#b5502f;margin:4px 0"></div>
    <div class="modal-btns">
      ${isNew?'':`<button class="icon-btn" style="margin-right:auto;color:#b5502f" onclick="App.deleteAccount('${esc(a.id)}')">削除</button>`}
      <button class="icon-btn primary" onclick="App.saveAccount()">${isNew?'発行する':'保存'}</button>
      <button class="icon-btn" onclick="App.closeModal()">キャンセル</button>
    </div>
  </div></div>`;
}
function roleHintText(r){
  return {
    '社長':'全店舗の全データ・全機能＋アカウント発行が可能です。',
    '本部':'全店舗の全データ・全機能＋アカウント発行が可能です。',
    'マネージャー':'担当店舗のみ閲覧できます。PL・広告管理あり（担当店舗間の比較つき）。',
    '店舗':'自店のみ閲覧できます。PL・広告管理・他店比較・アカウント管理は既定で非表示（下の「表示するタブ」で変更できます）。',
  }[r]||'';
}

/* ---------------- アプリ操作（グローバル） ---------------- */
window.App = {
  login: doLogin,
  logout(){ if(confirm('ログアウトしますか？')) doLogout(); },
  tab(t){ S.tab=t; render(); },
  period(p){ S.period=p; S.pWeekIdx=null; render(); },
  store(n){ S.store=n; render(); },
  set(k,v){ S[k]=v; render(); },
  setWeek(i){ S.pWeekIdx=i; render(); },
  aiRun(){ const el=$('ai-q'); S.aiQ=el?el.value:S.aiQ; S.aiResult=answerQuery(S.aiQ); render(); },
  aiFill(q){ S.aiQ=q; S.aiResult=answerQuery(q); render(); },
  depNav(d){
    if(d===0){ S.depMonth=''; render(); return; }
    const m0=depMonthDate(); const n=new Date(m0.getFullYear(),m0.getMonth()+d,1);
    S.depMonth=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0'); render();
  },
  dowNav(d){
    if(d===0){ S.aDowMonth=''; render(); return; }
    const m0=anaDowMonth(); const n=new Date(m0.getFullYear(),m0.getMonth()+d,1);
    S.aDowMonth=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0'); render();
  },
  setYm(key,which,val){  // 年/月プルダウンの変更を状態キーに反映
    const ref=D.refDate||new Date();
    const cur=S[key]?String(S[key]).split('-'):null;
    let y=cur?+cur[0]:ref.getFullYear(), m=cur?+cur[1]:ref.getMonth()+1;
    if(which==='y') y=+val; else m=+val;
    S[key]=y+'-'+String(m).padStart(2,'0');
    if(key==='revMonth') S.revWeekIdx=null;
    render();
  },
  ymToday(key){ S[key]=''; if(key==='revMonth') S.revWeekIdx=null; render(); },
  setYmd(key,which,val,baseISO){  // 年/月/日プルダウン（期間指定）の変更を反映
    const b=String(S[key]||baseISO||'').split('-');
    const ref=D.refDate||new Date();
    let y=+b[0]||ref.getFullYear(), m=+b[1]||(ref.getMonth()+1), d=+b[2]||ref.getDate();
    if(which==='y')y=+val; else if(which==='m')m=+val; else d=+val;
    const dim=new Date(y,m,0).getDate(); if(d>dim)d=dim;   // 月末を超える日はクランプ
    S[key]=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0'); render();
  },
  thisMonth(){  // ダッシュボードの期間を「今月（今週/今日）」に一発で戻す
    const ref=D.refDate||new Date();
    S.pMonth=ref.getFullYear()+'-'+String(ref.getMonth()+1).padStart(2,'0');
    S.pDay=S.pMonth+'-'+String(ref.getDate()).padStart(2,'0');
    S.pYear=String(ref.getFullYear());
    S.pWeekIdx=null; render();
  },
  adNav(d){
    const ref=D.refDate||new Date();
    const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
    const n=new Date(m0.getFullYear(),m0.getMonth()+d,1);
    S.adMonth=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0'); render();
  },
  plNav(d){
    if(d===0){ S.plMonth=''; render(); return; }
    const ref=D.refDate||new Date();
    const m0=S.plMonth?new Date(+S.plMonth.split('-')[0],+S.plMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
    const n=new Date(m0.getFullYear(),m0.getMonth()+d,1);
    S.plMonth=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0'); render();
  },
  revNav(d){
    if(d===0){ S.revMonth=''; S.revWeekIdx=null; render(); return; }
    const ref=D.refDate||new Date();
    const m0=S.revMonth?new Date(+S.revMonth.split('-')[0],+S.revMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
    const n=new Date(m0.getFullYear(),m0.getMonth()+d,1);
    S.revMonth=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0'); render();
  },
  setRevWeek(i){ S.revWeekIdx=i; render(); },
  report(kind,date,stores,group){
    // stores: カンマ区切り文字列 or 配列（配信グループごとの店舗絞り込み）
    const list=Array.isArray(stores)?stores:(stores?String(stores).split(',').map(s2=>s2.trim()).filter(Boolean):null);
    S.reportMode={kind:kind||'daily',date:date||'',stores:list,group:group||''}; render();
  },
  reportExit(){ S.reportMode=null; render(); },
  /* ---- 目標・イベント入力 ---- */
  openTargetInput(){
    const m0=tgtMonthDate();
    const month=m0.getFullYear()+'-'+String(m0.getMonth()+1).padStart(2,'0');
    S.modal={type:'target', store:S.tStore||scopeStores()[0], month}; render();
  },
  tgtSwitch(){ const st=$('tg-store')?$('tg-store').value:''; const mo=$('tg-month')?$('tg-month').value:''; S.modal={type:'target', store:st, month:mo||S.modal.month}; render(); },
  tgtFill(){ const pct=Number($('tg-pct')&&$('tg-pct').value)||100;
    document.querySelectorAll('[id^="tg-d-"]').forEach(i=>{ const ly=Number(i.dataset.ly)||0; if(ly>0) i.value=Math.round(ly*pct/100/1000)*1000; }); this.tgtRecalc(); },
  tgtClear(){ document.querySelectorAll('[id^="tg-d-"]').forEach(i=>{ i.value=''; }); this.tgtRecalc(); },
  tgtRecalc(){ let t=0; document.querySelectorAll('[id^="tg-d-"]').forEach(i=>{ const v=Number(String(i.value).trim()); if(v>0) t+=v; });
    const el=$('tg-total'); if(!el) return; el.textContent=yen(t);
    const ly=Number(el.dataset.ly)||0, cmp=$('tg-total-cmp');
    if(cmp) cmp.textContent=ly>0?('／ 昨年同曜日合計 '+yen(ly)+'（'+(t>0?(t/ly*100).toFixed(0)+'%）':'—）')):''; },
  async saveTargetInput(){
    const msg=$('tg-msg');
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ保存できます（デモモードでは保存不可）'; return; }
    const store=$('tg-store').value, month=$('tg-month').value;
    if(!store||!/^\d{4}-\d{2}$/.test(month)){ msg.textContent='店舗と対象月を確認してください'; return; }
    const daily=[];
    document.querySelectorAll('[id^="tg-d-"]').forEach(i=>{ const d2=Number(i.id.replace('tg-d-','')); const v=String(i.value).trim(); daily.push([d2, v===''?'':Number(v)||0]); });
    const g=(id)=>{ const v=String($(id)&&$(id).value||'').trim(); return v===''?'':Number(v)||0; };
    msg.style.color='#8c8375'; msg.textContent='保存中…';
    try{
      const d=await api({ action:'saveTargets', token:S.auth.token, store, month,
        daily:JSON.stringify(daily), pa:g('tg-pa'), emp:g('tg-emp'), cost:g('tg-cost'), dinii:g('tg-dinii'), review:g('tg-review') });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
      S.modal=null; S.tMonth=month; toast('目標を保存しました');
      await fetchData(true,{ only:['目標','目標月次'], partial:true }); render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  openTargetDay(store,date){ S.modal={type:'targetDay', store, date}; render(); },
  async saveTargetDay(){
    const msg=$('td-msg'); const m=S.modal;
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ保存できます'; return; }
    const v=String($('td-goal')&&$('td-goal').value||'').trim();
    msg.style.color='#8c8375'; msg.textContent='保存中…';
    try{
      const d=await api({ action:'saveTargetDay', token:S.auth.token, store:m.store, date:m.date, goal:v });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
      S.modal=null; toast(v===''?'この日の目標を削除しました':'目標を更新しました');
      await fetchData(true,{ only:['目標'], partial:true }); render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  csvSection(prefix){ downloadCsvSection(prefix); },
  /* ---- 口座CSVインポート（入金管理） ---- */
  /* ---- 週報 ---- */
  wkSearch(v){
    S.wkFQ=v; render();
    const el=$('wa-q'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); }
  },
  wkNav(d){
    if(d===0){ S.wkWeek=''; render(); return; }
    const cur=wkCurrent(); const n=addD(cur,d*7);
    S.wkWeek=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
    render();
  },
  async saveWeekly(){
    const msg=$('wk-msg');
    const s=wkCurrent();
    const tpl=wkTemplateFor(wkMyPosition());
    const answers=[]; 
    for(let i=0;i<tpl.length;i++){
      const el=$('wk-'+i); const v=el?el.value.trim():'';
      if(tpl[i].required&&!v){ msg.style.color='#b5502f'; msg.textContent='「'+tpl[i].label+'」は必須です'; return; }
      answers.push({ order:i+1, label:tpl[i].label, value:v });
    }
    const week=s.getFullYear()+'-'+String(s.getMonth()+1).padStart(2,'0')+'-'+String(s.getDate()).padStart(2,'0');
    const store=selStoreName()||scopeStores()[0]||'';
    if(!(S.auth&&S.auth.token)){ msg.style.color='#b5502f'; msg.textContent='API未接続のため保存できません（デモモード）'; return; }
    msg.style.color='#8c8375'; msg.textContent='保存中…';
    try{
      const d=await api({ action:'saveWeekly', token:S.auth.token, week, store, position:wkMyPosition(), answers:JSON.stringify(answers) });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
      msg.textContent=''; toast('週報を保存しました'); fetchDataFast();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  async saveFeedback(reportId){
    const el=$('fb-'+reportId); const body=el?el.value.trim():'';
    if(!body){ toast('フィードバックを入力してください'); return; }
    if(!(S.auth&&S.auth.token)){ toast('API未接続のため保存できません（デモモード）'); return; }
    try{
      const d=await api({ action:'saveFeedback', token:S.auth.token, reportId, body });
      if(!d.ok){ toast(d.error||'保存に失敗しました'); return; }
      el.value=''; toast('フィードバックを送信しました'); fetchDataFast();
    }catch(e){ toast('通信エラー: '+e.message); }
  },
  /* ---- 招待リンク ---- */
  openInvite(){ if(!isAdminRole())return; S.modal={type:'invite',data:null}; render(); },
  async createInvite(){
    const msg=$('iv-msg');
    const role=$('iv-role').value, position=$('iv-pos').value.trim(), days=$('iv-days').value;
    const count=$('iv-count')?$('iv-count').value:1;
    const checked=[...$('iv-stores').querySelectorAll('input:checked')].map(i=>i.value);
    const stores=(role==='社長'||role==='本部')?'全店':(checked.includes('全店')?'全店':checked.join(', '));
    if(!stores){ msg.style.color='#b5502f'; msg.textContent='担当店舗を選択してください'; return; }
    if(!(S.auth&&S.auth.token)){ msg.style.color='#b5502f'; msg.textContent='API未接続のため発行できません（デモモード）'; return; }
    msg.style.color='#8c8375'; msg.textContent='発行中…';
    try{
      const d=await api({ action:'createInvite', token:S.auth.token, role, position, stores, days, count });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'発行に失敗しました'; return; }
      const base=location.origin+location.pathname+'?invite=';
      const urls=(d.tokens&&d.tokens.length?d.tokens:[d.token]).map(t=>base+t);
      S.modal={type:'invite',data:{ urls, expires:d.expires, role, position, stores }};
      render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  copyInvite(){ const el=$('iv-url'); if(el){ el.select(); document.execCommand('copy'); toast('招待リンクをコピーしました'); } },
  async doRegister(){
    const msg=$('rg-msg');
    const id=$('rg-id').value.trim(), pw=$('rg-pw').value, pw2=$('rg-pw2').value, name=$('rg-name').value.trim();
    if(!id||!pw||!name){ msg.textContent='すべて入力してください'; return; }
    if(pw.length<8){ msg.textContent='パスワードは8文字以上にしてください'; return; }
    if(pw!==pw2){ msg.textContent='パスワードが一致しません'; return; }
    msg.style.color='#8c8375'; msg.textContent='登録中…';
    try{
      const d=await api({ action:'registerFromInvite', token:S.invite.token, id, pw, name });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'登録に失敗しました'; return; }
      S.invite=null; S.inviteDone=true; render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  openDepositImport(){ if(!requireFeature('depositImport'))return; DEP_IMPORT={rows:[],file:''}; S.modal={type:'depImport'}; render(); },
  async depFileChosen(inp){
    const msg=$('dp-msg'); msg.textContent='';
    const f=inp.files&&inp.files[0]; if(!f) return;
    try{
      const buf=await f.arrayBuffer();
      let text=new TextDecoder('utf-8',{fatal:false}).decode(buf);
      if(text.indexOf('�')>=0) text=new TextDecoder('shift-jis').decode(buf);  // 銀行CSVはShift_JISが多い
      const r=depParseCsv(text);
      if(r.error){ DEP_IMPORT={rows:[],file:''}; msg.textContent=r.error; this.depPreview(); return; }
      DEP_IMPORT={rows:r.rows, file:f.name};
      this.depPreview();
    }catch(e){ msg.textContent='ファイルを読み込めませんでした: '+e.message; }
  },
  // プレビュー描画（ATMフィルタを反映）。取込対象の件数・合計もここで表示
  depPreview(){
    const box=$('dp-preview'), runBtn=$('dp-run'); if(!box) return;
    const atmOnly=$('dp-atm')&&$('dp-atm').checked;
    const isAtm=(d2)=>String(d2||'').normalize('NFKC').toUpperCase().indexOf('ATM')>=0;
    const rows=DEP_IMPORT.rows.filter(r=>!atmOnly||isAtm(r.desc));
    if(!DEP_IMPORT.rows.length){ box.innerHTML='<div class="empty" style="padding:14px;font-size:12.5px">CSVファイルを選択してください</div>'; if(runBtn)runBtn.disabled=true; return; }
    if(!rows.length){ box.innerHTML='<div class="empty" style="padding:14px;font-size:12.5px">ATM入金の行がありません（チェックを外すと全入金行が対象になります）</div>'; if(runBtn)runBtn.disabled=true; return; }
    const toks=depTokenize(rows);
    const total=toks.reduce((s,r)=>s+r.amt,0);
    let h2=`<div style="font-size:12.5px;font-weight:700;color:#3d5163;margin-bottom:4px">取込対象 ${toks.length}件 ／ 合計 ${yen(total)} <span class="mut" style="font-weight:400">（${esc(DEP_IMPORT.file)}）</span></div>
      <div class="scroll-x" style="max-height:220px;overflow-y:auto;border:1px solid var(--line2);border-radius:8px">
      <table class="tbl"><thead><tr><th>日付</th><th>入金額</th><th>摘要</th><th>識別（取引時刻/残高）</th></tr></thead><tbody>`;
    toks.slice(0,300).forEach(r=>{ const dt=new Date(r.t);
      h2+=`<tr><td style="white-space:nowrap">${dt.getFullYear()}/${dt.getMonth()+1}/${dt.getDate()}</td><td style="text-align:right">${yen(r.amt)}</td><td style="font-size:11px">${esc(r.desc)}</td><td class="mut" style="font-size:11px">${esc(r.token)}</td></tr>`; });
    h2+=`</tbody></table></div>
      <div class="mut" style="font-size:11px;margin-top:3px">※「識別」は入金DBの取引時刻列に入る値。時刻が無いCSVは残高で同日同額を区別します（既存のCSV取込と同じ方式）。</div>`;
    if(rows.length>300) h2+=`<div class="mut" style="font-size:11px;margin-top:3px">※プレビューは300件まで表示（取込は全${rows.length}件）</div>`;
    box.innerHTML=h2; if(runBtn)runBtn.disabled=false;
  },
  async runDepositImport(){
    const msg=$('dp-msg');
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ取込できます（デモモードでは不可）'; return; }
    const store=$('dp-store')&&$('dp-store').value;
    if(!store){ msg.textContent='店舗を選択してください'; return; }
    const atmOnly=$('dp-atm')&&$('dp-atm').checked;
    const isAtm=(d2)=>String(d2||'').normalize('NFKC').toUpperCase().indexOf('ATM')>=0;
    const rows=depTokenize(DEP_IMPORT.rows.filter(r=>!atmOnly||isAtm(r.desc)));
    if(!rows.length){ msg.textContent='取込対象の行がありません'; return; }
    const payload=rows.map(r=>{ const dt=new Date(r.t);
      return [dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0'), r.amt, r.desc, r.token]; });
    const runBtn=$('dp-run'); if(runBtn)runBtn.disabled=true;
    msg.style.color='#8c8375'; msg.textContent='取込中…（'+rows.length+'件）';
    try{
      const d=await api({ action:'importDeposits', token:S.auth.token, store, rows:JSON.stringify(payload) });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'取込に失敗しました'; if(runBtn)runBtn.disabled=false; return; }
      S.modal=null;
      toast(`入金 ${d.added}件を取り込みました`+(d.dup>0?`（重複スキップ ${d.dup}件）`:''));
      await fetchData(true,{ only:['deposit'], partial:true }); render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; if(runBtn)runBtn.disabled=false; }
  },
  /* ---- PL経費入力 ---- */
  openPlInput(){
    if(!requireFeature('plInput'))return;
    const m0=plMonthDate();
    const ym=m0.getFullYear()+'-'+String(m0.getMonth()+1).padStart(2,'0');
    S.modal={type:'plInput', ym, store:selStoreName()||scopeStores()[0]}; render();
  },
  plSwitch(){ const ym=$('pli-ym')&&$('pli-ym').value, st=$('pli-store')&&$('pli-store').value;
    S.modal={type:'plInput', ym:ym||S.modal.ym, store:st||S.modal.store}; render(); },
  // PL表の科目行の「編集」→ その科目が入っている店舗（or 全社共通）の月次編集モーダルを開く
  openPlItemEdit(item){
    const m0=plMonthDate();
    const ym=m0.getFullYear()+'-'+String(m0.getMonth()+1).padStart(2,'0');
    const t0=dayMs(new Date(m0.getFullYear(),m0.getMonth(),1));
    const selN=selStoreName(); const scope=new Set((selN?[selN]:scopeStores()).map(normStore));
    // この月×スコープ内でこの科目を持つ行を探し、その店舗のモーダルを開く（共通経費は__common__）
    const hit=D.pl.find(r=>r.t===t0&&r.item===item&&(!String(r.store).trim()||scope.has(normStore(r.store))));
    let store=selN||scopeStores()[0];
    if(hit) store=String(hit.store).trim()?hit.store:'__common__';
    if(store==='__common__'&&!(S.auth&&(S.auth.account.role==='社長'||S.auth.account.role==='本部'))) store=selN||scopeStores()[0];
    S.modal={type:'plInput', ym, store}; render();
  },
  // 期間一括計上：開始月〜終了月の各月に同じ科目の経費を計上（金額空欄＝期間内のその科目を削除）
  async savePlBulk(){
    const msg=$('plb-msg');
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ保存できます'; return; }
    const ym1=$('plb-ym1').value, ym2=$('plb-ym2').value, store=$('pli-store').value;
    const item=$('plb-item').value.trim(), cat=$('plb-cat').value, memo=$('plb-memo').value.trim();
    const amtRaw=String($('plb-amt').value).trim();
    if(!ym1||!ym2){ msg.textContent='開始月と終了月を指定してください'; return; }
    if(!item){ msg.textContent='勘定科目を入力してください'; return; }
    msg.style.color='#8c8375'; msg.textContent='一括計上中…（PL管理システムにも反映しています）';
    try{
      const d=await api({ action:'savePlBulk', token:S.auth.token, ym1, ym2, store, item, cat, amount:amtRaw, memo });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'一括計上に失敗しました'; return; }
      S.modal=null;
      toast(amtRaw===''?`「${item}」を${d.months}ヶ月分削除しました`:`「${item}」を${d.months}ヶ月分一括計上しました`+(d.plsys?'／'+d.plsys:''));
      await fetchData(true,{ only:['pl','PL'], partial:true }); render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  plGuessCat(inp){ const c=PL_ITEM_CAT[String(inp.value).trim()]; if(c){ const sel=inp.closest('tr').querySelector('.pli-cat'); if(sel)sel.value=c; } },
  plAddRow(){ const tb=$('pli-rows'); if(tb) tb.insertAdjacentHTML('beforeend', plRowHtml('','O','','')); },
  async savePlInput(){
    const msg=$('pli-msg'); const m=S.modal;
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ保存できます'; return; }
    const entries=[];
    document.querySelectorAll('#pli-rows tr').forEach(tr=>{
      const item=tr.querySelector('.pli-item').value.trim();
      const cat=tr.querySelector('.pli-cat').value;
      const amt=Number(tr.querySelector('.pli-amt').value)||0;
      const memo=tr.querySelector('.pli-memo').value.trim();
      if(item&&amt>0) entries.push([item,cat,amt,memo]);
    });
    msg.style.color='#8c8375'; msg.textContent='保存中…（PL管理システムにも反映しています）';
    try{
      const d=await api({ action:'savePlEntries', token:S.auth.token, ym:$('pli-ym').value||m.ym, store:$('pli-store').value||m.store, entries:JSON.stringify(entries) });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
      S.modal=null; toast('経費を保存しました（'+d.saved+'件）'+(d.plsys?'／'+d.plsys:''));
      await fetchData(true,{ only:['pl','PL'], partial:true }); render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  /* ---- 広告費入力 ---- */
  openAdInput(){
    if(!requireFeature('adInput'))return;
    const ref=D.refDate||new Date();
    const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
    const ym=m0.getFullYear()+'-'+String(m0.getMonth()+1).padStart(2,'0');
    const opts=adStoreOptions(); const sel=selStoreName();
    S.modal={type:'adInput', ym, store:(sel&&opts.includes(sel))?sel:opts[0]}; render();
  },
  adSwitch(){ const ym=$('adi-ym')&&$('adi-ym').value, st=$('adi-store')&&$('adi-store').value;
    const md=$('adi-media')&&$('adi-media').value;
    S.modal={type:'adInput', ym:ym||S.modal.ym, store:st||S.modal.store, media:(md&&md!=='__free__')?md:S.modal.media, ym2:$('adi-ym2')&&$('adi-ym2').value||''}; render(); },
  // 媒体を変えたらプランの選択肢を⚙️プランマスタから連動更新（「その他」は自由入力欄を表示）
  adMediaChanged(){
    const sel=$('adi-media'); const free=$('adi-media-free');
    if(sel.value==='__free__'){ if(free)free.style.display='block'; return; }
    if(free)free.style.display='none';
    this.adSwitch();   // 再描画でプラン選択肢を選択媒体に合わせて作り直す
  },
  adPlanChanged(){
    const sel=$('adi-plan'); const free=$('adi-plan-free');
    if(sel.value==='__free__'){ if(free)free.style.display='block'; return; }
    if(free)free.style.display='none';
    const opt=sel.options[sel.selectedIndex]; const fee=Number(opt&&opt.dataset.fee)||0;
    const cost=$('adi-cost'); if(fee>0&&cost&&String(cost.value).trim()==='') cost.value=fee;   // 標準料金をプリセット（空欄時のみ）
  },
  async saveAdInput(){
    const msg=$('adi-msg');
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ保存できます'; return; }
    const ym=$('adi-ym').value, ymTo=$('adi-ym2')&&$('adi-ym2').value||'', store=$('adi-store').value;
    let media=$('adi-media').value; if(media==='__free__') media=$('adi-media-free').value.trim();
    let plan=$('adi-plan').value; if(plan==='__free__') plan=$('adi-plan-free').value.trim();
    const memo=$('adi-memo').value.trim();
    const costRaw=String($('adi-cost').value).trim();
    if(!media){ msg.textContent='媒体を入力してください'; return; }
    const btn=$('adi-run'); if(btn)btn.disabled=true;
    msg.style.color='#8c8375'; msg.textContent='保存中…（管理シートの💾広告費DBに反映しています）';
    try{
      const d=await api({ action:'saveAdFee', token:S.auth.token, ym, ymTo, store, media, plan, cost:costRaw, memo });
      if(btn)btn.disabled=false;
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
      const period=d.months>1?(`${ym.replace('-','/')}〜${ymTo.replace('-','/')}・${d.months}ヶ月分`):'';
      msg.style.color='#4c7d5c';
      msg.textContent=d.deleted?('✓ 削除しました（'+media+(plan?'・'+plan:'')+(period?'・'+period:'')+'）')
        :('✓ 保存しました（'+media+(plan?'・'+plan:'')+' '+yen(Number(costRaw)||0)+(period?' × '+period:'')+'）。続けて入力できます');
      $('adi-cost').value=''; $('adi-memo').value='';
      fetchData(true,{ only:['広告'], partial:true }).then(()=>{ if(S.modal&&S.modal.type!=='adInput') render(); });
    }catch(e){ if(btn)btn.disabled=false; msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  /* ---- 売上入力（広告管理・💾売上DB） ---- */
  openAdSales(){
    if(!requireFeature('adSales'))return;
    const ref=D.refDate||new Date();
    const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
    const ym=m0.getFullYear()+'-'+String(m0.getMonth()+1).padStart(2,'0');
    const opts=adStoreOptions(); const sel=selStoreName();
    S.modal={type:'adSales', ym, store:(sel&&opts.includes(sel))?sel:opts[0]}; render();
  },
  adSalesSwitch(){
    S.modal={type:'adSales', ym:$('as-ym')&&$('as-ym').value||S.modal.ym,
      store:$('as-store')&&$('as-store').value||S.modal.store, media:$('as-media')&&$('as-media').value||S.modal.media}; render();
  },
  async saveAdSales(){
    const msg=$('as-msg');
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ保存できます'; return; }
    const ym=$('as-ym').value, store=$('as-store').value, media=$('as-media').value;
    if(!media){ msg.textContent='媒体を選択してください（⚙️媒体マスタが未受信の可能性があります）'; return; }
    const vals={}; AD_SALES_FIELDS.forEach(f=>{ vals[f.k]=String($('as-'+f.k).value).trim(); });
    vals.fee=String($('as-fee').value).trim();
    const btn=$('as-run'); if(btn)btn.disabled=true;
    msg.style.color='#8c8375'; msg.textContent='保存中…（管理シートの💾売上DBに反映しています）';
    try{
      const d=await api({ action:'saveAdSales', token:S.auth.token, ym, store, media, values:JSON.stringify(vals) });
      if(btn)btn.disabled=false;
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
      msg.style.color='#4c7d5c'; msg.textContent='✓ '+(d.updated?'上書き保存':'追加')+'しました（'+esc(media)+'）。続けて別の媒体も入力できます';
      fetchData(true,{ only:['広告効果'], partial:true }).then(()=>{ if(S.modal&&S.modal.type==='adSales') render(); });
    }catch(e){ if(btn)btn.disabled=false; msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  /* ---- 予約CSV取込 ---- */
  openRsvImport(){ if(!requireFeature('rsvImport'))return; RSV_IMPORT={rows:[],file:''}; S.modal={type:'rsvImport'}; render(); },
  async rsvFileChosen(inp){
    const msg=$('rv-msg'); msg.textContent='';
    const f=inp.files&&inp.files[0]; if(!f) return;
    try{
      const buf=await f.arrayBuffer();
      let text=new TextDecoder('utf-8',{fatal:false}).decode(buf);
      if(text.indexOf('�')>=0) text=new TextDecoder('shift-jis').decode(buf);
      const r=rsvParseCsv(text);
      if(r.error){ RSV_IMPORT={rows:[],file:''}; msg.textContent=r.error; this.rsvPreview(); return; }
      RSV_IMPORT={rows:r.rows, file:f.name};
      // 経路（受付窓口）ごとのチェックボックスを生成（既定は全て取込）
      const wins={}; r.rows.forEach(x=>{ const k=x.win||'（経路なし）'; wins[k]=(wins[k]||0)+1; });
      $('rv-wins').innerHTML='<div style="font-size:11.5px;color:#8c8375;margin-bottom:3px">取り込む経路（受付窓口）：</div>'+
        Object.entries(wins).map(([k,n])=>`<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:0 10px 4px 0;cursor:pointer"><input type="checkbox" class="rv-win" value="${esc(k)}" checked onchange="App.rsvPreview()">${esc(k)}（${n}件）</label>`).join('');
      this.rsvPreview();
    }catch(e){ msg.textContent='ファイルを読み込めませんでした: '+e.message; }
  },
  rsvSelectedRows(){
    const on=new Set([...document.querySelectorAll('.rv-win')].filter(c=>c.checked).map(c=>c.value));
    return RSV_IMPORT.rows.filter(r=>on.size===0||on.has(r.win||'（経路なし）'));
  },
  rsvPreview(){
    const box=$('rv-preview'), btn=$('rv-run'); if(!box) return;
    if(!RSV_IMPORT.rows.length){ box.innerHTML='<div class="empty" style="padding:14px;font-size:12.5px">CSVファイルを選択してください</div>'; if(btn)btn.disabled=true; return; }
    const rows=this.rsvSelectedRows();
    if(!rows.length){ box.innerHTML='<div class="empty" style="padding:14px;font-size:12.5px">取込対象の経路が選ばれていません</div>'; if(btn)btn.disabled=true; return; }
    const ppl=rows.reduce((s,r)=>s+r.n,0);
    let h2=`<div style="font-size:12.5px;font-weight:700;color:#3d5163;margin-bottom:4px">取込対象 ${rows.length}件 ／ ${cnt(ppl)}人 <span class="mut" style="font-weight:400">（${esc(RSV_IMPORT.file)}）</span></div>
      <div class="scroll-x" style="max-height:200px;overflow-y:auto;border:1px solid var(--line2);border-radius:8px">
      <table class="tbl"><thead><tr><th>来店日</th><th>時間</th><th>人数</th><th>経路</th><th>ステータス</th><th>作成日</th></tr></thead><tbody>`;
    rows.slice(0,300).forEach(r=>{ h2+=`<tr><td style="white-space:nowrap">${esc(r.d)}</td><td>${esc(r.tm)}</td><td style="text-align:right">${r.n||''}</td><td style="font-size:11px">${esc(r.win)}</td><td style="font-size:11px">${esc(r.st)}</td><td class="mut" style="font-size:11px">${esc(r.cd)}</td></tr>`; });
    h2+=`</tbody></table></div>`;
    if(rows.length>300) h2+=`<div class="mut" style="font-size:11px;margin-top:3px">※プレビューは300件まで表示（取込は全${rows.length}件）</div>`;
    box.innerHTML=h2; if(btn)btn.disabled=false;
  },
  async runRsvImport(){
    const msg=$('rv-msg');
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ取込できます'; return; }
    const store=$('rv-store')&&$('rv-store').value;
    if(!store){ msg.textContent='店舗を選択してください'; return; }
    const rows=this.rsvSelectedRows();
    if(!rows.length){ msg.textContent='取込対象の行がありません'; return; }
    const payload=rows.map(r=>[r.no,r.d,r.tm,r.n,r.st,r.win,r.cd,r.ct]);
    const btn=$('rv-run'); if(btn)btn.disabled=true;
    msg.style.color='#8c8375'; msg.textContent='取込中…（'+rows.length+'件）';
    try{
      const d=await api({ action:'importReservations', token:S.auth.token, store, rows:JSON.stringify(payload) });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'取込に失敗しました'; if(btn)btn.disabled=false; return; }
      S.modal=null;
      toast(`予約 ${d.added}件を取り込みました`+(d.dup>0?`（重複スキップ ${d.dup}件）`:''));
      await fetchData(true,{ only:['予約'], partial:true }); render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; if(btn)btn.disabled=false; }
  },
  openEventInput(id){ S.modal={type:'event', id:id||''}; render(); },
  async saveEventInput(){
    const msg=$('ev-msg');
    if(!S.auth||!S.auth.token){ msg.textContent='スプレッドシート接続時のみ保存できます'; return; }
    const date=$('ev-date').value, name=$('ev-name').value.trim(), venue=$('ev-venue').value.trim(), memo=$('ev-memo').value.trim();
    const stores=[...$('ev-stores').querySelectorAll('input:checked')].map(i=>i.value).join(', ');
    if(!date||!name){ msg.textContent='日付とイベント名を入力してください'; return; }
    msg.style.color='#8c8375'; msg.textContent='保存中…';
    try{
      const d=await api({ action:'saveEvent', token:S.auth.token, id:S.modal.id||'', date, name, venue, stores, memo });
      if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
      S.modal=null; toast('イベントを保存しました');
      await fetchData(true,{ only:['イベント'], partial:true }); render();
    }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
  },
  async deleteEventBtn(id){
    if(!confirm('このイベントを削除しますか？')) return;
    try{
      const d=await api({ action:'deleteEvent', token:S.auth.token, id });
      if(!d.ok){ toast(d.error||'削除に失敗しました'); return; }
      S.modal=null; toast('イベントを削除しました');
      await fetchData(true,{ only:['イベント'], partial:true }); render();
    }catch(e){ toast('通信エラー: '+e.message); }
  },
  refresh(){ if(S.auth&&S.auth.token){ fetchDataFast(); toast('最新データを取得中…'); } else { loadSampleData(); render(); toast('サンプルデータを再読込しました（API未接続）'); } },
  csv: downloadCsv,
  pdf: downloadPdf,
  openConnect(){ if(S.auth && S.auth.account.role!=='社長'){ toast('接続設定は社長のみ変更できます'); return; } S.modal='connect'; render(); },
  closeModal(){ S.modal=null; render(); },
  roleHint(r){ const el=$('ac-role-hint'); if(el)el.textContent=roleHintText(r);
    const box=$('ac-tabs');   // 権限を変えたらタブ選択をその権限の既定に戻す（そこから個別調整できる）
    if(box){ const def=(ROLE_TABS[r]||ROLE_TABS['店舗']).filter(k=>k!=='accounts');
      box.querySelectorAll('input').forEach(i=>{ i.checked=def.includes(i.value); i.parentElement.classList.toggle('on',i.checked); }); } },
  toggleZen(cb){
    const box=$('ac-stores');
    box.querySelectorAll('input').forEach(i=>{ if(i.value!=='全店'){ i.checked=false; i.parentElement.classList.remove('on'); i.disabled=cb.checked; } });
    cb.parentElement.classList.toggle('on',cb.checked);
  },
  async testConnect(){
    const url=$('cn-url').value.trim(); const msg=$('cn-msg');
    if(!url){ msg.textContent='URLを入力してください'; msg.style.color='#b5502f'; return; }
    msg.textContent='接続テスト中…'; msg.style.color='#8c8375';
    try{
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'ping'})});
      const d=await r.json();
      if(d&&d.ok){ msg.textContent='✓ 接続に成功しました（'+(d.time||'')+'）'; msg.style.color='#4c7d5c'; }
      else { msg.textContent='応答はありますがAPI形式が不正です。Code.gsのデプロイを確認してください'; msg.style.color='#b5502f'; }
    }catch(e){ msg.textContent='接続できません: '+e.message; msg.style.color='#b5502f'; }
  },
  saveConnect(){
    const url=$('cn-url').value.trim();
    const poll=$('cn-poll').value;
    const months=$('cn-months')?$('cn-months').value:'24';
    try{
      if(url) localStorage.setItem(LS.api,url); else localStorage.removeItem(LS.api);
      localStorage.setItem(LS.poll,poll);
      localStorage.setItem(LS.months,months);
    }catch(e){}
    S.modal=null;
    toast(url?'接続設定を保存しました。ログインし直すとシートのアカウントで認証されます':'接続を解除しました');
    if(S.auth&&S.auth.token){ S.dataVersion=''; fetchDataFast(); startPolling(); }
    render();
  },
  disconnect(){
    try{ localStorage.removeItem(LS.api); }catch(e){}
    S.connState='demo'; S.modal=null;
    if(S.auth&&S.auth.token){ doLogout('接続を解除しました。デモアカウントでログインできます'); }
    else render();
    toast('接続を解除しました');
  },
  editAccount(id){
    const live=!!(S.auth&&S.auth.token);
    const list=live?(S.accounts||[]):demoAccounts();
    const data=id?list.find(a=>a.id===id):null;
    S.modal={ type:'account', id:id||'', data };
    render();
  },
  async saveAccount(){
    const msg=$('ac-msg');
    const isNew=!S.modal.id;
    const id=(isNew?$('ac-id').value:S.modal.id).trim();
    const name=$('ac-name').value.trim()||id;
    const pw=$('ac-pw').value;
    const role=$('ac-role').value;
    const active=$('ac-active').value;
    const memo=$('ac-memo').value;
    const position=($('ac-position')?$('ac-position').value:'').trim();
    let stores;
    if(role==='社長'||role==='本部') stores='全店';
    else{
      const checked=[...$('ac-stores').querySelectorAll('input:checked')].map(i=>i.value);
      if(checked.includes('全店')) stores='全店';
      else stores=checked.join(', ');
    }
    // 表示タブ：権限の既定と同じなら空（＝既定に追従）、変えていればカンマ区切りで保存
    const tabsChecked=[...$('ac-tabs').querySelectorAll('input:checked')].map(i=>i.value);
    const defTabs=(ROLE_TABS[role]||ROLE_TABS['店舗']).filter(k=>k!=='accounts');
    const tabs=(tabsChecked.length===defTabs.length&&tabsChecked.every(k=>defTabs.includes(k)))?'':tabsChecked.join(',');
    // 使える機能：権限の既定と同じなら空（＝既定に追従）、1つも無いなら'なし'（既定に戻らないよう明示）
    const permsChecked=[...$('ac-perms').querySelectorAll('input:checked')].map(i=>i.value);
    const defPerms=ROLE_FEATURES[role]||[];
    const sameAsDefault=permsChecked.length===defPerms.length&&permsChecked.every(k=>defPerms.includes(k));
    const perms=sameAsDefault?'':(permsChecked.length?permsChecked.join(','):'なし');
    if(!id){ msg.textContent='ログインIDを入力してください'; return; }
    if(!stores){ msg.textContent='担当店舗を1つ以上選択してください'; return; }
    if(!tabsChecked.length){ msg.textContent='表示するタブを1つ以上選択してください'; return; }
    const live=!!(S.auth&&S.auth.token);
    if(live){
      msg.style.color='#8c8375'; msg.textContent='保存中…';
      try{
        const d=await api({ action:'saveAccount', token:S.auth.token, accountId:id, pw, name, role, stores, active, memo, tabs, perms, position });
        if(!d.ok){ msg.style.color='#b5502f'; msg.textContent=d.error||'保存に失敗しました'; return; }
        S.accounts=null; S.modal=null; toast('アカウントを保存しました'); render();
      }catch(e){ msg.style.color='#b5502f'; msg.textContent='通信エラー: '+e.message; }
      return;
    }
    // デモモード
    const list=demoAccounts();
    const ex=list.find(a=>a.id===id);
    if(isNew&&ex){ msg.textContent='このIDは既に存在します'; return; }
    if(isNew&&!pw){ msg.textContent='新規アカウントにはパスワードが必要です'; return; }
    if(ex){ ex.name=name; if(pw)ex.pw=pw; ex.role=role; ex.stores=stores; ex.active=active!=='FALSE'; ex.memo=memo; ex.tabs=tabs; ex.perms=perms; ex.position=position; }
    else list.push({ id, pw, name, role, stores, active:active!=='FALSE', memo, tabs, perms, position });
    saveDemoAccounts(list);
    S.modal=null; toast('アカウントを保存しました（デモ：このブラウザのみ）'); render();
  },
  async deleteAccount(id){
    if(!confirm('アカウント「'+id+'」を削除しますか？')) return;
    const live=!!(S.auth&&S.auth.token);
    if(live){
      try{
        const d=await api({ action:'deleteAccount', token:S.auth.token, accountId:id });
        if(!d.ok){ toast(d.error||'削除に失敗しました'); return; }
        S.accounts=null; S.modal=null; toast('削除しました'); render();
      }catch(e){ toast('通信エラー: '+e.message); }
      return;
    }
    const list=demoAccounts().filter(a=>a.id!==id);
    saveDemoAccounts(list);
    S.modal=null; toast('削除しました'); render();
  },
};

/* ---------------- 起動 ---------------- */
(function init(){
  loadSampleData();
  // URLパラメータ ?report=daily|weekly|monthly(&date=YYYY-MM-DD) でレポートカード表示（Lark日報の撮影用）
  // 招待リンク（?invite=トークン）→ 登録画面。ログインより先に判定する
  try{
    const iq=new URLSearchParams(location.search).get('invite');
    if(iq){
      S.invite={ token:iq, loading:true };
      api({ action:'checkInvite', token:iq }).then(d=>{
        S.invite = d.ok ? { token:iq, role:d.role, position:d.position, stores:d.stores }
                        : { token:iq, error:d.error||'このリンクは使用できません' };
        render();
      }).catch(e=>{ S.invite={ token:iq, error:'通信エラー: '+e.message }; render(); });
    }
  }catch(e){}
  try{
    const q=new URLSearchParams(location.search);
    if(q.get('report')) S.reportMode={ kind:q.get('report'), date:q.get('date')||'',
      stores:q.get('stores')?q.get('stores').split(',').map(s2=>s2.trim()).filter(Boolean):null, group:q.get('group')||'' };
  }catch(e){}
  try{
    const raw=localStorage.getItem(LS.sess);
    if(raw){
      const sess=JSON.parse(raw);
      if(sess&&sess.account){
        if(sess.token&&apiUrl()){ S.auth=sess; S.connState='connecting'; fetchDataFast(); startPolling(); }
        else if(!sess.token&&!apiUrl()){ S.auth=sess; }
      }
    }
  }catch(e){}
  render();
})();
