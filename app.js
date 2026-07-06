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
  '社長':       ['dash','analysis','deposit','ad','review','ai','accounts'],
  '本部':       ['dash','analysis','deposit','ad','review','ai','accounts'],
  'マネージャー':['dash','analysis','deposit','ad','review','ai'],
  '店舗':       ['dash','analysis','deposit','review','ai'],
};
const TAB_LABELS = { dash:'ダッシュボード', analysis:'推移分析', deposit:'入金管理', ad:'広告管理', review:'口コミ', ai:'AI検索', accounts:'アカウント管理' };
// 口コミ集約：同じ実店舗にぶら下がる別名店舗（Googleマイビジネスが分かれているケース）
// 親店舗（=分析_日別店舗の店舗名）に、口コミ上の子店舗名をぶら下げる
const REVIEW_CHILDREN = {
  '黒霧屋 新横浜': ['カラオケ 彩-irodori 新横浜アリーナ通り店', 'うお蔵 新横浜'],
  '鶏武者 新横浜': ['匠味 新横浜'],
  '鶏武者 川崎店': ['匠味 川崎'],
};
// 口コミ店舗名 → 親店舗 の逆引き
const REVIEW_PARENT = (()=>{ const m={}; Object.keys(REVIEW_CHILDREN).forEach(p=>REVIEW_CHILDREN[p].forEach(c=>m[c]=p)); return m; })();
// ある親店舗に表示すべき口コミ店舗名（親自身＋子）
function reviewNamesFor(parent){ return [parent].concat(REVIEW_CHILDREN[parent]||[]); }
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
  depMonth:'', adMonth:'',
  aMetric:'sales', aGran:'day', aBreak:'total', aRange:'30', aYoY:true,
  aiQ:'', aiResult:null, dataVersion:'',
  accounts:null, accErr:'', modal:null, loginErr:'',
};
const D = { daily:[], media:[], deposit:[], review:[], ad:[], extra:{}, refDate:null, maxDate:null };
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
const compact = (v)=>{ v=v||0; if(v>=1e8)return (v/1e8).toFixed(2)+'億'; if(v>=1e4)return Math.round(v/1e4)+'万'; return Math.round(v).toLocaleString('ja-JP'); };
const parseDateStr = (ds)=>{ const p=String(ds).replace(/-/g,'/').split('/'); if(p.length<3)return 0; const Y=+p[0],M=+p[1],Dd=+p[2]; if(!Y||!M||!Dd)return 0; return new Date(Y,M-1,Dd).getTime(); };

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
        iL=colAny(H,['人件費合計','人件費']), iC=colAny(H,['仕入金額','仕入','原価']), iCash=colAny(H,['現金']);
  if(iD<0||iS<0||iSl<0){ D.diag.daily='列が見つかりません（必要: 店舗名・日付/営業日・純売上）'; return false; }
  const recs=[]; let max=0;
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const st=String(c[iS]||'').trim(); const t=parseDateStr(c[iD]);
    if(!st||!t) continue;
    recs.push({ store:st, t, sales:num(c[iSl]), guests:num(c[iG]), pa:num(c[iPA]), emp:num(c[iEmp]), labor:num(c[iL]), cost:num(c[iC]), cash:num(c[iCash]) });
    if(t>max)max=t;
  }
  if(!recs.length){ D.diag.daily='0件（ヘッダーは一致したがデータ行なし）'; return false; }
  D.daily=recs; D.maxDate=new Date(max); D.diag.daily='OK '+recs.length+'件';
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
  const hi=findHeader(rows,['日付','広告']);
  const H=rows[hi].map(h=>String(h).trim());
  const iD=colOf(H,'日付'), iS=colOf(H,'店舗'), iM=colOf(H,'媒体');
  let iC=colOf(H,'広告費'); if(iC<0)iC=colOf(H,'費用'); if(iC<0)iC=colOf(H,'金額');
  if(iD<0||iC<0) return false;
  const recs=[];
  for(let i=hi+1;i<rows.length;i++){
    const c=rows[i]; const t=parseDateStr(c[iD]); if(!t)continue;
    recs.push({ store:String(iS>=0?c[iS]||'':'').trim(), t, media:String(iM>=0?c[iM]||'':'').trim(), cost:num(c[iC]) });
  }
  if(!recs.length) return false;
  D.ad=recs; return true;
}
function ingestSheets(sheets, partial){
  if(!partial){ D.extra={}; D.diag={}; D.receivedKeys=Object.keys(sheets); }
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
    else if(key==='ad'||key==='広告') ingestAd(rows);
    else D.extra[key]=rows;
  }
}
function loadSampleData(){
  if(window.__DAILY_CSV)   ingestDaily(csvToRows(window.__DAILY_CSV));
  if(window.__SALES_CSV)   ingestMedia(csvToRows(window.__SALES_CSV));
  if(window.__DEPOSIT_CSV) ingestDeposit(csvToRows(window.__DEPOSIT_CSV));
  if(window.__REVIEW_CSV)  ingestReview(csvToRows(window.__REVIEW_CSV));
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
  const o={sales:0,guests:0,cost:0,pa:0,emp:0,labor:0,cash:0};
  for(const r of D.daily){
    if(r.t<a||r.t>b) continue;
    if(selName){ if(r.store!==selName) continue; }
    else if(setNames && !setNames.has(r.store)) continue;
    o.sales+=r.sales; o.guests+=r.guests; o.cost+=r.cost; o.pa+=r.pa; o.emp+=r.emp; o.labor+=r.labor; o.cash+=r.cash;
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
  const W=1240,H=(opts&&opts.h)||300,padT=16,padB=34,padL=58,padR=16;
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
  series.forEach(s=>{
    const pts=[];
    s.data.forEach((v,i)=>{ if(v!=null) pts.push([x(i),yv(v)]); });
    if(!pts.length) return;
    els+=`<polyline points="${pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.dash?2:2.6}" ${s.dash?'stroke-dasharray="5 4"':''} stroke-linejoin="round"/>`;
    if(n<=40) pts.forEach(p=>{ els+=`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.8" fill="${s.color}"/>`; });
  });
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
  EXPORT=[];
  const tabs=myTabs();
  if(!tabs.includes(S.tab)) S.tab=tabs[0];
  let body='';
  if(S.tab==='dash') body=viewDash();
  else if(S.tab==='analysis') body=viewAnalysis();
  else if(S.tab==='deposit') body=viewDeposit();
  else if(S.tab==='ad') body=viewAd();
  else if(S.tab==='review') body=viewReview();
  else if(S.tab==='ai') body=viewAI();
  else if(S.tab==='accounts') body=viewAccounts();
  root.innerHTML=`<div class="app">${viewHeader()}${diagBanner()}${viewNav()}${body}</div>${S.modal?viewModal():''}`;
}
function renderHeaderOnly(){ /* 軽量更新は全再描画で十分 */ }

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
  let h='<div class="store-tabs no-print">';
  h+=`<button class="${S.store==='all'?'on':''}" onclick="App.store('all')">${sc.length===allStores().length?'全店':'担当店舗 合算'}</button>`;
  sc.forEach((n)=>{ h+=`<button class="${S.store===n?'on':''}" onclick="App.store(this.dataset.n)" data-n="${esc(n)}">${esc(n)}</button>`; });
  return h+'</div>';
}
function periodCtrlHtml(){
  const r=periodRange();
  const P=S.period;
  const ref=D.refDate||new Date();
  const defMonth=ref.getFullYear()+'-'+String(ref.getMonth()+1).padStart(2,'0');
  const defDay=defMonth+'-'+String(ref.getDate()).padStart(2,'0');
  let picker='';
  if(P==='day') picker=`<input type="date" value="${S.pDay||defDay}" onchange="App.set('pDay',this.value)">`;
  else if(P==='week'){
    const wk=r.weekIdx;
    picker=`<input type="month" value="${S.pMonth||defMonth}" onchange="App.set('pMonth',this.value)">
      <span class="seg">${[0,1,2,3,4].map(i=>`<button class="${wk===i?'on':''}" onclick="App.setWeek(${i})">第${i+1}週</button>`).join('')}</span>`;
  }
  else if(P==='month') picker=`<input type="month" value="${S.pMonth||defMonth}" onchange="App.set('pMonth',this.value)">`;
  else if(P==='year'){
    const years=[...new Set(D.daily.map(x=>new Date(x.t).getFullYear()))].sort();
    if(!years.length)years.push(ref.getFullYear());
    picker=`<select onchange="App.set('pYear',this.value)">${years.map(y=>`<option ${String(S.pYear||ref.getFullYear())===String(y)?'selected':''}>${y}</option>`).join('')}</select>`;
  }
  else picker=`<input type="date" value="${S.cStart}" onchange="App.set('cStart',this.value)"> 〜 <input type="date" value="${S.cEnd}" onchange="App.set('cEnd',this.value)">`;
  return `
  <div class="ctrl-bar no-print">
    <div class="seg">
      ${[['day','日次'],['week','週次'],['month','月次'],['year','年間'],['custom','期間指定']].map(([k,l])=>`<button class="${P===k?'on':''}" onclick="App.period('${k}')">${l}</button>`).join('')}
    </div>
    ${picker}
    <span class="period-label">${esc(r.label)}</span>
  </div>`;
}

