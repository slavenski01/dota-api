import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { openDatabase,migrate,saveDataset,LocalStorage,storeStateSegments,prepareMotionSegments,transaction } from '@dota/persistence';
import { readPlaybackWindow,readMatchFrame } from '@dota/jobs';
import { PlaybackCache,observedFrame,playbackScope } from '../apps/web/lib/playback-cache.ts';
import { fixture,base } from './fixtures/analysis.mjs';

test('cache is bounded, pins current window, isolates accounts/perspectives/versions and discards late replies',()=>{
 const cache=new PlaybackCache(),scope=playbackScope('d','1','retrospective');cache.reset(scope);const generation=cache.generation;
 cache.pin(0);
 for(let bucket=0;bucket<10;bucket++)cache.put(scope,generation,{version:'playback-v1',bucket},2*1024**2);
 assert.equal(cache.size,4);assert.equal(cache.bytes,8*1024**2);assert.ok(cache.get(0));assert.equal(cache.get(1),undefined);
 const other=playbackScope('d','1','decision');cache.reset(other);assert.equal(cache.bytes,0);assert.equal(cache.get(0),undefined);
 assert.equal(cache.put(scope,generation,{version:'playback-v1',bucket:0},100),false);
 assert.notEqual(other,playbackScope('d','2','decision'));assert.notEqual(other,playbackScope('new','1','decision'));
 assert.throws(()=>cache.put(other,cache.generation,{version:'wrong',bucket:0},100));
 assert.throws(()=>cache.put(other,cache.generation,{version:'playback-v1',bucket:0},5*1024**2));
});

test('intervals preserve boundary observations, actual state time, old datasets and decision masking',async()=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL),root=await mkdtemp('/tmp/dota-playback-');
 try{
  await migrate(pool);const ctx=fixture(),storage=new LocalStorage(root);
  const source=JSON.parse(await readFile('packages/contracts/fixtures/records.json')).find(r=>r.kind==='hero_state');
  const states=[-5,0,5,25,30,35,60].map(time=>({...source,...base('hero_state',`s-${time}`),playerSlot:0,gameTimeSeconds:time,tick:1000+time*30,perspective:{mode:'omniscient'},visibility:{status:'unknown',value:null,reason:'Unverified'},position:{status:'known',value:{x:time,y:0,z:0,coordinateSystem:'world',mapVersion:null},observedAtSeconds:time},hp:{status:'known',value:time+100,observedAtSeconds:time},mana:{status:'unknown',value:null,reason:'unknown'},alive:{status:'known',value:true,observedAtSeconds:time},inventory:{status:'unknown',value:null,reason:'unknown'},resources:{status:'unknown',value:null,reason:'unknown'},lastKnownPosition:null}));
  await saveDataset(pool,{id:'dataset',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},[...ctx.records,...states]);
  await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',['dataset',ctx.validation.version,ctx.validation]);
  await storeStateSegments(pool,storage,'dataset',states);
  const before=await readPlaybackWindow(pool,storage,'dataset','1','retrospective',0,'playback-v1');assert.equal(before.motionAvailable,false);
  const tracks=[0,1].map(bucket=>({...base('hero_motion',`m-${bucket}`),playerSlot:0,formatVersion:'motion-v1',stepSeconds:0.25,samples:Array.from({length:120},(_,i)=>({time:bucket*30+i/4,tick:100+bucket*900+i*7,x:bucket*30+i/4,y:0,alive:true,breakBefore:i===0?'start':null}))}));
  await transaction(pool,await prepareMotionSegments(storage,'dataset','1',tracks));
  const first=await readPlaybackWindow(pool,storage,'dataset','1','retrospective',0,'playback-v1'),second=await readPlaybackWindow(pool,storage,'dataset','1','retrospective',1,'playback-v1');
  assert.equal(first.motionAvailable,true);
  assert.deepEqual(observedFrame(first,30),observedFrame(second,30));
  for(const time of [0,0.01,5,10,11,29.999,30])assert.deepEqual(observedFrame(first,time),await readMatchFrame(pool,storage,'dataset','1','retrospective',time));
  assert.ok(first.motion.flatMap(t=>t.samples).some(s=>s.time===30));
  assert.ok(second.motion.flatMap(t=>t.samples).some(s=>s.time===29.75));
  assert.equal(observedFrame(first,11).states[0].state,null);
  assert.equal(observedFrame(first,10).states[0].state.gameTimeSeconds,5);
  const masked=await readPlaybackWindow(pool,{read(){throw Error('hidden read');}},'dataset','1','decision',0,'playback-v1');
  assert.deepEqual(masked.states,[]);assert.deepEqual(masked.motion,[]);assert.ok(observedFrame(masked,10).states.every(s=>s.mapPosition===null&&s.state.hp.status==='unknown'));
  for(const [mode,bucket,version] of [['retrospective',0,'wrong'],['wrong',0,'playback-v1'],['retrospective',1.5,'playback-v1'],['retrospective',500,'playback-v1']])await assert.rejects(readPlaybackWindow(pool,storage,'dataset','1',mode,bucket,version));
  await assert.rejects(readPlaybackWindow(pool,storage,'dataset','999','retrospective',0,'playback-v1'));
  await assert.rejects(readPlaybackWindow(pool,storage,'dataset','1','retrospective',0,'playback-v1','wrong-episode'));
 }finally{await pool.end();await rm(root,{recursive:true,force:true});}
});
