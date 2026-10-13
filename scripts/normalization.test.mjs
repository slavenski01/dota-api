import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {openDatabase,migrate,LocalStorage,transaction,registerArtifact,REPLAY_MEDIA_TYPE} from '@dota/persistence';
import {normalizationHandler,decodeDataset} from '../packages/jobs/dist/normalization.js';
import {defaultVersions} from '@dota/jobs';
test('real replay normalization is committed atomically with provenance and distinct event semantics',async t=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL), root=await mkdtemp('/tmp/dota-normalized-');
 try {
  await migrate(pool); const storage=new LocalStorage(root);
  const path=resolve('data/replay-validation/2026-10-12-e01-t02/manifest.json');
  let manifest;try {manifest=JSON.parse(await readFile(path));}catch(e){if(e.code==='ENOENT'){t.skip('local replay unavailable');return;}throw e;}
  const sample=manifest.records[0],matchId=String(sample.matchId);
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
 } finally {await pool.end();await rm(root,{recursive:true,force:true});}
});
test('decoder rejects truncated, foreign-request and fake successful output',async()=>{
 const end={protocolVersion:'1.0.0',schemaVersion:'0.1.0',requestId:'req',sequence:0,type:'complete',recordCount:0};
 for(const text of ['',JSON.stringify(end)+'\n',JSON.stringify({...end,requestId:'other'})+'\n'])await assert.rejects(decodeDataset(Buffer.from(text),'req','1','a'.repeat(64),'artifact','dataset'));
});
