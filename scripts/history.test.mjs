import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase,migrate,selectProfile,parseHistory,transaction,saveHistoryPage } from '@dota/persistence';
import { startQueue,consume,requestHistory,executeHistory,getHistoryStatus,QUEUE } from '@dota/jobs';
const pool=openDatabase(process.env.TEST_DATABASE_URL);let boss;let stop;let fetcher;let calls=0;
const row=(n,extra={})=>({match_id:String(n),start_time:1700000000+n,player_slot:0,hero_id:1,radiant_win:true,duration:2000,kills:2,deaths:3,assists:4,...extra});
async function wait(id) {for(let n=0;n<100;n++){const r=await boss.getJobById(QUEUE,id);if(r?.state==='completed')return;await delay(100);}throw Error('timeout');}
before(async()=>{await migrate(pool);boss=await startQueue(process.env.TEST_DATABASE_URL,{retryDelay:1});await selectProfile(pool,'123','account',async()=>Response.json({}));stop=await consume(boss,pool,c=>executeHistory(pool,boss,c,async(...args)=>{calls++;return fetcher(...args);}));});
after(async()=>{await stop?.();await boss?.stop();await pool.end();});
test('parser rejects unsafe IDs and preserves nullable statistics and side-based result',()=>{
 assert.throws(()=>parseHistory([row(1,{match_id:9007199254740992})]));
 assert.throws(()=>parseHistory({error:'bad'}));
 assert.throws(()=>parseHistory([row(1,{radiant_win:'false'})]));
 const parsed=parseHistory([row(1,{match_id:'9007199254740993',player_slot:128,kills:null})])[0];
 assert.equal(parsed.matchId,'9007199254740993');assert.equal(parsed.won,false);assert.equal(parsed.kills,null);
});
test('queue submission deduplicates; pages append, overlapping rows deduplicate, refresh is cached',async()=>{
 fetcher=async url=>{assert.match(url,/limit=50&offset=0&significant=0&sort=start_time/);return Response.json(Array.from({length:50},(_,n)=>row(n+1)));};
 const [a,b]=await Promise.all([requestHistory(pool,boss,'123','refresh'),requestHistory(pool,boss,'123','refresh')]);assert.equal(a.id,b.id);await wait(a.id);
 assert.equal(calls,1);assert.equal((await requestHistory(pool,boss,'123','refresh')).cached,true);
 fetcher=async url=>{assert.match(url,/offset=50/);return Response.json([row(50),row(51)]);};
 const next=await requestHistory(pool,boss,'123','older');await wait(next.id);
 assert.equal((await pool.query('SELECT count(*) FROM dota.player_matches')).rows[0].count,'51');
 const state=await getHistoryStatus(pool,boss,'123');assert.equal(state.sourceExhausted,true);assert.equal(state.pages.length,2);assert.equal(state.latest.status,'ready');
 assert.equal((await requestHistory(pool,boss,'123','older')).cached,true);
});
test('refresh adds new matches; empty successful response differs from failure and keeps stored data',async()=>{
 await pool.query("UPDATE dota.history_pages SET fetched_at=now()-interval '2 minutes'");
 fetcher=async()=>Response.json([row(52)]);await wait((await requestHistory(pool,boss,'123','refresh')).id);
 assert.equal((await pool.query('SELECT count(*) FROM dota.player_matches')).rows[0].count,'52');
 await pool.query("UPDATE dota.history_pages SET fetched_at=now()-interval '2 minutes'");
 fetcher=async()=>Response.json([]);await wait((await requestHistory(pool,boss,'123','refresh')).id);
 assert.equal((await getHistoryStatus(pool,boss,'123')).latest.status,'ready');
 await pool.query("UPDATE dota.history_pages SET fetched_at=now()-interval '2 minutes'");
 fetcher=async()=>new Response('broken');await wait((await requestHistory(pool,boss,'123','refresh')).id);
 const state=await getHistoryStatus(pool,boss,'123');assert.equal(state.latest.status,'failed');assert.equal(state.latest.error,'invalid_provider_response');
 assert.equal((await pool.query('SELECT count(*) FROM dota.player_matches')).rows[0].count,'52');
});
test('429 enforces persisted retry-after without overwriting pages',async()=>{
 fetcher=async()=>new Response('',{status:429,headers:{'Retry-After':'120'}});
 await wait((await requestHistory(pool,boss,'123','refresh')).id);
 const state=await getHistoryStatus(pool,boss,'123');assert.equal(state.latest.error,'provider_rate_limited');assert.ok(state.latest.retry_at);
 await assert.rejects(requestHistory(pool,boss,'123','refresh'),e=>e.code==='provider_rate_limited'&&e.retryAfter>100);
 await pool.query('DELETE FROM dota.provider_cooldowns');
});
test('identity conflict rolls back the complete page',async()=>{
 await pool.query("INSERT INTO dota.profiles(account_id) VALUES ('124')");
 const count=(await pool.query('SELECT count(*) FROM dota.matches')).rows[0].count;
 await assert.rejects(transaction(pool,c=>saveHistoryPage(c,'124',0,parseHistory([row(900),row(1)]))),/participant_account_conflict/);
 assert.equal((await pool.query('SELECT count(*) FROM dota.matches')).rows[0].count,count);
 assert.equal((await pool.query("SELECT count(*) FROM dota.player_matches WHERE account_id='124'")).rows[0].count,'0');
});
test('expired queue job is surfaced and a manual retry can replace it',async()=>{
 await stop();stop=null;
 const a=await requestHistory(pool,boss,'123','refresh');await boss.cancel(QUEUE,a.id);
 assert.equal((await getHistoryStatus(pool,boss,'123')).latest.status,'failed');
 const b=await requestHistory(pool,boss,'123','refresh');assert.notEqual(a.id,b.id);
 fetcher=async()=>Response.json([]);stop=await consume(boss,pool,c=>executeHistory(pool,boss,c,fetcher));await wait(b.id);
});
