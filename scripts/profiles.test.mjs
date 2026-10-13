import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, migrate, normalizePlayerId, parseProfile, selectProfile, selectedProfile, openDota } from '@dota/persistence';
const pool = openDatabase(process.env.TEST_DATABASE_URL);
before(() => migrate(pool)); after(() => pool.end());
const response = value => async () => Response.json(value);
test('explicit ID types, precision, sentinel and nonindividual Steam IDs', () => {
  const ids = normalizePlayerId('123', 'account');
  assert.equal(ids.steamId64, '76561197960265851');
  assert.deepEqual(normalizePlayerId(ids.steamId64, 'steam'), ids);
  for (const [id, kind] of [['0','account'], ['4294967295','account'], ['4294967296','account'], [123,'account'], ['123','steam'], ['103582791429521408','steam'], ['76561197960265851','account'], ['123','auto'], ['1e3','account']]) assert.throws(() => normalizePlayerId(id, kind));
});
test('unknown profile and limited history are not inferred from a nickname', () => {
  const ids = normalizePlayerId('123', 'account');
  assert.equal(parseProfile({}, ids).access, 'unknown');
  assert.equal(parseProfile({ fh_unavailable: true }, ids).access, 'limited');
  assert.throws(() => parseProfile({ profile: { account_id: 124, personaname: 'same name' } }, ids), /identity_mismatch/);
  assert.throws(() => parseProfile({ error: 'upstream error' }, ids), /invalid_provider/);
});
test('selection survives reload and never reassigns existing match participants', async () => {
  const profile = await selectProfile(pool, '123', 'account', response({ profile: { account_id: 123, steamid: '76561197960265851', personaname: 'Fixture' }, fh_unavailable: false }));
  assert.deepEqual(await selectedProfile(pool), profile);
  await pool.query("INSERT INTO dota.matches(match_id) VALUES ('1')");
  await pool.query("INSERT INTO dota.participants VALUES ('1',0,'123')");
  await selectProfile(pool, '124', 'account', response({}));
  assert.equal((await selectedProfile(pool)).accountId, '124');
  assert.equal((await pool.query('SELECT account_id FROM dota.participants')).rows[0].account_id, '123');
  await assert.rejects(selectProfile(pool, '125', 'account', response({ profile: { account_id: 999 } })), /identity_mismatch/);
  assert.equal((await selectedProfile(pool)).accountId, '124');
});
test('rate limit, network and invalid response remain distinct errors', async () => {
  await assert.rejects(openDota('/players/1', async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } })), e => e.code === 'provider_rate_limited' && e.retryAfter === 120);
  await assert.rejects(openDota('/players/1', async () => { throw Error('secret'); }), /provider_unavailable/);
  await assert.rejects(openDota('/players/1', async () => new Response('not json')), /invalid_provider_response/);
});
test('optional OpenDota key stays on the fixed source and exceptions are redacted', async () => {
  const previous = process.env.OPENDOTA_API_KEY;
  process.env.OPENDOTA_API_KEY = 'test-secret & /?';
  try {
    await openDota('/players/123/matches?offset=25', async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://api.opendota.com');
      assert.equal(url.searchParams.get('offset'), '25');
      assert.equal(url.searchParams.get('api_key'), process.env.OPENDOTA_API_KEY);
      assert.equal(options.redirect, 'error');
      return Response.json([]);
    });
    await assert.rejects(openDota('/players/123', async url => { throw Error(url); }), error => error.message === 'provider_unavailable');
  } finally {
    if (previous === undefined) delete process.env.OPENDOTA_API_KEY;
    else process.env.OPENDOTA_API_KEY = previous;
  }
});
