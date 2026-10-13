import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { openDatabase, migrate, saveDataset, LocalStorage, storeStateSegments } from '@dota/persistence';
import { readMatchExplorer, readMatchFrame, readMatchEvents, readMatchSeries } from '@dota/jobs';
import { fixture, base, death, objective, event } from './fixtures/analysis.mjs';
const unknown={status:'unknown',value:null,reason:'Unverified'};
export const state=(id,time,slot=0)=>({...base('hero_state',id),playerSlot:slot,gameTimeSeconds:time,tick:null,perspective:{mode:'omniscient'},visibility:unknown,position:unknown,
  hp:{status:'known',value:0,observedAtSeconds:time},mana:unknown,alive:unknown,inventory:unknown,resources:unknown,lastKnownPosition:null,coverageIds:[]});
test('whole-match API works without analysis: identity, full time, tied events, filters, masked views and gaps',async()=>{
  const pool=openDatabase(process.env.TEST_DATABASE_URL),root=await mkdtemp('/tmp/dota-explorer-');
  try {
    await migrate(pool);
    const ctx=fixture([death('e-A',5),death('e-a',5,128),objective('e-b',5),event('pre-item',-10,{type:'item',action:'purchased',playerSlot:0,itemId:'1'})]);
    const samples=[state('pre',-30),state('zero',5),state('future',6),state('duplicate-a',20),state('duplicate-b',20),state('enemy',5,128)];
    await saveDataset(pool,{id:'dataset',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},[...ctx.records,...samples]);
    await assert.rejects(readMatchExplorer(pool,'dataset','1'),/dataset_not_validated/);
    await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',['dataset',ctx.validation.version,ctx.validation]);
    const storage=new LocalStorage(root);await storeStateSegments(pool,storage,'dataset',samples);
    const view=await readMatchExplorer(pool,'dataset','1');assert.equal(view.players.length,10);assert.equal(view.window.startSeconds,-60);assert.equal(view.window.endSeconds,1200);assert.equal(view.player.statistics.kills,0);
    const frame=await readMatchFrame(pool,storage,'dataset','1','retrospective',5);assert.equal(frame.states[0].state.id,'zero');assert.equal(frame.states[0].ageSeconds,0);
    assert.equal((await readMatchFrame(pool,storage,'dataset','1','retrospective',12)).states[0].state,null);
    assert.equal((await readMatchFrame(pool,storage,'dataset','1','retrospective',20)).states[0].state,null);
    assert.equal((await readMatchFrame(pool,storage,'dataset','1','retrospective',1200)).time,1200);
    const masked=await readMatchFrame(pool,{read(){throw Error('hidden read');}},'dataset','1','decision',5);assert.ok(masked.states.every(s=>s.ageSeconds===null&&s.mapPosition===null&&s.state.hp.status==='unknown'));
    const pages=[];let cursor;
    do {const result=await readMatchEvents(pool,'dataset','1',{mode:'retrospective',limit:1,...(cursor?{cursor}:{})});pages.push(...result.events.map(e=>e.id));cursor=result.nextCursor;}while(cursor);
    assert.deepEqual(pages,['pre-item','e-A','e-a','e-b']);
    assert.deepEqual((await readMatchEvents(pool,'dataset','1',{mode:'retrospective',playerSlot:0})).events.map(e=>e.id),['pre-item','e-A']);
    assert.equal((await readMatchEvents(pool,'dataset','1',{mode:'retrospective',type:'objective'})).events.length,1);
    assert.deepEqual((await readMatchEvents(pool,'dataset','1',{mode:'decision'})).events,[]);
    assert.deepEqual((await readMatchSeries(pool,'dataset','1',128,'retrospective')).series.map(s=>[s.hp,s.mana]),[[0,null]]);
    assert.deepEqual((await readMatchSeries(pool,'dataset','1',128,'decision')).series,[]);
    assert.ok((await readMatchSeries(pool,'dataset','1',0,'retrospective')).series.filter(s=>s.time===20).every(s=>s.hp===null));
    for(const account of ['999','2x'])await assert.rejects(readMatchExplorer(pool,'dataset',account));
    for(const time of [-61,1201,NaN,Infinity])await assert.rejects(readMatchFrame(pool,storage,'dataset','1','retrospective',time),/invalid_context_request/);
    for(const filter of [{limit:201},{limit:1.5},{type:'invalid'},{playerSlot:5},{cursor:'invalid'}])await assert.rejects(readMatchEvents(pool,'dataset','1',{mode:'retrospective',...filter}),/invalid_context_request/);
    const first=await readMatchEvents(pool,'dataset','1',{mode:'retrospective',limit:1});
    await assert.rejects(readMatchEvents(pool,'dataset','1',{mode:'retrospective',type:'death',cursor:first.nextCursor}),/invalid_context_request/);
  } finally { await pool.end();await rm(root,{recursive:true,force:true}); }
});
