// Replay evidence stays in ignored data/. Run after building the parser/contracts.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { readMessages } from '@dota/contracts';
const manifestPath=resolve('data/replay-validation/2026-10-12-e01-t02/manifest.json');
const manifest=JSON.parse(await readFile(manifestPath));
const directory=resolve('data/e14-validation');await mkdir(directory,{recursive:true});
const summary=[];const baseline=new Map();
for(const [index,entry] of manifest.records.entries())for(const step of (index===0?[100,250,500,1000]:[250])){
 const label=`R${index+1}`,request={protocolVersion:'1.0.0',schemaVersion:'0.1.0',type:'parse',requestId:'motion-check',replayPath:resolve(dirname(manifestPath),entry.replayFile),expectedMatchId:String(entry.matchId)};
 const started=performance.now(),stdout=[],stderr=[];
 const child=spawn('/usr/bin/time',['-l',resolve('services/replay-parser/build/install/replay-parser/bin/replay-parser'),step===250?'--normalized':`--normalized-${step}ms`],{env:{...process.env,JAVA_OPTS:'-Xmx1g'},stdio:['pipe','pipe','pipe']});
 child.stdin.end(JSON.stringify(request)+'\n');child.stdout.on('data',b=>stdout.push(b));child.stderr.on('data',b=>stderr.push(b));
 const [code]=await once(child,'exit');assert.equal(code,0,Buffer.concat(stderr).toString());
 const body=Buffer.concat(stdout),rows=[];
 for await(const message of readMessages((async function*(){yield body;})()))if(message.type==='record')rows.push(message.record);
 const tracks=rows.filter(r=>r.kind==='hero_motion'),states=rows.filter(r=>r.kind==='hero_state');
 assert.equal(new Set(tracks.map(t=>t.playerSlot)).size,10);
 let compared=0;const stateIndex=new Map(states.map(s=>[`${s.playerSlot}:${s.tick}`,s]));
 const points=new Map();
 for(const track of tracks)for(const sample of track.samples){
  const state=stateIndex.get(`${track.playerSlot}:${sample.tick}`);
  if(state?.position.status==='known'){assert.equal(sample.x,state.position.value.x);assert.equal(sample.y,state.position.value.y);assert.equal(sample.time,state.gameTimeSeconds);compared++;}
  const group=points.get(track.playerSlot)??[];group.push(sample);points.set(track.playerSlot,group);
 }
 const gaps=[],errors=[];let breaks=0;
 for(const [slot,group] of points){
  group.sort((a,b)=>a.time-b.time);
  for(let i=1;i<group.length;i++){assert.ok(group[i].time>group[i-1].time);gaps.push(group[i].time-group[i-1].time);if(group[i].breakBefore)breaks++;}
  if(step===100)baseline.set(slot,group);
  else if(index===0){let i=0;for(const p of baseline.get(slot)??[]){while(i+1<group.length&&group[i+1].time<p.time)i++;const a=group[i],b=group[i+1];if(!a||!b||b.breakBefore||!a.alive||!b.alive||p.x===null||a.x===null||b.x===null||p.time<a.time||b.time-a.time>step/1000+0.04)continue;const f=(p.time-a.time)/(b.time-a.time);errors.push(Math.hypot(a.x+(b.x-a.x)*f-p.x,a.y+(b.y-a.y)*f-p.y));}}
 }
 gaps.sort((a,b)=>a-b);errors.sort((a,b)=>a-b);assert.ok(compared>0);assert.ok(gaps.length>1000);
 const motion=Buffer.from(JSON.stringify(tracks));
 const result={sample:label,stepMs:step,seconds:(performance.now()-started)/1000,peakRssBytes:Number(Buffer.concat(stderr).toString().match(/(\d+)\s+maximum resident set size/)?.[1]??0),stdoutBytes:body.length,motionBytes:motion.length,gzipBytes:gzipSync(motion).length,samples:[...points.values()].reduce((a,b)=>a+b.length,0),gapP50:gaps[Math.floor(gaps.length*.5)],gapP99:gaps[Math.floor(gaps.length*.99)],boundaries:breaks,matchingStateObservations:compared,errorVs100msP95:errors.length?errors[Math.floor(errors.length*.95)]:null};
 summary.push(result);console.log(JSON.stringify(result));
 if(step===250)await writeFile(resolve(directory,label+'.ndjson'),body);
 await writeFile(resolve(directory,'motion-summary.json'),JSON.stringify(summary,null,2)+'\n');
}
