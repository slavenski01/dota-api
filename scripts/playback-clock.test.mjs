import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackClock } from '../apps/web/lib/playback-clock.ts';
test('all speeds follow monotonic elapsed time without accumulated scheduling drift',()=>{
 for(const speed of [.5,1,2,4]){
  const clock=new PlaybackClock();clock.reset(1000,-30,speed);
  for(const wall of [1000,1016.7,1035.1,1190,4999.999,60001])assert.ok(Math.abs(clock.at(wall,10000)-(-30+(wall-1000)*speed/1000))<1e-9);
  assert.equal(clock.at(10000000,1200),1200);
 }
});
test('buffering, pause and visibility resume rebase time without a background jump',()=>{
 const clock=new PlaybackClock();clock.reset(0,100,1);const pause=clock.at(1500,1000);assert.equal(pause,101.5);
 clock.reset(120000,pause,1);assert.equal(clock.at(120000,1000),pause);assert.equal(clock.at(121000,1000),102.5);
 clock.reset(121000,102.5,4);assert.equal(clock.at(121250,1000),103.5);
 clock.reset(121250,103.5,.5);assert.equal(clock.at(122250,1000),104);
});
