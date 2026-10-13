import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { openDatabase, migrate, saveDataset, LocalStorage, registerArtifact, transaction } from "@dota/persistence";
import { startQueue, consume, QUEUE, JobError, requestWorkflow, executeWorkflow, getWorkflow, cancelWorkflow, defaultVersions, STAGES, runBoundedProcess } from "@dota/jobs";
const pool=openDatabase(process.env.TEST_DATABASE_URL);
const dir=await mkdtemp("/tmp/dota-workflow-");const storage=new LocalStorage(dir);
const fixtures=JSON.parse(await readFile(new URL("../packages/contracts/fixtures/records.json",import.meta.url)));
let boss, versions;
async function until(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await delay(100);}throw new Error("condition_timeout");}
async function setup(matchId,suffix="a"){
 const datasetId=`dataset-${matchId}`;
 if(suffix==="a")await saveDataset(pool,{id:datasetId,matchId,parserRunId:null,normalizationVersion:"fixture",inputSha256:"a".repeat(64),versions:{}},fixtures.filter(r=>["match","participant"].includes(r.kind)).map(r=>({...r,matchId})));
 const file=await storage.put(Readable.from([`fixture-${matchId}-${suffix}`]));const artifactId=`artifact-${matchId}-${suffix}`;
 await transaction(pool,client=>registerArtifact(client,{id:artifactId,matchId,file,mediaType:"application/octet-stream",source:{fixture:true}}));
 return {matchId,artifactId};
}
const simple=()=>Object.fromEntries(STAGES.map(stage=>[stage,async()=>stage==="analysing"?{dataLevel:"summary",reportStatus:"failed",limitations:["Текстовый этап недоступен в тесте"]}:{}]));
const start=handlers=>consume(boss,pool,context=>executeWorkflow(pool,boss,context,handlers));
const finished=id=>until(async()=>{const result=await getWorkflow(pool,boss,id);return ["ready","failed","cancelled","unavailable"].includes(result.job.status)&&result;});
before(async()=>{await migrate(pool);boss=await startQueue(process.env.TEST_DATABASE_URL,{retryDelay:1});versions=await defaultVersions();await pool.query("CREATE TABLE public.stage_effect(job_id text,stage text,PRIMARY KEY(job_id,stage))");});
after(async()=>{await boss?.stop();await pool.end();await rm(dir,{recursive:true});});

test("item and game plan are persisted, validated and distinguish concurrent requests",async()=>{
 const input=await setup("307");const analysisOptions={keyItemId:"1",gamePlan:"Защищать союзника"};
 const first=await requestWorkflow(pool,boss,{...input,analysisOptions},versions);
 assert.deepEqual((await getWorkflow(pool,boss,first.id)).analysisOptions,analysisOptions);
 assert.equal((await requestWorkflow(pool,boss,{...input,analysisOptions},versions)).id,first.id);
 await assert.rejects(requestWorkflow(pool,boss,{...input,analysisOptions:{...analysisOptions,gamePlan:"Инициировать"}},versions),/analysis_options_conflict/);
 await assert.rejects(requestWorkflow(pool,boss,{...input,analysisOptions:{keyItemId:"1"}},versions),/invalid_analysis_options/);
 const previous=(await getWorkflow(pool,boss,first.id)).versions.configSha256;
 await cancelWorkflow(pool,boss,first.id);
 const changed=await requestWorkflow(pool,boss,{...input,analysisOptions:{...analysisOptions,keyItemId:"2"}},versions);
 assert.notEqual((await getWorkflow(pool,boss,changed.id)).versions.configSha256,previous);
 await cancelWorkflow(pool,boss,changed.id);
});

