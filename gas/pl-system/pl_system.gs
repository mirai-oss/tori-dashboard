/* PL管理システム 再構築スクリプト（Google Apps Script）
   実行: buildAll → 全タブ再構築 / メニュー「▶ PL管理 > DB_PLへ転記」で転記 */
var DASH_ID = '1OuaAQBeXHxJZtDXEbQx-V7w56fCWW5jpDmZvBpkfIbQ';
var DASH_URL = 'https://docs.google.com/spreadsheets/d/' + DASH_ID + '/';
var N = {g:'🏠 ガイド', s:'⚙ 設定', m:'📚 科目マスタ', i:'✍ 販管費入力', c:'✅ 入力チェック', p:'📋 月次PL', t:'📈 年間推移', d:'🔄 取込_日別', w:'🔄 取込_月次'};
var STORES = ['鳥一代 本店','鳥一代 はなれ','芝の鳥一代','鳥一代 恵比寿','鳥一代 新橋','黒霧屋 新横浜','鶏武者 川崎店','鶏武者 新横浜','横濱ホルモン会館　エース　本厚木店','じんべえ 新横浜店','じんべえ 川崎店','秋葉原 肉寿司','本社・共通'];
var C = {title:'#1F4E79', hdr:'#4472C4', in:'#FFF2CC', sub:'#E2EFDA', calc:'#DDEBF7', gray:'#F2F2F2', warn:'#FCE4EC'};
var NUM = '#,##0;(#,##0);"-"', PCT = '0.0%';
var SC = ['E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T']; // 店舗16列
var AUTO_MEMO = '媒体販促費（自動計上）'; // DB_PL自動転記行のマーカー
var MC = ['D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA']; // 月24列(年間推移)、合計はAB列

function q(n){ return "'" + n + "'!"; }

function master(){ // [code,name,区分,データ源,チェック,メモ] ×60
  var MB='手入力', sp=function(c,k,n){var a=[];for(var i=1;i<=n;i++)a.push([c+('0'+(k+i)).slice(-2),'',c.charAt(0)==='X'?'X':c,MB,'','空き枠（科目名を入力すると全シートに自動反映）']);return a;};
  var m=[];
  m.push(['S01','売上','S','自動｜売上','','ダッシュボード純売上を自動集計']);
  m.push(['S02','その他売上','S',MB,'','物販・イベント等']);
  m=m.concat(sp('S',2,2));
  m.push(['F01','仕入（食材・飲料）','F','自動｜仕入','','ダッシュボード仕入れを自動集計']);
  m=m.concat(sp('F',1,5));
  m.push(['L01','社員人件費','L','自動｜社員人件費','','ダッシュボードから自動集計']);
  m.push(['L02','アルバイト人件費（PA）','L','自動｜PA人件費','','ダッシュボードから自動集計']);
  m.push(['L03','役員報酬','L',MB,'','']);
  m.push(['L04','法定福利費','L',MB,'','']);
  m.push(['L05','通勤手当','L',MB,'','']);
  m.push(['L06','旅費交通費','L',MB,'','']);
  m.push(['L07','賞与積立','L',MB,'','管理会計上の引当']);
  m.push(['L08','退職金等','L',MB,'','']);
  m=m.concat(sp('L',8,2));
  m.push(['R01','家賃','R',MB,'✔','']);
  m.push(['R02','リース料','R',MB,'','']);
  m.push(['R03','家賃更新按分','R',MB,'','更新料の月割']);
  m=m.concat(sp('R',3,3));
  m.push(['A01','広告宣伝費','A',MB,'','']);
  m.push(['A02','販売促進費','A',MB,'','']);
  m=m.concat(sp('A',2,6));
  var O=[['水道光熱費','✔'],['通信費','✔'],['消耗品・備品費',''],['修繕費',''],['衛生管理費','✔'],['カード手数料','✔'],['支払手数料',''],['支払報酬料',''],['採用教育費',''],['接待交際費',''],['会議費',''],['慶弔見舞費',''],['保険料',''],['租税公課',''],['減価償却費',''],['福利厚生費',''],['諸会費',''],['雑費',''],['本部経費（按分）','']];
  for(var i=0;i<O.length;i++) m.push(['O'+('0'+(i+1)).slice(-2),O[i][0],'O',MB,O[i][1],'']);
  m.push(['O20','媒体販促費（自動）','O','自動｜媒体販促','','⚙設定「対象媒体」リストの純売上 × 媒体販促費率を自動計上']);
  m=m.concat(sp('O',20,4));
  m.push(['X01','銀行返済','X',MB,'','PL外（財務CF）。販管費には含まれません']);
  m=m.concat(sp('X',1,1));
  if(m.length!==60) throw 'master count '+m.length;
  return m;
}

function buildAll(){
  var ss=SpreadsheetApp.getActive(), ui=SpreadsheetApp.getUi();
  if(ss.getSheetByName(N.p)){
    if(ui.alert('再構築','既に新シートが存在します。削除して作り直しますか？',ui.ButtonSet.YES_NO)!==ui.Button.YES) return;
  }
  // 既存DB_PLの行を退避（販管費入力へ引き継ぎ）
  var seed=readDbPl();
  var tmp=ss.getSheetByName('__tmp')||ss.insertSheet('__tmp');
  // 旧タブ退避
  var newNames=Object.keys(N).map(function(k){return N[k];});
  ss.getSheets().forEach(function(sh){
    var nm=sh.getName();
    if(newNames.indexOf(nm)>=0){ ss.deleteSheet(sh); }
  });
  ss.getSheets().forEach(function(sh){
    var nm=sh.getName();
    if(nm.indexOf('旧_')!==0 && nm!=='__tmp' && newNames.indexOf(nm)<0){ sh.setName('旧_'+nm); try{sh.hideSheet();}catch(e){} }
  });
  buildGuide(ss); buildSettings(ss); buildMaster(ss); buildInput(ss,seed);
  buildDaily(ss); buildMonthly(ss); buildCheck(ss); buildPl(ss); buildTrend(ss);
  // 並び順
  var order=[N.g,N.s,N.m,N.i,N.c,N.p,N.t,N.d,N.w];
  for(var i=0;i<order.length;i++){ ss.setActiveSheet(ss.getSheetByName(order[i])); ss.moveActiveSheet(i+1); }
  ss.getSheets().forEach(function(sh){ if(sh.getName().indexOf('旧_')===0 && !sh.isSheetHidden()){ try{sh.hideSheet();}catch(e){} } });
  try{ss.deleteSheet(tmp);}catch(e){}
  ss.setActiveSheet(ss.getSheetByName(N.p));
  ui.alert('再構築完了','新しいPL管理システムを構築しました。\n「🔄 取込_日別」タブのA1セルで初回のみ「アクセスを許可」を押してください。',ui.ButtonSet.OK);
}

