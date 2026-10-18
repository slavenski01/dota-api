import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { openDatabase, migrate, saveDataset, transaction, insertRecords, insertReview } from "@dota/persistence";

const pool = openDatabase(process.env.TEST_DATABASE_URL);
const fixture = JSON.parse(await readFile(new URL("../packages/contracts/fixtures/records.json", import.meta.url)));
const participant = fixture.find(r => r.kind === "participant");
const slots = [0,1,2,3,4,128,129,130,131,132];
const baseRecords = fixture.filter(r => !["job","participant","hero_motion"].includes(r.kind));
baseRecords.push(...slots.map(playerSlot => ({ ...participant, id: `participant-${playerSlot}`, playerSlot, team: playerSlot < 128 ? "radiant" : "dire" })));
const dataset = { id: "dataset-1", matchId: participant.matchId, parserRunId: null, normalizationVersion: "test", inputSha256: "a".repeat(64), versions: { parser: "fixture" } };
before(async () => { await migrate(pool); });
after(async () => { await pool.end(); });

test("empty database migrations are serialized, repeatable, checksummed and atomic", async () => {
  const count = (await pool.query("SELECT count(*) FROM public.dota_migrations")).rows[0].count;
  await Promise.all([migrate(pool), migrate(pool)]);
  assert.equal((await pool.query("SELECT count(*) FROM public.dota_migrations")).rows[0].count, count);
  const dir = await mkdtemp("/tmp/dota-migrations-");
  try {
    await writeFile(`${dir}/001_data.sql`, "SELECT 1;");
    await assert.rejects(migrate(pool, pathToFileURL(`${dir}/`)), /migration_changed/);
    await rm(`${dir}/001_data.sql`);
    await writeFile(`${dir}/999_invalid.sql`, "CREATE TABLE public.should_rollback(id int); SELECT broken_column;");
    await assert.rejects(migrate(pool, pathToFileURL(`${dir}/`)));
    assert.equal((await pool.query("SELECT to_regclass('public.should_rollback') AS name")).rows[0].name, null);
  } finally { await rm(dir, { recursive: true }); }
});
test("contract snapshots retain exact IDs, nulls and negative game time", async () => {
  await saveDataset(pool, dataset, baseRecords);
  const row = (await pool.query("SELECT match_id,game_time_seconds,payload FROM dota.events WHERE id='death-1'")).rows[0];
  assert.equal(row.match_id, "9007199254740993");
  assert.equal(row.game_time_seconds, -12.25);
  const saved = (await pool.query("SELECT payload FROM dota.participant_snapshots WHERE player_slot=128")).rows[0].payload;
  assert.equal(saved.accountId, null); assert.equal(saved.statistics.kills, 0); assert.equal(saved.statistics.lastHits, null);
  assert.equal((await pool.query("SELECT count(*) FROM dota.participants")).rows[0].count, "10");
});
test("duplicate, malformed IDs, orphan participants and cross-match records are rejected", async () => {
  await assert.rejects(saveDataset(pool, dataset, baseRecords), { code: "23505" });
  await assert.rejects(pool.query("INSERT INTO dota.matches VALUES ('01',NULL)"), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO dota.participants VALUES ('2',0,NULL)"), { code: "23503" });
  const record = { ...fixture.find(r => r.kind === "event"), id: "wrong-match", matchId: "2" };
  await assert.rejects(pool.query("INSERT INTO dota.records(dataset_id,payload) VALUES ($1,$2)", [dataset.id, record]), { code: "23503" });
  await assert.rejects(saveDataset(pool, { ...dataset, id: "rollback" }, [...baseRecords, baseRecords[0]]));
  assert.equal((await pool.query("SELECT count(*) FROM dota.datasets WHERE id='rollback'")).rows[0].count, "0");
});
test("snapshots and reviews cannot be overwritten; reports retain the referenced review version", async () => {
  await assert.rejects(pool.query("UPDATE dota.records SET payload=payload WHERE id='death-1'"), { code: "23514" });
  await assert.rejects(pool.query("DELETE FROM dota.datasets WHERE id=$1", [dataset.id]), { code: "23514" });
  const review = { ...fixture.find(r => r.kind === "episode").review, version: 2, status: "uncertain", alternative: null };
  await transaction(pool, client => insertReview(client, dataset.id, "episode-1", review));
  assert.equal((await pool.query("SELECT review_version FROM dota.report_reviews")).rows[0].review_version, 1);
  await assert.rejects(pool.query("UPDATE dota.episode_reviews SET payload=payload"), { code: "23514" });
  await assert.rejects(transaction(pool, client => insertReview(client, dataset.id, "episode-1", { ...review, version: 3, status: "confirmed_error" })), /review_requires_alternative/);
  const report = { ...fixture.find(r => r.kind === "report"), id: "report-2", reviewRefs: [{ episodeId: "episode-1", reviewVersion: 99 }] };
  await assert.rejects(transaction(pool, client => insertRecords(client, dataset.id, [report])), { code: "23503" });
  assert.equal((await pool.query("SELECT count(*) FROM dota.reports")).rows[0].count, "1");
});
test("required player/time and match/game-time indexes exist", async () => {
  const names = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='dota'")).rows.map(r => r.indexname);
  for (const name of ["participants_player_match", "matches_time", "events_match_time", "states_match_time"]) assert.ok(names.includes(name));
});
