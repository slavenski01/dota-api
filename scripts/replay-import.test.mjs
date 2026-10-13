import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { openDatabase, migrate, LocalStorage, registerArtifact, transaction, REPLAY_MEDIA_TYPE } from '@dota/persistence';
import { importReplay, downloadReplay, validateReplay } from '@dota/jobs';
const pool = openDatabase(process.env.TEST_DATABASE_URL);
const root = await mkdtemp(join(tmpdir(),'replay-import-test-')); const storage = new LocalStorage(root);
before(()=>migrate(pool));after(async()=>{await pool.end();await rm(root,{recursive:true,force:true});});
const dem=Buffer.concat([Buffer.from('PBDEMS2\0'),Buffer.alloc(1024,1)]);
const opts={matchId:'201',accountId:'123',signal:new AbortController().signal,validate:async()=>['123']};
const url='http://replay123.valve.net/570/201_123.dem.bz2';
test('raw, zstd and bzip2 share validation, hash and atomic storage',async()=>{
  const bzip=spawnSync('bzip2',['-c'],{input:dem});assert.equal(bzip.status,0);
  let expected;
  for(const [compression,bytes]of [['none',dem],['zstd',zstdCompressSync(dem)],['bzip2',bzip.stdout]]){
    const progress=[];let checks=0;
    const result=await importReplay(storage,Readable.from([bytes]),{...opts,totalBytes:bytes.length,validate:async(path)=>{checks++;assert.deepEqual(await readFile(path),dem);return ['123'];},progress:async value=>progress.push(value)});
    assert.equal(checks,1);assert.equal(result.source.compression,compression);
    expected??=result.file.sha256;assert.equal(result.file.sha256,expected);await storage.verify(result.file);
    assert.equal(progress[0].totalBytes,bytes.length);assert.equal(progress.at(-1).phase,'stored');
  }
  assert.deepEqual(await readdir(join(root,'.tmp')),[]);
});
test('HTML, invalid decompressed header, truncated input and limits never publish',async()=>{
  for(const [bytes,patch,code]of [
    [Buffer.from('<html>error</html>'),{},'invalid_replay_format'],
    [zstdCompressSync(Buffer.from('not a replay at all')),{},'invalid_replay_format'],
    [dem,{totalBytes:dem.length+1},'replay_truncated'],
    [zstdCompressSync(dem).subarray(0,-3),{},'invalid_replay_format|replay_transfer_failed'],
    [spawnSync('bzip2',['-c'],{input:dem}).stdout,{limits:{downloadBytes:10000,decodedBytes:20,transferMs:1000}},'replay_size_limit'],
    [dem,{limits:{downloadBytes:10,decodedBytes:10000,transferMs:1000}},'replay_size_limit'],
    [zstdCompressSync(dem),{limits:{downloadBytes:10000,decodedBytes:20,transferMs:1000}},'replay_size_limit'],
    [dem,{validate:async()=>{throw new Error('invalid');}},'replay_transfer_failed'],
  ]){
    let puts=0;await assert.rejects(importReplay({put:async()=>{puts++;throw Error();}},Readable.from([bytes]),{...opts,...patch}),new RegExp(code));assert.equal(puts,0);
  }
  await assert.rejects(importReplay(storage,Readable.from([dem]),{...opts,signal:AbortSignal.abort()}),/abort/i);
});
test('stale GET URL is resolved again, known length checked and saved replay reused',async()=>{
  let metadata=0,gets=0;
  const fetcher=async(input,init)=>{
    if(init?.method==='HEAD')return new Response(null,{status:200});
    if(String(input).includes('api.opendota')){metadata++;return Response.json({match_id:201,replay_url:url,players:[{account_id:123}]});}
    gets++;return gets===1?new Response(null,{status:404}):new Response(zstdCompressSync(dem));
  };
  const result=await downloadReplay(pool,storage,{...opts,fetcher});assert.equal(metadata,2);assert.equal(gets,2);
  await transaction(pool,client=>registerArtifact(client,{id:result.artifactId,matchId:'201',file:result.file,source:result.source,mediaType:REPLAY_MEDIA_TYPE}));
  const again=await downloadReplay(pool,storage,{...opts,fetcher:()=>{throw Error('must not fetch');}});
  assert.equal(again.artifactId,result.artifactId);
});
test('actual Clarity accepts local E01 sample and rejects mismatched identity',async(t)=>{
  const manifestPath=resolve('data/replay-validation/2026-10-12-e01-t02/manifest.json');
  let manifest;
  try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code==='ENOENT'){t.skip('local E01 evidence not available');return;}throw error;}
  const sample=manifest.records[0],path=resolve(dirname(manifestPath),sample.replayFile);
  const accountId=String(manifest.accountId),matchId=String(sample.matchId);
  const result=await importReplay(storage,createReadStream(path),{matchId,accountId,signal:opts.signal});
  assert.equal(result.file.sha256,sample.sha256Replay);assert.ok(result.source.accountIds.includes(accountId));
  await assert.rejects(validateReplay(path,matchId==='1'?'2':'1',accountId,sample.sha256Replay,opts.signal),/invalid_replay/);
  await assert.rejects(validateReplay(path,matchId,'4294967294',sample.sha256Replay,opts.signal),/replay_participant_mismatch/);
});