function readDbPl(){
  try{
    var dp=SpreadsheetApp.openById(DASH_ID).getSheetByName('DB_PL');
    var last=dp.getLastRow(); if(last<2) return [];
    var tz=Session.getScriptTimeZone();
    return dp.getRange(2,1,last-1,6).getValues().filter(function(r){return r[0]!=='' && r[1]!=='' && String(r[5])!==AUTO_MEMO;}).map(function(r){
      var ym=(r[0] instanceof Date)?Utilities.formatDate(r[0],tz,'yyyy/MM'):String(r[0]);
      return [ym,r[1],r[2],r[4],r[5]]; // 年月,店舗,科目,金額,メモ（区分は数式）
    });
  }catch(e){ return []; }
}

function sheetReset(ss,name,color){
  var sh=ss.getSheetByName(name); if(sh) ss.deleteSheet(sh);
  sh=ss.insertSheet(name); sh.setTabColor(color); return sh;
}
function title(sh,text,span){
  sh.getRange(1,1,1,span).setBackground(C.title);
  sh.getRange(1,1).setValue(text).setBackground(C.title).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(11).setVerticalAlignment('middle');
  sh.setRowHeight(1,30);
}
function hdr(sh,row,vals,col0){
  col0=col0||1;
  sh.getRange(row,col0,1,vals.length).setValues([vals]).setBackground(C.hdr).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
}

/* ---------- ガイド ---------- */
function buildGuide(ss){
  var sh=sheetReset(ss,N.g,'#1F4E79');
  title(sh,'🏠 PL管理システム ガイド ── わかりやすく・見やすく・管理しやすく・連携しやすく',6);
  var rows=[
    ['',''],['■ データの流れ',''],
    ['自動連携','売上・仕入・社員/アルバイト人件費・客数 → ダッシュボード「分析_日別店舗」から自動取込（🔄タブ）'],
    ['自動計上','⚙設定「対象媒体」リスト（Ring-style・いちご屋・Live GATE・Peevo…追加可）の純売上 × 媒体販促費率 →「媒体販促費（自動）」（区分O）としてPLに自動反映。DB_PLへも転記されます'],
    ['手入力','家賃・水道光熱費などの販管費 → 「✍ 販管費入力」タブだけに入力（1行＝年月×店舗×科目×金額）'],
    ['転記','メニュー「▶ PL管理 > DB_PLへ転記」→ ダッシュボードのDB_PLへ同じ列順で自動転記'],
    ['',''],['■ 使い方（月次ルーティン）',''],
    ['1','「✍ 販管費入力」に当月の販管費を追記（黄色セルのみ）'],
    ['2','「✅ 入力チェック」で対象月を選び、⚠（未入力）が無いか確認'],
    ['3','「📋 月次PL」「📈 年間推移」で確認 → メニューからDB_PLへ転記'],
    ['',''],['■ 科目・店舗の追加',''],
    ['科目追加','「📚 科目マスタ」の空き枠に科目名を入力するだけで、月次PL・年間推移・入力チェックへ自動反映'],
    ['店舗追加','「⚙ 設定」の店舗マスタ空き枠に店舗名（ダッシュボードと同じ表記）を追加するだけ'],
    ['チェック対象','科目マスタの「入力チェック対象」を✔にすると、入力チェックで未入力監視されます'],
    ['',''],['■ 初回のみ',''],
    ['接続許可','「🔄 取込_日別」タブのA1セルに表示される「アクセスを許可」ボタンを1回押してください'],
    ['',''],['■ AIエージェント運用',''],
    ['入力','「✍ 販管費入力」の末尾に行追記（メモ欄に「AI」と記録）'],
    ['確認','「✅ 入力チェック」の⚠件数を確認'],
    ['報告','「📋 月次PL」のKPI（F率・L率・FL率・営業利益率）を読み取り報告'],
  ];
  sh.getRange(3,2,rows.length,2).setValues(rows);
  for(var r=0;r<rows.length;r++){ if(rows[r][0].indexOf('■')===0) sh.getRange(3+r,2,1,2).setFontWeight('bold').setBackground(C.gray); }
  sh.setColumnWidth(1,20); sh.setColumnWidth(2,110); sh.setColumnWidth(3,760);
  sh.setHiddenGridlines(true);
}

