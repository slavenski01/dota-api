import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { openDatabase,migrate,selectProfile,transaction,saveHistoryPage,parseHistory } from '@dota/persistence';
import { startQueue,consume,executeHistory } from '@dota/jobs';
test('production profile/history/list HTTP flow, validation, cache headers and read-only list',async()=>{
 const pool=openDatabase(process.env.TEST_DATABASE_URL);let web,boss,stop;
 try {
  await migrate(pool);
  await selectProfile(pool,'123','account',async()=>Response.json({profile:{account_id:123,personaname:'Тестовый игрок'},fh_unavailable:true}));
  const rows=Array.from({length:30},(_,n)=>({match_id:String(1000+n),start_time:1767225600+n*7200,hero_id:n%2?2:1,player_slot:n%2?128:0,radiant_win:true,duration:1800+n,kills:n,deaths:4,assists:10}));
  await transaction(pool,c=>saveHistoryPage(c,'123',0,parseHistory(rows)));
  boss=await startQueue(process.env.TEST_DATABASE_URL);stop=await consume(boss,pool,c=>executeHistory(pool,boss,c,async()=>Response.json(rows)));
  const socket=createServer().listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
  web=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:resolve('apps/web'),env:{...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  web.stdout.on('data',()=>{});web.stderr.on('data',()=>{});
  const base=`http://127.0.0.1:${port}`;
  for(let n=0;n<100;n++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await delay(100);}
  const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/profile')).status,200);
  const profile=await fetch(base+'/api/profile');assert.match(profile.headers.get('cache-control'),/no-store/);assert.equal((await profile.json()).profile.accountId,'123');
  const invalid=await post('/api/profile',{id:'123',kind:'steam'},{Origin:base});
  assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,'invalid_steam_type');
  assert.equal((await post('/api/profile',null)).status,400);
  assert.equal((await post('/api/profile',{id:'123',kind:'account'},{Origin:'https://example.com'})).status,403);
  assert.equal((await post('/api/history',{accountId:'123',mode:'invalid'})).status,400);
  assert.equal((await fetch(base+'/api/matches?accountId=123&from=2024-02-30')).status,400);
  const first=await fetch(base+'/api/matches?accountId=123');assert.match(first.headers.get('cache-control'),/no-store/);const page=await first.json();assert.equal(page.items.length,25);
  const second=await(await fetch(base+'/api/matches?accountId=123&cursor='+page.nextCursor)).json();assert.equal(second.items.length,5);assert.equal(new Set([...page.items,...second.items].map(r=>r.matchId)).size,30);
  assert.equal((await pool.query('SELECT count(*) FROM dota.workflow_jobs')).rows[0].count,'0');
  assert.equal((await post('/api/history',{accountId:'123',mode:'refresh'},{Origin:base})).status,200);
  await pool.query("UPDATE dota.history_pages SET fetched_at=now()-interval '2 minutes'");
  const queued=await post('/api/history',{accountId:'123',mode:'refresh'},{Origin:base});assert.equal(queued.status,202);
  let state;
  for(let n=0;n<100;n++){state=await(await fetch(base+'/api/history?accountId=123')).json();if(state.latest?.status==='ready')break;await delay(100);}
  assert.equal(state.latest.status,'ready');
  if(process.env.E03_PREVIEW_GATE){
   console.log(`E03 browser preview: ${base}/profile`);
   const deadline=Date.now()+600000;
   while(Date.now()<deadline){try{await access(process.env.E03_PREVIEW_GATE);break;}catch{}await delay(500);}
  }
 }finally{if(web){const ended=once(web,'exit');web.kill('SIGTERM');await ended;}await stop?.();await boss?.stop();await pool.end();}
});
