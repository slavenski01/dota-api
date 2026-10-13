import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openDatabase, migrate, saveDataset, LocalStorage, storeStateSegments, transaction } from '@dota/persistence';
import { readEpisodeFrame, analysisHandler, defaultVersions } from '@dota/jobs';
import { fixture, base, death } from './fixtures/analysis.mjs';
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
    await storeStateSegments(pool,storage,'dataset',[sample('before',98,42),sample('future',101,999),sample('same-a',110,10),sample('same-b',110,20)]);
    const output=await analysisHandler(pool)({row:{dataset_id:'dataset',account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal});
    await transaction(pool,output.commit);
    const id=(await pool.query("SELECT id FROM dota.records WHERE kind='episode'")).rows[0].id;
    const frame=await readEpisodeFrame(pool,storage,'dataset','1',id,'retrospective',100);
    assert.equal(frame.states[0].state.hp.value,42);assert.equal(frame.states[0].ageSeconds,2);assert.ok(frame.events.length);assert.ok(frame.facts.length);
    const gap=await readEpisodeFrame(pool,storage,'dataset','1',id,'retrospective',107);assert.equal(gap.states[0].state,null);
    const conflict=await readEpisodeFrame(pool,storage,'dataset','1',id,'retrospective',110);assert.equal(conflict.states[0].state,null);
    const failStorage={read(){throw Error('must not read omniscient segments');}};
    const masked=await readEpisodeFrame(pool,failStorage,'dataset','1',id,'decision',100);
    assert.ok(masked.states.every(s=>s.state.hp.status==='unknown'&&s.ageSeconds===null));assert.deepEqual(masked.events,[]);assert.deepEqual(masked.facts,[]);
    assert.ok(!JSON.stringify(masked).includes('future'));assert.equal(masked.map.status,'unverified');
    for(const [mode,time] of [['bad',100],['decision',NaN],['retrospective',0],['retrospective',2000]])await assert.rejects(readEpisodeFrame(pool,storage,'dataset','1',id,mode,time),/invalid_context_request/);
    await assert.rejects(readEpisodeFrame(pool,storage,'dataset','999',id,'decision',100),/episode_not_found/);
    await assert.rejects(readEpisodeFrame(pool,storage,'other','1',id,'decision',100),/episode_not_found/);
  }finally{await pool.end();await rm(root,{recursive:true,force:true});}
});