test("concurrent launches deduplicate; enqueue and application job commit atomically",async()=>{
 const input=await setup("301");const launched=await Promise.all(Array.from({length:10},()=>requestWorkflow(pool,boss,input,versions)));
 assert.equal(new Set(launched.map(r=>r.id)).size,1);assert.equal(launched.filter(r=>!r.reused).length,1);
 await cancelWorkflow(pool,boss,launched[0].id);
 let rolledBackQueueId;
 const failing={send:async(...args)=>{rolledBackQueueId=await boss.send(...args);throw new Error("simulated_submission_crash");}};
 await assert.rejects(requestWorkflow(pool,failing,{matchId:"399"},versions),/simulated_submission_crash/);
 assert.equal((await pool.query("SELECT count(*) FROM dota.workflow_jobs WHERE match_id='399'")).rows[0].count,"0");
 assert.equal((await pool.query("SELECT count(*) FROM dota.matches WHERE match_id='399'")).rows[0].count,"0");
 assert.equal(await boss.getJobById(QUEUE,rolledBackQueueId),null);
});
test("checkpoints roll back failed effects and resume without repeating completed stages",async()=>{
 const input=await setup("302");const counts={};let failed=false;
 const handlers=Object.fromEntries(STAGES.map(stage=>[stage,async({row})=>{
  counts[stage]=(counts[stage]??0)+1;
  return { ...(stage==="analysing"?{dataLevel:"summary",reportStatus:"failed",limitations:["Нет текста"]}:{}),
   commit:async client=>{await client.query("INSERT INTO public.stage_effect VALUES ($1,$2)",[row.id,stage]);if(stage==="parsing"&&!failed){failed=true;throw new JobError("transient_commit_failure",true);}}};
 }]));
 const stop=await start(handlers);
 try{
  const {id}=await requestWorkflow(pool,boss,input,versions);const result=await finished(id);
  assert.equal(result.job.status,"ready");assert.equal(result.job.dataLevel,"summary");assert.equal(result.job.reportStatus,"failed");
  assert.equal(result.queueState,"completed");assert.equal(counts.parsing,2);assert.equal(counts.resolving,1);assert.equal(counts.downloading,1);
  assert.equal((await pool.query("SELECT count(*) FROM public.stage_effect WHERE job_id=$1",[id])).rows[0].count,"5");
  assert.equal((await pool.query("SELECT count(*) FROM dota.job_steps WHERE job_id=$1",[id])).rows[0].count,"5");
  assert.equal((await requestWorkflow(pool,boss,input,versions)).id,id);
 }finally{await stop();}
});
test("input, parser, rules, skill, model, context and configuration changes invalidate reuse",async()=>{
 const input={matchId:"302",artifactId:"artifact-302-a"};
 const old=(await requestWorkflow(pool,boss,input,versions)).id;
 for(const [key,value] of Object.entries({parser:"new-parser",normalization:"new-normalization",rules:"new-rules",skillSha256:"b".repeat(64),model:"new-model",contextSha256:"c".repeat(64),configSha256:"d".repeat(64)})){
  const next=await requestWorkflow(pool,boss,input,{...versions,[key]:value});assert.notEqual(next.id,old);await cancelWorkflow(pool,boss,next.id);
 }
 const different=await requestWorkflow(pool,boss,await setup("302","b"),versions);assert.notEqual(different.id,old);await cancelWorkflow(pool,boss,different.id);
});
test("cancellation prevents a pending stage from publishing effects",async()=>{
 const input=await setup("303");let entered=false,release;
 const barrier=new Promise(resolve=>{release=resolve;});const handlers=simple();
 handlers.resolving=async({row})=>{entered=true;await barrier;return {commit:client=>client.query("INSERT INTO public.stage_effect VALUES ($1,'resolving')",[row.id])};};
 const stop=await start(handlers);
 try{
  const {id}=await requestWorkflow(pool,boss,input,versions);await until(()=>entered);await cancelWorkflow(pool,boss,id);release();
  await stop();assert.equal((await finished(id)).job.status,"cancelled");
  assert.equal((await pool.query("SELECT count(*) FROM public.stage_effect WHERE job_id=$1",[id])).rows[0].count,"0");
 }finally{release();await stop();}
});
test("a stale queue attempt cannot publish into a newer attempt",async()=>{
 const input=await setup("304");const {id}=await requestWorkflow(pool,boss,input,versions);
 const [old]=await boss.fetch(QUEUE,{includeMetadata:true});await boss.fail(QUEUE,old,{code:"simulated_crash"});
 const current=await until(async()=>{const rows=await boss.fetch(QUEUE,{includeMetadata:true});return rows[0];});
 await assert.rejects(executeWorkflow(pool,boss,{job:old,signal:new AbortController().signal},simple()),/claim_lost/);
 assert.equal((await pool.query("SELECT count(*) FROM dota.job_steps WHERE job_id=$1",[id])).rows[0].count,"0");
 await executeWorkflow(pool,boss,{job:current,signal:new AbortController().signal},simple());
 assert.equal((await finished(id)).job.status,"ready");
});
test("permanent failure keeps previously available summary separate from report readiness",async()=>{
 const input=await setup("305");const handlers=simple();handlers.parsing=async()=>{throw new JobError("invalid_replay");};
 const stop=await start(handlers);
 try{const {id}=await requestWorkflow(pool,boss,input,versions);const state=await finished(id);assert.equal(state.job.status,"failed");assert.equal(state.job.dataLevel,"summary");assert.equal(state.job.reportStatus,"not_requested");}
 finally{await stop();}
});
test("polling reconciles exhausted queue attempts after a worker disappears",async()=>{
 const input=await setup("306");const {id}=await requestWorkflow(pool,boss,input,versions);
 const queueId=(await pool.query("SELECT queue_job_id FROM dota.workflow_jobs WHERE id=$1",[id])).rows[0].queue_job_id;
 assert.equal((await boss.update(QUEUE,undefined,{id:queueId,retryLimit:0})).updated,1);
 const [job]=await boss.fetch(QUEUE,{includeMetadata:true});
 await boss.fail(QUEUE,job);
 const result=await getWorkflow(pool,boss,id);assert.equal(result.job.status,"failed");assert.equal(result.job.error.code,"queue_attempts_exhausted");assert.equal(result.job.dataLevel,"summary");
});
test("HTTP API returns a durable ID, supports polling/cancel and rejects invalid requests",async()=>{
 const server=createServer().listen(0,"127.0.0.1");await once(server,"listening");const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const env={...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,STORAGE_ROOT:dir,NEXT_TELEMETRY_DISABLED:"1"};
 const web=spawn(process.execPath,[resolve("node_modules/next/dist/bin/next"),"start","--hostname","127.0.0.1","--port",String(port)],{cwd:resolve("apps/web"),env,stdio:["ignore","pipe","pipe"]});
 const base=`http://127.0.0.1:${port}`;let logs="";web.stderr.on("data",chunk=>{logs+=chunk;});web.stdout.on("data",()=>{});
 let worker;
 const post=(value,headers={})=>fetch(`${base}/api/jobs`,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(value)});
 try{
  await until(async()=>{try{return(await fetch(`${base}/api/health`)).ok;}catch{return false;}});
  assert.equal((await fetch(`${base}/jobs`)).status,200);
  assert.equal((await post({matchId:123})).status,400);
  assert.equal((await post({matchId:"01"})).status,400);
  assert.equal((await post({matchId:"401",command:"untrusted"})).status,400);
  assert.equal((await post({matchId:"401"},{Origin:"https://untrusted.example"})).status,403);
  assert.equal((await post({matchId:"401",oversized:"x".repeat(9000)})).status,400);
  assert.equal((await fetch(`${base}/api/jobs/not-found`)).status,404);
  const responses=await Promise.all([post({matchId:"9007199254740994"}),post({matchId:"9007199254740994"})]);
  for(const response of responses)assert.equal(response.status,202,logs);
  const [a,b]=await Promise.all(responses.map(r=>r.json()));assert.equal(a.id,b.id);
  let state=await fetch(`${base}/api/jobs/${a.id}`);assert.match(state.headers.get("cache-control"),/no-store/);assert.equal((await state.json()).job.matchId,"9007199254740994");
  assert.equal((await fetch(`${base}/api/jobs/${a.id}`,{method:"DELETE"})).status,200);
  assert.equal((await(await fetch(`${base}/api/jobs/${a.id}`)).json()).job.status,"cancelled");
  let entered=false;const handlers=simple();
  handlers.resolving=async({signal})=>{entered=true;await runBoundedProcess({command:process.execPath,args:["-e","setInterval(()=>{},1000)"]},signal);return {};};
  const stop=await start(handlers);
  try{
   const active=await(await post({matchId:"403"})).json();await until(()=>entered);
   assert.equal((await fetch(`${base}/api/jobs/${active.id}`,{signal:AbortSignal.timeout(2000)})).status,200);
   assert.equal((await fetch(`${base}/api/jobs/${active.id}`,{method:"DELETE",signal:AbortSignal.timeout(2000)})).status,200);
  }finally{await stop();}
  const launch=await(await post({matchId:"402"})).json();
  worker=spawn(process.execPath,["apps/worker/dist/index.js"],{env,stdio:"ignore"});
  const unavailable=await until(async()=>{const result=await(await fetch(`${base}/api/jobs/${launch.id}`)).json();return result.job?.status==="unavailable"&&result;});
  assert.equal(unavailable.job.dataLevel,"none");assert.equal(unavailable.job.error.code,"player_required");
 }finally{
  for(const child of [worker,web].filter(Boolean)){if(child.exitCode===null){const exit=once(child,"exit");child.kill("SIGTERM");const timer=setTimeout(()=>child.kill("SIGKILL"),5000);await exit;clearTimeout(timer);}}
 }
});