/* ---------- 設定 ---------- */
function buildSettings(ss){
  var sh=sheetReset(ss,N.s,'#548235');
  title(sh,'⚙ 設定 ── 対象期間・店舗マスタ・税率（黄色セルが入力欄）',8);
  sh.getRange('A3').setValue('期間開始月'); sh.getRange('B3').setNumberFormat('@').setValue('2026/01').setBackground(C.in).setFontColor('#1155CC').setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('A4').setValue('期間終了月'); sh.getRange('B4').setNumberFormat('@').setValue('2026/12').setBackground(C.in).setFontColor('#1155CC').setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('C3').setValue('← yyyy/mm 形式で入力。最大24ヶ月（決算期や長期推移に合わせて自由に設定）').setFontColor('#888888');
  sh.getRange('C4').setFormula('=IF(OR($B$3="",$B$4=""),"",IF(DATEDIF(DATE(LEFT($B$3,4)*1,MID($B$3,6,2)*1,1),DATE(LEFT($B$4,4)*1,MID($B$4,6,2)*1,1),"M")>23,"⚠ 24ヶ月を超えています。24ヶ月目までのみ表示されます",DATEDIF(DATE(LEFT($B$3,4)*1,MID($B$3,6,2)*1,1),DATE(LEFT($B$4,4)*1,MID($B$4,6,2)*1,1),"M")+1&"ヶ月"))').setFontColor('#888888');
  sh.getRange('A5').setValue('法人税等率'); sh.getRange('B5').setValue(0.34).setNumberFormat('0.0%').setBackground(C.in).setFontColor('#1155CC');
  sh.getRange('C5').setValue('媒体販促費率').setHorizontalAlignment('right');
  sh.getRange('D5').setValue(0.24).setNumberFormat('0.0%').setBackground(C.in).setFontColor('#1155CC').setHorizontalAlignment('center');
  sh.getRange('E5').setValue('← H列「対象媒体」リストの純売上に掛けて「媒体販促費（自動）」（区分O）として自動計上').setFontColor('#888888');
  sh.getRange('A6').setValue('■ 店舗マスタ（ダッシュボードと同じ表記で。空き枠に追加すると全シートに反映）').setFontWeight('bold');
  hdr(sh,7,['No','店舗名'],1);
  var rows=[]; for(var i=0;i<16;i++) rows.push([i+1, STORES[i]||'']);
  sh.getRange(8,1,16,2).setValues(rows);
  sh.getRange(8,2,16,1).setBackground(C.in);
  sh.getRange('D6').setValue('■ 月リスト（自動）').setFontWeight('bold');
  hdr(sh,7,['年月'],4);
  var S0='DATE(LEFT($B$3,4)*1,MID($B$3,6,2)*1,1)', E0='DATE(LEFT($B$4,4)*1,MID($B$4,6,2)*1,1)';
  var mf=[]; for(var j=0;j<24;j++) mf.push(['=IF(OR($B$3="",$B$4=""),"",IF(EDATE('+S0+','+j+')>'+E0+',"",TEXT(EDATE('+S0+','+j+'),"yyyy/mm")))']);
  sh.getRange(8,4,24,1).setFormulas(mf);
  sh.getRange('F6').setValue('■ 店舗選択リスト（自動）').setFontWeight('bold');
  hdr(sh,7,['選択肢'],6);
  sh.getRange(8,6).setValue('全店');
  for(var k2=0;k2<16;k2++) sh.getRange(9+k2,6).setFormula('=IF($B$'+(8+k2)+'="","",$B$'+(8+k2)+')');
  sh.getRange('H6').setValue('■ 連携先').setFontWeight('bold');
  sh.getRange('H7').setValue('ダッシュボード'); sh.getRange('H8').setValue(DASH_URL).setFontColor('#666666');
  sh.getRange('H10').setValue('■ 媒体販促費 対象媒体（空き枠に追加すると自動で計上対象に）').setFontWeight('bold');
  hdr(sh,11,['対象媒体'],8);
  var med=['Ring-style','いちご屋','Live GATE','Peevo'],mrows=[]; for(var k3=0;k3<10;k3++) mrows.push([med[k3]||'']);
  sh.getRange(12,8,10,1).setValues(mrows).setBackground(C.in);
  ss.setNamedRange('対象媒体リスト', sh.getRange('H12:H21'));
  sh.setColumnWidth(1,60); sh.setColumnWidth(2,240); sh.setColumnWidth(4,90); sh.setColumnWidth(6,240); sh.setColumnWidth(8,300);
  ss.setNamedRange('店舗リスト', sh.getRange('B8:B23'));
  ss.setNamedRange('月リスト', sh.getRange('D8:D31'));
  ss.setNamedRange('店舗選択リスト', sh.getRange('F8:F24'));
  sh.setFrozenRows(1);
}

/* ---------- 科目マスタ ---------- */
function buildMaster(ss){
  var sh=sheetReset(ss,N.m,'#548235');
  title(sh,'📚 科目マスタ ── 空き枠に科目名を入力すると全シートへ自動反映（黄色セルが編集欄）',6);
  hdr(sh,2,['コード','管理科目','区分','データ源','入力チェック対象','メモ']);
  var m=master();
  sh.getRange(3,1,60,6).setValues(m);
  sh.getRange(3,2,60,1).setBackground(C.in);
  sh.getRange(3,5,60,1).setBackground(C.in).setHorizontalAlignment('center');
  sh.getRange(3,6,60,1).setBackground(C.in);
  sh.getRange(3,3,60,2).setBackground(C.gray);
  // 区分・データ源・チェックのプルダウン
  var dvK=SpreadsheetApp.newDataValidation().requireValueInList(['S','F','L','R','A','O','X'],true).setAllowInvalid(false).build();
  var dvS=SpreadsheetApp.newDataValidation().requireValueInList(['自動｜売上','自動｜仕入','自動｜PA人件費','自動｜社員人件費','自動｜媒体販促','手入力'],true).setAllowInvalid(false).build();
  var dvC=SpreadsheetApp.newDataValidation().requireValueInList(['✔',''],true).setAllowInvalid(true).build();
  sh.getRange(3,3,60,1).setDataValidation(dvK);
  sh.getRange(3,4,60,1).setDataValidation(dvS);
  sh.getRange(3,5,60,1).setDataValidation(dvC);
  ss.setNamedRange('科目リスト', sh.getRange('B3:B62'));
  var w=[70,200,55,140,120,320];
  for(var i=0;i<w.length;i++) sh.setColumnWidth(i+1,w[i]);
  sh.setFrozenRows(2);
}

