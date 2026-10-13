import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, saveDataset, transaction } from '@dota/persistence';
import { saveEpisodeReview, readEpisodeReviews, readAnalysis, analysisHandler, defaultVersions } from '@dota/jobs';
import { validateDataset } from '@dota/analysis';
import { fixture, death } from './fixtures/analysis.mjs';
test('reviews preserve history, enforce optimistic concurrency and remain tied to exact episode version',async()=>{
  const pool=openDatabase(process.env.TEST_DATABASE_URL);
  try{
    await migrate(pool);
    async function seed(datasetId){
      const ctx=fixture([death('death',100)]);
      for(const r of ctx.records)if(r.kind==='coverage')r.datasetId=datasetId;
      ctx.validation=validateDataset(ctx.records,{datasetId,matchId:'1',artifactId:'replay',inputSha256:'a'.repeat(64),inputVerified:true,parserCompleted:true,parserVersion:'normalized-v1/clarity-5.0.1'});
      await saveDataset(pool,{id:datasetId,matchId:'1',parserRunId:null,normalizationVersion:'fixture',inputSha256:'a'.repeat(64),versions:{}},ctx.records);
      await pool.query('INSERT INTO dota.dataset_checks VALUES ($1,$2,$3)',[datasetId,ctx.validation.version,ctx.validation]);
      const output=await analysisHandler(pool)({row:{dataset_id:datasetId,account_id:'1',analysis_options:null,versions:await defaultVersions()},signal:new AbortController().signal});
      await transaction(pool,output.commit);return (await readAnalysis(pool,datasetId,'1',output.analysisId)).episodes[0].episode;
    }
    const episode=await seed('dataset');
    const input={expectedVersion:0,status:'confirmed_error',explanation:'Evidence reviewed',alternative:'Wait near ally; path and ally were verified',author:'Reviewer',material:'dota_client',perspective:{mode:'team',team:'radiant'}};
    const save=(value)=>saveEpisodeReview(pool,'dataset','1',episode.id,value);
    assert.equal((await readEpisodeReviews(pool,'dataset','1',episode.id)).current,null);
    for(const invalid of [{...input,status:['confirmed_error']},{...input,material:['timeline']},{...input,alternative:null},{...input,alternative:'  '},{...input,author:' '},{...input,explanation:' '},{...input,reviewedAt:'2030-01-01'},{...input,expectedVersion:-1},{...input,perspective:{mode:'team',team:'dire'}},{...input,material:'map'}])await assert.rejects(save(invalid));
    let saved=await save(input);assert.equal(saved.current.version,1);assert.equal(saved.reviews.length,1);assert.ok(saved.current.reviewedAt);
    assert.deepEqual(await save(input),saved);
    const a={...input,expectedVersion:1,status:'justified',explanation:'More evidence',alternative:null};
    const b={...a,status:'uncertain'};
    const competing=await Promise.allSettled([save(a),save(b)]);
    assert.equal(competing.filter(r=>r.status==='fulfilled').length,1);assert.match(competing.find(r=>r.status==='rejected').reason.message,/review_conflict/);
    const current=await readEpisodeReviews(pool,'dataset','1',episode.id);assert.deepEqual(current.reviews.map(r=>r.version),[2,1]);
    await assert.rejects(save({...input,expectedVersion:0,explanation:'stale'}),/review_conflict/);
    saved=await save({...input,expectedVersion:2,status:'unreviewed',explanation:'Withdrawn for another review',alternative:null,material:'timeline',perspective:{mode:'omniscient'}});
    assert.equal(saved.current.status,'unreviewed');assert.equal(saved.reviews.length,3);
    const original=(await pool.query("SELECT payload FROM dota.records WHERE kind='episode' AND id=$1",[episode.id])).rows[0].payload;
    assert.equal(original.review,null);
    await assert.rejects(pool.query('UPDATE dota.episode_reviews SET payload=payload'),/immutable_snapshot/);
    const newEpisode=await seed('dataset2');assert.notEqual(newEpisode.id,episode.id);assert.equal((await readEpisodeReviews(pool,'dataset2','1',newEpisode.id)).current,null);
    assert.equal((await readEpisodeReviews(pool,'dataset','1',episode.id)).reviews.length,3);
    await assert.rejects(saveEpisodeReview(pool,'dataset','2',episode.id,input),/episode_not_found/);
    await assert.rejects(saveEpisodeReview(pool,'dataset2','1',episode.id,input),/episode_not_found/);
  }finally{await pool.end();}
});
