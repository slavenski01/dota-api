import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase,migrate,saveDataset,LocalStorage,storeStateSegments } from '@dota/persistence';
import { fixture,base,death } from './fixtures/analysis.mjs';
const unknown={status:'unknown',value:null,reason:'Unverified'};
test('production full-match HTTP without episodes: direct links, frames, filters and isolation',async()=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL),root=await mkdtemp('/tmp/dota-explorer-web-');let web;
 try{
  await migrate(pool);const ctx=fixture(Array.from({length:205},(_,i)=>death(`death-${String(i).padStart(3,'0')}`,i*5,i%2?128:0)));
  ctx.records.filter(r=>r.kind==='participant').forEach((p,i)=>p.heroId=String([1,2,3,4,5,6,7,8,9,10][i]));
  const samples=[];
  for(let time=-30;time<=1200;time+=5)for(const slot of [0,1,2,3,4,128,129,130,131,132])samples.push({...base('hero_state',`s-${slot}-${time}`),provenance:{...base('hero_state','x').provenance,sourceVersion:'normalized-v2/clarity-5.0.1/protobuf-7.1'},
   playerSlot:slot,gameTimeSeconds:time,tick:null,perspective:{mode:'omniscient'},position:{status:'known',value:{x:(slot<128?-1:1)*(3000+slot%5*200)-time,y:slot%5*900-1800,z:0,coordinateSystem:'world',mapVersion:null},observedAtSeconds:time},
   hp:{status:'known',value:Math.max(0,1200-time),observedAtSeconds:time},mana:{status:'known',value:400,observedAtSeconds:time},alive:{status:'known',value:true,observedAtSeconds:time},inventory:unknown,visibility:unknown,resources:unknown,lastKnownPosition:null,coverageIds:[]});
  await saveDataset(pool,{id:'explore-web',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},[...ctx.records.map(r=>r.kind==='coverage'?{...r,datasetId:'explore-web'}:r),...samples]);
  await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',['explore-web',ctx.validation.version,{...ctx.validation,datasetId:'explore-web'}]);
  await storeStateSegments(pool,new LocalStorage(root),'explore-web',samples);
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  web=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:resolve('apps/web'),env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,STORAGE_ROOT:root,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  web.stdout.on('data',()=>{});web.stderr.on('data',()=>{});
  const baseUrl=`http://127.0.0.1:${port}`;
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(baseUrl+'/api/health')).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  const endpoint=`${baseUrl}/api/datasets/explore-web/explore?accountId=1`;
  const view=await(await fetch(endpoint)).json();assert.equal(view.players.length,10);
  assert.equal((await fetch(endpoint+'&resource=frame&time=-30')).status,200);
  assert.equal((await fetch(endpoint+'&resource=frame&time=1201')).status,400);
  assert.equal((await fetch(endpoint+'&resource=frame&time=')).status,400);
  assert.equal((await fetch(endpoint+'&resource=frame&time=0&time=1')).status,400);
  assert.equal((await fetch(endpoint+'&resource=events&type=bad')).status,400);
  assert.equal((await fetch(endpoint.replace('accountId=1','accountId=999'))).status,404);
  const masked=await(await fetch(endpoint+'&resource=frame&time=10&mode=decision')).json();assert.ok(masked.states.every(s=>s.mapPosition===null&&s.state.hp.status==='unknown'));
  assert.deepEqual((await(await fetch(endpoint+'&resource=events&mode=decision')).json()).events,[]);
  const first=await(await fetch(endpoint+'&resource=events')).json();assert.equal(first.events.length,100);assert.ok(first.nextCursor);
  const second=await(await fetch(endpoint+'&resource=events&cursor='+first.nextCursor)).json();assert.equal(second.events.length,100);assert.notEqual(first.events.at(-1).id,second.events[0].id);
  const notesUrl=`${baseUrl}/api/datasets/explore-web/notes?accountId=1`;
  const payload={id:randomUUID(),time:600,playerSlot:128,mode:'retrospective',content:'Сверить позицию на десятой минуте'};
  const post=(body,origin=baseUrl)=>fetch(notesUrl,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  assert.equal((await post(payload,'https://untrusted.example')).status,403);
  assert.equal((await post(payload)).status,200);assert.equal((await post(payload)).status,200);
  assert.equal((await post({...payload,content:'changed'})).status,409);
  assert.equal((await post({...payload,id:randomUUID(),time:-1000})).status,400);
  assert.equal((await post({...payload,id:randomUUID(),content:''})).status,400);
  assert.equal((await(await fetch(notesUrl)).json()).notes.length,1);
  assert.equal((await(await fetch(notesUrl+'&mode=decision')).json()).notes.length,0);
  assert.equal((await fetch(notesUrl.replace('accountId=1','accountId=999'))).status,404);
  const path='/matches/1/explore?accountId=1&datasetId=explore-web&time=600&hero=128&mode=retrospective';
  assert.equal((await fetch(baseUrl+path)).status,200);
  if(process.env.EXPLORER_PREVIEW_GATE){console.log(`Explorer preview: ${baseUrl}${path}`);while(true){try{await access(process.env.EXPLORER_PREVIEW_GATE);break;}catch{}await delay(500);}}
 }finally{if(web&&web.exitCode===null){const ended=once(web,'exit');web.kill('SIGTERM');await ended;}await pool.end();await rm(root,{recursive:true,force:true});}
});
