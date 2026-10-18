import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSmooth,visualPositions } from '../apps/web/lib/visual-motion.ts';
const a={time:10,tick:300,x:0,y:0,alive:true,breakBefore:null},b={...a,time:10.25,tick:308,x:100};
const window=(samples,mode='retrospective')=>({motionAvailable:true,frame:{mode},motion:[{playerSlot:0,provenance:{sourceVersion:'normalized-v2/clarity-5.0.1/protobuf-7.1'},samples}]});
test('only ordinary adjacent motion is smoothed; source observations remain unchanged',()=>{
 const input=window([a,b]),copy=structuredClone(input);assert.ok(canSmooth(a,b));
 const mid=visualPositions(input,10.125)[0];assert.equal(mid.interpolated,true);assert.equal(mid.observedTime,10);
 assert.equal(mid.mapPosition.x,(8192+50)/16256*100);assert.deepEqual(input,copy);
 assert.equal(visualPositions(input,10)[0].interpolated,false);
 assert.equal(visualPositions(input,10.5)[0].interpolated,false); // last observation, not extrapolation
 assert.deepEqual(visualPositions(input,11),[]);
 assert.deepEqual(visualPositions(input,0),[]);
 assert.deepEqual(visualPositions(window([a,b],'decision'),10.125),[]);
 assert.equal(visualPositions({...input,motionAvailable:false},10),undefined);
});
test('teleport, death, respawn, unknown, gaps and large jumps never create a path',()=>{
 for(const change of [{breakBefore:'jump'},{breakBefore:'life'},{breakBefore:'gap'},{breakBefore:'unknown'},{alive:false},{x:null,y:null},{time:11},{x:2000}]){
  const end={...b,...change};assert.equal(canSmooth(a,end),false);assert.equal(visualPositions(window([a,end]),10.125)[0].interpolated,false);
 }
 assert.equal(canSmooth({...a,alive:false},b),false);assert.equal(canSmooth({...a,alive:null},b),false);
 assert.deepEqual(visualPositions(window([{...a,x:null,y:null}]),10),[]);
 assert.deepEqual(visualPositions(window([a,{...a}]),10),[]);
 const future=visualPositions(window([a,b]),10.25)[0];assert.equal(future.observedTime,10.25);assert.equal(future.interpolated,false);
});
