import { readFile,writeFile,mkdtemp,rm } from 'node:fs/promises';
import { readMessages } from '@dota/contracts';
import { openDatabase,migrate,saveDataset,LocalStorage,prepareStateSegments,prepareMotionSegments,transaction } from '@dota/persistence';
import { readPlaybackWindow } from '@dota/jobs';
import { PlaybackCache,playbackScope } from '../apps/web/lib/playback-cache.ts';
const pool=openDatabase(process.env.TEST_DATABASE_URL),root=await mkdtemp('/tmp/dota-playback-measure-');
try{
 await migrate(pool);const records=[];
 for await(const m of readMessages((async function*(){yield await readFile('data/e14-validation/R3.ndjson');})()))if(m.type==='record')records.push(m.record);
 const match=records.find(r=>r.kind==='match'),player=records.find(r=>r.kind==='participant'&&r.accountId!==null),datasetId='playback-measure',storage=new LocalStorage(root);
 await saveDataset(pool,{id:datasetId,matchId:match.matchId,parserRunId:null,normalizationVersion:'e14-motion-v1-250ms',inputSha256:'a'.repeat(64),versions:{}},records.filter(r=>['match','participant'].includes(r.kind)));
 await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',[datasetId,'coverage-v1',{datasetId,version:'coverage-v1',complete:true,coverage:records.filter(r=>r.kind==='coverage')}]);
 await transaction(pool,await prepareStateSegments(storage,datasetId,match.matchId,records.filter(r=>r.kind==='hero_state')));
 await transaction(pool,await prepareMotionSegments(storage,datasetId,match.matchId,records.filter(r=>r.kind==='hero_motion')));
 records.length=0;global.gc?.();const baseline=process.memoryUsage().heapUsed;
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
}finally{await pool.end();await rm(root,{recursive:true,force:true});}
