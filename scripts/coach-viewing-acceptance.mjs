// Local E15 acceptance. Reuses ready reports; never invokes a model.
// Writes clearly labelled technical notes/uncertain reviews, preserving existing reviews.
// Private snapshots and URLs stay under ignored data/e15-validation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
process.loadEnvFile();
const [mode='capture',baseArg,project='dota-api']=process.argv.slice(2);
assert.ok(['capture','seal','verify'].includes(mode));assert.match(project,/^[a-z][a-z0-9-]{1,48}$/);
const base=baseArg??`http://127.0.0.1:${process.env.DOTA_PORT||3000}`;
assert.ok(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const root=resolve('data/e15-validation');await mkdir(root,{recursive:true,mode:0o700});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const immutable=r=>({id:r.id,version:r.version,status:r.status,context:r.context,output:r.output,versions:r.versions,reviewSources:r.reviewSources,usage:r.usage,model:r.model,durationMs:r.durationMs});
async function database(script){
  const child=spawn('docker',['compose','-p',project,'exec','-T','worker','node','--input-type=module'],{env:process.env,stdio:['pipe','pipe','pipe']});
  child.stdin.end(script);let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
  const [code]=await once(child,'close');assert.equal(code,0,'database check failed');return JSON.parse(output);
}
async function json(path,body){
  const r=await fetch(base+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
  const value=await r.json();assert.ok(r.ok,`${r.status}:${value.error}`);return value;
}
const inventory=await database(`import {openDatabase} from '@dota/persistence';import {createHash} from 'node:crypto';const p=openDatabase();try{
 const rows=(await p.query("SELECT DISTINCT ON(c.dataset_id) c.id AS report_id,c.dataset_id,c.analysis_id,c.input->'context'->>'matchId' AS match_id,p.payload->>'accountId' AS account_id FROM dota.coach_runs c JOIN dota.records p ON p.dataset_id=c.dataset_id AND p.kind='participant' AND p.player_slot=c.player_slot WHERE c.status='ready' ORDER BY c.dataset_id,c.version DESC")).rows;
 const fingerprints={};for(const table of ['coach_runs','match_notes','episode_reviews','motion_segments']){const data=(await p.query('SELECT to_jsonb(t) AS row FROM dota.'+table+' t ORDER BY to_jsonb(t)::text')).rows;fingerprints[table]={rows:data.length,sha256:createHash('sha256').update(JSON.stringify(data)).digest('hex')};}
 console.log(JSON.stringify({rows,fingerprints,count:(await p.query('SELECT count(*)::int AS n FROM dota.coach_runs')).rows[0].n}));
}finally{await p.end();}`);
if(mode==='seal'){
  const saved=JSON.parse(await readFile(join(root,'snapshot.json'),'utf8'));
  assert.equal(inventory.count,saved.coachRuns);
  saved.fingerprints=inventory.fingerprints;saved.sealedAt=new Date().toISOString();
  await writeFile(join(root,'snapshot.json'),JSON.stringify(saved,null,2),{mode:0o600});
  console.log(JSON.stringify({stage:'seal',tables:Object.fromEntries(Object.entries(inventory.fingerprints).map(([name,v])=>[name,v.rows]))}));
}else if(mode==='verify'){
  const saved=JSON.parse(await readFile(join(root,'snapshot.json'),'utf8'));
  assert.equal(inventory.count,saved.coachRuns,'acceptance must not create model runs');
  if(saved.fingerprints)assert.deepEqual(inventory.fingerprints,saved.fingerprints,'all reports, notes, reviews and motion references must survive unchanged');
  for(const sample of saved.samples){
    const r=(await json(sample.reportApi)).reports[0];assert.equal(hash(immutable(r)),sample.reportHash);
    const notes=(await json(sample.notesApi)).notes;assert.deepEqual(notes.find(n=>n.id===sample.note.id),sample.note);
    if(sample.episodeApi){
      const view=await json(sample.episodeApi);assert.equal(hash(view),sample.viewHash);
      const reviews=await json(sample.reviewsApi);assert.deepEqual(reviews.reviews.find(r=>r.version===sample.review.version),sample.review);
      const playback=await json(sample.playbackApi);assert.equal(hash(playback),sample.playbackHash);
    }
    assert.equal((await fetch(base+sample.reportPage)).status,200);
  }
  const result={stage:'verify',project,samples:saved.samples.length,reportHashes:true,notes:true,reviews:true,playback:true,allTableHashes:!!saved.fingerprints,newModelRuns:0,checkedAt:new Date().toISOString()};
  await writeFile(join(root,`verified-${project}.json`),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}else{
  const samples=[];let full=0,noCandidates=0;
  for(const t of inventory.rows){
    const query=new URLSearchParams({accountId:t.account_id,analysisId:t.analysis_id,reportId:t.report_id});
    const reportApi=`/api/datasets/${t.dataset_id}/coach?${query}`,r=(await json(reportApi)).reports[0];
    if(samples.some(s=>s.matchId===t.match_id))continue;
    const explore=await json(`/api/datasets/${t.dataset_id}/explore?accountId=${t.account_id}`);
    let episodeId,view,review,episodeApi,reviewsApi,playbackApi,playback;
    for(const e of r.output.episodes){
      const path=`/api/datasets/${t.dataset_id}/episodes/${e.episodeId}/reviews?accountId=${t.account_id}`,history=await json(path);
      if(!history.current){episodeId=e.episodeId;reviewsApi=path;break;}
    }
    if(r.output.episodes.length&&!episodeId){episodeId=r.output.episodes[0].episodeId;reviewsApi=`/api/datasets/${t.dataset_id}/episodes/${episodeId}/reviews?accountId=${t.account_id}`;}
    let time=Math.max(explore.window.startSeconds,Math.min(60,explore.window.endSeconds));
    if(episodeId){
      episodeApi=`${reportApi}&${new URLSearchParams({episodeId,mode:'retrospective'})}`;view=await json(episodeApi);
      const decision=await json(`${reportApi}&${new URLSearchParams({episodeId,mode:'decision'})}`);assert.equal(decision.retrospective,null);
      assert.equal(view.matchId,t.match_id);assert.equal(view.datasetId,t.dataset_id);assert.equal(view.playerSlot,r.context.playerSlot);assert.ok(view.retrospective.evidence.length);
      assert.ok(view.window.startSeconds>=explore.window.startSeconds&&view.window.endSeconds<=explore.window.endSeconds);time=view.time;
      playbackApi=`/api/datasets/${t.dataset_id}/explore?${new URLSearchParams({accountId:t.account_id,resource:'playback',version:'playback-v1',mode:'retrospective',episodeId,bucket:String(Math.floor(time/30))})}`;
      playback=await json(playbackApi);assert.equal(playback.frame.datasetId,t.dataset_id);assert.equal(playback.frame.playerSlot,view.playerSlot);assert.ok(playback.end<=view.window.endSeconds);
      const history=await json(reviewsApi);
      if(history.current)review=history.current;
      else review=(await json(reviewsApi,{expectedVersion:0,status:'uncertain',explanation:'Техническая приёмка E15: сохранность оценки и ссылки проверена. Обзор команды и применимость ресурсов неизвестны; игровая ошибка не подтверждена.',alternative:null,author:'Codex — техническая приёмка E15',material:'timeline',perspective:{mode:'omniscient'}})).current;
      full++;
    }else{assert.equal(r.output.nextAction.kind,'experiment');noCandidates++;}
    const notesApi=`/api/datasets/${t.dataset_id}/notes?accountId=${t.account_id}&mode=retrospective`;
    const payload={id:randomUUID(),time,playerSlot:r.context.playerSlot,mode:'retrospective',content:'Техническая приёмка E15: заметка к сохранённому моменту. Не является подтверждением игровой ошибки.',...(episodeId?{coach:{reportId:r.id,analysisId:t.analysis_id,episodeId}}:{})};
    const note=await json(`/api/datasets/${t.dataset_id}/notes?accountId=${t.account_id}`,payload);
    assert.equal((await json(`/api/datasets/${t.dataset_id}/notes?accountId=${t.account_id}`,payload)).id,note.id);
    const after=(await json(reportApi)).reports[0];assert.deepEqual(immutable(after),immutable(r));
    const reportPage=`/matches/${t.match_id}/coach?${new URLSearchParams({datasetId:t.dataset_id,...Object.fromEntries(query)})}`;
    assert.equal((await fetch(base+reportPage)).status,200);
    samples.push({sample:samples.length+1,matchId:t.match_id,reportApi,reportPage,reportHash:hash(immutable(r)),notesApi,note,
      ...(episodeId?{episodeId,episodeApi,viewHash:hash(view),reviewsApi,review,playbackApi,playbackHash:hash(playback),motion:playback.motionAvailable,
        episodePage:`/matches/${t.match_id}/episodes/${episodeId}?${new URLSearchParams({datasetId:t.dataset_id,...Object.fromEntries(query),time:String(time),hero:String(r.context.playerSlot),mode:'retrospective'})}`}:{noCandidates:true}),
      durationMs:r.durationMs,usage:r.usage,model:r.model});
    console.log(JSON.stringify({sample:samples.length,episode:!!episodeId,motion:playback?.motionAvailable??explore.motionAvailable,unchangedReport:true,note:true,review:!!review}));
  }
  assert.ok(full>=3,'requires three real matches with recommendations');assert.ok(noCandidates>=1,'requires a no-candidate control');
  const snapshot={createdAt:new Date().toISOString(),coachRuns:inventory.count,samples};
  await writeFile(join(root,'snapshot.json'),JSON.stringify(snapshot,null,2),{mode:0o600});
  console.log(JSON.stringify({stage:'capture',samples:samples.length,fullScenarios:full,noCandidates,newModelRuns:0}));
}
