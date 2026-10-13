import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { openDatabase, migrate } from "@dota/persistence";
import { startQueue, consume, QUEUE, JobError, runBoundedProcess } from "@dota/jobs";
const pool = openDatabase(process.env.TEST_DATABASE_URL);
const dir = await mkdtemp("/tmp/dota-jobs-");
let boss;
async function until(fn, timeout=12000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { const value=await fn(); if(value) return value; await delay(100); }
  throw new Error("condition_timeout");
}
async function done(id, state="completed") { return until(async () => { const job=await boss.getJobById(QUEUE,id); return job?.state===state && job; }); }
function alive(pid) { try { process.kill(pid,0); return true; } catch { return false; } }
before(async () => { await migrate(pool); boss=await startQueue(process.env.TEST_DATABASE_URL,{retryDelay:1}); });
after(async () => { await boss?.stop(); await pool.end(); await rm(dir,{recursive:true}); });

test("two workers never execute heavy handlers concurrently", async () => {
  const second=await startQueue(process.env.TEST_DATABASE_URL,{retryDelay:1});
  let active=0, peak=0, processed=0;
  const handler=async () => { active++; peak=Math.max(peak,active); await delay(200); active--; processed++; };
  const stopA=await consume(boss,pool,handler), stopB=await consume(second,pool,handler);
  try {
    const ids=await Promise.all([1,2,3].map(n=>boss.send(QUEUE,{n})));
    await Promise.all(ids.map(id=>done(id)));
    assert.equal(processed,3); assert.equal(peak,1);
  } finally { await stopA(); await stopB(); await second.stop(); }
});
test("temporary errors retry with delay; permanent errors stop after one attempt", async () => {
  const attempts=new Map(), times=[];
  await pool.query("CREATE TABLE public.once_effect(id uuid PRIMARY KEY)");
  const stop=await consume(boss,pool,async ({job})=>{
    attempts.set(job.id,(attempts.get(job.id)??0)+1);
    if(job.data.permanent) throw new JobError("invalid_replay");
    times.push(Date.now());
    await pool.query("INSERT INTO public.once_effect VALUES ($1) ON CONFLICT DO NOTHING",[job.id]);
    if(job.retryCount===0) throw new JobError("temporary_source_error",true);
  });
  try {
    const transient=await boss.send(QUEUE,{}), permanent=await boss.send(QUEUE,{permanent:true});
    await done(transient); await done(permanent,"failed");
    assert.equal(attempts.get(transient),2); assert.equal(attempts.get(permanent),1);
    assert.ok(times[1]-times[0]>=400);
    assert.equal((await pool.query("SELECT count(*) FROM public.once_effect")).rows[0].count,"1");
  } finally { await stop(); }
});
test("an abruptly killed worker's claim is recovered after expiration", async () => {
  const id=await boss.send(QUEUE,{}, {expireInSeconds:2,retryDelay:1});
  const child=spawn(process.execPath,["scripts/fixtures/queue-crash.mjs"],{env:process.env,stdio:["ignore","pipe","pipe"]});
  try {
    await until(async()=> (await boss.getJobById(QUEUE,id))?.state==="active");
    const exited=once(child,"exit"); child.kill("SIGKILL"); await exited;
    await delay(2300); await boss.supervise(QUEUE);
    const stop=await consume(boss,pool,async()=>({recovered:true}));
    try { const recovered=await done(id); assert.equal(recovered.retryCount,1); assert.equal(recovered.output.recovered,true); }
    finally { await stop(); }
  } finally { child.kill("SIGKILL"); }
});
test("queue cancellation stops the active child and preserves cancelled state", async () => {
  await boss.updateQueue(QUEUE,{expireInSeconds:600});
  const pidFile=`${dir}/cancel.pid`; let stopped=false;
  const stop=await consume(boss,pool,async ({signal})=>{
    try { await runBoundedProcess({command:process.execPath,args:["-e","require('fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)",pidFile]},signal); }
    finally { stopped=true; }
  });
  try {
    const id=await boss.send(QUEUE,{});
    const pid=await until(async()=>{try{return Number(await readFile(pidFile,"utf8"));}catch{return false;}});
    await boss.cancel(QUEUE,id); await until(()=>stopped); await until(()=>!alive(pid));
    assert.equal((await boss.getJobById(QUEUE,id)).state,"cancelled");
  } finally { await stop(); }
});
test("process timeout, memory and output limits are enforced", async () => {
  const signal=new AbortController().signal;
  await assert.rejects(runBoundedProcess({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],timeoutMs:300},signal),/process_timeout/);
  await assert.rejects(runBoundedProcess({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],memoryBytes:1024},signal),/process_memory_limit/);
  await assert.rejects(runBoundedProcess({command:process.execPath,args:["-e","console.log('x'.repeat(10000))"],stdoutBytes:10},signal),/process_output_limit/);
});
test("watchdog kills an orphan child after the worker is SIGKILLed", async () => {
  const pidFile=`${dir}/orphan.pid`;
  const parent=spawn(process.execPath,["scripts/fixtures/process-crash.mjs",pidFile],{env:process.env,stdio:"ignore"});
  try {
    const pid=await until(async()=>{try{return Number(await readFile(pidFile,"utf8"));}catch{return false;}});
    const exited=once(parent,"exit"); parent.kill("SIGKILL"); await exited;
    await until(()=>!alive(pid));
  } finally { parent.kill("SIGKILL"); }
});
test("application worker connects to PostgreSQL and shuts down on SIGTERM", async () => {
  const child=spawn(process.execPath,["apps/worker/dist/index.js"],{env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,STORAGE_ROOT:`${dir}/worker-storage`},stdio:["ignore","pipe","pipe"]});
  let output=""; child.stdout.on("data",chunk=>{output+=chunk;});
  try {
    await until(()=>output.includes('"worker.started"'));
    const exited=once(child,"exit"); child.kill("SIGTERM");
    const [code]=await exited; assert.equal(code,0); assert.match(output,/worker.stopped/);
  } finally { child.kill("SIGKILL"); }
});
