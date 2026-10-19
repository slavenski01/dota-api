import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {summarizePractice} from '@dota/analysis';
import {openDatabase,migrate,saveDataset} from '@dota/persistence';
import {createPractice,savePracticeObservation,readPractice,saveComparisonContext} from '@dota/jobs';
import {fixture} from './fixtures/analysis.mjs';
test('practice aggregates counts, separates unknown cases and treats no opportunity as neither success nor failure',()=>{
  assert.deepEqual(summarizePractice([{done:0,missed:0,uncertain:0}]),{done:0,missed:0,uncertain:0,known:0,reviewed:0,rate:null,noOpportunityGames:1});
  const r=summarizePractice([{done:1,missed:0,uncertain:2},{done:1,missed:9,uncertain:0}]);
  assert.equal(r.rate,2/11);assert.equal(r.reviewed,13);assert.equal(r.uncertain,2);
});
test('five-game experiment: applicability, immutable history, idempotency, concurrent final slot and author snapshots',async()=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL);
 try{
  await migrate(pool);
  for(let i=0;i<=7;i++){
   const id=String(300+i),datasetId=`practice-${id}`,ctx=fixture();
   for(const r of ctx.records){r.matchId=id;if(r.kind==='coverage')r.datasetId=datasetId;if(r.kind==='match'){r.startedAt=new Date(Date.now()+(i===0?-86400000:i*3600000)).toISOString();r.mode='22';}}
   ctx.validation.datasetId=datasetId;ctx.validation.matchId=id;for(const c of ctx.validation.coverage){c.matchId=id;c.datasetId=datasetId;}
   await saveDataset(pool,{id:datasetId,matchId:id,parserRunId:null,normalizationVersion:'fixture',inputSha256:'c'.repeat(64),versions:{}},ctx.records);
   await pool.query('INSERT INTO dota.dataset_checks VALUES($1,$2,$3)',[datasetId,ctx.validation.version,ctx.validation]);
   await saveComparisonContext(pool,datasetId,'1',{role:i===7?4:3,patch:'7.40',aspect:null,party:null,plan:null,earlyLeave:false,dataGap:false,author:'Context author',expectedVersion:0});
  }
  const input={id:randomUUID(),action:'Перед входом проверить продолжение союзников',scope:'Перед добровольным входом в бой при наличии времени',author:'Experiment author',filters:{relaxed:[],additional:[]},reportId:null};
  const series=await createPractice(pool,'practice-300','1',input);
  assert.deepEqual(await createPractice(pool,'practice-300','1',input),series);
  await assert.rejects(createPractice(pool,'practice-300','1',{...input,action:'Изменённое действие'}),/progress_conflict/);
  await assert.rejects(createPractice(pool,'practice-300','1',{...input,id:randomUUID(),reportId:randomUUID()}),/progress_not_found/);
  const content={seriesId:series.id,expectedVersion:0,done:0,missed:0,uncertain:0,note:'Подходящей возможности в просмотренной игре не было.',author:'Observer',mmr:null};
  const save=(i,v=content,account='1')=>savePracticeObservation(pool,`practice-${300+i}`,account,v);
  await assert.rejects(save(0),/invalid_progress/);
  await assert.rejects(save(7),/invalid_progress/);
  await assert.rejects(save(1,content,'2'),/progress_not_found/);
  for(const invalid of [{...content,done:-1},{...content,uncertain:1.5},{...content,note:''},{...content,mmr:undefined},{...content,mmr:30001}])await assert.rejects(save(1,invalid),/invalid_progress/);
  const first=await save(1);assert.deepEqual(await save(1),first);
  await save(2,{...content,done:1,uncertain:2,mmr:3000});
  await save(3,{...content,done:1,missed:9,mmr:3025});
  await save(4,{...content,uncertain:1});
  const attempts=await Promise.allSettled([save(5),save(6)]);assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.match(attempts.find(r=>r.status==='rejected').reason.message,/progress_conflict/);
  let view=(await readPractice(pool,'practice-301','1'))[0];assert.equal(view.complete,true);assert.equal(view.observations.length,5);assert.equal(view.totals.rate,2/11);assert.equal(view.totals.noOpportunityGames,2);assert.equal(view.totals.uncertain,3);
  const updated=await save(1,{...content,expectedVersion:1,done:2,note:'Уточнены две просмотренные возможности.',author:'Second observer'});assert.equal(updated.version,2);
  view=(await readPractice(pool,'practice-301','1'))[0];assert.equal(view.history.length,6);assert.deepEqual(view.history.find(o=>o.matchId==='301'&&o.version===1),first);
  assert.equal(view.totals.rate,4/13);assert.equal(view.observations.find(o=>o.matchId==='302').mmr,3000);
  await assert.rejects(save(1,{...content,note:'устаревшая правка'}),/progress_conflict/);
  await assert.rejects(pool.query('UPDATE dota.practice_observations SET payload=payload'),/immutable_snapshot/);
  await assert.rejects(pool.query('DELETE FROM dota.practice_series'),/immutable_snapshot/);
 }finally{await pool.end();}
});