/* ---------- 販管費入力 ---------- */
function buildInput(ss,seed){
  var sh=sheetReset(ss,N.i,'#BF9000');
  var LAST=2002;
  title(sh,'✍ 販管費入力 ── 唯一の手入力タブ。1行＝年月×店舗×科目×金額（DB_PLと同じ並び順）。AIエージェントはここに追記',6);
  hdr(sh,2,['年月','店舗名','勘定科目','区分(自動)','金額','メモ']);
  // D列: 区分自動
  var df=[]; for(var r=3;r<=LAST;r++) df.push(['=IF($C'+r+'="","",IFERROR(VLOOKUP($C'+r+','+q(N.m)+'$B$3:$C$62,2,FALSE),"？"))']);
  sh.getRange(3,4,df.length,1).setFormulas(df);
  // 書式
  sh.getRange(3,1,LAST-2,3).setBackground(C.in);
  sh.getRange(3,5,LAST-2,2).setBackground(C.in);
  sh.getRange(3,4,LAST-2,1).setBackground(C.gray).setHorizontalAlignment('center');
  sh.getRange(3,5,LAST-2,1).setNumberFormat(NUM);
  // 入力規則
  var ml=ss.getRangeByName('月リスト'), sl=ss.getRangeByName('店舗リスト'), al=ss.getRangeByName('科目リスト');
  sh.getRange(3,1,LAST-2,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(ml,true).setAllowInvalid(true).build());
  sh.getRange(3,2,LAST-2,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(sl,true).setAllowInvalid(true).build());
  sh.getRange(3,3,LAST-2,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(al,true).setAllowInvalid(true).build());
  // 既存DB_PL行を引き継ぎ
  if(seed && seed.length){
    var abc=seed.map(function(r){return [r[0],r[1],r[2]];});
    var ef=seed.map(function(r){return [r[3],r[4]||'既存DB_PLから引継'];});
    sh.getRange(3,1,seed.length,3).setValues(abc);
    sh.getRange(3,5,seed.length,2).setValues(ef);
  }
  var w=[80,220,160,70,110,220];
  for(var i=0;i<w.length;i++) sh.setColumnWidth(i+1,w[i]);
  sh.setFrozenRows(2);
}

/* ---------- 取込_日別 ---------- */
function buildDaily(ss){
  var sh=sheetReset(ss,N.d,'#7F7F7F');
  sh.getRange('A1').setFormula('=QUERY(IMPORTRANGE("'+DASH_URL+'","分析_日別店舗!A2:AA50000"),"select Col1,Col10,Col16,Col18,Col24,Col25,Col27 where Col10 is not null",0)');
  sh.getRange('H1').setFormula('=ARRAYFORMULA(IF(A1:A="","",TEXT(A1:A,"yyyy/mm")))');
  sh.getRange('J1').setValue('A:日付 B:店舗 C:客数 D:純売上 E:PA人件費 F:社員人件費 G:仕入 H:年月 ／ K:年月(媒体) L:店舗 M:販促対象純売上 N:年月キー ／ 初回はA1の「アクセスを許可」を押す').setFontColor('#888888');
  sh.getRange('K1').setFormula('=IFERROR(LET(d,{IMPORTRANGE("'+DASH_URL+'","分析_媒体別日次!B2:B100000"),IMPORTRANGE("'+DASH_URL+'","分析_媒体別日次!J2:K100000"),IMPORTRANGE("'+DASH_URL+'","分析_媒体別日次!O2:O100000")},QUERY(FILTER(d,COUNTIF(\'⚙ 設定\'!$H$12:$H$21,CHOOSECOLS(d,3)),CHOOSECOLS(d,3)<>""),"select Col1, Col2, sum(Col4) group by Col1, Col2 label sum(Col4) \'\'",0)),"")');
  sh.getRange('N1').setFormula('=ARRAYFORMULA(IF(K1:K="","",TEXT(K1:K,"yyyy/mm")))');
  sh.hideSheet();
}

/* ---------- 取込_月次 ---------- */
function buildMonthly(ss){
  var sh=sheetReset(ss,N.w,'#7F7F7F');
  hdr(sh,1,['年月','店舗名','客数','純売上','PA人件費','社員人件費','仕入','媒体販促対象売上']);
  var f=[];
  for(var j=0;j<24;j++){
    for(var s=0;s<16;s++){
      var r=2+j*16+s, st="'⚙ 設定'!$B$"+(8+s), mo="'⚙ 設定'!$D$"+(8+j);
      var g='=IF(OR('+st+'="",'+mo+'=""),"",';
      var cr=q(N.d)+'$H:$H,$A'+r+','+q(N.d)+'$B:$B,$B'+r;
      f.push([
        g+mo+')',
        g+st+')',
        g+'SUMIFS('+q(N.d)+'$C:$C,'+cr+'))',
        g+'SUMIFS('+q(N.d)+'$D:$D,'+cr+'))',
        g+'SUMIFS('+q(N.d)+'$E:$E,'+cr+'))',
        g+'SUMIFS('+q(N.d)+'$F:$F,'+cr+'))',
        g+'SUMIFS('+q(N.d)+'$G:$G,'+cr+'))',
        g+'SUMIFS('+q(N.d)+'$M:$M,'+q(N.d)+'$N:$N,$A'+r+','+q(N.d)+'$L:$L,$B'+r+'))'
      ]);
    }
  }
  sh.getRange(2,1,f.length,8).setFormulas(f);
  sh.getRange(2,3,f.length,6).setNumberFormat(NUM);
  sh.hideSheet();
}

/* ---------- 月次PL / 年間推移 共通行定義 ---------- */
// ブロック: [区分, マスタ開始行, 科目数, PL開始行]
var BLK=[['S',3,4,6],['F',7,6,11],['L',13,10,19],['R',23,6,30],['A',29,8,37],['O',37,24,46]];
var ROW={subS:10,subF:17,gp:18,subL:29,subR:36,subA:45,subO:70,sga:71,op:72,tax:73,np:74,bank:75,fcf:76,kpi:79};
var XMR=61; // 銀行返済マスタ行

function srcFormula(mr,mo,st,acct){ // データ源で分岐する集計式
  var M=q(N.m), W=q(N.w), I=q(N.i);
  return 'IF('+M+'$D$'+mr+'="自動｜売上",SUMIFS('+W+'$D:$D,'+W+'$A:$A,'+mo+','+W+'$B:$B,'+st+'),'+
    'IF('+M+'$D$'+mr+'="自動｜仕入",SUMIFS('+W+'$G:$G,'+W+'$A:$A,'+mo+','+W+'$B:$B,'+st+'),'+
    'IF('+M+'$D$'+mr+'="自動｜PA人件費",SUMIFS('+W+'$E:$E,'+W+'$A:$A,'+mo+','+W+'$B:$B,'+st+'),'+
    'IF('+M+'$D$'+mr+'="自動｜社員人件費",SUMIFS('+W+'$F:$F,'+W+'$A:$A,'+mo+','+W+'$B:$B,'+st+'),'+
    'IF('+M+'$D$'+mr+'="自動｜媒体販促",ROUND(SUMIFS('+W+'$H:$H,'+W+'$A:$A,'+mo+','+W+'$B:$B,'+st+')*'+q(N.s)+'$D$5,0),'+
    'SUMIFS('+I+'$E:$E,'+I+'$A:$A,'+mo+','+I+'$B:$B,'+st+','+I+'$C:$C,'+acct+'))))))';
}

