import { readFile,writeFile,mkdtemp,rm,access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readMessages } from '@dota/contracts';
import { openDatabase,migrate,saveDataset,LocalStorage,prepareStateSegments,prepareMotionSegments,transaction } from '@dota/persistence';
import { readPlaybackWindow } from '@dota/jobs';
import { PlaybackCache,playbackScope } from '../apps/web/lib/playback-cache.ts';
const pool=openDatabase(process.env.TEST_DATABASE_URL),root=await mkdtemp('/tmp/dota-playback-measure-');let web;
try{
 await migrate(pool);const records=[];
 for await(const m of readMessages((async function*(){yield await readFile('data/e14-validation/R3.ndjson');})()))if(m.type==='record')records.push(m.record);
 const match=records.find(r=>r.kind==='match'),player=records.find(r=>r.kind==='participant'&&r.accountId!==null),datasetId='playback-measure',storage=new LocalStorage(root);
 for(const record of records)if(record.kind==='coverage')record.datasetId=datasetId;
 const buckets=new Set();
 const indexed=records.filter(r=>{if(r.kind==='hero_motion')return false;if(r.kind!=='hero_state')return true;const key=`${r.playerSlot}:${Math.floor(r.gameTimeSeconds/5)}`;if(buckets.has(key))return false;buckets.add(key);return true;});
 await saveDataset(pool,{id:datasetId,matchId:match.matchId,parserRunId:null,normalizationVersion:'e14-motion-v1-250ms',inputSha256:'a'.repeat(64),versions:{}},indexed);
 await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',[datasetId,'coverage-v1',{datasetId,version:'coverage-v1',complete:true,coverage:records.filter(r=>r.kind==='coverage')}]);
 await transaction(pool,await prepareStateSegments(storage,datasetId,match.matchId,records.filter(r=>r.kind==='hero_state')));
 await transaction(pool,await prepareMotionSegments(storage,datasetId,match.matchId,records.filter(r=>r.kind==='hero_motion')));
 records.length=0;indexed.length=0;global.gc?.();const baseline=process.memoryUsage().heapUsed;
 const scope=playbackScope(datasetId,player.accountId,'retrospective'),cache=new PlaybackCache();cache.reset(scope);
 const timings=[],sizes=[];let maxHeap=0,maxBytes=0;
 for(let bucket=0;bucket<=Math.floor(match.durationSeconds/30);bucket++){
  const started=performance.now();const window=await readPlaybackWindow(pool,storage,datasetId,player.accountId,'retrospective',bucket,'playback-v1');timings.push(performance.now()-started);
  const bytes=Buffer.byteLength(JSON.stringify(window));sizes.push(bytes);cache.pin(bucket);cache.put(scope,cache.generation,window,bytes);maxBytes=Math.max(maxBytes,cache.bytes);
  global.gc?.();maxHeap=Math.max(maxHeap,process.memoryUsage().heapUsed-baseline);
 }
 timings.sort((a,b)=>a-b);sizes.sort((a,b)=>a-b);
 const report={sample:'R3',durationSeconds:match.durationSeconds,intervals:timings.length,latencyP50Ms:timings[Math.floor(timings.length*.5)],latencyP95Ms:timings[Math.floor(timings.length*.95)],responseP50Bytes:sizes[Math.floor(sizes.length*.5)],responseMaxBytes:sizes.at(-1),cacheMaxSerializedBytes:maxBytes,cacheWindows:cache.size,heapIncreaseBytes:maxHeap,explicitGc:!!global.gc};
 console.log(JSON.stringify(report));await writeFile('data/e14-validation/playback-summary.json',JSON.stringify(report,null,2)+'\n');
 if(process.env.PLAYBACK_PREVIEW_GATE){
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  web=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:resolve('apps/web'),env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,STORAGE_ROOT:root,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});web.stdout.on('data',()=>{});web.stderr.on('data',()=>{});
  for(let i=0;i<150;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)break;}catch{}await delay(100);}
  console.log(`Real playback preview: http://127.0.0.1:${port}/matches/${match.matchId}/explore?datasetId=${datasetId}&accountId=${player.accountId}&time=600&mode=retrospective&diagnostics=1`);
  while(true){try{await access(process.env.PLAYBACK_PREVIEW_GATE);break;}catch{}await delay(500);}
 }
}finally{if(web&&web.exitCode===null){const ended=once(web,'exit');web.kill('SIGTERM');await ended;}await pool.end();await rm(root,{recursive:true,force:true});}