function mediaTableRows(a,b,pa,pb,scopeSet,selName){
  const agg={},prevAgg={};
  for(const r of D.media){
    const inScope=selName?(r.store===selName):scopeSet.has(r.store);
    if(!inScope) continue;
    if(r.t>=a&&r.t<=b){ const o=agg[r.media]||(agg[r.media]={net:0,g:0}); o.net+=r.net; o.g+=r.guests; }
    if(r.t>=pa&&r.t<=pb){ prevAgg[r.media]=(prevAgg[r.media]||0)+r.net; }
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

  // 口コミ（対象店舗の最新スナップショット加重平均）
  const revOf=(nm,limit)=>{ let latest=null; for(const rr of D.review){ if(rr.store!==nm)continue; if(limit&&rr.t>limit)continue; if(!latest||rr.t>latest.t)latest=rr; } return latest; };
  const targetStores=selName?[selName]:sc;
  // 同じ実店舗にぶら下がる別名店舗（うお蔵・匠味など）も合算
  let ws=0,cs=0; targetStores.forEach(nm=>{ reviewNamesFor(nm).forEach(rn=>{ const l=revOf(rn); if(l&&l.count>0){ws+=l.star*l.count;cs+=l.count;} }); });
  const revScore=cs>0?(ws/cs).toFixed(2):'—', revCount=cs>0?cnt(cs)+'件':'—';

  const y1=yoyStr(Ssl,pS), yG=yoyStr(cur.guests,prev.guests,'前年 '), ySp=yoyStr(spend,pSpend,'前年 ');
  const yF=ptStr(foodR,pFood,true), yL=ptStr(laborR,pLabor,true), yFL=ptStr(flR,pFood+pLabor,true);
  const kpis=[
    { lb:(S.period==='day'?'日次':S.period==='week'?'週次':S.period==='month'?'月次':S.period==='year'?'累計':'期間')+'売上', vl:yen(Ssl), yy:y1 },
    { lb:'原価率 (F)', vl:Ssl>0?(foodR*100).toFixed(1)+'%':'—', yy:yF },
    { lb:'人件費率 (L)', vl:Ssl>0?(laborR*100).toFixed(1)+'%':'—', yy:yL },
    { lb:'FL合計', vl:Ssl>0?(flR*100).toFixed(1)+'%':'—', yy:yFL },
    { lb:'客数', vl:cnt(cur.guests)+'人', yy:yG },
    { lb:'客単価', vl:yen(spend), yy:ySp },
    { lb:'口コミ点数', vl:revScore, yy:{t:'Google加重平均',cls:'mut'} },
    { lb:'口コミ件数', vl:revCount, yy:{t:'累計',cls:'mut'} },
  ];
  let h=periodCtrlHtml()+storeSegHtml();
  h+=`<div class="kpi-grid">`+kpis.map(k=>`<div class="kpi"><div class="lb">${k.lb}</div><div class="vl">${k.vl}</div><div class="yy ${k.yy.cls}">${k.yy.t}</div></div>`).join('')+`</div>`;
  EXPORT.push({ title:'KPI（'+r.label+(selName?'・'+selName:'・'+(sc.length===allStores().length?'全店':'担当店舗'))+'）',
    headers:['指標','値','前年比較'], rows:kpis.map(k=>[k.lb,k.vl,k.yy.t]) });

  h+=dashChartPanel(r,scopeSet,selName);
  h+=`<div class="grid2">${flPanel(cur,prev)}${mediaPanel(a,b,pa2,pb2,scopeSet,selName)}</div>`;
  // 店舗を選んでいるときは「日別明細」、全店/合算のときは「店舗比較」
  h+= selName ? dailyStorePanel(r,selName) : comparePanel(r,p,sc,selName);
  return h;
}

// 店舗選択時：期間内の1日ごとの売上・客数・単価・前年比・累計差異・FL
function dailyStorePanel(r,selName){
  const days=[]; for(let d=new Date(r.s); dayMs(d)<=dayMs(r.e); d=addD(d,1)) days.push(new Date(d));
  const maxT=D.maxDate?dayMs(D.maxDate):Infinity;
  let cumCur=0, cumPrev=0, tS=0,tG=0,tCost=0,tLabor=0;
  let h=`<div class="panel"><div class="panel-head"><div><h3>日別 明細（${esc(selName)} ／ ${esc(r.label)}）</h3>
    <div class="sub">1日ごとの売上・客数・客単価・前年比・累計差異・FL（${(r.s.getMonth()+1)}/${r.s.getDate()}〜${(r.e.getMonth()+1)}/${r.e.getDate()}）</div></div></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>日付</th><th>売上</th><th>客数</th><th>客単価</th><th>前年比</th><th>累計差異(対前年)</th><th>FL</th></tr></thead><tbody>`;
  const exp=[];
  days.forEach(d=>{
    const t=dayMs(d);
    const c=stat(null,t,t,selName);
    const pv=stat(null,dayMs(addD(d,-364)),dayMs(addD(d,-364)),selName);
    const future=t>maxT;
    if(future){
      h+=`<tr><td class="mut">${mdw(d)}</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td></tr>`;
      return;
    }
    cumCur+=c.sales; cumPrev+=pv.sales; tS+=c.sales; tG+=c.guests; tCost+=c.cost; tLabor+=c.labor;
    const sp=c.guests>0?c.sales/c.guests:0;
    const yy=yoyStr(c.sales,pv.sales,'');
    const cumDiff=cumCur-cumPrev;
    const fl=c.sales>0?(c.cost+c.labor)/c.sales:0;
    h+=`<tr><td>${mdw(d)}</td><td>${yen(c.sales)}</td><td>${cnt(c.guests)}人</td><td>${yen(sp)}</td>
      <td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t||'—'}</td>
      <td class="${cumDiff>=0?'pos':'neg'}">${(cumDiff>=0?'+':'▲')+yen(Math.abs(cumDiff)).slice(1)}</td>
      <td class="${fl>0.6?'warn':''}">${c.sales>0?(fl*100).toFixed(1)+'%':'—'}</td></tr>`;
    exp.push([mdw(d),Math.round(c.sales),Math.round(c.guests),Math.round(sp),yy.t||'',Math.round(cumDiff),c.sales>0?(fl*100).toFixed(1)+'%':'']);
  });
  const tSp=tG>0?tS/tG:0, tFl=tS>0?(tCost+tLabor)/tS:0, tDiff=cumCur-cumPrev;
  h+=`<tr class="total"><td>合計</td><td>${yen(tS)}</td><td>${cnt(tG)}人</td><td>${yen(tSp)}</td><td></td>
    <td class="${tDiff>=0?'pos':'neg'}">${(tDiff>=0?'+':'▲')+yen(Math.abs(tDiff)).slice(1)}</td>
    <td class="${tFl>0.6?'warn':''}">${tS>0?(tFl*100).toFixed(1)+'%':'—'}</td></tr>`;
  h+=`</tbody></table></div></div>`;
  exp.push(['合計',Math.round(tS),Math.round(tG),Math.round(tSp),'',Math.round(tDiff),tS>0?(tFl*100).toFixed(1)+'%':'']);
  EXPORT.push({ title:'日別明細（'+selName+'／'+r.label+'）', headers:['日付','売上','客数','客単価','前年比','累計差異(対前年)','FL'], rows:exp });
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
  let h=`<div class="panel"><div class="panel-head"><div><h3>FL（原価・人件費）内訳</h3><div class="sub">集約シート実績</div></div></div><table class="tbl"><thead><tr><th>項目</th><th>金額</th><th>比率</th><th>前年</th></tr></thead><tbody>`;
  rows.forEach(x=>{ const pt=ptStr(x.r,x.pr,true);
    h+=`<tr><td><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${x.c};margin-right:8px"></span>${esc(x.nm)}</td><td>${yen(x.amt)}</td><td>${(x.r*100).toFixed(1)}%</td><td class="${pt.cls==='up'?'pos':pt.cls==='dn'?'neg':'mut'}">${pt.t}</td></tr>`; });
  const ptFL=ptStr(flR,pFlR,true);
  h+=`<tr class="total"><td>FL合計</td><td>${yen(fl)}</td><td>${(flR*100).toFixed(1)}%</td><td class="${ptFL.cls==='up'?'pos':'neg'}">${ptFL.t}</td></tr>`;
  h+=`<tr><td>利益（FL後）</td><td class="${profit>=0?'pos':'neg'}">${yen(profit)}</td><td>${(profit/Ssl*100).toFixed(1)}%</td><td class="mut">—</td></tr>`;
  h+=`</tbody></table></div>`;
  EXPORT.push({ title:'FL内訳', headers:['項目','金額','比率','前年'],
    rows:rows.map(x=>[x.nm,Math.round(x.amt),(x.r*100).toFixed(1)+'%',ptStr(x.r,x.pr,true).t]).concat([['FL合計',Math.round(fl),(flR*100).toFixed(1)+'%',ptFL.t],['利益(FL後)',Math.round(profit),(profit/Ssl*100).toFixed(1)+'%','']]) });
  return h;
}

function mediaPanel(a,b,pa2,pb2,scopeSet,selName){
  const { total, rows }=mediaTableRows(a,b,pa2,pb2,scopeSet,selName);
  if(!rows.length && D.mediaPending) return `<div class="panel"><div class="panel-head"><div><h3>媒体別 売上</h3><div class="sub">読み込み中…</div></div></div><div class="empty">媒体別データを読み込んでいます…</div></div>`;
  if(!rows.length) return `<div class="panel"><h3>媒体別 売上</h3><div class="empty">媒体別データがありません</div></div>`;
  let h=`<div class="panel"><div class="panel-head"><div><h3>媒体別 売上</h3><div class="sub">予約媒体・チャネル別の実績</div></div></div><div class="scroll-x"><table class="tbl"><thead><tr><th>媒体</th><th>売上</th><th>構成比</th><th>客数</th><th>客単価</th><th>前年比</th></tr></thead><tbody>`;
  rows.slice(0,12).forEach(x=>{
    const yy=yoyStr(x.net,x.prev,'');
    h+=`<tr><td>${esc(x.media)}</td><td>${yen(x.net)}</td><td>${total>0?(x.net/total*100).toFixed(1):'—'}%</td><td>${cnt(x.g)}人</td><td>${yen(x.g>0?x.net/x.g:0)}</td><td class="${yy.cls==='up'?'pos':yy.cls==='dn'?'neg':'mut'}">${yy.t.replace('前年比 ','')}</td></tr>`;
  });
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'媒体別売上', headers:['媒体','売上','構成比','客数','客単価','前年比'],
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
  else { for(let d=new Date(s); dayMs(d)<=dayMs(e); d=addD(d,1)) buckets.push({label:(d.getMonth()+1)+'/'+d.getDate(),a:dayMs(d),b:dayMs(d)}); }

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
    <div class="seg">${[['sales','売上'],['guests','客数'],['spend','客単価']].map(([k,l])=>`<button class="${M===k?'on':''}" onclick="App.set('aMetric','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['day','日別'],['week','週別'],['month','月別']].map(([k,l])=>`<button class="${G===k?'on':''}" onclick="App.set('aGran','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['total','合計'],['store','店舗別'],['media','媒体別']].map(([k,l])=>`<button class="${B===k?'on':''}" onclick="App.set('aBreak','${k}')">${l}</button>`).join('')}</div>
    <div class="seg">${[['30','直近30日'],['90','直近90日'],['year','年初来'],['custom','期間指定']].map(([k,l])=>`<button class="${RG===k?'on':''}" onclick="App.set('aRange','${k}')">${l}</button>`).join('')}</div>
    ${RG==='custom'?`<input type="date" value="${S.cStart}" onchange="App.set('cStart',this.value)"> 〜 <input type="date" value="${S.cEnd}" onchange="App.set('cEnd',this.value)">`:''}
    ${B==='total'?`<button class="icon-btn" onclick="App.set('aYoY',${S.aYoY?'false':'true'})">${S.aYoY?'☑':'☐'} 前年重ね</button>`:''}
  </div>`+storeSegHtml();
  h+=`<div class="panel"><div class="panel-head"><div><h3>${ml} の推移（${G==='day'?'日別':G==='week'?'週別':'月別'}・${B==='total'?'合計':B==='store'?'店舗別':'媒体別'}）</h3>
    <div class="sub">${(s.getMonth()+1)}/${s.getDate()}〜${(e.getMonth()+1)}/${e.getDate()} ／ ${buckets.length}区間</div></div><div class="legend">${legend}</div></div>
    ${lineChart(buckets.map(b2=>b2.label),series,M)}</div>`;
  h+=`<div class="panel"><div class="panel-head"><h3>明細</h3></div><div class="scroll-x"><table class="tbl"><thead><tr><th>期間</th>${series.map(x=>`<th>${esc(x.name)}</th>`).join('')}</tr></thead><tbody>`;
  buckets.forEach((bk,i)=>{ h+=`<tr><td>${esc(bk.label)}</td>${series.map(x=>`<td>${fmtV(x.data[i])}</td>`).join('')}</tr>`; });
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:ml+'の推移', headers:['期間'].concat(series.map(x=>x.name)),
    rows:buckets.map((bk,i)=>[bk.label].concat(series.map(x=>Math.round(x.data[i])))) });
  return h;
}

/* ---------------- 入金管理 ---------------- */
function depMonthDate(){
  if(S.depMonth){ const p=S.depMonth.split('-'); return new Date(+p[0],+p[1]-1,1); }
  const ref=D.refDate||new Date(); return new Date(ref.getFullYear(),ref.getMonth(),1);
}
function viewDeposit(){
  const sc=scopeStores(); const selName=selStoreName();
  const m0=depMonthDate();
  const y=m0.getFullYear(), m=m0.getMonth(), lastDay=new Date(y,m+1,0).getDate();
  const mS=dayMs(new Date(y,m,1)), mE=dayMs(new Date(y,m,lastDay));
  const targets=selName?[selName]:sc; const tSet=new Set(targets);
  const maxT=D.maxDate?dayMs(D.maxDate):Infinity;

  // 入金記録が始まった日より前の現金売上は未入金の対象にしない
  let depStart=Infinity;
  for(const r of D.deposit){ if(r.t<depStart) depStart=r.t; }
  if(!isFinite(depStart)) depStart=mS;

  // 繰越（入金記録開始日〜月初前日の 現金売上−入金）
  let carry=0;
  for(const r of D.daily){ if(tSet.has(r.store)&&r.t>=depStart&&r.t<mS) carry+=r.cash||0; }
  for(const r of D.deposit){ if(tSet.has(r.store)&&r.t<mS) carry-=r.amount||0; }

  // 日別集計
  const days=[]; let cum=carry, tC=0,tD=0;
  for(let d=1;d<=lastDay;d++){
    const t=dayMs(new Date(y,m,d));
    let cash=0,dep=0;
    for(const r of D.daily){ if(tSet.has(r.store)&&r.t===t) cash+=r.cash||0; }
    for(const r of D.deposit){ if(tSet.has(r.store)&&r.t===t) dep+=r.amount||0; }
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
    <div class="mini-nav">
      <button onclick="App.depNav(-1)">‹</button><span class="lbl">${mLabel}</span><button onclick="App.depNav(1)">›</button>
      <button onclick="App.depNav(0)" style="font-size:11px;color:#8c8375">今月</button>
    </div>
    <span class="period-label">現金売上（入金予定）と ATM入金の照合 ／ ${esc(scopeLabel)}</span>
  </div>`+storeSegHtml();

  // サマリーカード
  const unpaid=tC-tD;
  h+=`<div class="kpi-grid">
    <div class="kpi"><div class="lb">繰越未入金（前月まで）</div><div class="vl" style="color:${carry>0?'#b5502f':'#3d3a33'}">${yen(carry)}</div><div class="yy">入金記録開始以降の累計</div></div>
    <div class="kpi"><div class="lb">当月 入金予定（現金売上）</div><div class="vl">${yen(tC)}</div><div class="yy">${mLabel}実績分</div></div>
    <div class="kpi"><div class="lb">当月 入金済（ATM）</div><div class="vl">${yen(tD)}</div><div class="yy">${mLabel}実績分</div></div>
    <div class="kpi"><div class="lb">当月 未入金</div><div class="vl ${unpaid>0?'':''}" style="color:${unpaid>0?'#b5502f':'#4c7d5c'}">${yen(unpaid)}</div><div class="yy">累計残 ${yen(days.length?days[days.length-1].future?cum:days[days.length-1].cum:carry)}</div></div>
  </div>`;

  // 店舗別サマリー（合算表示時のみ）
  if(!selName&&sc.length>1){
    h+=`<div class="panel"><div class="panel-head"><div><h3>店舗別 入金状況（${mLabel}）</h3><div class="sub">行クリックで店舗の日別明細へ</div></div></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>入金予定(現金売上)</th><th>入金(ATM)</th><th>未入金(当月)</th><th>累計未入金</th><th>状態</th></tr></thead><tbody>`;
    const expS=[];
    sc.forEach(nm=>{
      let c=0,dp=0,cAll=0,dAll=0;
      for(const r of D.daily){ if(r.store!==nm)continue; if(r.t>=mS&&r.t<=mE&&r.t<=maxT)c+=r.cash||0; if(r.t>=depStart&&r.t<=Math.min(mE,maxT))cAll+=r.cash||0; }
      for(const r of D.deposit){ if(r.store!==nm)continue; if(r.t>=mS&&r.t<=mE)dp+=r.amount||0; if(r.t<=mE)dAll+=r.amount||0; }
      const u=c-dp, cu=cAll-dAll;
      const badge=u<=0?(c>0||dp>0?'<span class="badge ok">完了</span>':'<span class="badge zero">—</span>'):'<span class="badge ng">未入金あり</span>';
      h+=`<tr class="click" onclick="App.store(this.dataset.n)" data-n="${esc(nm)}"><td>${esc(nm)}</td><td>${yen(c)}</td><td>${yen(dp)}</td>
        <td class="${u>0?'neg':u<0?'pos':'mut'}">${yen(u)}</td><td class="${cu>0?'neg':'mut'}">${yen(cu)}</td><td>${badge}</td></tr>`;
      expS.push([nm,Math.round(c),Math.round(dp),Math.round(u),Math.round(cu),u>0?'未入金あり':'完了']);
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
      h+=`<tr><td class="mut">${mdw(x.dt)}</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td><span class="badge zero">データ待ち</span></td></tr>`;
      return;
    }
    const badge=(x.cash===0&&x.dep===0)?'<span class="badge zero">—</span>':(x.diff<=0?'<span class="badge ok">完了</span>':'<span class="badge ng">未入金</span>');
    h+=`<tr><td>${mdw(x.dt)}</td><td>${yen(x.cash)}</td><td>${yen(x.dep)}</td>
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
function viewAd(){
  const sc=scopeStores(); const scopeSet=new Set(sc);
  if(!D.ad.length){
    let h=`<div class="panel"><div class="panel-head"><div><h3>広告管理</h3><div class="sub">スプレッドシート接続で自動有効化</div></div></div>
    <div class="note-box">
      広告データはまだ接続されていません。スプレッドシートに <code>DB_広告</code> という名前のシートを追加するだけで、
      次回同期時からこのタブに自動で表示されます（接続設定シートに <code>ad</code> キーで登録してもOK）。<br><br>
      <b>シートの列（1行目にヘッダー）:</b><br>
      <code>日付</code>（例 2026/07/01）／ <code>店舗名</code> ／ <code>媒体</code>（ホットペッパー等）／ <code>広告費</code><br><br>
      売上データと自動で突き合わせ、店舗別・媒体別の広告費、売上対比（広告費率）を表示します。
    </div></div>`;
    // その他の接続済みシート
    h+=extraSheetsHtml();
    return h;
  }
  const ref=D.refDate||new Date();
  const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
  const y=m0.getFullYear(),m=m0.getMonth();
  const mS=dayMs(new Date(y,m,1)), mE=dayMs(new Date(y,m+1,0));
  const mLabel=y+'年 '+(m+1)+'月';
  const inScope=(r)=>!r.store||scopeSet.has(r.store);
  let h=`<div class="ctrl-bar no-print"><div class="mini-nav">
    <button onclick="App.adNav(-1)">‹</button><span class="lbl">${mLabel}</span><button onclick="App.adNav(1)">›</button></div>
    <span class="period-label">広告費と売上の対比（${mLabel}）</span></div>`;
  // 店舗別
  const byStore={};
  for(const r of D.ad){ if(!inScope(r))continue; if(r.t<mS||r.t>mE)continue; const k=r.store||'（店舗未指定）'; byStore[k]=(byStore[k]||0)+r.cost; }
  const totalAd=Object.values(byStore).reduce((s,v)=>s+v,0);
  h+=`<div class="panel"><div class="panel-head"><h3>店舗別 広告費（${mLabel}）</h3></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>広告費</th><th>売上（当月）</th><th>広告費率</th></tr></thead><tbody>`;
  const expA=[];
  Object.keys(byStore).sort((a2,b2)=>byStore[b2]-byStore[a2]).forEach(nm=>{
    const sl=stat(null,mS,mE,nm).sales;
    const rate=sl>0?byStore[nm]/sl*100:0;
    h+=`<tr><td>${esc(nm)}</td><td>${yen(byStore[nm])}</td><td>${yen(sl)}</td><td class="${rate>10?'warn':''}">${sl>0?rate.toFixed(1)+'%':'—'}</td></tr>`;
    expA.push([nm,Math.round(byStore[nm]),Math.round(sl),sl>0?rate.toFixed(1)+'%':'']);
  });
  const totalSales=stat(scopeSet,mS,mE,null).sales;
  h+=`<tr class="total"><td>合計</td><td>${yen(totalAd)}</td><td>${yen(totalSales)}</td><td>${totalSales>0?(totalAd/totalSales*100).toFixed(1)+'%':'—'}</td></tr></tbody></table></div></div>`;
  EXPORT.push({ title:'店舗別広告費（'+mLabel+'）', headers:['店舗','広告費','売上','広告費率'], rows:expA });
  // 媒体別
  const byMedia={};
  for(const r of D.ad){ if(!inScope(r))continue; if(r.t<mS||r.t>mE)continue; const k=r.media||'（媒体未指定）'; byMedia[k]=(byMedia[k]||0)+r.cost; }
  if(Object.keys(byMedia).length>1){
    h+=`<div class="panel"><div class="panel-head"><h3>媒体別 広告費（${mLabel}）</h3></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>媒体</th><th>広告費</th><th>構成比</th></tr></thead><tbody>`;
    Object.keys(byMedia).sort((a2,b2)=>byMedia[b2]-byMedia[a2]).forEach(k=>{
      h+=`<tr><td>${esc(k)}</td><td>${yen(byMedia[k])}</td><td>${totalAd>0?(byMedia[k]/totalAd*100).toFixed(1):'—'}%</td></tr>`;
    });
    h+=`</tbody></table></div></div>`;
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

/* ---------------- 口コミ ---------------- */
function viewReview(){
  const sc=scopeStores(); const selName=selStoreName();
  const baseStores=selName?[selName]:sc;
  if(!D.review.length) return storeSegHtml()+`<div class="panel"><h3>口コミ推移</h3><div class="empty">口コミデータがありません</div></div>`;
  // 親店舗＋ぶら下がる別名店舗（口コミデータに存在するもののみ）を対象にする
  const revStores=new Set(D.review.map(r=>r.store));
  const targets=[];
  baseStores.forEach(nm=>{ reviewNamesFor(nm).forEach(rn=>{ if((rn===nm||revStores.has(rn))&&!targets.includes(rn)) targets.push(rn); }); });
  const parentTag=(nm)=>REVIEW_PARENT[nm]?` <span class="mut" style="font-size:11px">（${esc(REVIEW_PARENT[nm])}）</span>`:'';
  // 月次バケット（直近12ヶ月）
  const ref=D.refDate||new Date();
  const months=[];
  for(let i=11;i>=0;i--){ const d=new Date(ref.getFullYear(),ref.getMonth()-i,1); months.push(d); }
  const cat=months.map(d=>(d.getMonth()+1)+'月');
  const starAt=(nm,limit)=>{ let latest=null; for(const r of D.review){ if(r.store!==nm)continue; if(r.t>limit)continue; if(!latest||r.t>latest.t)latest=r; } return latest?latest.star:null; };
  const series=targets.map((nm,i)=>({ name:nm, color:PALETTE[i%PALETTE.length],
    data:months.map(d=>starAt(nm,dayMs(new Date(d.getFullYear(),d.getMonth()+1,0)))) }));
  const legend=series.map(s=>`<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  let h=storeSegHtml();
  const subNote=selName&&REVIEW_CHILDREN[selName]?`各月末時点のスナップショット ／ ${esc(selName)}に紐づく店舗（${REVIEW_CHILDREN[selName].map(esc).join('・')}）も表示`:'各月末時点のスナップショット';
  h+=`<div class="panel"><div class="panel-head"><div><h3>Google口コミ 平均星 推移（直近12ヶ月）</h3><div class="sub">${subNote}</div></div><div class="legend">${legend}</div></div>
  ${lineChart(cat,series,'star',{zoom:true,axisFmt:(v)=>v.toFixed(2)})}</div>`;
  // 最新スナップショット表
  const d30=dayMs(addD(ref,-30));
  h+=`<div class="panel"><div class="panel-head"><h3>最新スナップショット</h3></div>
  <div class="scroll-x"><table class="tbl"><thead><tr><th>店舗</th><th>平均星</th><th>累計件数</th><th>直近30日 増加</th><th>最終取得日</th></tr></thead><tbody>`;
  const expR=[];
  targets.forEach(nm=>{
    let latest=null,inc=0;
    for(const r of D.review){ if(r.store!==nm)continue; if(!latest||r.t>latest.t)latest=r; if(r.t>=d30)inc+=r.delta||0; }
    if(!latest){ h+=`<tr><td>${esc(nm)}${parentTag(nm)}</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td><td class="mut">—</td></tr>`; return; }
    const dt=new Date(latest.t);
    h+=`<tr><td>${esc(nm)}${parentTag(nm)}</td><td>${latest.star.toFixed(2)}</td><td>${cnt(latest.count)}件</td><td class="${inc>0?'pos':'mut'}">${inc>0?'+'+inc:'—'}</td><td class="mut">${dt.getFullYear()}/${dt.getMonth()+1}/${dt.getDate()}</td></tr>`;
    expR.push([nm,latest.star.toFixed(2),latest.count,inc,dt.getFullYear()+'/'+(dt.getMonth()+1)+'/'+dt.getDate()]);
  });
  h+=`</tbody></table></div></div>`;
  EXPORT.push({ title:'口コミ最新スナップショット', headers:['店舗','平均星','累計件数','直近30日増加','最終取得日'], rows:expR });
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
  adNav(d){
    const ref=D.refDate||new Date();
    const m0=S.adMonth?new Date(+S.adMonth.split('-')[0],+S.adMonth.split('-')[1]-1,1):new Date(ref.getFullYear(),ref.getMonth(),1);
    const n=new Date(m0.getFullYear(),m0.getMonth()+d,1);
    S.adMonth=n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0'); render();
  },
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