function plCommonRows(sh,valCols,labelFill){ // B,C列(科目・区分)と小計ラベル
  var M=q(N.m);
  BLK.forEach(function(b){
    for(var i=0;i<b[2];i++){
      var r=b[3]+i, mr=b[1]+i;
      sh.getRange(r,2).setFormula('=IF('+M+'B'+mr+'="","",'+M+'B'+mr+')');
      sh.getRange(r,3).setFormula('=IF($B'+r+'="","",'+M+'C'+mr+')');
    }
  });
  var subs=[[ROW.subS,'売上高合計'],[ROW.subF,'売上原価合計'],[ROW.gp,'売上総利益（粗利）'],[ROW.subL,'人件費計'],[ROW.subR,'家賃計'],[ROW.subA,'広告販促計'],[ROW.subO,'その他経費計'],[ROW.sga,'販管費合計（L+R+A+O）'],[ROW.op,'営業利益'],[ROW.tax,'法人税等（概算）'],[ROW.np,'当期純利益'],[ROW.bank,'銀行返済'],[ROW.fcf,'財務CF（返済後）']];
  subs.forEach(function(s){
    sh.getRange(s[0],2).setValue(s[1]).setFontWeight('bold');
    sh.getRange(s[0],2,1,valCols+2).setBackground(s[0]===ROW.op||s[0]===ROW.gp?C.calc:C.sub);
  });
  sh.getRange(ROW.kpi-1,2).setValue('■ KPI（対売上比率ほか）').setFontWeight('bold');
  var kpis=['F率（原価率）','L率（人件費率）','R率（家賃率）','A率（広告費率）','O率（その他率）','FL率','FLR率','営業利益率','客数','客単価'];
  for(var k=0;k<kpis.length;k++) sh.getRange(ROW.kpi+k,2).setValue(kpis[k]);
}

/* ---------- 月次PL ---------- */
function buildPl(ss){
  var sh=sheetReset(ss,N.p,'#2E75B6');
  title(sh,'📋 月次PL ── 対象月を選ぶだけ。全店＋店舗横並び比較（自動集計・編集不要）',20);
  sh.getRange('B3').setValue('対象月').setFontWeight('bold');
  sh.getRange('C3').setFormula('=INDEX(月リスト,6)');
  sh.getRange('C3').setBackground(C.in).setFontColor('#1155CC').setFontWeight('bold').setHorizontalAlignment('center')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(ss.getRangeByName('月リスト'),true).setAllowInvalid(true).build());
  hdr(sh,5,['科目','区分','全店'],2);
  for(var s=0;s<16;s++) sh.getRange(5,5+s).setFormula('=IF('+q(N.s)+'$B$'+(8+s)+'="","",'+q(N.s)+'$B$'+(8+s)+')').setBackground(C.hdr).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
  plCommonRows(sh,17);
  // 科目行
  BLK.forEach(function(b){
    for(var i=0;i<b[2];i++){
      var r=b[3]+i, mr=b[1]+i, row=[];
      row.push('=IF($B'+r+'="","",SUM(E'+r+':T'+r+'))');
      SC.forEach(function(cl){
        row.push('=IF($B'+r+'="","",IF('+cl+'$5="","",'+srcFormula(mr,'$C$3',cl+'$5','$B'+r)+'))');
      });
      sh.getRange(r,4,1,17).setFormulas([row]);
    }
  });
  // 小計・計算行（D〜T列）
  var cols=['D'].concat(SC);
  function calcRow(r,fn){ var row=cols.map(function(cl){ return (cl==='D')?fn(cl):'=IF('+cl+'$5="","",'+fn(cl).slice(1)+')'; }); sh.getRange(r,4,1,17).setFormulas([row]); }
  calcRow(ROW.subS,function(cl){return '=SUM('+cl+'6:'+cl+'9)';});
  calcRow(ROW.subF,function(cl){return '=SUM('+cl+'11:'+cl+'16)';});
  calcRow(ROW.gp,function(cl){return '='+cl+ROW.subS+'-'+cl+ROW.subF;});
  calcRow(ROW.subL,function(cl){return '=SUM('+cl+'19:'+cl+'28)';});
  calcRow(ROW.subR,function(cl){return '=SUM('+cl+'30:'+cl+'35)';});
  calcRow(ROW.subA,function(cl){return '=SUM('+cl+'37:'+cl+'44)';});
  calcRow(ROW.subO,function(cl){return '=SUM('+cl+'46:'+cl+'69)';});
  calcRow(ROW.sga,function(cl){return '='+cl+ROW.subL+'+'+cl+ROW.subR+'+'+cl+ROW.subA+'+'+cl+ROW.subO;});
  calcRow(ROW.op,function(cl){return '='+cl+ROW.gp+'-'+cl+ROW.sga;});
  calcRow(ROW.tax,function(cl){return '=IF(N('+cl+ROW.op+')>0,ROUND('+cl+ROW.op+'*'+q(N.s)+'$B$5,0),0)';});
  calcRow(ROW.np,function(cl){return '='+cl+ROW.op+'-'+cl+ROW.tax;});
  sh.getRange(ROW.bank,4).setFormula('=SUM(E'+ROW.bank+':T'+ROW.bank+')');
  SC.forEach(function(cl){
    sh.getRange(ROW.bank,sh.getRange(cl+'1').getColumn()).setFormula('=IF('+cl+'$5="","",SUMIFS('+q(N.i)+'$E:$E,'+q(N.i)+'$A:$A,$C$3,'+q(N.i)+'$B:$B,'+cl+'$5,'+q(N.i)+'$C:$C,'+q(N.m)+'$B$'+XMR+'))');
  });
  calcRow(ROW.fcf,function(cl){return '='+cl+ROW.np+'-'+cl+ROW.bank;});
  // KPI
  var K=ROW.kpi;
  function kpiRow(r,fn,fmt){ var row=cols.map(function(cl){ return '=IF('+cl+'$5="","",'+fn(cl)+')'; }); sh.getRange(r,4,1,17).setFormulas([row]).setNumberFormat(fmt); }
  kpiRow(K+0,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",'+cl+'$'+ROW.subF+'/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+1,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",'+cl+'$'+ROW.subL+'/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+2,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",'+cl+'$'+ROW.subR+'/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+3,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",'+cl+'$'+ROW.subA+'/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+4,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",'+cl+'$'+ROW.subO+'/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+5,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",('+cl+'$'+ROW.subF+'+'+cl+'$'+ROW.subL+')/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+6,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",('+cl+'$'+ROW.subF+'+'+cl+'$'+ROW.subL+'+'+cl+'$'+ROW.subR+')/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+7,function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",'+cl+'$'+ROW.op+'/'+cl+'$'+ROW.subS+')';},PCT);
  kpiRow(K+8,function(cl){return (cl==='D')?'SUMIFS('+q(N.w)+'$C:$C,'+q(N.w)+'$A:$A,$C$3)':'SUMIFS('+q(N.w)+'$C:$C,'+q(N.w)+'$A:$A,$C$3,'+q(N.w)+'$B:$B,'+cl+'$5)';},NUM);
  kpiRow(K+9,function(cl){return 'IF(N('+cl+'$'+(K+8)+')=0,"",'+cl+'$'+ROW.subS+'/'+cl+'$'+(K+8)+')';},NUM);
  // 書式
  sh.getRange(6,4,ROW.fcf-5,17).setNumberFormat(NUM);
  sh.getRange(K,4,10,17).setBorder(true,true,true,true,true,true,'#DDDDDD',SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(5,2,ROW.fcf-4,19).setBorder(true,true,true,true,true,true,'#CCCCCC',SpreadsheetApp.BorderStyle.SOLID);
  sh.setColumnWidth(1,20); sh.setColumnWidth(2,190); sh.setColumnWidth(3,45); sh.setColumnWidth(4,110);
  for(var c=5;c<=20;c++) sh.setColumnWidth(c,105);
  sh.setFrozenRows(5); sh.setFrozenColumns(4);
  sh.setHiddenGridlines(true);
}

