// Private local evidence: compare production snapshots with previous raw research observations.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readMessages} from '@dota/contracts';
const manifestPath=resolve('data/replay-validation/2026-10-12-e01-t02/manifest.json');
const manifest=JSON.parse(readFileSync(manifestPath));
const out=resolve('data/e05-validation/states');mkdirSync(out,{recursive:true});
const results=[];
for(const [i,sample] of manifest.records.entries()){
 const label=`R${i+1}`,request={protocolVersion:'1.0.0',schemaVersion:'0.1.0',type:'parse',requestId:'state-check',replayPath:resolve(dirname(manifestPath),sample.replayFile),expectedMatchId:String(sample.matchId)};
 const started=performance.now();
 const run=spawnSync(resolve('services/replay-parser/build/install/replay-parser/bin/replay-parser'),['--normalized'],{input:JSON.stringify(request)+'\n',maxBuffer:128*1024**2,env:{...process.env,JAVA_OPTS:'-Xmx1g'},timeout:120000});
 assert.equal(run.status,0,run.stderr.toString());writeFileSync(resolve(out,label+'.ndjson'),run.stdout);
 const rows=[];for await(const m of readMessages((async function*(){yield run.stdout;})()))if(m.type==='record')rows.push(m.record);
 const states=rows.filter(r=>r.kind==='hero_state');assert.ok(states.length>100);assert.ok(states.some(r=>r.gameTimeSeconds<0));
 const raw=JSON.parse(readFileSync(`data/context-validation/2026-10-12-e01-t04/run/${label}-first.json`));
 const index=new Map(raw.samples.map(r=>[`${r.playerSlot}:${r.tick}`,r]));let compared=0;
 for(const state of states){
  const r=index.get(`${state.playerSlot}:${state.tick}`);if(!r)continue;
  for(const field of ['hp','mana','alive'])if(state[field].status==='known'){assert.equal(state[field].value,r[field]);compared++;}
  assert.equal(state.position.status,'unknown');
  if(state.inventory.status==='known')assert.equal(state.inventory.value.length,r.inventory.entries.length);
 }
 assert.ok(compared>0,'No matching control ticks');
 let deathChecks=0;
 for(const death of rows.filter(r=>r.kind==='event'&&r.data.type==='death')){
  const observation=states.find(s=>s.playerSlot===death.data.victimSlot&&s.gameTimeSeconds>=death.gameTimeSeconds&&s.gameTimeSeconds-death.gameTimeSeconds<=1.1);
  assert.ok(observation,'Missing post-death observation in control replay');
  assert.equal(observation.alive.status,'known');assert.equal(observation.alive.value,false);deathChecks++;
 }
 assert.equal(new Set(states.map(r=>`${r.playerSlot}:${r.gameTimeSeconds}`)).size,states.length);
 const result={sample:label,states:states.length,controlValuesCompared:compared,deathChecks,bytes:run.stdout.length,seconds:(performance.now()-started)/1000};results.push(result);console.log(result);
 writeFileSync(resolve(out,'summary.json'),JSON.stringify(results,null,2)+'\n');
}
