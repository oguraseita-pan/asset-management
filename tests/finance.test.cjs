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
