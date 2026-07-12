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
  '社長':       ['dash','analysis','detail','pl','deposit','ad','review','ai','accounts'],
  '本部':       ['dash','analysis','detail','pl','deposit','ad','review','ai','accounts'],
  'マネージャー':['dash','analysis','detail','pl','deposit','ad','review','ai'],
  '店舗':       ['dash','analysis','detail','pl','deposit','review','ai'],
};
const TAB_LABELS = { dash:'ダッシュボード', analysis:'推移分析', detail:'明細分析', pl:'PL（損益）', deposit:'入金管理', ad:'広告管理', review:'口コミ', ai:'AI検索', accounts:'アカウント管理' };
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
  aiQ:'', aiResult:null, dataVersion:'',
  reportMode:null,   // {kind:'daily'|'weekly'|'monthly', date:'YYYY-MM-DD'} Lark日報用の1枚カード表示
  accounts:null, accErr:'', modal:null, loginErr:'',
};
const D = { daily:[], media:[], deposit:[], review:[], ad:[], adfx:[], tanka:{}, pl:[], dinii:[], diniiCols:[], extra:{}, storeAlias:{}, storeParent:{}, mediaClass:{}, holidays:null, refDate:null, maxDate:null };
let EXPORT = [];      // 現在タブのCSVエクスポート対象 [{title,headers,rows}]
let pollTimer = null;

/* ---------------- 共通ユーティリティ ---------------- */
const $ = (id)=>document.getElementById(id);
const esc = (s)=>String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen = (n)=>'¥'+Math.round(n||0).toLocaleString('ja-JP');
const num = (v)=>parseFloat(String(v==null?'':v).replace(/[^0-9.\-]/g,''))||0;
const cnt = (n)=>Math.round(n||0).toLocaleString('ja-JP');
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
        iEmpBase=colAny(H,['社員給与賞与']), iWelf=colAny(H,['法定福利費']), iComm=colAny(H,['通勤手当']);
  if(iD<0||iS<0||iSl<0){ D.diag.daily='列が見つかりません（必要: 店舗名・日付/営業日・純売上）'; return false; }
  const recs=[]; let max=0;
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const st=String(c[iS]||'').trim(); const t=parseDateStr(c[iD]);
    if(!st||!t) continue;
    recs.push({ store:st, t, sales:num(c[iSl]), guests:num(c[iG]), pa:num(c[iPA]), emp:num(c[iEmp]), labor:num(c[iL]), cost:num(c[iC]), cash:num(c[iCash]),
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
  if(iD<0||(iA<0&&iG<0)){ D.diag['広告効果']='列が見つかりません（必要: 年月・アクセス数または予約組数）／見出し行: '+H.filter(Boolean).join('|'); return false; }
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i];
    const t=parseDateStr(c[iD])||parseYm(c[iD]); if(!t)continue;
    const access=iA>=0?num(c[iA]):0, grp=iG>=0?num(c[iG]):0, ppl=iP>=0?num(c[iP]):0, tel=iT>=0?num(c[iT]):0;
    if(!(access||grp||ppl||tel))continue;
    recs.push({ store:String(iS>=0?c[iS]||'':'').trim(), t, media:String(iM>=0?c[iM]||'':'').trim(), access, grp, ppl, tel });
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
  if(iD<0||iI<0||iA<0){ D.diag['PL']='列が見つかりません（必要: 年月・勘定科目・金額）／見出し行: '+H.filter(Boolean).join('|'); return false; }
  const recs=[]; let dateSkipped=0;
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i];
    const item=String(c[iI]||'').trim(); if(!item) continue;
    const t0=parseYm(c[iD])||parseDateStr(c[iD]);
    if(!t0){ dateSkipped++; continue; }
    const d=new Date(t0);
    recs.push({ store:String(iS>=0?c[iS]||'':'').trim(), t:new Date(d.getFullYear(),d.getMonth(),1).getTime(), item, cat:iK>=0?plCatOf(c[iK]):'O', amount:num(c[iA]) });
  }
  if(!recs.length){ D.diag['PL']='0件'+(dateSkipped>0?'（'+dateSkipped+'行あるが年月を読めていません）':'（データ行がありません）'); return false; }
  D.pl=recs; D.diag['PL']='OK '+recs.length+'件'; return true;
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
  if(!partial){ D.extra={}; D.diag={}; D.receivedKeys=Object.keys(sheets); D.ad=[]; D.adSrc=''; D.adfx=[]; D.tanka={}; D.rsv=[]; D.pl=[]; D.dinii=[]; D.storeAlias={}; D.storeParent={}; }  // 広告・PL・ダイニー・対応表・親子はフル受信のたびに入れ替え
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
    else if(isHolidayKey(key)) ingestHoliday(rows);
    else if(isStoreParentKey(key)){ D.storeParent=ingestStoreParent(rows); D.diag[key]='OK '+Object.keys(D.storeParent).length+'件の親子'; }
    else if(isStoreMapKey(key)){ D.storeAlias=ingestStoreMap(rows); D.diag[key]='OK '+Object.keys(D.storeAlias).length+'件の対応'; }
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
function myTabs(){
  const acc=S.auth&&S.auth.account;
  return ROLE_TABS[acc&&acc.role]||ROLE_TABS['店舗'];
}
function isAdminRole(){ const a=S.auth&&S.auth.account; return a&&(a.role==='社長'||a.role==='本部'); }
function selStoreName(){ return S.store==='all'?null:S.store; }

