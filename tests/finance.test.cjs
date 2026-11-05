// Regression tests for the single-file finance app.
// Run with: node --test tests/finance.test.cjs
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function section(start,end){
  const i=html.indexOf(start),j=html.indexOf(end,i+start.length);
  assert.ok(i>=0&&j>i,'Missing section: '+start);
  return html.slice(i,j);
}
const helpers=section('    function rebaseUserChanges(', '    /* ---------- helpers ---------- */');
const pie=section('    const PIE_PALETTE =', '    /* ---------- list ---------- */');
const charts=section('    function createAreaSVG(', '    function renderAreaChartCard(');
const context={
  normalize:x=>x,
  totalsForSnapshot:()=>({entries:[]}),
  toJPY:e=>e.amount,
  formatJPY:n=>'¥'+Math.round(n).toLocaleString('ja-JP')
};
vm.createContext(context);
vm.runInContext(helpers+'\nthis.rebaseUserChanges=rebaseUserChanges;',context);
vm.runInContext(pie+'\nthis.pieDataFor=pieDataFor;this.escapePieLabel=escapePieLabel;',context);
vm.runInContext(charts+'\nthis.createAreaSVG=createAreaSVG;',context);

const copy=x=>JSON.parse(JSON.stringify(x));
function baseline(){
  return {
    accounts:[{id:'a',name:'Bank'}],
    entries:[{id:'1',accountId:'a',month:'2026-10',owner:'晴太',type:'asset',assetClass:'現金',amount:100}],
    rates:{JPY:1,USD:150},meta:{lastBackup:null},
    mainCategories:['銀行'],assetClasses:['現金'],
    memoTree:{rootIds:[],nodes:{}},updatedAt:1
  };
}
test('inline JavaScript parses',()=>{
  const js=section('<script>','</script>').replace('<script>','');
  assert.doesNotThrow(()=>new vm.Script(js));
});
test('independent device edits are merged transactionally',()=>{
  const base=baseline(),local=copy(base),remote=copy(base);
  local.entries[0].amount=120;
  remote.rates.USD=155;
  const result=context.rebaseUserChanges(base,local,remote);
  assert.equal(result.conflicts.length,0);
  assert.equal(result.merged.entries[0].amount,120);
  assert.equal(result.merged.rates.USD,155);
});
test('deleted entries do not resurrect during merge',()=>{
  const base=baseline(),local=copy(base),remote=copy(base);
  local.entries=[];
  remote.accounts.push({id:'b',name:'New bank'});
  const result=context.rebaseUserChanges(base,local,remote);
  assert.equal(result.merged.entries.length,0);
  assert.equal(result.merged.accounts.length,2);
});
test('deleting an account removes its entries including concurrent additions',()=>{
  const base=baseline(),local=copy(base),remote=copy(base);
  local.accounts=[];local.entries=[];
  remote.entries.push({id:'2',accountId:'a',month:'2026-11',owner:'香花',amount:200});
  const result=context.rebaseUserChanges(base,local,remote);
  assert.equal(result.merged.accounts.length,0);
  assert.equal(result.merged.entries.length,0);
});
test('conflicting edits of the same asset are detected',()=>{
  const base=baseline(),local=copy(base),remote=copy(base);
  local.entries[0].amount=120;remote.entries[0].amount=130;
  const result=context.rebaseUserChanges(base,local,remote);
  assert.ok(result.conflicts.some(x=>x.startsWith('entries:')));
});
test('independent memo and asset edits both survive',()=>{
  const base=baseline(),local=copy(base),remote=copy(base);
  local.memoTree.nodes.note={id:'note',name:'Memo',body:'hello'};
  remote.entries[0].amount=200;
  const result=context.rebaseUserChanges(base,local,remote);
  assert.equal(result.conflicts.length,0);
  assert.equal(result.merged.memoTree.nodes.note.body,'hello');
  assert.equal(result.merged.entries[0].amount,200);
});
test('pie totals are calculated in yen and small slices are grouped',()=>{
  context.totalsForSnapshot=()=>({entries:[
    {type:'asset',assetClass:'株式',amount:700},
    {type:'asset',assetClass:'現金',amount:298},
    {type:'asset',assetClass:'外貨',amount:2},
    {type:'liability',assetClass:'ローン',amount:400}
  ]});
  const result=context.pieDataFor('2026-10','all');
  assert.equal(result.total,1000);
  assert.equal(result.rows.find(r=>r.label==='株式').amount,700);
  const other=result.rows.find(r=>r.label==='その他');
  assert.equal(other.amount,2);
  assert.ok(other.classes.includes('外貨'));
});
test('asset labels are escaped before they enter donut HTML',()=>{
  assert.equal(context.escapePieLabel('<img src=x onerror="x">'),'&lt;img src=x onerror=&quot;x&quot;&gt;');
});
test('negative balances produce finite chart coordinates',()=>{
  const svg=context.createAreaSVG([{month:'2026-01',value:-100},{month:'2026-02',value:100}],460,220);
  assert.ok(svg.includes('<svg'));
  assert.ok(!svg.includes('NaN')&&!svg.includes('Infinity'));
});

