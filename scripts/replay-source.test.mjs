import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { openDatabase, migrate, LocalStorage, resolveReplay, replayUrl, replayRequest, registerArtifact, transaction, REPLAY_MEDIA_TYPE } from '@dota/persistence';
const pool = openDatabase(process.env.TEST_DATABASE_URL);
const root = await mkdtemp(join(tmpdir(), 'replay-source-')); const storage = new LocalStorage(root);
before(() => migrate(pool)); after(async () => { await pool.end(); await rm(root, { recursive:true, force:true }); });
const url = id => `http://replay123.valve.net/570/${id}_123.dem.bz2`;
const provider = (id, status=200, replay_url=url(id)) => async (_url, init) => init?.method === 'HEAD' ? new Response(null,{status}) : Response.json({match_id:Number(id),replay_url,players:[{account_id:123}]});
test('allowlist checks host, port, identity, credentials and query', () => {
  assert.equal(replayUrl(url('1'),'1'),url('1'));
  for(const value of ['http://localhost/570/1_1.dem','https://replay1.valve.net.evil/570/1_1.dem',url('2'),url('1')+'?key=secret',url('1').replace('http://','http://user@'),url('1').replace('.net/','.net:123/')]) assert.throws(()=>replayUrl(value,'1'),/invalid_replay_source/);
});
test('candidate is not an artifact; cache and forced refresh retain server-only provenance', async()=>{
  const first=await resolveReplay(pool,storage,'101',{fetcher:provider('101'),accountId:'123'});
  assert.equal(first.status,'candidate');
  assert.equal((await resolveReplay(pool,storage,'101',{fetcher:()=>{throw Error('must not fetch');}})).status,'candidate');
  assert.equal((await resolveReplay(pool,storage,'101',{force:true,fetcher:provider('101',200,null)})).status,'missing');
  assert.equal((await pool.query("SELECT count(*) FROM dota.artifacts WHERE match_id='101'")).rows[0].count,'0');
});
test('missing link, confirmed absence and temporary error differ',async()=>{
  assert.equal((await resolveReplay(pool,storage,'102',{fetcher:provider('102',200,null)})).status,'missing');
  assert.equal((await resolveReplay(pool,storage,'103',{fetcher:provider('103',404)})).status,'unavailable');
  await assert.rejects(resolveReplay(pool,storage,'104',{fetcher:provider('104',503)}),/replay_temporarily_unavailable/);
  await assert.rejects(resolveReplay(pool,storage,'105',{fetcher:provider('999')}),/replay_match_mismatch/);
  await assert.rejects(resolveReplay(pool,storage,'106',{fetcher:provider('106'),accountId:'456'}),/replay_participant_mismatch/);
});
test('redirect target checked before sending request; cancellation propagates',async()=>{
  let calls=0;
  await assert.rejects(replayRequest(url('1'),'1','GET',new AbortController().signal,async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}});}),/invalid_replay_source/);
  assert.equal(calls,1);
  await assert.rejects(resolveReplay(pool,storage,'1',{signal:AbortSignal.abort()}),/abort/i);
});
test('only verified replay artifacts can bypass the network; corruption triggers resolution',async()=>{
  await pool.query("INSERT INTO dota.matches(match_id) VALUES ('107')");
  const file=await storage.put(Readable.from(['fixture']));
  await transaction(pool,client=>registerArtifact(client,{id:'replay107',matchId:'107',file,mediaType:REPLAY_MEDIA_TYPE,source:{validation:'replay-v1',accountIds:['123']}}));
  assert.equal((await resolveReplay(pool,storage,'107',{accountId:'123',fetcher:()=>{throw Error('must not fetch');}})).status,'stored');
  await rm(join(root,file.key));
  assert.equal((await resolveReplay(pool,storage,'107',{fetcher:provider('107')})).status,'candidate');
});
