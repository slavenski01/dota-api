import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {decisionContext,maskUnverifiedState} from '@dota/analysis';
const unknown={status:'unknown',value:null,reason:'raw hidden reason must not survive'};
const known=(value,time)=>({status:'known',value,observedAtSeconds:time});
function state(time,visible=true,slot=128){return {schemaVersion:'0.1.0',kind:'hero_state',id:`sample-${slot}-${time}`,matchId:'1',
 provenance:{source:'fixture',acquiredAt:'2026-10-13T00:00:00.000Z',artifactId:'secret-artifact',sourceVersion:'test',inputIds:['future-death']},
 playerSlot:slot,gameTimeSeconds:time,tick:50,perspective:{mode:'team',team:'radiant'},visibility:visible?known('visible',time):unknown,
 position:visible?known({x:100,y:200,z:null,coordinateSystem:'world',mapVersion:null},time):unknown,hp:visible?known(123,time):unknown,
 mana:visible?known(40,time):unknown,alive:visible?known(true,time):unknown,inventory:visible?known([{itemId:'1',slot:0,charges:0}],time):unknown,
 resources:visible?known([{resourceId:'1',kind:'item',cooldownRemainingSeconds:known(0,time),canUse:known(true,time)}],time):unknown,
 lastKnownPosition:null,coverageIds:['future-coverage']};}
const enemy=c=>c.states.find(s=>s.playerSlot===128);
test('visible enemies expose only observed fields; raw provenance and enemy cooldown never leak',()=>{
 const context=decisionContext([state(10)],'radiant',0,10);assert.equal(enemy(context).hp.value,123);assert.equal(enemy(context).resources.status,'unknown');
 const text=JSON.stringify(context);for(const secret of ['secret-artifact','future-death','future-coverage','sample-128','raw hidden reason'])assert.ok(!text.includes(secret));
 assert.equal(context.states.length,10);assert.equal(context.mode,'decision');
});
test('hidden and unknown states expose only established historical position, never future observations',()=>{
 const seen=state(5),hidden=state(10,false),future=state(11);future.position.value.x=99999;
 for(const visibility of [unknown,known('hidden',10)]){
  hidden.visibility=visibility;hidden.lastKnownPosition={position:future.position.value,observedAtSeconds:9};
  const result=enemy(decisionContext([seen,hidden,future],'radiant',0,10));
  assert.equal(result.hp.status,'unknown');assert.equal(result.position.status,'unknown');assert.equal(result.lastKnownPosition.position.x,100);assert.equal(result.lastKnownPosition.observedAtSeconds,5);
  assert.equal(result.visibility.status,visibility.status);assert.ok(!JSON.stringify(result).includes('99999'));
 }
});
test('stale snapshots are not interpolated, simultaneous conflicts fail closed, and full views are refused',()=>{
 assert.equal(enemy(decisionContext([state(9)],'radiant',0,10)).visibility.status,'unknown');
 assert.equal(enemy(decisionContext([state(10),{...state(10),id:'conflict'}],'radiant',0,10)).hp.status,'unknown');
 assert.throws(()=>decisionContext([{...state(10),perspective:{mode:'omniscient'}}],'radiant',0,10),/team_observations_required/);
 assert.throws(()=>decisionContext([state(10)],'dire',0,10),/invalid_decision_context/);
});
test('production mask is invariant to hidden state and future-selected sampling density',()=>{
 const original={...state(10),perspective:{mode:'omniscient'}};
 const altered=structuredClone(original);altered.hp.value=998877;altered.position.value.x=876543;
 const masked=r=>maskUnverifiedState(r,'radiant');
 assert.deepEqual(decisionContext([masked(original)],'radiant',0,10),decisionContext([masked(altered),masked({...original,id:'extra',gameTimeSeconds:11})],'radiant',0,10));
 const result=enemy(decisionContext([masked(original)],'radiant',0,10));assert.equal(result.lastKnownPosition,null);assert.equal(result.visibility.status,'unknown');
});
test('control episodes for visibility loss/gain, smoke, invisibility and detection remain unverified',t=>{
 const names=['R1-visibility-loss','R2-visibility-gain','R3-smoke','R4-invisibility','R5-detection'];let checked=0;
 for(const name of names){const path=`data/context-validation/2026-10-12-e01-t04/run/${name}.json`;if(!existsSync(path))continue;
  const research=JSON.parse(readFileSync(path));
  for(const raw of research.samples){const full=state(raw.gameTimeSeconds,false,raw.playerSlot);full.perspective={mode:'omniscient'};
   full.hp=raw.hp===null?unknown:known(raw.hp,raw.gameTimeSeconds);full.mana=raw.mana===null?unknown:known(raw.mana,raw.gameTimeSeconds);
   const result=maskUnverifiedState(full,'radiant');assert.equal(result.visibility.status,'unknown');assert.equal(result.hp.status,'unknown');assert.equal(result.lastKnownPosition,null);checked++;
  }
 }
 if(!checked)t.skip('local E01 control episodes unavailable');else t.diagnostic(`${checked} control observations remain masked; candidate bits/modifiers never authorize disclosure`);
});
