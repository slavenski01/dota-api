import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase,migrate,selectProfile,transaction,saveHistoryPage,parseHistory,LocalStorage } from '@dota/persistence';
import { startQueue,consume,executeWorkflow,replayHandlers } from '@dota/jobs';
async function until(fn){for(let n=0;n<600;n++){const value=await fn();if(value)return value;await delay(100);}throw Error('timeout');}
test('production replay HTTP: dedup, missing source, persistent summary, manual validation and download',async(t)=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL);const root=await mkdtemp('/tmp/dota-replay-web-');let web,boss,stop;let previewPath='/profile';
 try {
  await migrate(pool);
  await selectProfile(pool,'123','account',async()=>Response.json({profile:{account_id:123,personaname:'Тестовый игрок'},fh_unavailable:true}));
  await transaction(pool,c=>saveHistoryPage(c,'123',0,parseHistory([{match_id:501,start_time:1767225600,hero_id:1,player_slot:0,radiant_win:true,duration:1800,kills:4,deaths:5,assists:6}])));
  boss=await startQueue(process.env.TEST_DATABASE_URL,{retryDelay:1});
  const storage=new LocalStorage(root);
  const handlers=replayHandlers(pool,storage,async()=>Response.json({match_id:501,replay_url:null,players:[{account_id:123}]}));
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  web=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:resolve('apps/web'),env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,STORAGE_ROOT:root,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  web.stdout.on('data',()=>{});web.stderr.on('data',()=>{});
  const base=`http://127.0.0.1:${port}`;
  await until(async()=>{try{return(await fetch(base+'/api/health')).ok;}catch{return false;}});
  const post=(body)=>fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
  const state=async id=>{const result=await fetch(base+'/api/jobs/'+id);assert.equal(result.status,200);return result.json();};
  const finished=id=>until(async()=>{const s=await state(id);return ['unavailable','failed','cancelled','ready'].includes(s.job.status)&&s;});
  assert.equal((await fetch(base+'/matches/501?accountId=123')).status,200);
  const launched=await Promise.all([post({matchId:'501',accountId:'123'}),post({matchId:'501',accountId:'123'})]);
  const [a,b]=await Promise.all(launched.map(r=>r.json()));assert.equal(a.id,b.id);
  stop=await consume(boss,pool,c=>executeWorkflow(pool,boss,c,handlers));
  const missing=await finished(a.id);assert.equal(missing.job.error.code,'replay_link_missing');assert.equal(missing.job.dataLevel,'summary');
  let detail=await(await fetch(base+'/api/replays/501?accountId=123')).json();assert.equal(detail.jobId,a.id);assert.equal(detail.summary.kills,4);assert.equal(detail.replay,null);
  assert.equal((await fetch(base+'/api/replays/501/file?accountId=123')).status,404);
  assert.equal((await fetch(base+'/api/replays/501?accountId=123',{method:'POST',headers:{'Content-Type':'application/octet-stream',Origin:'https://untrusted.example'},body:'fake'})).status,403);
  const upload=async(id,accountId,body)=>fetch(`${base}/api/replays/${id}?accountId=${accountId}`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Origin:base},body,duplex:'half'});
  const bad=await upload('501','123','<html>wrong</html>');assert.equal(bad.status,202);const badId=(await bad.json()).id;
  assert.equal((await finished(badId)).job.error.code,'invalid_replay_format');assert.equal((await fetch(base+'/api/replays/501/file?accountId=123')).status,404);
  const manifestPath=resolve('data/replay-validation/2026-10-12-e01-t02/manifest.json');
  let manifest;
  try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;t.diagnostic('Local E01 evidence unavailable; real upload subcase skipped');}
  if(manifest){
   const sample=manifest.records[0],matchId=String(sample.matchId),accountId=String(manifest.accountId),path=resolve(dirname(manifestPath),sample.replayFile);
   const result=await upload(matchId,accountId,createReadStream(path));assert.equal(result.status,202);const {id}=await result.json();
   const done=await finished(id);assert.equal(done.job.status,'ready');assert.equal(done.job.error,null);assert.ok(done.analysisId);assert.ok(done.artifactId);assert.equal(done.accountId,accountId);assert.equal(done.progress.phase,'stored');
   assert.equal(done.job.dataLevel,'replay_context');assert.ok(done.datasetId);
   const analysisUrl=`${base}/api/datasets/${done.datasetId}/analysis?accountId=${accountId}&analysisId=${done.analysisId}`;
   const analysisResponse=await fetch(analysisUrl);assert.equal(analysisResponse.status,200);
   const analysis=await analysisResponse.json();assert.equal(analysis.mode,'retrospective');assert.ok(analysis.primaryEpisodeIds.length<=3);assert.ok(analysis.results.some(r=>r.ruleId==='D01'));assert.equal(analysis.versions.rules,'e06-v1');
   for(const candidate of analysis.episodes){const detail=await fetch(`${base}/api/datasets/${done.datasetId}/episodes/${candidate.episode.id}?accountId=${accountId}`);assert.equal(detail.status,200);const data=await detail.json();assert.equal(data.evidence.length,candidate.episode.evidenceIds.length);}
   assert.equal((await fetch(analysisUrl.replace(accountId,'4294967294'))).status,404);
   assert.equal((await fetch(analysisUrl+'&mode=decision')).status,400);
   const contextUrl=`${base}/api/datasets/${done.datasetId}/context?time=60&playerSlot=0`;
   const contextResponse=await fetch(contextUrl);assert.equal(contextResponse.status,200);
   const context=await contextResponse.json();assert.equal(context.mode,'decision');assert.equal(context.states.length,10);assert.ok(context.states.every(s=>s.hp.status==='unknown'&&s.visibility.status==='unknown'));
   const retro=await(await fetch(contextUrl+'&mode=retrospective')).json();assert.equal(retro.mode,'retrospective');assert.equal(retro.perspective,'omniscient');assert.ok(retro.states.some(s=>s.hp.status==='known'));
   assert.equal((await fetch(contextUrl+'&mode=invalid')).status,400);
   assert.equal((await fetch(contextUrl.replace('time=60','time=NaN'))).status,400);
   assert.equal((await fetch(contextUrl.replace(done.datasetId,'nonexistent'))).status,404);

   const downloaded=await fetch(`${base}/api/replays/${matchId}/file?accountId=${accountId}`);assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/\.dem/);
   const hash=createHash('sha256');for await(const chunk of downloaded.body)hash.update(chunk);assert.equal(hash.digest('hex'),sample.sha256Replay);
   const analysisOptions={keyItemId:analysis.purchases[0]?.data.itemId??'1',gamePlan:'Контрольный план: защищать союзника'};
   const retry=await(await post({matchId,accountId,analysisOptions})).json();const retried=await finished(retry.id);assert.equal(retried.job.status,'ready');assert.equal(retried.artifactId,done.artifactId);assert.deepEqual(retried.analysisOptions,analysisOptions);
   const revised=await(await fetch(`${base}/api/datasets/${retried.datasetId}/analysis?accountId=${accountId}&analysisId=${retried.analysisId}`)).json();assert.deepEqual(revised.options,analysisOptions);if(analysis.purchases.length)assert.ok(revised.results.some(r=>r.ruleId==='I01'&&r.status==='signal'));
   assert.equal((await post({matchId,accountId,analysisOptions:{keyItemId:'1'}})).status,400);
   previewPath=`/matches/${matchId}?accountId=${accountId}`;
   assert.equal((await fetch(`${base}/api/replays/${matchId}/file?accountId=4294967294`)).status,404);
  }
  if(process.env.E04_PREVIEW_GATE){
   console.log(`Replay browser preview: ${base}${previewPath}`);
   while(true){try{await access(process.env.E04_PREVIEW_GATE);break;}catch{}await delay(500);}
  }
 }finally{if(web&&web.exitCode===null){const ended=once(web,'exit');web.kill('SIGTERM');await ended;}await stop?.();await boss?.stop();await pool.end();await rm(root,{recursive:true,force:true});}
});
