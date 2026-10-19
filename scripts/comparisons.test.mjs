import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectComparison, comparisonMetrics, snapshotAt, quantile } from '@dota/analysis';
import { openDatabase, migrate, saveDataset } from '@dota/persistence';
import { createComparison, readComparisons, saveComparisonContext, readComparisonContext } from '@dota/jobs';
import { fixture } from './fixtures/analysis.mjs';
const filters = {relaxed:[],additional:[]};
const context = {role:3,patch:'7.40',aspect:null,party:null,plan:null,earlyLeave:false,dataGap:false};
const missing = snapshotAt({semantic:'last_hits',cumulative:true,timelineVerified:false,intervalSeconds:null,evidenceIds:[],points:[]},600);
const match = (id, extra={}) => ({...context,matchId:String(id),datasetId:`d${id}`,accountId:'1',startedAt:new Date(Date.UTC(2026,0,id)).toISOString(),heroId:'1',mode:'22',won:id%2===0,contextVersion:1,validated:true,conflict:false,metrics:{lastHits:{value:id,evidenceIds:['player']}},lane:{last_hits:missing,experience:missing},...extra});
test('cohorts exclude current/future/unknown/abandon/gaps; relaxed filters are explicit and metric n is independent',()=>{
  const current=match(20), previous=[match(1),match(2,{metrics:{lastHits:{value:null,evidenceIds:[]}}}),match(3,{role:null}),match(4,{earlyLeave:true}),match(5,{dataGap:null}),match(21),current,match(6,{patch:'7.39'}),match(7,{accountId:'2'})];
  const selected=selectComparison(current,previous,filters);
  assert.deepEqual(selected.included.map(m=>m.matchId),['1','2']);
  assert.deepEqual(selected.included.map(m=>m.won),[false,true]);
  assert.equal(comparisonMetrics(selected).lastHits.n,1);
  assert.ok(selected.excluded.some(e=>e.reasons.includes('current_match')));
  assert.ok(selected.excluded.some(e=>e.reasons.includes('role_unknown')));
  assert.ok(selectComparison(current,previous,{relaxed:['patch'],additional:[]}).included.some(m=>m.matchId==='6'));
  assert.equal(selectComparison({...current,role:null},previous,filters).included.length,0);
  assert.equal(quantile([0,10,20,30],.25),7.5);
});
test('versioned context and immutable comparison snapshots survive changes, isolate accounts and reject stale writes',async()=>{
  const pool=openDatabase(process.env.TEST_DATABASE_URL);
  try {
    await migrate(pool);
    for(let id=1;id<=3;id++){
      const ctx=fixture();
      for(const r of ctx.records){r.matchId=String(id);if(r.kind==='coverage')r.datasetId=`d${id}`;if(r.kind==='match'){r.startedAt=new Date(Date.UTC(2026,0,id)).toISOString();r.mode='22';}}
      ctx.validation.datasetId=`d${id}`;ctx.validation.matchId=String(id);
      for(const c of ctx.validation.coverage){c.datasetId=`d${id}`;c.matchId=String(id);}
      await saveDataset(pool,{id:`d${id}`,matchId:String(id),parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},ctx.records);
      await pool.query('INSERT INTO dota.dataset_checks VALUES($1,$2,$3)',[`d${id}`,ctx.validation.version,ctx.validation]);
    }
    const input={...context,author:'Reviewer',expectedVersion:0};
    const save=(id,v=input)=>saveComparisonContext(pool,`d${id}`,'1',v);
    for(let i=1;i<=3;i++)await save(i);
    assert.equal((await save(1)).history.length,1);
    const first=await createComparison(pool,'d3','1',filters);
    assert.deepEqual(first.selection.included.map(m=>m.matchId).sort(),['1','2']);
    assert.deepEqual(await createComparison(pool,'d3','1',filters),first);
    await save(1,{...input,role:4,expectedVersion:1});
    const second=await createComparison(pool,'d3','1',filters);
    assert.notEqual(first.id,second.id);assert.equal(second.selection.included.length,1);
    const history=await readComparisons(pool,'d3','1');assert.deepEqual(history.find(r=>r.id===first.id),first);
    assert.equal((await readComparisonContext(pool,'d1','1')).history.length,2);
    await assert.rejects(save(1,{...input,patch:'changed'}),/comparison_conflict/);
    await assert.rejects(save(1,{...input,role:0}),/invalid_comparison/);
    await assert.rejects(save(1,{...input,earlyLeave:undefined}),/invalid_comparison/);
    await assert.rejects(createComparison(pool,'d3','999',filters),/comparison_not_found/);
    await assert.rejects(createComparison(pool,'d3','1',{relaxed:['patch','patch'],additional:[]}),/invalid_comparison/);
    await assert.rejects(pool.query('UPDATE dota.comparison_runs SET payload=payload'),/immutable_snapshot/);
    await assert.rejects(pool.query('DELETE FROM dota.comparison_contexts'),/immutable_snapshot/);
    const concurrent=await Promise.allSettled([save(2,{...input,expectedVersion:1,role:1}),save(2,{...input,expectedVersion:1,role:2})]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
  } finally {await pool.end();}
});
