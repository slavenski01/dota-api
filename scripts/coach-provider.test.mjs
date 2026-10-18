import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { openDatabase, migrate, saveDataset, transaction } from '@dota/persistence';
import { startQueue, consume, analysisHandler, defaultVersions, enqueueCoach, executeCoach, readCoachRuns, coachHash,
  coachInstructions, coachConfig, atomicCoachFile, readCoachFile, invokeCoachBridge, validateCoachResponse, JobError } from '@dota/jobs';
import { processCoachSpool, processDockerSpool } from './coach-bridge.mjs';
import { fixture, death } from './fixtures/analysis.mjs';
const config = coachConfig({});
const result = { output: { ok: true }, usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costUsd: null, billing: 'subscription' }, cliVersion: 'fixture', durationMs: 5 };
async function until(fn) { for(let i=0;i<100;i++) { const value=await fn(); if(value) return value; await delay(100); } throw Error('timeout'); }
test('queue deduplicates, freezes instructions, reserves budget and persists failure/usage', async()=>{
  const pool=openDatabase(process.env.TEST_DATABASE_URL); let boss, stop;
  try {
    await migrate(pool); boss=await startQueue(process.env.TEST_DATABASE_URL,{retryDelay:1});
    const ctx=fixture([death('d1',100)]);
    await saveDataset(pool,{id:'dataset',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},ctx.records);
    await pool.query('INSERT INTO dota.dataset_checks(dataset_id,version,payload) VALUES ($1,$2,$3)',['dataset',ctx.validation.version,ctx.validation]);
    const analysis=await analysisHandler(pool)({row:{dataset_id:'dataset',account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal,steps:{}});
    await transaction(pool,analysis.commit);
    const context={playerSlot:0}, input={prompt:'fixture',schema:{},context,contextSha256:coachHash(context),instructions:await coachInstructions(),schemaVersion:'fixture'};
    const request={datasetId:'dataset',analysisId:analysis.analysisId,accountId:'1',requestKey:randomUUID()};
    const [a,b]=await Promise.all([enqueueCoach(pool,boss,request,input),enqueueCoach(pool,boss,{...request,requestKey:randomUUID()},input)]);
    assert.equal(a.id,b.id); assert.notEqual(a.reused,b.reused);
    await assert.rejects(enqueueCoach(pool,boss,{...request,accountId:'2',requestKey:randomUUID()},input),/analysis_not_found/);
    let invocations=0;
    stop=await consume(boss,pool,c=>executeCoach(pool,boss,c,async()=>{invocations++; return result;}));
    const rows=await until(async()=>{const r=await readCoachRuns(pool,boss,'dataset','1',analysis.analysisId);return r[0]?.status==='ready'&&r;});
    assert.equal(invocations,1); assert.deepEqual(rows[0].usage,result.usage); assert.equal(rows[0].input.instructions.sha256,input.instructions.sha256);
    assert.equal((await enqueueCoach(pool,boss,request,input)).id,a.id);
    await assert.rejects(pool.query("UPDATE dota.coach_runs SET result='{}' WHERE id=$1",[a.id]),/immutable coach snapshot/);
    await assert.rejects(enqueueCoach(pool,boss,{...request,requestKey:randomUUID()},input,{...config,totalRuns:1}),/coach_budget_exhausted/);
    await stop(); stop=null;
    const next=await enqueueCoach(pool,boss,{...request,requestKey:randomUUID()},input);
    stop=await consume(boss,pool,c=>executeCoach(pool,boss,c,async()=>{throw new JobError('coach_subscription_limit');}));
    const failed=await until(async()=>{const r=(await readCoachRuns(pool,boss,'dataset','1',analysis.analysisId)).find(r=>r.id===next.id);return r?.status==='failed'&&r;});
    assert.equal(failed.error_code,'coach_subscription_limit'); assert.equal(failed.version,2); assert.equal(failed.usage,null);
  } finally { await stop?.(); await boss?.stop(); await pool.end(); }
});
test('spool resumes cached results, refuses duplicate invocation, handles timeout and abandoned claim',async()=>{
  const directory=await mkdtemp('/tmp/dota-coach-test-'); const old=process.env.DOTA_COACH_BRIDGE_DIR; process.env.DOTA_COACH_BRIDGE_DIR=directory;
  const signal=new AbortController().signal; let invocations=0;
  try {
    const id=randomUUID(), input={prompt:'fixture',schema:{}};
    await atomicCoachFile(join(directory,`${id}.request.json`),{id,input,config,expiresAt:Date.now()+30000});
    await processCoachSpool(directory,signal,async()=>{invocations++;return result;});
    await processCoachSpool(directory,signal,async()=>{invocations++;return result;});
    assert.equal(invocations,1);
    assert.deepEqual(await invokeCoachBridge(id,input,config,signal),result);
    const abandoned=randomUUID();
    await atomicCoachFile(join(directory,`${abandoned}.request.json`),{id:abandoned,input,config,expiresAt:Date.now()+30000});
    await writeFile(join(directory,`${abandoned}.claim`),'2147483647');
    await processCoachSpool(directory,signal,async()=>{invocations++;return result;});
    assert.equal((await readCoachFile(join(directory,`${abandoned}.result.json`),1000)).error,'coach_interrupted');
    const timed=randomUUID();
    await atomicCoachFile(join(directory,`${timed}.request.json`),{id:timed,input,config,expiresAt:Date.now()+30000});
    await processCoachSpool(directory,signal,async()=>{throw new JobError('process_timeout');});
    assert.equal((await readCoachFile(join(directory,`${timed}.result.json`),1000)).error,'coach_timeout');
    assert.throws(()=>validateCoachResponse({...result,usage:{...result.usage,inputTokens:-1}},config),/coach_invalid_response/);
  } finally { if(old===undefined) delete process.env.DOTA_COACH_BRIDGE_DIR; else process.env.DOTA_COACH_BRIDGE_DIR=old; await rm(directory,{recursive:true,force:true}); }
});
test('container spool claims once, preserves results and expires an abandoned request',async()=>{
  const directory=await mkdtemp('/tmp/dota-coach-container-test-');
  const transport=(action,id,input)=>new Promise((accept,reject)=>{
    const child=spawn(process.execPath,['scripts/coach-spool.mjs',action,...(id?[id]:[])],{env:{...process.env,DOTA_COACH_BRIDGE_DIR:directory},stdio:['pipe','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();child.once('error',reject);
    child.once('close',code=>code===0?accept(JSON.parse(output)):reject(Error('spool_failed')));child.stdin.end(input?JSON.stringify(input):'');
  });
  const request=id=>({id,input:{prompt:'fixture',schema:{}},config,expiresAt:Date.now()+30000});
  try {
    const id=randomUUID();await atomicCoachFile(join(directory,`${id}.request.json`),request(id));
    let invocations=0;
    await processDockerSpool(new AbortController().signal,transport,async()=>{invocations++;return result;});
    await processDockerSpool(new AbortController().signal,transport,async()=>{invocations++;return result;});
    assert.equal(invocations,1);
    await transport('complete',id,{error:'coach_provider_failed'});
    assert.deepEqual(await readCoachFile(join(directory,`${id}.result.json`),1000),result);
    const abandoned=randomUUID(),payload=request(abandoned);
    await atomicCoachFile(join(directory,`${abandoned}.request.json`),payload);
    assert.equal((await transport('next')).id,abandoned);
    assert.equal(await transport('next'),null);
    await atomicCoachFile(join(directory,`${abandoned}.request.json`),{...payload,expiresAt:Date.now()-1});
    assert.equal(await transport('next'),null);
    assert.equal((await readCoachFile(join(directory,`${abandoned}.result.json`),1000)).error,'coach_request_expired');
  } finally {await rm(directory,{recursive:true,force:true});}
});
