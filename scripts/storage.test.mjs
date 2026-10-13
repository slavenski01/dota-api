import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, unlink, utimes } from "node:fs/promises";
import { Readable, PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate, saveDataset, LocalStorage, storeStateSegments, readStateWindow, artifactById } from "@dota/persistence";
const pool = openDatabase(process.env.TEST_DATABASE_URL);
const dir = await mkdtemp("/tmp/dota-storage-");
const storage = new LocalStorage(dir);
const fixture = JSON.parse(await readFile(new URL("../packages/contracts/fixtures/records.json", import.meta.url)));
before(async () => { await migrate(pool); });
after(async () => { await pool.end(); await rm(dir, { recursive: true }); });

test("atomic files are content-addressed and concurrent identical writes are safe", async () => {
  const data = Buffer.from("complete artifact");
  const [a, b] = await Promise.all([storage.put(Readable.from([data])), storage.put(Readable.from([data]))]);
  assert.deepEqual(a, b); assert.deepEqual(await storage.read(a.key, 100), data);
  await storage.verify(a);
  assert.deepEqual(await readdir(`${dir}/.tmp`), []);
});
test("partial writes, oversized input and cancellation never publish a file", async () => {
  const source = new PassThrough(); const controller = new AbortController();
  const putting = storage.put(source, { signal: controller.signal });
  source.write("partial"); controller.abort();
  await assert.rejects(putting, { name: "AbortError" });
  await assert.rejects(storage.put(Readable.from([Buffer.alloc(11)]), { maxBytes: 10 }), /artifact_too_large/);
  async function* broken() { yield "prefix"; throw new Error("source_failed"); }
  await assert.rejects(storage.put(Readable.from(broken())), /source_failed/);
  assert.deepEqual(await readdir(`${dir}/.tmp`), []);
  await assert.rejects(artifactById(pool, "../outside"), /invalid_artifact_id/);
});
test("traversal, symlinks and corrupted existing content are rejected", async () => {
  await assert.rejects(storage.read("../../etc/passwd", 100), /invalid_storage_key/);
  const file = await storage.put(Readable.from(["corrupt-me"]));
  await writeFile(`${dir}/${file.key}`, "corrupted");
  await assert.rejects(storage.verify(file), /integrity/);
  await assert.rejects(storage.put(Readable.from(["corrupt-me"])), /integrity/);
  await unlink(`${dir}/${file.key}`);
  await symlink("/etc/hosts", `${dir}/${file.key}`);
  await assert.rejects(storage.read(file.key, 10000));
});
test("cleanup removes only abandoned .part files older than 24 hours", async () => {
  const old = `${dir}/.tmp/${randomUUID()}.part`; const fresh = `${dir}/.tmp/${randomUUID()}.part`;
  await writeFile(old, "old"); await writeFile(fresh, "new"); await writeFile(`${dir}/.tmp/keep.txt`, "keep");
  await utimes(old, new Date(0), new Date(0));
  assert.equal(await storage.cleanupTemporary(), 1);
  assert.equal(await readFile(fresh, "utf8"), "new");
  assert.equal(await readFile(`${dir}/.tmp/keep.txt`, "utf8"), "keep");
});
test("window reads only intersecting segments and preserve requested perspective", async () => {
  const records = fixture.filter(r => ["match", "participant"].includes(r.kind)).map(r => ({ ...r, matchId: "22" }));
  await saveDataset(pool, { id: "segment-dataset", matchId: "22", parserRunId: null, normalizationVersion: "test", inputSha256: "a".repeat(64), versions: {} }, records);
  const state = fixture.find(r => r.kind === "hero_state" && r.perspective.mode === "omniscient");
  const states = [601, 602, 660].map(time => ({ ...structuredClone(state), id: `state-${time}`, matchId: "22", gameTimeSeconds: time }));
  const team = fixture.find(r => r.kind === "hero_state" && r.perspective.mode === "team" && r.visibility.value === "hidden");
  states.push({ ...structuredClone(team), id: "team-state", matchId: "22", gameTimeSeconds: 601 });
  await storeStateSegments(pool, storage, "segment-dataset", states);
  let reads = 0;
  const counted = { read: async (...args) => { reads++; return storage.read(...args); } };
  const window = await readStateWindow(pool, counted, "segment-dataset", 601, 602, "omniscient");
  assert.deepEqual(window.map(r => r.id), ["state-601", "state-602"]); assert.equal(reads, 1);
  const masked = await readStateWindow(pool, storage, "segment-dataset", 601, 602, team.perspective.team);
  assert.equal(masked.length, 1); assert.equal(masked[0].position.status, team.position.status);
  await assert.rejects(readStateWindow(pool, storage, "segment-dataset", 0, 121, "omniscient"), /invalid_state_window/);
  await assert.rejects(storeStateSegments(pool, storage, "segment-dataset", states), { code: "23505" });
  assert.equal((await pool.query("SELECT count(*) FROM dota.state_segments")).rows[0].count, "3");
});
