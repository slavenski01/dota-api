import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase,migrate,saveDataset,transaction} from '@dota/persistence';
import {analysisHandler,defaultVersions,createPractice} from '@dota/jobs';
import {fixture,death} from './fixtures/analysis.mjs';
test('E09 production HTTP validates inputs and origin; comparisons and five-game observations persist across restart',async()=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL);let web;
 const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const root=`http://127.0.0.1:${port}`;
 async function start(){web=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:resolve('apps/web'),env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,NEXT_TELEMETRY_DISABLED:'1'},stdio:'ignore'});for(let n=0;n<100;n++){try{if((await fetch(root+'/api/health')).ok)return;}catch{}await delay(100);}throw Error('web_not_ready');}
 async function stop(){if(web){const ended=once(web,'exit');web.kill('SIGTERM');await ended;web=null;}}
 const route=(n,name)=>`${root}/api/datasets/web-${n}/${name}?accountId=1`;
 const post=(url,body,origin=root)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
 const get=async url=>{const r=await fetch(url);assert.equal(r.status,200);return r.json();};
 try{
  await migrate(pool);
  for(let n=1;n<=7;n++){
   const ctx=fixture(n===1?[death('early-death',300)]:[]),id=String(n),datasetId=`web-${n}`;
   for(const r of ctx.records){r.matchId=id;if(r.kind==='coverage')r.datasetId=datasetId;if(r.kind==='match'){r.mode='22';r.startedAt=n===1?'2020-01-01T00:00:00.000Z':new Date(Date.UTC(2099,0,n)).toISOString();}}
   ctx.validation.datasetId=datasetId;ctx.validation.matchId=id;for(const c of ctx.validation.coverage){c.datasetId=datasetId;c.matchId=id;}
   await saveDataset(pool,{id:datasetId,matchId:id,parserRunId:null,normalizationVersion:'fixture',inputSha256:'d'.repeat(64),versions:{}},ctx.records);
   await pool.query('INSERT INTO dota.dataset_checks VALUES($1,$2,$3)',[datasetId,ctx.validation.version,ctx.validation]);
   const result=await analysisHandler(pool)({row:{dataset_id:datasetId,account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal});await transaction(pool,result.commit);
  }
  await start();
  const value={role:3,patch:'7.40',aspect:null,party:null,plan:null,earlyLeave:false,dataGap:false,author:'Автор проверки',expectedVersion:0};
  assert.equal((await post(route(1,'comparisons'),{action:'context',value},'https://untrusted.example')).status,403);
  assert.equal((await post(route(1,'comparisons'),{action:'context',value:{...value,earlyLeave:'false'}})).status,400);
  assert.equal((await fetch(route(1,'comparisons')+'&accountId=1')).status,400);
  assert.equal((await fetch(route(1,'comparisons').replace('accountId=1','accountId=999'))).status,404);
  for(let n=1;n<=7;n++)assert.equal((await post(route(n,'comparisons'),{action:'context',value})).status,200);
  const compared=await post(route(1,'comparisons'),{action:'compare',value:{relaxed:[],additional:[]}});assert.equal(compared.status,200);const comparison=await compared.json();assert.equal(comparison.lane[0].status,'skipped');assert.ok(comparison.analysisId);
  assert.equal((await fetch(`${root}/matches/1/compare?datasetId=web-1&accountId=1`)).status,200);
  const create={id:randomUUID(),action:'Перед входом проверить продолжение союзников',scope:'Перед добровольным началом боя при наличии времени',author:'Автор проверки',reportId:null,filters:{relaxed:[],additional:[]}};
  const created=await post(route(1,'progress'),{action:'create',value:create});assert.equal(created.status,200);const series=await created.json();
  assert.deepEqual(await(await post(route(1,'progress'),{action:'create',value:create})).json(),series);
  const input={seriesId:series.id,expectedVersion:0,done:1,missed:2,uncertain:1,note:'Просмотрены четыре подходящих входа в бой.',author:'Автор проверки',mmr:null};
  assert.equal((await post(route(1,'progress'),{action:'observe',value:input})).status,400);
  for(let n=2;n<=6;n++)assert.equal((await post(route(n,'progress'),{action:'observe',value:n===2?{...input,done:0,missed:0,uncertain:0,note:'Подходящих ситуаций не было.'}:input})).status,200);
  assert.equal((await post(route(7,'progress'),{action:'observe',value:input})).status,409);
  const before=await get(route(2,'progress'));assert.equal(before[0].observations.length,5);assert.equal(before[0].totals.rate,1/3);assert.equal(before[0].totals.noOpportunityGames,1);
  assert.equal((await post(route(2,'progress'),{action:'observe',value:{...input,expectedVersion:1,done:2}})).status,200);
  const updated=await get(route(2,'progress')),comparisons=await get(route(1,'comparisons'));
  await stop();await start();assert.deepEqual(await get(route(2,'progress')),updated);assert.deepEqual(await get(route(1,'comparisons')),comparisons);
  assert.equal((await fetch(route(2,'progress').replace('accountId=1','accountId=999'))).status,404);
  if(process.env.DOTA_E09_PREVIEW==='1'){
   // Local fixture preview only; the temporary database is removed after interruption.
   await createPractice(pool,'web-1','1',{...create,id:randomUUID(),action:'Проверять доступные пути отхода перед входом'});
   console.log(`E09_PREVIEW ${root}/matches/2/compare?datasetId=web-2&accountId=1`);
   await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  }
 }finally{await stop();await pool.end();}
});