/* ---------------- 集計 ---------------- */
function stat(setNames, a, b, selName){
  const o={sales:0,guests:0,cost:0,pa:0,emp:0,labor:0,cash:0,empBase:0,welfare:0,commute:0};
  for(const r of D.daily){
    if(r.t<a||r.t>b) continue;
    if(selName){ if(r.store!==selName) continue; }
    else if(setNames && !setNames.has(r.store)) continue;
    o.sales+=r.sales; o.guests+=r.guests; o.cost+=r.cost; o.pa+=r.pa; o.emp+=r.emp; o.labor+=r.labor; o.cash+=r.cash;
    o.empBase+=r.empBase||0; o.welfare+=r.welfare||0; o.commute+=r.commute||0;
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
// 初回・更新時：まず軽い必須データ(daily/入金/口コミ)を出し、重い媒体別は後から読み込む
async function fetchDataFast(){
  D.mediaPending=true; D.media=[];                // サンプル媒体データを一旦クリア
  await fetchData(true, { exclude:['media'] });   // 必須のみ → すぐ表示
  await fetchData(true, { only:['media'], partial:true }); // 媒体別を裏で追加
  D.mediaPending=false;
  render();
  // data は version を返さないので、初回に一度だけ署名を取得しておく（次の自動更新のムダ取得を防ぐ）
  fetchVersion().then(v=>{ if(v!==null) S.dataVersion=v; });
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
  await fetchData(true);
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
  S.auth={ token:null, account:{ id:acc.id, name:acc.name, role:acc.role, stores:acc.stores } };
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
function csvCell(v){ const s=String(v==null?'':v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function downloadPdf(){ window.print(); }

/* =====================================================================
 * 描画
 * ===================================================================== */
function render(){
  const root=$('root');
  if(!S.auth){ root.innerHTML=viewLogin(); return; }
  if(S.reportMode){ root.innerHTML=viewReport(S.reportMode.kind, S.reportMode.date, S.reportMode.stores, S.reportMode.group); return; }
  EXPORT=[];
  const tabs=myTabs();
  if(!tabs.includes(S.tab)) S.tab=tabs[0];
  let body='';
  if(S.tab==='dash') body=viewDash();
  else if(S.tab==='detail') body=viewDetail();
  else if(S.tab==='analysis') body=viewAnalysis();
  else if(S.tab==='deposit') body=viewDeposit();
  else if(S.tab==='pl') body=viewPL();
  else if(S.tab==='ad') body=viewAd();
  else if(S.tab==='review') body=viewReview();
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
  const kpis=[
    { lb:(S.period==='day'?'日次':S.period==='week'?'週次':S.period==='month'?'月次':S.period==='year'?'累計':'期間')+'売上', vl:yen(Ssl), yy:y1 },
    { lb:'原価率 (F)', vl:Ssl>0?(foodR*100).toFixed(1)+'%':'—', sub:Ssl>0?yen(cur.cost):'', yy:yF },
    { lb:'人件費率 (L)', vl:Ssl>0?(laborR*100).toFixed(1)+'%':'—', sub:Ssl>0?('PA '+yen(cur.pa)+' ／ 社員 '+yen(cur.emp)):'', yy:yL },
    { lb:'FL合計', vl:Ssl>0?(flR*100).toFixed(1)+'%':'—', yy:yFL },
    { lb:'客数', vl:cnt(cur.guests)+'人', yy:yG },
    { lb:'客単価', vl:yen(spend), yy:ySp },
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
  h+=`<div class="kpi-grid">`+kpis.map(k=>`<div class="kpi"><div class="lb">${k.lb}</div><div class="vl">${k.vl}</div>${k.sub?`<div class="yy" style="color:#5c5348;font-weight:600;margin-bottom:2px">${k.sub}</div>`:''}<div class="yy ${k.yy.cls}">${k.yy.t}</div></div>`).join('')+`</div>`;
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
      h+=`<tr class="click" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}"><td>${esc(nm)}</td><td>${yen(s2.mtdSales)}</td><td>${yen(s2.remSales)}</td><td style="font-weight:700">${yen(s2.fSales)}</td><td class="mut">${yen(s2.lyFull)}</td><td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t}</td></tr>`;
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
  <div class="scroll-x"><table class="tbl"><thead><tr><th>日付</th><th>売上</th><th>客数</th><th>客単価</th><th>PA（比率）</th><th>社員（比率）</th><th>原価（比率）</th><th>前年比</th><th>累計差異(対前年)</th></tr></thead><tbody>`;
  const exp=[];
  days.forEach(d=>{
    const t=dayMs(d);
    const c=stat(null,t,t,selName);
    const pv=stat(null,dayMs(addD(d,-364)),dayMs(addD(d,-364)),selName);
    const future=t>maxT;
    if(future){
      h+=`<tr><td class="mut">${mdwH(d)}</td>${'<td class="mut">—</td>'.repeat(8)}</tr>`;
      return;
    }
    cumCur+=c.sales; cumPrev+=pv.sales; tS+=c.sales; tG+=c.guests; tCost+=c.cost; tPa+=c.pa; tEmp+=c.emp;
    const sp=c.guests>0?c.sales/c.guests:0;
    const yy=yoyStr(c.sales,pv.sales,'');
    const cumDiff=cumCur-cumPrev;
    h+=`<tr><td>${mdwH(d)}</td><td>${yen(c.sales)}</td><td>${cnt(c.guests)}人</td><td>${yen(sp)}</td>
      <td>${ap(c.pa,c.sales)}</td><td>${ap(c.emp,c.sales)}</td><td>${ap(c.cost,c.sales)}</td>
      <td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t||'—'}</td>
      <td class="${cumDiff>=0?'pos':'neg'}">${(cumDiff>=0?'+':'▲')+yen(Math.abs(cumDiff)).slice(1)}</td></tr>`;
    const pct=(a2)=>c.sales>0?(a2/c.sales*100).toFixed(1)+'%':'';
    exp.push([mdw(d),Math.round(c.sales),Math.round(c.guests),Math.round(sp),Math.round(c.pa),pct(c.pa),Math.round(c.emp),pct(c.emp),Math.round(c.cost),pct(c.cost),yy.t||'',Math.round(cumDiff)]);
  });
  const tSp=tG>0?tS/tG:0, tDiff=cumCur-cumPrev;
  h+=`<tr class="total"><td>合計</td><td>${yen(tS)}</td><td>${cnt(tG)}人</td><td>${yen(tSp)}</td>
    <td>${ap(tPa,tS)}</td><td>${ap(tEmp,tS)}</td><td>${ap(tCost,tS)}</td><td></td>
    <td class="${tDiff>=0?'pos':'neg'}">${(tDiff>=0?'+':'▲')+yen(Math.abs(tDiff)).slice(1)}</td></tr>`;
  h+=`</tbody></table></div></div>`;
  const tp=(a2)=>tS>0?(a2/tS*100).toFixed(1)+'%':'';
  exp.push(['合計',Math.round(tS),Math.round(tG),Math.round(tSp),Math.round(tPa),tp(tPa),Math.round(tEmp),tp(tEmp),Math.round(tCost),tp(tCost),'',Math.round(tDiff)]);
  EXPORT.push({ title:'日別明細（'+selName+'／'+r.label+'）', headers:['日付','売上','客数','客単価','PA額','PA率','社員額','社員率','原価額','原価率','前年比','累計差異(対前年)'], rows:exp });
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
      <td>${esc(nm)}</td><td>${yen(c.sales)}</td>
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
  h+=`<div class="panel"><div class="panel-head"><h3>明細</h3></div><div class="scroll-x"><table class="tbl"><thead><tr><th>期間</th>${series.map(x=>`<th>${esc(x.name)}</th>`).join('')}${hasYoY?'<th>差異（対前年）</th>':''}</tr></thead><tbody>`;
  buckets.forEach((bk,i)=>{
    const dateCell=bk.dt?mdwH(bk.dt):esc(bk.label);
    h+=`<tr><td>${dateCell}</td>${series.map(x=>`<td>${fmtV(x.data[i])}</td>`).join('')}${hasYoY?`<td>${diffTxt(series[0].data[i]-series[1].data[i])}</td>`:''}</tr>`;
  });
  // 合計行（客単価は加重平均で算出）
  const totOf=(gp)=>val(gp.recs,dayMs(s),dayMs(e));
  const totals=groups.map(gp=>totOf(gp));
  if(hasYoY){
    const prevTot=val(dailyIn,dayMs(sub1y(s)),dayMs(sub1y(e)));
    h+=`<tr class="total"><td>合計</td><td>${fmtV(totals[0])}</td><td>${fmtV(prevTot)}</td><td>${diffTxt(totals[0]-prevTot)}</td></tr>`;
  } else {
    h+=`<tr class="total"><td>合計</td>${totals.map(v=>`<td>${fmtV(v)}</td>`).join('')}</tr>`;
  }
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:ml+'の推移', headers:['期間'].concat(series.map(x=>x.name)).concat(hasYoY?['差異(対前年)']:[]),
    rows:buckets.map((bk,i)=>[bk.label].concat(series.map(x=>Math.round(x.data[i]))).concat(hasYoY?[Math.round(series[0].data[i]-series[1].data[i])]:[])) });
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
function viewDetail(){
  const hourRaw=extraSheet('明細時間帯'), itemRaw=extraSheet('明細商品'), storeRaw=extraSheet('明細店舗');
  let h='';
  if(!hourRaw && !itemRaw && !storeRaw){
    return `<div class="panel"><div class="panel-head"><div><h3>明細分析（BigQuery連携）</h3>
      <div class="sub">Diniiの明細をBigQueryで集計して、時間帯別・商品別を表示します</div></div></div>
      <div class="note-box" style="line-height:1.9">
        BigQueryに明細を投入し、GASを直結すると、ここに<b>店舗別・時間帯別・商品別</b>が表示されます。
        （設定手順書: BigQuery_GAS直結_設定手順.md）
      </div></div>`;
  }
  // 税込/税別トグル（既定=税別。飲食の売上管理は税別が基本）
  const taxExcl=(S.detailTax||'excl')==='excl';
  const taxLb=taxExcl?'税別':'税込';
  // 売上列の取り出し：税別ならsales_excl、無ければsalesにフォールバック
  const salesAt=(header,r)=>{ const ie=hcol(header,'sales_excl'), is=hcol(header,'sales'); const i=taxExcl?(ie>=0?ie:is):(is>=0?is:ie); return num(r[i]); };
  h+=`<div class="ctrl-bar no-print">
    <div class="seg">${[['excl','税別'],['incl','税込']].map(([k,l])=>`<button class="${(S.detailTax||'excl')===k?'on':''}" onclick="App.set('detailTax','${k}')">${l}</button>`).join('')}</div>
    <span class="period-label">明細分析（${taxLb}表記 ／ BigQuery明細）</span>
  </div>
  <div class="note-box no-print" style="margin:4px 0 2px;padding:10px 14px;font-size:11.5px">
    ℹ️ ここはPOS明細の積み上げ（値引き前グロス）で、<b>時間帯・商品・店舗の傾向を見る用</b>です。オフィシャルな売上金額はダッシュボード／PLの日別売上（値引き後ネット）が正となり、数%の差が出ます。
  </div>
`;

  // 取込カバレッジ（月×店舗数×行数）— 薄い月を見つけて後から再取得依頼できる
  const covRaw=extraSheet('明細カバレッジ');
  if(covRaw){
    const g=parseGrid(covRaw); const H=g.header;
    const iMo=hcol(H,'month'), iSt=hcol(H,'stores'), iDy=hcol(H,'days'), iRw=hcol(H,'rows');
    const recs=g.data.map(r=>({ month:String(r[iMo>=0?iMo:0]||'').trim(), stores:num(r[iSt>=0?iSt:1]), days:num(r[iDy>=0?iDy:2]), rows:num(r[iRw>=0?iRw:3]) })).filter(r=>r.month);
    if(recs.length){
      const maxSt=Math.max(...recs.map(r=>r.stores));
      h+=`<div class="panel"><div class="panel-head"><div><h3>取込カバレッジ（月別）</h3>
        <div class="sub">店舗数が少ない月は「取りこぼし or 導入前」。気になる月は再取得を依頼できます（最大 ${maxSt}店）</div></div></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>月</th><th>店舗数</th><th>日数</th><th>明細行数</th><th>状態</th></tr></thead><tbody>`;
      recs.forEach(r=>{
        const full=r.stores>=maxSt;
        const badge=full?'<span class="badge ok">充足</span>':`<span class="badge ng">${maxSt-r.stores}店 不足?</span>`;
        h+=`<tr><td>${esc(r.month)}</td><td class="${full?'':'neg'}">${r.stores}店</td><td>${r.days}日</td><td>${cnt(r.rows)}</td><td>${badge}</td></tr>`;
      });
      h+=`</tbody></table></div></div>`;
      EXPORT.push({ title:'取込カバレッジ', headers:['月','店舗数','日数','明細行数'], rows:recs.map(r=>[r.month,r.stores,r.days,Math.round(r.rows)]) });
    }
  }
  // 店舗別
  if(storeRaw){
    const g=parseGrid(storeRaw); const H=g.header;
    const iSt=hcol(H,'店舗','store','store_id'), iChk=hcol(H,'checks');
    const recs=g.data.map(r=>({ store:String(r[iSt>=0?iSt:0]||'').trim(), sales:salesAt(H,r), checks:num(r[iChk>=0?iChk:2]) })).filter(r=>r.store).sort((a,b)=>b.sales-a.sales);
    if(recs.length){
      const tot=recs.reduce((s,r)=>s+r.sales,0);
      h+=`<div class="panel"><div class="panel-head"><div><h3>店舗別 売上（${taxLb}）</h3><div class="sub">BigQueryの明細を店舗名で集計（DB_店舗ID対応で変換）</div></div></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>売上</th><th>会計数</th><th>会計単価</th><th>構成比</th></tr></thead><tbody>`;
      recs.forEach(r=>{ h+=`<tr><td>${esc(r.store)}</td><td>${yen(r.sales)}</td><td>${cnt(r.checks)}組</td><td>${yen(r.checks>0?r.sales/r.checks:0)}</td><td>${tot>0?(r.sales/tot*100).toFixed(1):'—'}%</td></tr>`; });
      if(recs.length>1) h+=`<tr class="total"><td>全店合計</td><td>${yen(tot)}</td><td>${cnt(recs.reduce((s,r)=>s+r.checks,0))}組</td><td></td><td>100%</td></tr>`;
      h+=`</tbody></table></div></div>`;
      EXPORT.push({ title:'店舗別売上('+taxLb+')', headers:['店舗','売上','会計数','会計単価','構成比'], rows:recs.map(r=>[r.store,Math.round(r.sales),Math.round(r.checks),Math.round(r.checks>0?r.sales/r.checks:0),tot>0?(r.sales/tot*100).toFixed(1)+'%':'']) });
    }
  }
  // 時間帯別
  if(hourRaw){
    const g=parseGrid(hourRaw); const H=g.header;
    const iH=hcol(H,'hour'), iChk=hcol(H,'checks');
    const recs=g.data.map(r=>({ hour:parseInt(String(r[iH>=0?iH:0]).replace(/[^0-9]/g,''),10), sales:salesAt(H,r), checks:num(r[iChk>=0?iChk:2]) })).filter(r=>!isNaN(r.hour));
    const ord=(x)=>(x.hour+18)%24;   // 6時始まりの営業日順
    recs.sort((a,b)=>ord(a)-ord(b));
    const cat=recs.map(r=>r.hour+'時');
    const totalSales=recs.reduce((s,r)=>s+r.sales,0), totalChk=recs.reduce((s,r)=>s+r.checks,0);
    const peak=recs.reduce((m,r)=>r.sales>m.sales?r:m,{sales:-1});
    h+=`<div class="kpi-grid">
      <div class="kpi"><div class="lb">合計売上（${taxLb}）</div><div class="vl">${yen(totalSales)}</div><div class="yy">明細集計</div></div>
      <div class="kpi"><div class="lb">会計数</div><div class="vl">${cnt(totalChk)}組</div><div class="yy">延べ</div></div>
      <div class="kpi"><div class="lb">会計単価</div><div class="vl">${yen(totalChk>0?totalSales/totalChk:0)}</div><div class="yy">${taxLb}・売上÷会計数</div></div>
      <div class="kpi"><div class="lb">ピーク時間帯</div><div class="vl">${peak.sales>=0?peak.hour+'時台':'—'}</div><div class="yy">${peak.sales>=0?yen(peak.sales):''}</div></div>
    </div>`;
    const series=[{name:'売上',color:C_NOW,data:recs.map(r=>r.sales)}];
    h+=`<div class="panel"><div class="panel-head"><div><h3>時間帯別 売上（会計日時ベース・${taxLb}）</h3><div class="sub">営業日順（夕方→深夜）／ 棒＝売上</div></div></div>
      ${barChart(cat,series,{})}
      <div class="scroll-x"><table class="tbl"><thead><tr><th>時間帯</th><th>売上</th><th>会計数</th><th>会計単価</th><th>構成比</th></tr></thead><tbody>`;
    recs.forEach(r=>{ h+=`<tr><td>${r.hour}時台</td><td>${yen(r.sales)}</td><td>${cnt(r.checks)}組</td><td>${yen(r.checks>0?r.sales/r.checks:0)}</td><td>${totalSales>0?(r.sales/totalSales*100).toFixed(1):'—'}%</td></tr>`; });
    h+=`<tr class="total"><td>合計</td><td>${yen(totalSales)}</td><td>${cnt(totalChk)}組</td><td>${yen(totalChk>0?totalSales/totalChk:0)}</td><td>100%</td></tr></tbody></table></div></div>`;
    EXPORT.push({ title:'時間帯別売上('+taxLb+')', headers:['時間帯','売上','会計数','会計単価','構成比'], rows:recs.map(r=>[r.hour+'時台',Math.round(r.sales),Math.round(r.checks),Math.round(r.checks>0?r.sales/r.checks:0),totalSales>0?(r.sales/totalSales*100).toFixed(1)+'%':'']) });
  }
  // 商品別ランキング
  if(itemRaw){
    const g=parseGrid(itemRaw); const H=g.header;
    const iM=hcol(H,'menu','商品'), iQ=hcol(H,'qty');
    const recs=g.data.map(r=>({ menu:String(r[iM>=0?iM:0]||'').trim(), sales:salesAt(H,r), qty:num(r[iQ>=0?iQ:2]) })).filter(r=>r.menu).sort((a,b)=>b.sales-a.sales);
    const maxS=recs.length?recs[0].sales:1;
    h+=`<div class="panel"><div class="panel-head"><div><h3>商品別 売上ランキング（${taxLb}）</h3><div class="sub">明細（メニュー）別の売上・出数</div></div></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>順位</th><th>商品</th><th>売上</th><th>出数</th><th></th></tr></thead><tbody>`;
    recs.slice(0,40).forEach((r,i)=>{
      const pct=Math.round((r.sales/(maxS||1))*100);
      h+=`<tr><td>${i+1}</td><td>${esc(r.menu)}</td><td>${yen(r.sales)}</td><td>${cnt(r.qty)}点</td>
        <td style="min-width:120px"><div style="height:7px;background:#efe9dd;border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#5f7052"></div></div></td></tr>`;
    });
    h+=`</tbody></table></div></div>`;
    EXPORT.push({ title:'商品別ランキング('+taxLb+')', headers:['順位','商品','売上','出数'], rows:recs.map((r,i)=>[i+1,r.menu,Math.round(r.sales),Math.round(r.qty)]) });
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
      h+=`<tr class="click" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}"><td>${esc(nm)}</td><td>${yen(c)}</td><td>${yen(dp)}</td>
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
    return storeSegHtml()+`<div class="panel"><div class="panel-head"><div><h3>広告管理</h3><div class="sub">実データ（DB_広告シート）のみ表示・サンプルは入っていません</div></div></div>
    ${diagBox||`<div class="note-box">
      広告データはまだ接続されていません。スプレッドシートに <code>DB_広告</code> という名前のシートを作り、
      <code>日付</code>（例 2026/07/01）／ <code>店舗名</code> ／ <code>媒体</code> ／ <code>広告費</code> を入力すると、このタブに自動表示されます。<br>
      店舗別・媒体別のROAS（売上÷広告費）・広告費率・12ヶ月推移を表示します。
    </div>`}</div>`+extraSheetsHtml();
  }
  const ref=D.refDate||new Date();
  const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
  const y=m0.getFullYear(),m=m0.getMonth();
  const mS=dayMs(new Date(y,m,1)), mE=dayMs(new Date(y,m+1,0));
  const pS=dayMs(new Date(y,m-1,1)), pE=dayMs(new Date(y,m,0));
  const mLabel=y+'年 '+(m+1)+'月';
  const cur=adAgg(scopeSet,mS,mE), prv=adAgg(scopeSet,pS,pE);
  const totalSales=stat(scopeSet,mS,mE,null).sales;
  const roas=cur.ad>0?cur.medNet/cur.ad:0;
  const pRoas=prv.ad>0?prv.medNet/prv.ad:0;
  const adRate=totalSales>0?cur.ad/totalSales*100:0;
  const profit=cur.medNet-cur.ad;
  const mom=(c,p,invert)=>{ if(!(p>0)) return {t:'前月 —',cls:'mut'}; const d=(c-p)/p*100; const up=d>=0; return { t:'前月比 '+(up?'+':'▲')+Math.abs(d).toFixed(1)+'%', cls:(invert?!up:up)?'up':'dn' }; };
  let h=storeSegHtml();
  h+=`<div class="ctrl-bar no-print">${ymSelect('adMonth', y, m)}
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
    <div class="kpi"><div class="lb">広告費（${m+1}月）</div><div class="vl">${yen(cur.ad)}</div><div class="yy ${kA.cls}">${kA.t}</div></div>
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
    h+=`<tr><td style="${isChild(nm)?'padding-left:22px':''}">${esc(nm)}${tag}</td><td>${yen(o.cost)}</td><td>${yen(o.net)}</td><td>${roasBadge(o.cost,o.net)}</td><td>${sl>0?yen(sl):'—'}</td><td class="${rate>10?'warn':''}">${sl>0?rate.toFixed(1)+'%':'—'}</td></tr>`;
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
  // 12ヶ月推移
  const cat=[],adArr=[],netArr=[],roasArr=[];
  for(let i=11;i>=0;i--){
    const d=new Date(y,m-i,1);
    const a2=dayMs(d), b2=dayMs(new Date(d.getFullYear(),d.getMonth()+1,0));
    const g=adAgg(scopeSet,a2,b2);
    cat.push(String(d.getFullYear()).slice(2)+'/'+(d.getMonth()+1));
    adArr.push(g.ad||null); netArr.push(g.medNet||null); roasArr.push(g.ad>0?g.medNet/g.ad:null);
  }
  const series=[{name:'媒体経由売上',color:'#4c7d5c',data:netArr},{name:'広告費',color:'#b23b2e',data:adArr}];
  const legend=series.map(s=>`<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  h+=`<div class="panel"><div class="panel-head"><div><h3>広告費と媒体経由売上の推移（直近12ヶ月${selN?'・'+esc(selN):''}）</h3>
    <div class="sub">〜${mLabel}</div></div><div class="legend">${legend}</div></div>
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
  const keys=Object.keys(D.extra);
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
    keys.forEach(it=>rows.push({name:it, c:-(exCur.byCat[cat][it]||0), p:-(exPrv.byCat[cat][it]||0), l:-(exLyr.byCat[cat][it]||0), indent:true}));
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
    h+=`<tr class="${r2.line?'total':''}"><td style="${r2.indent?'padding-left:24px;':''}${r2.bold?'font-weight:700':''}">${esc(r2.name)}</td>
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
      h+=`<tr class="click" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}"><td>${esc(nm)}</td><td>${yen(c1.sales)}</td><td>${yen(g1)}</td><td>${yen(l1)}</td><td>${yen(a1)}</td><td>${yen(e1)}</td>
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
  if(isFiltered) sub+='（'+stores.length+'店舗）';
  const data={ kind, title, sub, salesLabel, fileKey, rows, tot, hasDinii, diniiRangeLabel, isFiltered,
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
  // 店舗別バーチャート（売上降順）
  const chartRows=d.rows.filter(r=>r.sales>0||r.prevSales>0);
  const chart=chartRows.length?barChart(chartRows.map(r=>r.store.replace(/[\s　]/,'\n')),
    [{name:'当期',color:'#3d5163',data:chartRows.map(r=>r.sales)},{name:'前年',color:'#c9b7a0',data:chartRows.map(r=>r.prevSales)}],{twoLine:true}):'';
  const salesLabel=kind==='monthly'?'月売上':kind==='weekly'?'週売上':'売上';
  let h=`<div id="report-card" style="width:1080px;margin:0 auto;background:#faf9f5;border:1px solid #e5ddcc;font-family:'Zen Kaku Gothic New',sans-serif;color:#3d3a33">
    <div style="background:#2a2420;padding:22px 32px;display:flex;align-items:center;gap:16px">
      <div style="width:44px;height:44px;border-radius:10px;background:#3a332c;display:flex;align-items:center;justify-content:center;font-family:'Shippori Mincho',serif;font-size:24px;color:#c9a86a">鳥</div>
      <div><div style="font-family:'Shippori Mincho',serif;font-size:21px;color:#f3ede1;letter-spacing:.1em">鳥一代グループ ${esc(d.title)}</div>
      <div style="font-size:13px;color:#9a8f7c;margin-top:3px">${esc(d.sub)}</div></div>
      <div style="margin-left:auto;font-size:11px;color:#9a8f7c">自動生成 ${esc(d.gen)}</div>
    </div>
    ${(()=>{
      const pctTxt=(v)=>v!=null?(v*100).toFixed(1)+'%':'—';
      const dnTxt=d.tot.dinii!=null?d.tot.dinii.toFixed(2):'—';
      const cards=[
        ['全店'+salesLabel,yen(d.tot.sales),'前年比 '+totYoy.t,totYoy.cls],
        ['客数',cnt(d.tot.guests)+'人','客単価 '+yen(spend),''],
        ['F率（原価）',pctTxt(d.tot.fr),'FL計 '+pctTxt(d.tot.fl),''],
        ['L率（人件費）',pctTxt(d.tot.lr),'FL計 '+pctTxt(d.tot.fl),''],
      ];
      if(d.hasDinii) cards.push(['ダイニー再来店',dnTxt,d.diniiRangeLabel+'・'+cnt(d.tot.diniiCount)+'件','']);
      cards.push([(kind==='monthly'?'年間累計':'月間累計'),yen(kind==='monthly'?d.tot.sales:d.tot.cum),'前年比 '+(kind==='monthly'?totYoy.t:cumYoy.t),(kind==='monthly'?totYoy.cls:cumYoy.cls)]);
      return `<div style="display:grid;grid-template-columns:repeat(${cards.length},1fr);gap:10px;padding:20px 32px 4px">`+
        cards.map(k=>`<div style="background:#fff;border:1px solid #efe9dd;border-radius:12px;padding:13px 14px">
          <div style="font-size:11.5px;color:#8c8375">${esc(k[0])}</div>
          <div style="font-size:21px;font-weight:700;margin:4px 0 2px">${k[1]}</div>
          <div style="font-size:11px;color:${k[3]||'#a99f8c'}">${k[2]}</div></div>`).join('')+`</div>`;
    })()}
    <div style="padding:14px 32px 0">${chart?`<div style="background:#fff;border:1px solid #efe9dd;border-radius:12px;padding:14px 16px 6px">
      <div style="font-size:12.5px;color:#8c8375;margin-bottom:6px">店舗別 ${salesLabel}（■当期 ■前年）</div>${chart}</div>`:''}</div>
    <div style="padding:14px 32px 20px">
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
    <span class="period-label">${live?'スプレッドシート「アカウント」シートと連動しています':'デモモード：このブラウザ内にのみ保存されます（API接続後はシート管理）'}</span>
  </div>`;
  if(S.accErr) h+=`<div class="login-err" style="margin:10px 0">${esc(S.accErr)}</div>`;
  h+=`<div class="panel"><div class="panel-head"><div><h3>発行済みアカウント</h3><div class="sub">権限: 社長・本部＝全店＋アカウント管理 ／ マネージャー＝担当店舗 ／ 店舗＝自店のみ</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>ログインID</th><th>表示名</th><th>権限</th><th>担当店舗</th><th>状態</th><th>メモ</th><th></th></tr></thead><tbody>`;
  list.forEach(a=>{
    h+=`<tr><td>${esc(a.id)}</td><td style="text-align:right">${esc(a.name)}</td><td>${esc(a.role)}</td>
    <td style="max-width:280px;white-space:normal">${esc(a.stores)}</td>
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
  return '';
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
function accountModal(){
  const m=S.modal;
  const a=m.data||{ id:'', name:'', role:'店舗', stores:'', active:true, memo:'' };
  const isNew=!m.id;
  const all=allStores();
  const selected=String(a.stores||'')==='全店'?all.slice():String(a.stores||'').split(/[,、]/).map(s=>s.trim()).filter(Boolean);
  const isZen=String(a.stores||'')==='全店';
  return `<div class="modal-bg" onclick="if(event.target===this)App.closeModal()"><div class="modal">
    <h3>${isNew?'新規アカウント発行':'アカウント編集'}</h3>
    <div class="sub">権限に応じて閲覧範囲と機能が自動で切り替わります。</div>
    <div class="form-grid">
      <div><label>ログインID ${isNew?'':'（変更不可）'}</label><input type="text" id="ac-id" value="${esc(a.id)}" ${isNew?'':'disabled'}></div>
      <div><label>表示名</label><input type="text" id="ac-name" value="${esc(a.name)}"></div>
      <div><label>パスワード${isNew?'':'（空欄＝変更なし）'}</label><input type="text" id="ac-pw" value="" placeholder="${isNew?'必須':'変更する場合のみ入力'}"></div>
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
    'マネージャー':'担当店舗のみ閲覧できます。担当店舗間の比較・広告管理あり。',
    '店舗':'自店のみ閲覧できます。他店比較・広告管理・アカウント管理は非表示。',
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
  refresh(){ if(S.auth&&S.auth.token) fetchData(); else { loadSampleData(); render(); toast('サンプルデータを再読込しました（API未接続）'); } },
  csv: downloadCsv,
  pdf: downloadPdf,
  openConnect(){ if(S.auth && S.auth.account.role!=='社長'){ toast('接続設定は社長のみ変更できます'); return; } S.modal='connect'; render(); },
  closeModal(){ S.modal=null; render(); },
  roleHint(r){ const el=$('ac-role-hint'); if(el)el.textContent=roleHintText(r); },
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
    let stores;
    if(role==='社長'||role==='本部') stores='全店';
    else{
      const checked=[...$('ac-stores').querySelectorAll('input:checked')].map(i=>i.value);
      if(checked.includes('全店')) stores='全店';
      else stores=checked.join(', ');
    }
    if(!id){ msg.textContent='ログインIDを入力してください'; return; }
    if(!stores){ msg.textContent='担当店舗を1つ以上選択してください'; return; }
    const live=!!(S.auth&&S.auth.token);
    if(live){
      msg.style.color='#8c8375'; msg.textContent='保存中…';
      try{
        const d=await api({ action:'saveAccount', token:S.auth.token, accountId:id, pw, name, role, stores, active, memo });
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
    if(ex){ ex.name=name; if(pw)ex.pw=pw; ex.role=role; ex.stores=stores; ex.active=active!=='FALSE'; ex.memo=memo; }
    else list.push({ id, pw, name, role, stores, active:active!=='FALSE', memo });
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
