import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openDatabase, migrate, saveDataset, LocalStorage, storeStateSegments, transaction } from '@dota/persistence';
import { readEpisodeFrame, analysisHandler, defaultVersions } from '@dota/jobs';
import { fixture, base, death } from './fixtures/analysis.mjs';
import { EPISODE_MAP, POSITION_SOURCE_VERSION, episodeMapPoint, projectWorldPosition } from '../packages/jobs/dist/episode-map.js';
const unknown = {status:'unknown',value:null,reason:'Unverified'};
export const sample = (id,time,hp) => ({...base('hero_state',id),playerSlot:0,gameTimeSeconds:time,tick:null,perspective:{mode:'omniscient'},
  visibility:unknown,position:unknown,hp:{status:'known',value:hp,observedAtSeconds:time},mana:unknown,alive:unknown,inventory:unknown,resources:unknown,lastKnownPosition:null,coverageIds:[]});
test('episode frames enforce window, freshness, identity and no retrospective data in decision mode',async()=>{
  const pool=openDatabase(process.env.TEST_DATABASE_URL),root=await mkdtemp('/tmp/dota-episode-view-');
  try{
    await migrate(pool);const ctx=fixture([death('d',100)]);
    await saveDataset(pool,{id:'dataset',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},ctx.records);
    await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)', ['dataset',ctx.validation.version,ctx.validation]);
    const storage=new LocalStorage(root);
    const before=sample('before',98,42);before.provenance={...before.provenance,sourceVersion:POSITION_SOURCE_VERSION};before.position={status:'known',value:{x:100,y:200,z:0,coordinateSystem:'world',mapVersion:null},observedAtSeconds:98};
    await storeStateSegments(pool,storage,'dataset',[before,sample('future',101,999),sample('same-a',110,10),sample('same-b',110,20)]);
    const output=await analysisHandler(pool)({row:{dataset_id:'dataset',account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal});
    await transaction(pool,output.commit);
    const id=(await pool.query("SELECT id FROM dota.records WHERE kind='episode'")).rows[0].id;
    const frame=await readEpisodeFrame(pool,storage,'dataset','1',id,'retrospective',100);
    assert.equal(frame.states[0].state.hp.value,42);assert.equal(frame.states[0].ageSeconds,2);assert.ok(frame.events.length);assert.ok(frame.facts.length);
    assert.deepEqual(frame.states[0].mapPosition,projectWorldPosition(100,200));assert.deepEqual(frame.map,EPISODE_MAP);
    const gap=await readEpisodeFrame(pool,storage,'dataset','1',id,'retrospective',107);assert.equal(gap.states[0].state,null);
    const conflict=await readEpisodeFrame(pool,storage,'dataset','1',id,'retrospective',110);assert.equal(conflict.states[0].state,null);
    const failStorage={read(){throw Error('must not read omniscient segments');}};
    const masked=await readEpisodeFrame(pool,failStorage,'dataset','1',id,'decision',100);
    assert.ok(masked.states.every(s=>s.state.hp.status==='unknown'&&s.ageSeconds===null));assert.deepEqual(masked.events,[]);assert.deepEqual(masked.facts,[]);
    assert.ok(!JSON.stringify(masked).includes('future'));assert.equal(masked.map.status,'approximate');
    assert.ok(masked.states.every(s=>s.mapPosition===null&&s.state.position.status==='unknown'));
    for(const [mode,time] of [['bad',100],['decision',NaN],['retrospective',0],['retrospective',2000]])await assert.rejects(readEpisodeFrame(pool,storage,'dataset','1',id,mode,time),/invalid_context_request/);
    await assert.rejects(readEpisodeFrame(pool,storage,'dataset','999',id,'decision',100),/episode_not_found/);
    await assert.rejects(readEpisodeFrame(pool,storage,'other','1',id,'decision',100),/episode_not_found/);
  }finally{await pool.end();await rm(root,{recursive:true,force:true});}
});
test('projection preserves axes and measured 7.40 approximation without inventing off-map or stale positions',()=>{
 assert.deepEqual(projectWorldPosition(-8192,8064),{x:0,y:0});assert.deepEqual(projectWorldPosition(8064,-8192),{x:100,y:100});
 assert.equal(projectWorldPosition(9000,0),null);assert.equal(projectWorldPosition(0,NaN),null);
 const landmarks=[[-6457.6875,7599.03125,55,30],[6425.53125,-7313.78125,842,869],[-4096,-448,210,503],[3392,-448,680,405]];
 const errors=landmarks.map(([x,y,px,py])=>{const p=projectWorldPosition(x,y);return Math.hypot(p.x*9-px,p.y*9-py);});
 assert.ok(Math.max(...errors)<80);assert.ok(Math.max(...errors)>70,'Keep the known mismatch explicit; do not claim exact calibration');
 const old=sample('old',10,1);old.position={status:'known',value:{x:0,y:0,z:null,coordinateSystem:'world',mapVersion:null},observedAtSeconds:10};
 assert.equal(episodeMapPoint(old),null);
 old.provenance={...old.provenance,sourceVersion:POSITION_SOURCE_VERSION};assert.ok(episodeMapPoint(old));
 old.position.observedAtSeconds=9;assert.equal(episodeMapPoint(old),null);
 old.position.observedAtSeconds=11;assert.equal(episodeMapPoint(old),null);
});
