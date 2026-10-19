import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compareLaning,selectComparison,snapshotAt,evaluateL01,selectEpisodes,analysisContext} from '@dota/analysis';
import {openDatabase,migrate,saveDataset,transaction} from '@dota/persistence';
import {createComparison,saveComparisonContext,analysisHandler,readAnalysis,readEpisode,defaultVersions,buildCoachInput} from '@dota/jobs';
import {fixture,death,base} from './fixtures/analysis.mjs';
const context={role:3,patch:'7.40',aspect:null,party:null,plan:null,earlyLeave:false,dataGap:false};
const snapshot=value=>snapshotAt({semantic:'last_hits',cumulative:true,timelineVerified:true,intervalSeconds:5,evidenceIds:['match'],points:[{gameTimeSeconds:599,value,evidenceIds:['state']}]},600);
const match=(id,value=40+id)=>({...context,matchId:String(id),datasetId:`d${id}`,accountId:'1',heroId:'1',mode:'22',startedAt:new Date(Date.UTC(2026,0,id)).toISOString(),validated:true,conflict:false,contextVersion:1,won:true,metrics:{},lane:{last_hits:snapshot(value),experience:snapshot(value)}});
test('L01 has independent n, strict Q1, zero-IQR and context guards',()=>{
  const current=match(20,30),candidates=Array.from({length:10},(_,i)=>match(i+1));
  const select=(c=current,rows=candidates,filters={relaxed:[],additional:[]})=>selectComparison(c,rows,filters);
  let r=compareLaning(select())[0];assert.equal(r.status,'signal');assert.equal(r.q1,43.25);assert.equal(r.median,45.5);
  assert.equal(compareLaning(select(match(20,43.25)))[0].status,'no_signal');
  assert.ok(compareLaning(select(current,candidates.slice(1)))[0].reasons.includes('fewer_than_ten'));
  assert.ok(compareLaning(select(current,candidates.map(m=>({...m,lane:{last_hits:snapshot(50),experience:snapshot(50)}}))))[0].reasons.includes('zero_iqr'));
  assert.ok(compareLaning(select({...current,role:null}))[0].reasons.includes('context_unknown'));
  assert.ok(compareLaning(select({...current,patch:null}))[0].reasons.includes('context_unknown'));
  assert.ok(compareLaning(select(current,candidates,{relaxed:['patch'],additional:[]}))[0].reasons.includes('relaxed_comparison'));
  const partial=candidates.map((m,i)=>({...m,lane:{...m.lane,experience:snapshot(i===0?null:10)}}));
  const rows=compareLaning(select(current,partial));assert.equal(rows[0].n,10);assert.equal(rows[1].n,9);
});
test('L01 points to real lane deaths or an overview from zero, without an invented error time',async()=>{
  const source=JSON.parse(await readFile('packages/contracts/fixtures/records.json','utf8')).find(r=>r.kind==='hero_state');
  for(const events of [[],[death('early-death',300)]]){
    const ctx=fixture(events);const state={...source,...base('hero_state','state'),playerSlot:0,gameTimeSeconds:599,perspective:{mode:'omniscient'},coverageIds:[]};
    ctx.records.push(state);
    const selected=selectComparison(match(20,30),Array.from({length:10},(_,i)=>match(i+1)),{relaxed:[],additional:[]});
    const rules=evaluateL01(ctx,selected),episodes=selectEpisodes(ctx,rules,'analysis-lane');
    assert.equal(episodes.length,1);assert.equal(episodes[0].episode.decisionTimeSeconds,events.length?300:0);
    assert.equal(episodes[0].episode.window.startSeconds,events.length?270:0);
    assert.equal(episodes[0].episode.window.endSeconds,events.length?315:600);
  }
});
test('lane snapshot flows through stored comparison, new analysis, evidence, and coach context',async()=>{
  const pool=openDatabase(process.env.TEST_DATABASE_URL);
  try{
    await migrate(pool);const source=JSON.parse(await readFile('packages/contracts/fixtures/records.json','utf8')).find(r=>r.kind==='hero_state');
    for(let n=0;n<=10;n++){
      const id=String(200+n),datasetId=`lane-${id}`,ctx=fixture();
      const unknown={status:'unknown',value:null,reason:'Unverified'};
      const state={...source,...base('hero_state','state'),playerSlot:0,gameTimeSeconds:599,tick:null,perspective:{mode:'omniscient'},coverageIds:[],hp:unknown,mana:unknown,visibility:unknown,position:unknown,alive:unknown,inventory:unknown,resources:unknown,lastKnownPosition:null,
        lane:{formatVersion:'lane-v1',lastHits:{status:'known',observedAtSeconds:599,value:n===10?10:40+n},experience:{status:'known',observedAtSeconds:599,value:n===10?100:1000+n*100}}};
      ctx.records.push(state);
      for(const r of ctx.records){r.matchId=id;r.provenance={...r.provenance,sourceVersion:'normalized-v2/clarity-5.0.1/protobuf-7.1'};if(r.kind==='coverage')r.datasetId=datasetId;if(r.kind==='match'){r.startedAt=new Date(Date.UTC(2026,0,n+1)).toISOString();r.mode='22';}}
      ctx.validation.datasetId=datasetId;ctx.validation.matchId=id;for(const c of ctx.validation.coverage){c.matchId=id;c.datasetId=datasetId;}
      await saveDataset(pool,{id:datasetId,matchId:id,parserRunId:null,normalizationVersion:'fixture-lane',inputSha256:'b'.repeat(64),versions:{}},ctx.records);
      await pool.query('INSERT INTO dota.dataset_checks VALUES($1,$2,$3)',[datasetId,ctx.validation.version,ctx.validation]);
      await saveComparisonContext(pool,datasetId,'1',{...context,author:'Fixture',expectedVersion:0});
      if(n===10){const result=await analysisHandler(pool)({row:{dataset_id:datasetId,account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal});await transaction(pool,result.commit);}
    }
    const comparison=await createComparison(pool,'lane-210','1',{relaxed:[],additional:[]});
    assert.deepEqual(comparison.lane.map(l=>[l.n,l.status]),[[10,'signal'],[10,'signal']]);assert.ok(comparison.analysisId);
    const run=await readAnalysis(pool,'lane-210','1',comparison.analysisId);assert.equal(run.comparison.id,comparison.id);assert.equal(run.episodes.length,1);
    const episode=await readEpisode(pool,'lane-210','1',run.episodes[0].episode.id);assert.ok(episode.evidence.some(r=>r.id==='state'));
    const input=await buildCoachInput(pool,'lane-210','1',comparison.analysisId,{role:3,goal:'overview'});
    assert.equal(input.context.comparison.id,comparison.id);assert.ok(input.context.facts.some(f=>f.text.includes('Q1=')));assert.equal(input.context.episodes[0].time,0);
    await assert.rejects(buildCoachInput(pool,'lane-210','1',comparison.analysisId,{role:4,goal:'overview'}),/coach_invalid_request/);
    assert.deepEqual(await createComparison(pool,'lane-210','1',{relaxed:[],additional:[]}),comparison);
    assert.equal((await pool.query('SELECT count(*)::int n FROM dota.analysis_runs WHERE dataset_id=$1',['lane-210'])).rows[0].n,2);
  }finally{await pool.end();}
});
