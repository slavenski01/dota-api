import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, saveDataset, transaction } from '@dota/persistence';
import { analysisHandler, readAnalysis, readEpisode, defaultVersions } from '@dota/jobs';
import { fixture, death, objective } from './fixtures/analysis.mjs';
test('analysis publishes atomically, repeats idempotently, preserves versions and resolves every evidence link', async () => {
  const pool = openDatabase(process.env.TEST_DATABASE_URL);
  try {
    await migrate(pool);
    const ctx = fixture([death('d1', 100), death('d2', 300), death('d3', 500), death('d4', 700), objective('tower', 330)]);
    await saveDataset(pool, { id: 'dataset', matchId: '1', parserRunId: null, normalizationVersion: 'fixture', inputSha256: 'a'.repeat(64), versions: {} }, ctx.records);
    await pool.query('INSERT INTO dota.dataset_checks(dataset_id,version,payload) VALUES ($1,$2,$3)', ['dataset', ctx.validation.version, ctx.validation]);
    const row = { dataset_id: 'dataset', match_id: '1', account_id: '1', analysis_options: null, versions: await defaultVersions() };
    const handler = analysisHandler(pool), signal = new AbortController().signal;
    const output = await handler({ row, signal, steps: {} });
    await assert.rejects(transaction(pool, async c => { await output.commit(c); throw Error('rollback'); }), /rollback/);
    assert.equal((await pool.query('SELECT * FROM dota.analysis_runs')).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM dota.episodes')).rowCount, 0);
    await Promise.all([transaction(pool, output.commit), transaction(pool, output.commit)]);
    const saved = await readAnalysis(pool, 'dataset', '1', output.analysisId);
    assert.equal(saved.episodes.length, 4); assert.equal(saved.primaryEpisodeIds.length, 3);
    assert.equal((await pool.query('SELECT * FROM dota.analysis_runs')).rowCount, 1);
    assert.equal((await pool.query('SELECT * FROM dota.episodes')).rowCount, 4);
    for (const selected of saved.episodes) {
      const detail = await readEpisode(pool, 'dataset', '1', selected.episode.id);
      assert.equal(detail.mode, 'retrospective'); assert.equal(detail.evidence.length, selected.episode.evidenceIds.length);
      assert.ok(detail.evidence.every(e => selected.episode.evidenceIds.includes(e.id)));
    }
    const again = await handler({ row, signal, steps: {} }); assert.equal(again.analysisId, output.analysisId);
    const changed = await handler({ row: { ...row, analysis_options: { keyItemId: '1', gamePlan: 'Иной план' } }, signal, steps: {} });
    assert.notEqual(changed.analysisId, output.analysisId); await transaction(pool, changed.commit);
    assert.equal((await readAnalysis(pool, 'dataset', '1', output.analysisId)).id, output.analysisId);
    await assert.rejects(readAnalysis(pool, 'dataset', '2'), /analysis_not_found/);
    await assert.rejects(readEpisode(pool, 'dataset', '2', saved.episodes[0].episode.id), /episode_not_found/);
    await assert.rejects(readEpisode(pool, 'other', '1', saved.episodes[0].episode.id), /episode_not_found/);
    await assert.rejects(readAnalysis(pool, '../dataset', '1'), /invalid_analysis_request/);
    await assert.rejects(pool.query('UPDATE dota.analysis_runs SET payload=payload'), /immutable_snapshot/);
    await assert.rejects(handler({ row, signal: AbortSignal.abort(), steps: {} }));
    assert.equal((await handler({ row: { ...row, account_id: '999' }, signal, steps: {} })).unavailable, 'analysis_player_unresolved');
    assert.equal((await handler({ row: { ...row, versions: { ...row.versions, rules: 'old' } }, signal, steps: {} })).unavailable, 'analysis_version_unsupported');
  } finally { await pool.end(); }
});
