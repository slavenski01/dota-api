import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateDataset,windowUsability} from '@dota/analysis';
const slots=[0,1,2,3,4,128,129,130,131,132];
const provenance={source:'replay',acquiredAt:'2026-10-13T00:00:00.000Z',artifactId:'replay',sourceVersion:'normalized-v1/clarity-5.0.1/protobuf-7.1',inputIds:[]};
const base=(kind,id)=>({schemaVersion:'0.1.0',kind,id,matchId:'1',provenance});
const evidence={datasetId:'dataset',matchId:'1',artifactId:'replay',inputSha256:'a'.repeat(64),inputVerified:true,parserCompleted:true,parserVersion:'normalized-v1/clarity-5.0.1'};
function fixture(){
 const match={...base('match','match'),startedAt:null,durationSeconds:20,mode:null,patch:null,radiantWin:true};
 const players=slots.map(slot=>({...base('participant',`player-${slot}`),playerSlot:slot,team:slot<128?'radiant':'dire',accountId:null,steamId64:null,heroId:null,aspectId:null,role:null,statistics:{kills:0,deaths:slot===0?1:0,assists:0,lastHits:0,denies:0,gpm:0,xpm:0,heroDamage:0,towerDamage:0}}));
 const event={...base('event','death'),gameTimeSeconds:10,tick:null,coverageIds:['deaths-0'],data:{type:'death',victimSlot:0,killerSlot:null,afterBuyback:null}};
 const coverage=(field,ss,status,ids,window={startSeconds:-10,endSeconds:20})=>({...base('coverage',`${field}-${ss[0]}`),datasetId:'dataset',field,participantSlots:ss,window,status,evidenceIds:ids,reason:null,resolutionSeconds:null});
 return [match,...players,event,...slots.map(slot=>coverage('deaths',[slot],slot===0?'present':'empty',[`player-${slot}`,...(slot===0?['death']:[])])),coverage('time',slots,'present',['match']),coverage('statistics',slots,'present',players.map(p=>p.id),{startSeconds:20,endSeconds:20})];
}
const usable=(report,field='deaths',slot=0,from=0,to=15)=>windowUsability(report,field,[slot],{startSeconds:from,endSeconds:to});
test('verified deaths and evidenced empty slots support bounded windows; final stats are point observations',()=>{
 const report=validateDataset(fixture(),evidence);assert.deepEqual(report.issues,[]);assert.equal(usable(report).usable,true);assert.equal(usable(report,'deaths',1).usable,true);
 assert.equal(usable(report,'statistics',0,20,20).usable,true);assert.equal(usable(report,'statistics',0,0,20).usable,false);
 assert.equal(usable(report,'deaths',0,-11,20).usable,false);assert.equal(usable(report,'deaths',0,0,21).usable,false);
 for(const field of ['items','objectives','resources','positions','visibility','fights'])assert.equal(usable(report,field).usable,false);
});
test('transport and input proof are required even when all final counters match',()=>{
 for(const patch of [{parserCompleted:false},{inputVerified:false},{parserVersion:'other'}])assert.equal(usable(validateDataset(fixture(),{...evidence,...patch})).usable,false);
});
test('missing log entry, unresolved evidence and source conflicts cannot become confirmed empty',()=>{
 const without=fixture().filter(r=>r.id!=='death');let report=validateDataset(without,evidence);assert.equal(usable(report).usable,false);assert.ok(report.issues.some(i=>i.code==='evidence_not_found'));
 const conflict=fixture();conflict[1]={...conflict[1],provenance:{...provenance,source:'opendota'}};report=validateDataset(conflict,evidence);assert.equal(report.complete,false);assert.equal(usable(report).usable,false);
 const empty=fixture();empty.find(r=>r.id==='deaths-0').status='empty';assert.equal(usable(validateDataset(empty,evidence)).usable,false);
});
test('scope mismatches, wrong participant counters, duplicate deaths and false statistics block dependent rules',()=>{
 for(const mutate of [
  r=>{r.find(r=>r.id==='deaths-0').window.startSeconds=11;},
  r=>{r.find(r=>r.id==='player-0').statistics.deaths=2;},
  r=>{r.push({...structuredClone(r.find(r=>r.id==='death')),id:'second-death'});},
  r=>{r.find(r=>r.id==='death').coverageIds=['deaths-1'];},
 ]){const rows=fixture();mutate(rows);assert.equal(usable(validateDataset(rows,evidence)).usable,false);}
 const rows=fixture();rows.find(r=>r.id==='player-0').statistics.gpm=null;assert.equal(usable(validateDataset(rows,evidence),'statistics',0,20,20).usable,false);
});
test('overlapping unknown coverage vetoes a positive claim and invalid queries reject',()=>{
 const rows=fixture();rows.push({...structuredClone(rows.find(r=>r.id==='deaths-0')),id:'conflict',status:'unknown',reason:'source disagreement'});
 const report=validateDataset(rows,evidence);assert.equal(usable(report).usable,false);
 assert.throws(()=>usable(report,'deaths',0,10,0),/invalid_coverage_query/);
});
