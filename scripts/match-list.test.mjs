import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase,migrate,transaction,saveHistoryPage,parseHistory,parseMatchFilters,listMatches } from '@dota/persistence';
const pool=openDatabase(process.env.TEST_DATABASE_URL);
const filters=query=>parseMatchFilters(new URLSearchParams('accountId=123&'+query));
before(async()=>{
 await migrate(pool);await pool.query("INSERT INTO dota.profiles(account_id) VALUES ('123'),('124')");
 const rows=['9','10','11','9007199254740993','12'].map((id,n)=>({match_id:id,start_time:n<4?1704067200:1704153600,player_slot:n===2?null:n%2?128:0,hero_id:n===3?2:1,radiant_win:true,kills:n===2?null:n,duration:1000}));
 await transaction(pool,c=>saveHistoryPage(c,'123',0,parseHistory(rows)));
 await transaction(pool,c=>saveHistoryPage(c,'124',0,parseHistory([{...rows[0],match_id:'99'}])));
});
after(()=>pool.end());
test('keyset pages with tied timestamps and exact IDs cover the unchanged selection once',async()=>{
 let cursor=null;const ids=[];
 do {const result=await listMatches(pool,filters('limit=2'+(cursor?'&cursor='+cursor:'')));ids.push(...result.items.map(r=>r.matchId));cursor=result.nextCursor;}while(cursor);
 assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);assert.equal(ids[0],'12');assert.ok(ids.includes('9007199254740993'));assert.ok(!ids.includes('99'));
});
test('inclusive UTC date range, hero and result filters agree with nulls and player side',async()=>{
 assert.equal((await listMatches(pool,filters('from=2024-01-01&to=2024-01-01'))).items.length,4);
 assert.equal((await listMatches(pool,filters('from=2024-01-02'))).items.length,1);
 assert.equal((await listMatches(pool,filters('heroId=2&result=loss'))).items[0].matchId,'9007199254740993');
 const unknown=(await listMatches(pool,filters('result=unknown'))).items;assert.equal(unknown.length,1);assert.equal(unknown[0].kills,null);
 assert.equal((await listMatches(pool,filters('heroId=3'))).items.length,0);
});
test('invalid dates, filters, pagination limits and cross-filter cursors are rejected',async()=>{
 for(const q of ['from=2024-02-30','from=2025-01-01&to=2024-01-01','limit=0','limit=101','heroId=-1','result=yes','limit=2&limit=3','unexpected=true']) assert.throws(()=>filters(q));
 const {nextCursor}=await listMatches(pool,filters('limit=1'));
 await assert.rejects(listMatches(pool,filters('heroId=2&cursor='+nextCursor)),/invalid_match_cursor/);
 await assert.rejects(listMatches(pool,filters('cursor=garbage')),/invalid_match_cursor/);
 const other=filters('cursor='+nextCursor);other.accountId='124';await assert.rejects(listMatches(pool,other),/invalid_match_cursor/);
});
test('list reads are side effect free and never promise remote replay availability',async()=>{
 const before=(await pool.query('SELECT count(*) FROM dota.history_requests')).rows[0].count;
 const result=await listMatches(pool,filters(''));
 assert.ok(result.items.every(r=>r.replayAvailability==='unchecked'&&r.processing==='not_requested'&&r.dataLevel==='summary'));
 assert.equal((await pool.query('SELECT count(*) FROM dota.history_requests')).rows[0].count,before);
 assert.equal((await pool.query('SELECT count(*) FROM dota.workflow_jobs')).rows[0].count,'0');
});
test('stored artifact and processing/report state are separate from remote availability',async()=>{
 await pool.query("INSERT INTO dota.artifacts(id,match_id,storage_key,sha256,size_bytes,media_type,source) VALUES ('file','12',$1,$2,0,'application/gzip','{}')",['aa/'+'a'.repeat(64),'a'.repeat(64)]);
 const row=(await listMatches(pool,filters('from=2024-01-02'))).items[0];assert.equal(row.storedArtifact,true);assert.equal(row.replayAvailability,'unchecked');assert.equal(row.reportStatus,'not_requested');
});
