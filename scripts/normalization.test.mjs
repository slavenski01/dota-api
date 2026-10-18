import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {openDatabase,migrate,LocalStorage,transaction,registerArtifact,REPLAY_MEDIA_TYPE,readMotionWindow,readStateWindow,stateAt} from '@dota/persistence';
import {normalizationHandler,decodeDataset} from '../packages/jobs/dist/normalization.js';
import {datasetValidationHandler,datasetValidation} from '../packages/jobs/dist/dataset-validation.js';
import {windowUsability} from '@dota/analysis';
import {readDatasetContext} from "@dota/jobs";
import {defaultVersions} from '@dota/jobs';
test('real replay normalization is committed atomically with provenance and distinct event semantics',async t=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL), root=await mkdtemp('/tmp/dota-normalized-');
 try {
  await migrate(pool); const storage=new LocalStorage(root);
  const path=resolve('data/replay-validation/2026-10-12-e01-t02/manifest.json');
  let manifest;try {manifest=JSON.parse(await readFile(path));}catch(e){if(e.code==='ENOENT'){t.skip('local replay unavailable');return;}throw e;}
  const sample=manifest.records[Number(process.env.NORMALIZATION_SAMPLE_INDEX ?? 0)],matchId=String(sample.matchId);
  const file=await storage.put(createReadStream(resolve(dirname(path),sample.replayFile)));
  await transaction(pool,async c=>{await c.query('INSERT INTO dota.matches(match_id) VALUES ($1)',[matchId]);await registerArtifact(c,{id:'normalized-replay',matchId,file,mediaType:REPLAY_MEDIA_TYPE,source:{}});});
  const handler=normalizationHandler(pool,storage),row={artifact_id:'normalized-replay',match_id:matchId,versions:await defaultVersions()};
  const result=await handler({row,signal:new AbortController().signal,steps:{}});
  await assert.rejects(transaction(pool,async c=>{await result.commit(c);throw Error('rollback');}),/rollback/);
  assert.equal((await pool.query('SELECT * FROM dota.datasets')).rowCount,0);
  await transaction(pool,result.commit);
  const rows=(await pool.query('SELECT payload FROM dota.records WHERE dataset_id=$1',[result.datasetId])).rows.map(r=>r.payload);
  assert.ok(rows.every(r=>r.provenance.artifactId==='normalized-replay'));
  assert.equal(rows.filter(r=>r.kind==='participant').length,10);
  const items=rows.filter(r=>r.kind==='event'&&r.data.type==='item');assert.ok(items.some(r=>r.data.action==='purchased'));assert.ok(items.some(r=>r.data.action==='used'));
  assert.ok(rows.some(r=>r.kind==='event'&&r.data.type==='objective'));
  assert.ok(rows.filter(r=>r.kind==='coverage').every(r=>r.datasetId===result.datasetId));
  assert.ok(items.every(r=>['purchased','used'].includes(r.data.action)));
  assert.equal((await pool.query('SELECT * FROM dota.parser_runs')).rowCount,1);
  const checked=await datasetValidationHandler(pool)({row:{...row,dataset_id:result.datasetId},signal:new AbortController().signal,steps:{}});
  await transaction(pool,checked.commit);
  const report=await datasetValidation(pool,result.datasetId);assert.ok(report.complete,JSON.stringify(report.issues));assert.deepEqual(report.issues,[]);
  assert.equal(windowUsability(report,'deaths',[0],{startSeconds:0,endSeconds:10}).usable,true);
  assert.equal(windowUsability(report,'resources',[0],{startSeconds:0,endSeconds:10}).usable,false);
  await assert.rejects(pool.query('UPDATE dota.dataset_checks SET version=version'));
  const states=rows.filter(r=>r.kind==='hero_state');assert.ok(states.length>100);
  const first=states.sort((a,b)=>a.gameTimeSeconds-b.gameTimeSeconds)[0];assert.ok(first.gameTimeSeconds<0);
  assert.equal(await stateAt(pool,result.datasetId,first.playerSlot,first.gameTimeSeconds-1),null);
  const exact=await stateAt(pool,result.datasetId,first.playerSlot,first.gameTimeSeconds,0);assert.equal(exact.ageSeconds,0);
  const death=rows.find(r=>r.kind==='event'&&r.data.type==='death'&&r.gameTimeSeconds>10);
  const window=await readStateWindow(pool,storage,result.datasetId,death.gameTimeSeconds-5,death.gameTimeSeconds+5,'omniscient');
  assert.ok(window.length>50);assert.ok(window.some(r=>r.position.status==='known'));
  for(const r of window.filter(r=>r.position.status==='known')){
   assert.equal(r.position.observedAtSeconds,r.gameTimeSeconds);assert.equal(r.position.value.coordinateSystem,'world');
   assert.equal(r.position.value.mapVersion,null);assert.match(r.provenance.sourceVersion,/^normalized-v2\//);
  }
  assert.ok(window.some(r=>r.hp.status==='known'&&r.mana.status==='known'));
  assert.ok(window.every(r=>r.resources.status!=='known'||r.resources.value.every(v=>v.canUse.status==='unknown')));
  assert.deepEqual(await readStateWindow(pool,storage,result.datasetId,0,10,'radiant'),[]);
  assert.equal(new Set(window.map(r=>`${r.playerSlot}:${r.gameTimeSeconds}`)).size,window.length);
  const tracks=await readMotionWindow(pool,storage,result.datasetId,death.gameTimeSeconds-5,death.gameTimeSeconds+5);
  assert.equal(new Set(tracks.map(t=>t.playerSlot)).size,10);
  assert.ok(tracks.every(t=>t.stepSeconds===0.25&&t.provenance.artifactId==='normalized-replay'));
  assert.ok(tracks.flatMap(t=>t.samples).length>300);
  assert.equal(rows.some(r=>r.kind==='hero_motion'),false);
  await assert.rejects(readMotionWindow(pool,storage,result.datasetId,0,1000),/invalid_motion_window/);
  await assert.rejects(pool.query('UPDATE dota.motion_segments SET format_version=format_version'));
  const decision=await readDatasetContext(pool,storage,result.datasetId,'decision',death.gameTimeSeconds,0);
  assert.equal(decision.mode,'decision');assert.equal(decision.states.length,10);assert.ok(decision.states.every(s=>s.visibility.status==='unknown'&&s.hp.status==='unknown'&&s.lastKnownPosition===null));
  const retro=await readDatasetContext(pool,storage,result.datasetId,'retrospective',death.gameTimeSeconds,0);assert.equal(retro.perspective,'omniscient');assert.ok(retro.states.some(s=>s.hp.status==='known'));
  await assert.rejects(readDatasetContext(pool,storage,result.datasetId,'wrong',0,0),/invalid_context_request/);


 } finally {await pool.end();await rm(root,{recursive:true,force:true});}
});
test('decoder rejects truncated, foreign-request and fake successful output',async()=>{
 const end={protocolVersion:'1.0.0',schemaVersion:'0.1.0',requestId:'req',sequence:0,type:'complete',recordCount:0};
 for(const text of ['',JSON.stringify(end)+'\n',JSON.stringify({...end,requestId:'other'})+'\n'])await assert.rejects(decodeDataset(Buffer.from(text),'req','1','a'.repeat(64),'artifact','dataset'));
});