/* ---------- 年間推移 ---------- */
function buildTrend(ss){
  var sh=sheetReset(ss,N.t,'#2E75B6');
  title(sh,'📈 年間推移 ── 店舗を選ぶだけ。期間は「⚙ 設定」の開始月〜終了月で指定（最大24ヶ月・自動集計）',29);
  sh.getRange('B3').setValue('対象店舗').setFontWeight('bold');
  sh.getRange('C3').setValue('全店').setBackground(C.in).setFontColor('#1155CC').setFontWeight('bold').setHorizontalAlignment('center')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(ss.getRangeByName('店舗選択リスト'),true).setAllowInvalid(true).build());
  sh.getRange('E3').setFormula('="表示期間: "&'+q(N.s)+'$B$3&" 〜 "&'+q(N.s)+'$B$4&"（⚙ 設定で変更）"').setFontColor('#888888');
  hdr(sh,5,['科目','区分'],2);
  for(var j=0;j<24;j++) sh.getRange(5,4+j).setFormula('='+q(N.s)+'$D$'+(8+j)).setBackground(C.hdr).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange(5,28).setValue('合計').setBackground(C.hdr).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center');
  plCommonRows(sh,25);
  var ST='IF($C$3="全店","<>",$C$3)';
  BLK.forEach(function(b){
    for(var i=0;i<b[2];i++){
      var r=b[3]+i, mr=b[1]+i, row=[];
      MC.forEach(function(cl){
        row.push('=IF($B'+r+'="","",IF('+cl+'$5="","",'+srcFormula(mr,cl+'$5',ST,'$B'+r)+'))');
      });
      row.push('=IF($B'+r+'="","",SUM(D'+r+':AA'+r+'))');
      sh.getRange(r,4,1,25).setFormulas([row]);
    }
  });
  var cols=MC.concat(['AB']);
  function wrapCl(cl,body){ return (cl==='AB')?('='+body):('=IF('+cl+'$5="","",'+body+')'); }
  function calcRow(r,fn){ sh.getRange(r,4,1,25).setFormulas([cols.map(function(cl){return wrapCl(cl,fn(cl));})]); }
  calcRow(ROW.subS,function(cl){return 'SUM('+cl+'6:'+cl+'9)';});
  calcRow(ROW.subF,function(cl){return 'SUM('+cl+'11:'+cl+'16)';});
  calcRow(ROW.gp,function(cl){return 'N('+cl+ROW.subS+')-N('+cl+ROW.subF+')';});
  calcRow(ROW.subL,function(cl){return 'SUM('+cl+'19:'+cl+'28)';});
  calcRow(ROW.subR,function(cl){return 'SUM('+cl+'30:'+cl+'35)';});
  calcRow(ROW.subA,function(cl){return 'SUM('+cl+'37:'+cl+'44)';});
  calcRow(ROW.subO,function(cl){return 'SUM('+cl+'46:'+cl+'69)';});
  calcRow(ROW.sga,function(cl){return 'N('+cl+ROW.subL+')+N('+cl+ROW.subR+')+N('+cl+ROW.subA+')+N('+cl+ROW.subO+')';});
  calcRow(ROW.op,function(cl){return 'N('+cl+ROW.gp+')-N('+cl+ROW.sga+')';});
  calcRow(ROW.tax,function(cl){return 'IF(N('+cl+ROW.op+')>0,ROUND(N('+cl+ROW.op+')*'+q(N.s)+'$B$5,0),0)';});
  calcRow(ROW.np,function(cl){return 'N('+cl+ROW.op+')-N('+cl+ROW.tax+')';});
  MC.forEach(function(cl){
    sh.getRange(ROW.bank,sh.getRange(cl+'1').getColumn()).setFormula('=IF('+cl+'$5="","",SUMIFS('+q(N.i)+'$E:$E,'+q(N.i)+'$A:$A,'+cl+'$5,'+q(N.i)+'$B:$B,'+ST+','+q(N.i)+'$C:$C,'+q(N.m)+'$B$'+XMR+'))');
  });
  sh.getRange(ROW.bank,28).setFormula('=SUM(D'+ROW.bank+':AA'+ROW.bank+')');
  calcRow(ROW.fcf,function(cl){return 'N('+cl+ROW.np+')-N('+cl+ROW.bank+')';});
  var K=ROW.kpi;
  function kpiRow(r,fn,fmt){ sh.getRange(r,4,1,25).setFormulas([cols.map(function(cl){return wrapCl(cl,fn(cl));})]).setNumberFormat(fmt); }
  function ratio(a,b){ return function(cl){return 'IF(N('+cl+'$'+ROW.subS+')=0,"",('+a(cl)+')/'+cl+'$'+ROW.subS+')';}; }
  kpiRow(K+0,ratio(function(cl){return 'N('+cl+'$'+ROW.subF+')';}),PCT);
  kpiRow(K+1,ratio(function(cl){return 'N('+cl+'$'+ROW.subL+')';}),PCT);
  kpiRow(K+2,ratio(function(cl){return 'N('+cl+'$'+ROW.subR+')';}),PCT);
  kpiRow(K+3,ratio(function(cl){return 'N('+cl+'$'+ROW.subA+')';}),PCT);
  kpiRow(K+4,ratio(function(cl){return 'N('+cl+'$'+ROW.subO+')';}),PCT);
  kpiRow(K+5,ratio(function(cl){return 'N('+cl+'$'+ROW.subF+')+N('+cl+'$'+ROW.subL+')';}),PCT);
  kpiRow(K+6,ratio(function(cl){return 'N('+cl+'$'+ROW.subF+')+N('+cl+'$'+ROW.subL+')+N('+cl+'$'+ROW.subR+')';}),PCT);
  kpiRow(K+7,ratio(function(cl){return 'N('+cl+'$'+ROW.op+')';}),PCT);
  kpiRow(K+8,function(cl){return (cl==='AB')?'SUM(D'+(K+8)+':AA'+(K+8)+')':'SUMIFS('+q(N.w)+'$C:$C,'+q(N.w)+'$A:$A,'+cl+'$5,'+q(N.w)+'$B:$B,'+ST+')';},NUM);
  kpiRow(K+9,function(cl){return 'IF(N('+cl+'$'+(K+8)+')=0,"",N('+cl+'$'+ROW.subS+')/'+cl+'$'+(K+8)+')';},NUM);
  sh.getRange(6,4,ROW.fcf-5,25).setNumberFormat(NUM);
  sh.getRange(5,2,ROW.fcf-4,27).setBorder(true,true,true,true,true,true,'#CCCCCC',SpreadsheetApp.BorderStyle.SOLID);
  sh.setColumnWidth(1,20); sh.setColumnWidth(2,190); sh.setColumnWidth(3,45);
  for(var c=4;c<=28;c++) sh.setColumnWidth(c,100);
  sh.setFrozenRows(5); sh.setFrozenColumns(3);
  sh.setHiddenGridlines(true);
}