function makeFxContext(){
  const context={
    data:{
      rates:{JPY:1,USD:155,AED:42},
      accounts:[
        {id:'usd',name:'USD Account',currency:'USD'},
        {id:'aed',name:'AED Debt',currency:'AED'},
        {id:'yen',name:'JPY Account',currency:'JPY'}
      ],
      entries:[
        {id:'usd-1',month:'2026-09',owner:'晴太',accountId:'usd',type:'asset',assetClass:'外貨',mainCategory:'外貨口座',currency:'USD',amount:10000,rate:150},
        {id:'aed-1',month:'2026-09',owner:'香花',accountId:'aed',type:'liability',assetClass:'外貨',mainCategory:'負債',currency:'AED',amount:1000,rate:40},
        {id:'yen-1',month:'2026-09',owner:'晴太',accountId:'yen',type:'asset',assetClass:'現金',mainCategory:'銀行',currency:'JPY',amount:500000,rate:1}
      ]
    },
    currentMonthStr:()=>'2026-11',
    compareMonth:(a,b)=>a.localeCompare(b),
    selectableMonths:()=>['2026-09','2026-10','2026-11'],
    formatJPY:n=>'¥'+Math.round(n).toLocaleString('ja-JP'),
    formatAmount:(n,c)=>c+' '+n,
    accountById:id=>({name:id}),
    monthLabel:x=>x
  };
  vm.createContext(context);
  const conversion=section('    function isCurrentValuationMonth(', '    function accountOwners(');
  const snapshots=section('    function snapshotEntriesUpTo(', '    function previousMonth(');
  const timeseries=section('    function chartSeriesForRange(', '    function createAreaSVG(');
  const assetSeries=section('    function assetSeriesForAccount(', '    function renderAssetModalChart(');
  const classSeries=section('    function classSeriesForRange(', '    function showClassTrend(');
  const rowMarkup=section('    function entryRowHtml(', '    function accountOrderIndex(');
  vm.runInContext(
    conversion+snapshots+timeseries+assetSeries+classSeries+rowMarkup+
    '\nthis.fx={toJPY,totalsForSnapshot,chartSeriesForRange,assetSeriesForAccount,classSeriesForRange,entryRowHtml}',
    context
  );
  return context;
}
test('historical USD and AED values retain their recorded rates',()=>{
  const c=makeFxContext();
  const old=c.fx.totalsForSnapshot('2026-10');
  assert.equal(old.assets,2000000); // 10,000 USD × 150 + ¥500,000
  assert.equal(old.liabilities,40000); // AED 1,000 × 40
  assert.equal(c.fx.totalsForSnapshot('2026-09').net,1960000);
});
test('current snapshot reprices carried-forward USD assets and AED liabilities without rewriting entries',()=>{
  const c=makeFxContext();
  const before=JSON.stringify(c.data.entries);
  const today=c.fx.totalsForSnapshot('2026-11');
  assert.equal(today.assets,2050000); // USD 10,000 × 155 + ¥500,000
  assert.equal(today.liabilities,42000); // AED 1,000 × 42
  assert.equal(today.net,2008000);
  assert.equal(JSON.stringify(c.data.entries),before);
});
test('changing configured rates changes only the current valuation, not history',()=>{
  const c=makeFxContext();
  c.data.rates.USD=160;
  c.data.rates.AED=43;
  assert.equal(c.fx.totalsForSnapshot('2026-11').net,2057000);
  assert.equal(c.fx.totalsForSnapshot('2026-10').net,1960000);
});
test('asset and class history use historical conversion except the present month',()=>{
  const c=makeFxContext();
  const accountSeries=c.fx.assetSeriesForAccount('usd','晴太','2026-11','all');
  assert.deepEqual(Array.from(accountSeries,p=>p.value),[1500000,1500000,1550000]);
  const classSeries=c.fx.classSeriesForRange('外貨','晴太','2026-11','all');
  assert.deepEqual(Array.from(classSeries,p=>p.value),[1500000,1500000,1550000]);
});
test('list row currency equivalent uses the selected snapshot month',()=>{
  const c=makeFxContext();
  const usd=c.data.entries[0];
  assert.ok(c.fx.entryRowHtml(usd,'2026-11').includes('¥1,550,000'));
  assert.ok(c.fx.entryRowHtml(usd,'2026-10').includes('¥1,500,000'));
  assert.ok(html.includes('categoryBlocksHtml(te,month)'),'list groups must receive selected month');
  assert.ok(html.includes('s+toJPY(e,month)'),'list group totals must receive selected month');
});
test('rate fallback avoids invalid current rates; JPY is never double converted',()=>{
  const c=makeFxContext();
  const e=c.data.entries[0];
  c.data.rates.USD=-1;
  assert.equal(c.fx.toJPY(e,'2026-11'),1500000);
  assert.equal(c.fx.toJPY(c.data.entries[2],'2026-11'),500000);
});
