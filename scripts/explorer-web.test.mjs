import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase,migrate,saveDataset,LocalStorage,storeStateSegments,prepareMotionSegments,transaction } from '@dota/persistence';
import { analysisHandler, defaultVersions } from '@dota/jobs';
import { fixture,base,death } from './fixtures/analysis.mjs';
const unknown={status:'unknown',value:null,reason:'Unverified'};
test('production full-match HTTP without episodes: direct links, frames, filters and isolation',async()=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL),root=await mkdtemp('/tmp/dota-explorer-web-');let web, iconPreview;
 try{
  await migrate(pool);const ctx=fixture(Array.from({length:205},(_,i)=>death(`death-${String(i).padStart(3,'0')}`,i*5,i>=114&&i<=128?0:i%2?128:0)));
  ctx.records.filter(r=>r.kind==='participant').forEach((p,i)=>p.heroId=String([1,2,3,4,5,6,7,8,9,10][i]));
  const samples=[];
  for(let time=-30;time<=1200;time+=5)for(const slot of [0,1,2,3,4,128,129,130,131,132])samples.push({...base('hero_state',`s-${slot}-${time}`),provenance:{...base('hero_state','x').provenance,sourceVersion:'normalized-v2/clarity-5.0.1/protobuf-7.1'},
   playerSlot:slot,gameTimeSeconds:time,tick:null,perspective:{mode:'omniscient'},position:{status:'known',value:{x:(slot<128?-1:1)*(3000+slot%5*200)-time,y:slot%5*900-1800,z:0,coordinateSystem:'world',mapVersion:null},observedAtSeconds:time},
   hp:{status:'known',value:Math.max(0,1200-time),observedAtSeconds:time},mana:{status:'known',value:400,observedAtSeconds:time},alive:{status:'known',value:true,observedAtSeconds:time},inventory:unknown,visibility:unknown,resources:unknown,lastKnownPosition:null,coverageIds:[]});
  // A dead hero remains identifiable; two heroes share a position and must be selectable via the roster.
  for (const sample of samples) {
    if (sample.gameTimeSeconds === 600 && sample.playerSlot === 0) sample.alive.value = false;
    if (sample.gameTimeSeconds === 600 && sample.playerSlot === 1) sample.position = { ...samples.find(s=>s.gameTimeSeconds===600&&s.playerSlot===0).position };
    if (sample.gameTimeSeconds >= 1100 && sample.playerSlot === 132) sample.position = unknown;
  }
  await saveDataset(pool,{id:'explore-web',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},[...ctx.records.map(r=>r.kind==='coverage'?{...r,datasetId:'explore-web'}:r),...samples]);
  await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',['explore-web',ctx.validation.version,{...ctx.validation,datasetId:'explore-web',coverage:ctx.validation.coverage.map(c=>({...c,datasetId:'explore-web'}))}]);
  await storeStateSegments(pool,new LocalStorage(root),'explore-web',samples);
  if(process.env.EXPLORER_PREVIEW_GATE){
    const tracks=[];
    for(let bucket=-1;bucket<=40;bucket++)for(const slot of [0,1,2,3,4,128,129,130,131,132]){
      const rows=[];
      for(let i=0;i<120;i++){
        const time=bucket*30+i/4;if(time>1200)continue;
        const hidden=time>=1100&&slot===132,alive=!(slot===0&&time>=600&&time<605);
        const overlap=slot===1&&time===600;
        const x=(slot<128?-1:1)*(3000+slot%5*200)-time+(time>=610?1500:0);
        rows.push({time,tick:10000+Math.round((time+30)*30),x:hidden?null:overlap?-3600:x,y:hidden?null:overlap?-1800:slot%5*900-1800,alive,breakBefore:hidden?'unknown':time===610?'jump':slot===0&&(time===600||time===605)?'life':slot===1&&(time===600||time===600.25)?'jump':null});
      }
      if(rows.length)tracks.push({...base('hero_motion',`motion-${slot}-${bucket}`),provenance:{...base('hero_motion','x').provenance,sourceVersion:'normalized-v2/clarity-5.0.1/protobuf-7.1'},playerSlot:slot,formatVersion:'motion-v1',stepSeconds:0.25,samples:rows});
    }
    await transaction(pool,await prepareMotionSegments(new LocalStorage(root),'explore-web','1',tracks));
  }
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
  const intervalUrl=endpoint+'&resource=playback&version=playback-v1&bucket=20';
  const interval=await(await fetch(intervalUrl)).json();assert.equal(interval.version,'playback-v1');assert.equal(interval.start,600);assert.ok(interval.states.length);
  const decisionInterval=await(await fetch(intervalUrl+'&mode=decision')).json();assert.deepEqual(decisionInterval.states,[]);assert.deepEqual(decisionInterval.motion,[]);
  for(const suffix of ['&from=0','&bucket=21'])assert.equal((await fetch(intervalUrl+suffix)).status,400);
  assert.equal((await fetch(intervalUrl.replace('bucket=20','bucket=20.5'))).status,400);
  assert.equal((await fetch(intervalUrl.replace('playback-v1','wrong'))).status,400);
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
  const heroCatalog=JSON.parse(await readFile('apps/web/lib/hero-catalog.json','utf8'));
  const iconResponse=await fetch(baseUrl+heroCatalog.heroes['1'].icon);
  assert.equal(iconResponse.status,200);
  assert.equal(iconResponse.headers.get('content-type'),'image/png');
  assert.match(iconResponse.headers.get('cache-control'),/max-age=31536000.*immutable/);
  assert.deepEqual(Buffer.from(await iconResponse.arrayBuffer()),await readFile('apps/web/public'+heroCatalog.heroes['1'].icon));
  assert.equal((await fetch(baseUrl+'/heroes/9999.missing.png')).status,404);
  if(process.env.EXPLORER_PREVIEW_GATE){
    const edgeId='icons-unknown';
    const edgeRecords=ctx.records.map(r=>r.kind==='coverage'?{...r,datasetId:edgeId}:r.kind==='participant'&&r.playerSlot===132?{...r,heroId:'9999'}:r);
    await saveDataset(pool,{id:edgeId,matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'b'.repeat(64),versions:{}},[...edgeRecords,...samples]);
    await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',[edgeId,ctx.validation.version,{...ctx.validation,datasetId:edgeId,coverage:ctx.validation.coverage.map(c=>({...c,datasetId:edgeId}))}]);
    await storeStateSegments(pool,new LocalStorage(root),edgeId,samples);
    // Browser-only failure injection at a separate loopback origin. Production assets remain untouched.
    const imageRequests=new Map(), playbackRequests=new Map();
    const failedFrames=new Set();
    iconPreview=createHttpServer((req,res)=>{
      if(req.url.startsWith('/heroes/')){
        imageRequests.set(req.url,(imageRequests.get(req.url)??0)+1);
        if(req.url===heroCatalog.heroes['2'].icon){res.writeHead(404,{'Cache-Control':'no-store'});res.end('Missing preview icon');return;}
      }
      const requested=new URL(req.url,'http://preview.local');
      const at=requested.searchParams.get('time');
      if(requested.searchParams.get('resource')==='playback')playbackRequests.set(req.url,(playbackRequests.get(req.url)??0)+1);
      const isFrame=requested.searchParams.get('resource')==='frame'||requested.pathname.endsWith('/view');
      if(isFrame&&at==='603'&&!failedFrames.has(req.url)){failedFrames.add(req.url);res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'temporary_unavailable'}));return;}
      const proxy=httpRequest(baseUrl+req.url,{method:req.method,headers:req.headers},upstream=>{const send=()=>{res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);};if(isFrame&&at==='601')setTimeout(send,3000);else if(isFrame&&at==='602')setTimeout(send,500);else send();});
      proxy.on('error',()=>{res.writeHead(502);res.end();});req.pipe(proxy);
    }).listen(0,'127.0.0.1');
    await once(iconPreview,'listening');
    console.log(`Icon failure preview: http://127.0.0.1:${iconPreview.address().port}${path.replace('explore-web',edgeId)}`);
    const output=await analysisHandler(pool)({row:{dataset_id:'explore-web',account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal});
    await transaction(pool,output.commit);
    const episodes=(await pool.query("SELECT id,payload FROM dota.records WHERE kind='episode' AND dataset_id='explore-web'")).rows;
    const episode=episodes.find(e=>e.payload.window.startSeconds<=600&&e.payload.window.endSeconds>=600);
    assert.ok(episode,'Preview needs an episode at 600 seconds');
    console.log(`Explorer preview: ${baseUrl}${path}`);
    console.log(`Episode preview: ${baseUrl}/matches/1/episodes/${episode.id}?accountId=1&datasetId=explore-web&mode=retrospective&time=600`);
    while(true){try{await access(process.env.EXPLORER_PREVIEW_GATE);break;}catch{}await delay(500);}
    console.log('Playback requests:',JSON.stringify(Object.fromEntries(playbackRequests)));
    console.log('Icon preview requests:',JSON.stringify(Object.fromEntries(imageRequests)));
  }
 }finally{if(iconPreview){iconPreview.closeAllConnections();await new Promise(r=>iconPreview.close(r));}if(web&&web.exitCode===null){const ended=once(web,'exit');web.kill('SIGTERM');await ended;}await pool.end();await rm(root,{recursive:true,force:true});}
});