/* ---------- 入力チェック ---------- */
function buildCheck(ss){
  var sh=sheetReset(ss,N.c,'#C00000');
  title(sh,'✅ 入力チェック ── 対象月を選ぶと、自動連携の状況と手入力の未入力（⚠）が一覧で見えます',20);
  sh.getRange('B2').setValue('対象月').setFontWeight('bold');
  sh.getRange('C2').setFormula('=INDEX(月リスト,6)');
  sh.getRange('C2').setBackground(C.in).setFontColor('#1155CC').setFontWeight('bold').setHorizontalAlignment('center')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(ss.getRangeByName('月リスト'),true).setAllowInvalid(true).build());
  sh.getRange('E2').setValue('未入力件数').setFontWeight('bold');
  sh.getRange('F2').setFormula('=COUNTIF(E13:T72,"⚠")').setFontColor('#C00000').setFontWeight('bold').setHorizontalAlignment('center');
  // 自動連携状況
  sh.getRange('B4').setValue('■ 自動連携（ダッシュボード 分析_日別店舗）').setFontWeight('bold');
  hdr(sh,5,['項目',''],2);
  for(var s=0;s<16;s++) sh.getRange(5,5+s).setFormula('=IF('+q(N.s)+'$B$'+(8+s)+'="","",'+q(N.s)+'$B$'+(8+s)+')').setBackground(C.hdr).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
  sh.getRange(6,2).setValue('売上データ日数'); sh.getRange(7,2).setValue('純売上'); sh.getRange(8,2).setValue('仕入'); sh.getRange(9,2).setValue('人件費（PA+社員）');
  SC.forEach(function(cl){
    var st=cl+'$5', W=q(N.w), D=q(N.d);
    var col=sh.getRange(cl+'1').getColumn();
    sh.getRange(6,col).setFormula('=IF('+st+'="","",COUNTIFS('+D+'$H:$H,$C$2,'+D+'$B:$B,'+st+','+D+'$D:$D,">0"))');
    sh.getRange(7,col).setFormula('=IF('+st+'="","",SUMIFS('+W+'$D:$D,'+W+'$A:$A,$C$2,'+W+'$B:$B,'+st+'))');
    sh.getRange(8,col).setFormula('=IF('+st+'="","",SUMIFS('+W+'$G:$G,'+W+'$A:$A,$C$2,'+W+'$B:$B,'+st+'))');
    sh.getRange(9,col).setFormula('=IF('+st+'="","",SUMIFS('+W+'$E:$E,'+W+'$A:$A,$C$2,'+W+'$B:$B,'+st+')+SUMIFS('+W+'$F:$F,'+W+'$A:$A,$C$2,'+W+'$B:$B,'+st+'))');
  });
  sh.getRange(7,5,3,16).setNumberFormat(NUM);
  // 手入力チェックマトリクス
  sh.getRange('B11').setValue('■ 手入力チェック（科目マスタで「入力チェック対象＝✔」の科目 × 店舗。⚠＝未入力）').setFontWeight('bold');
  hdr(sh,12,['科目',''],2);
  for(var s2=0;s2<16;s2++) sh.getRange(12,5+s2).setFormula('=IF('+q(N.s)+'$B$'+(8+s2)+'="","",'+q(N.s)+'$B$'+(8+s2)+')').setBackground(C.hdr).setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
  var M=q(N.m), I=q(N.i);
  for(var i=0;i<60;i++){
    var r=13+i, mr=3+i;
    sh.getRange(r,2).setFormula('=IF(('+M+'$D$'+mr+'="手入力")*('+M+'$E$'+mr+'="✔")*('+M+'$B$'+mr+'<>""),'+M+'$B$'+mr+',"")');
    var row=[];
    SC.forEach(function(cl){
      var sums='SUMIFS('+I+'$E:$E,'+I+'$A:$A,$C$2,'+I+'$B:$B,'+cl+'$12,'+I+'$C:$C,$B'+r+')';
      row.push('=IF($B'+r+'="","",IF('+cl+'$12="","",IF('+sums+'=0,"⚠",'+sums+')))');
    });
    sh.getRange(r,5,1,16).setFormulas([row]).setNumberFormat(NUM).setHorizontalAlignment('center');
  }
  // 条件付き書式: ⚠を赤
  var rng=sh.getRange(6,5,67,16);
  var rule=SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('⚠').setBackground('#F4CCCC').setFontColor('#CC0000').setBold(true).setRanges([rng]).build();
  var rule0=SpreadsheetApp.newConditionalFormatRule().whenNumberEqualTo(0).setFontColor('#CC0000').setRanges([sh.getRange(6,5,1,16)]).build();
  sh.setConditionalFormatRules([rule,rule0]);
  sh.setColumnWidth(1,20); sh.setColumnWidth(2,190); sh.setColumnWidth(3,90); sh.setColumnWidth(4,10);
  for(var c=5;c<=20;c++) sh.setColumnWidth(c,105);
  sh.setFrozenRows(12); sh.setFrozenColumns(2);
  sh.setHiddenGridlines(true);
}

