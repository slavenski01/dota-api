import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,migrate} from '@dota/persistence';
import {buildCoachInput,validateCoachOutput,coachHash} from '@dota/jobs';
import {coachFixture,validCoachOutput} from './fixtures/coach.mjs';
test('context minimizes data, preserves unknowns, checks evidence and rejects invented report fields',async()=>{
  const pool=openDatabase(process.env.TEST_DATABASE_URL);
  try {
    await migrate(pool); const input=await coachFixture(pool), c=input.context;
    assert.equal(c.settings.role,null); assert.equal(c.rank,null);
    assert.ok(c.episodes.every(e=>e.decision.visibility==='unknown'&&e.decision.resources==='unknown'));
    assert.ok(c.facts.every(f=>f.evidenceIds.every(id=>c.evidence.some(e=>e.id===id))));
    assert.equal(c.facts.some(f=>f.text.startsWith('Доля участия')),false,'zero team kills is not zero participation');
    assert.ok(c.skipped.length>0);
    assert.doesNotMatch(JSON.stringify(c),/"(?:accountId|steamId|inventory|motion|positionX|nickname)":/);
    assert.equal(c.episodes[0].time,100);
    const valid=validCoachOutput(input); assert.deepEqual(validateCoachOutput(valid,input),valid);
    // PostgreSQL JSONB changes key order. Fingerprints must survive serialization/storage.
    const stored=(await pool.query('SELECT $1::jsonb AS value',[input])).rows[0].value;
    assert.equal(coachHash(stored.context),input.contextSha256);
    assert.deepEqual(validateCoachOutput(valid,stored),valid);
    for(const change of [
      x=>x.summaryFactIds.push('invented-evidence'),
      x=>x.episodes[0].factIds.push(x.summaryFactIds[0]),
      x=>x.episodes[0].episodeId='wrong-dataset',
      x=>x.episodes[0].time=999,
      x=>x.episodes[0].hypothesis='Возможно, ты потерял 999 золота.',
      x=>x.episodes[0].hypothesis='Ты точно видел врага и мог применить способность.',
      x=>x.nextAction.kind='practice',
      x=>x.nextAction.text='Перейди https://example.com',
      x=>x.episodes.push(x.episodes[0]),
      x=>x.summaryFactIds=[],
      x=>x.episodes=[]
    ]) {const bad=structuredClone(valid);change(bad);assert.throws(()=>validateCoachOutput(bad,input),/coach_invalid_report/);}
    await assert.rejects(buildCoachInput(pool,'dataset','2',c.analysisId,{role:null,goal:'overview'}),/analysis_not_found/);
    await assert.rejects(buildCoachInput(pool,'dataset','1',c.analysisId,{role:6,goal:'overview'}),/coach_invalid_request/);
  } finally {await pool.end();}
});
