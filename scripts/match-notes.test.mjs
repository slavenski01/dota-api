import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase,migrate,saveDataset} from '@dota/persistence';
import {readMatchNotes,saveMatchNote} from '@dota/jobs';
import {fixture} from './fixtures/analysis.mjs';
test('notes bind owner/dataset/time/hero/perspective, survive reload and deduplicate concurrent retries',async()=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL);
 try{
  await migrate(pool);const ctx=fixture();
  for(const id of ['notes-a','notes-b']){
   await saveDataset(pool,{id,matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},ctx.records.map(r=>r.kind==='coverage'?{...r,datasetId:id}:r));
   await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',[id,ctx.validation.version,{...ctx.validation,datasetId:id}]);
  }
  const input={id:randomUUID(),time:-20,playerSlot:128,mode:'retrospective',content:'  Проверить подход к линии <script>alert(1)</script>  '};
  const [a,b]=await Promise.all([saveMatchNote(pool,'notes-a','1',input),saveMatchNote(pool,'notes-a','1',input)]);
  assert.equal(a.id,b.id);assert.equal(a.content,input.content.trim());assert.equal(a.time,-20);assert.equal(a.playerSlot,128);
  assert.equal((await readMatchNotes(pool,'notes-a','1','retrospective')).length,1);
  assert.deepEqual(await readMatchNotes(pool,'notes-b','1','retrospective'),[]);
  assert.deepEqual(await readMatchNotes(pool,'notes-a','2','retrospective'),[]);
  assert.deepEqual(await readMatchNotes(pool,'notes-a','1','decision'),[]);
  const reopened=openDatabase(process.env.TEST_DATABASE_URL);try{assert.equal((await readMatchNotes(reopened,'notes-a','1','retrospective'))[0].id,a.id);}finally{await reopened.end();}
  for(const patch of [{content:'changed'},{time:20},{mode:'decision'},{playerSlot:1}])await assert.rejects(saveMatchNote(pool,'notes-a','1',{...input,...patch}),/note_conflict/);
  await assert.rejects(saveMatchNote(pool,'notes-b','1',input),/note_conflict/);
  for(const patch of [{id:'invalid'},{content:' '},{content:'a'.repeat(2001)},{time:NaN},{time:1201},{playerSlot:5},{mode:'bad'},{extra:true}])await assert.rejects(saveMatchNote(pool,'notes-a','1',{...input,id:randomUUID(),...patch}));
  await assert.rejects(saveMatchNote(pool,'notes-a','999',{...input,id:randomUUID()}),/analysis_not_found/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM dota.episode_reviews")).rows[0].n,0);
 }finally{await pool.end();}
});