/* ---------- メニュー & DB_PL転記 ---------- */
function onOpen(){
  SpreadsheetApp.getUi().createMenu('▶ PL管理')
    .addItem('DB_PLへ転記（販管費入力 → ダッシュボード）','syncToDbPl')
    .addSeparator()
    .addItem('システム再構築（初期化）','buildAll')
    .addToUi();
}

function ymKey(v,tz){
  if(v instanceof Date) return Utilities.formatDate(v,tz,'yyyy/MM');
  return String(v).replace(/^(\d{4})\/(\d)$/,'$1/0$2');
}

function computeAutoPromoRows(ss){ // 媒体販促費（自動）: 取込_月次H列 × 設定D5
  var w=ss.getSheetByName(N.w); if(!w) return [];
  var vals=w.getRange(2,1,384,8).getValues();
  var rate=Number(ss.getSheetByName(N.s).getRange('D5').getValue())||0;
  var acct=ss.getSheetByName(N.m).getRange(56,2).getValue()||'媒体販促費（自動）';
  var out=[];
  vals.forEach(function(r){
    if(r[0]!=='' && r[1]!=='' && Number(r[7])>0){
      var amt=Math.round(Number(r[7])*rate);
      if(amt>0) out.push([String(r[0]), r[1], acct, 'O', amt, AUTO_MEMO]);
    }
  });
  return out;
}

function syncToDbPl(){
  var ss=SpreadsheetApp.getActive(), ui=SpreadsheetApp.getUi(), tz=Session.getScriptTimeZone();
  var src=ss.getSheetByName(N.i);
  var last=src.getLastRow();
  var data=last>=3?src.getRange(3,1,last-2,6).getValues().filter(function(r){return r[0]!==''&&r[1]!==''&&r[2]!==''&&r[4]!=='';}):[];
  var auto=computeAutoPromoRows(ss);
  if(!data.length && !auto.length){ ui.alert('転記','転記するデータがありません。',ui.ButtonSet.OK); return; }
  var months={}, autoMonths={};
  data.forEach(function(r){ months[ymKey(r[0],tz)]=true; });
  auto.forEach(function(r){ autoMonths[r[0]]=true; });
  var dash=SpreadsheetApp.openById(DASH_ID), dp=dash.getSheetByName('DB_PL');
  var dlast=dp.getLastRow(), keep=[];
  if(dlast>=2){
    dp.getRange(2,1,dlast-1,6).getValues().forEach(function(r){
      if(r[0]==='') return;
      var ym=ymKey(r[0],tz);
      if(String(r[5])===AUTO_MEMO){ if(!autoMonths[ym]) keep.push(r); }
      else if(!months[ym]) keep.push(r);
    });
  }
  var rows=data.map(function(r){
    var ym=ymKey(r[0],tz).split('/');
    return [new Date(Number(ym[0]),Number(ym[1])-1,1), r[1], r[2], r[3], r[4], r[5]];
  });
  var autoRows=auto.map(function(r){
    var ym=r[0].split('/');
    return [new Date(Number(ym[0]),Number(ym[1])-1,1), r[1], r[2], r[3], r[4], r[5]];
  });
  var out=keep.concat(rows).concat(autoRows);
  if(dlast>=2) dp.getRange(2,1,dlast-1,6).clearContent();
  if(out.length){
    dp.getRange(2,1,out.length,6).setValues(out);
    dp.getRange(2,1,out.length,1).setNumberFormat('yyyy/m/d');
  }
  ui.alert('転記完了','DB_PLへ 手入力 '+rows.length+' 行＋媒体販促費（自動）'+autoRows.length+' 行を転記しました。\n手入力対象月: '+Object.keys(months).sort().join(', ')+'\n（対象月の既存行は差し替え、それ以外の月は保持）',ui.ButtonSet.OK);
}

