import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openDatabase, migrate, saveDataset } from '@dota/persistence';
import { readMatchOverview } from '@dota/jobs';
import { fixture, base } from './fixtures/analysis.mjs';
test('overview selects exact participant and dataset, preserves zero, unknown, negative time and gaps', async () => {
  const pool = openDatabase(process.env.TEST_DATABASE_URL);
  try {
    await migrate(pool);
    const ctx = fixture();
    const source = JSON.parse(await readFile('packages/contracts/fixtures/records.json', 'utf8')).find(r => r.kind === 'hero_state');
    const sample = (id, time, slot, hp) => ({ ...source, ...base('hero_state', id), playerSlot: slot, gameTimeSeconds: time,
      perspective: { mode: 'omniscient' }, coverageIds: [], visibility: {status:'unknown',value:null,reason:'Unverified'}, alive: {status:'unknown',value:null,reason:'Unverified'}, inventory: {status:'unknown',value:null,reason:'Unverified'}, resources: {status:'unknown',value:null,reason:'Unverified'}, lastKnownPosition: null, position: {status:'unknown',value:null,reason:'Uncalibrated'},
      hp: hp === null ? {status:'unknown',value:null,reason:'Gap'} : {status:'known',value:hp,observedAtSeconds:time},
      mana: {status:'known',value:0,observedAtSeconds:time} });
    await saveDataset(pool, {id:'dataset',matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},
      [...ctx.records, sample('before',-5,0,100),sample('zero',0,0,0),sample('missing',10,0,null),sample('enemy',0,128,999)]);
    await assert.rejects(readMatchOverview(pool,'dataset','1'),/analysis_not_found/);
    await pool.query('INSERT INTO dota.dataset_checks(dataset_id,version,payload) VALUES ($1,$2,$3)',['dataset',ctx.validation.version,ctx.validation]);
    const view = await readMatchOverview(pool,'dataset','1');
    assert.equal(view.player.role,null);assert.equal(view.player.statistics.kills,0);
    assert.deepEqual(view.series.map(p=>[p.time,p.hp,p.mana]),[[-5,100,0],[0,0,0],[10,null,0]]);
    assert.deepEqual(view.series.map(p=>p.evidenceId),['before','zero','missing']);
    await assert.rejects(readMatchOverview(pool,'dataset','999'),/analysis_not_found/);
    await assert.rejects(readMatchOverview(pool,'other','1'),/analysis_not_found/);
    await assert.rejects(readMatchOverview(pool,'../dataset','1'),/invalid_analysis_request/);
  } finally { await pool.end(); }
});
