import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { validateRecord, type ContractRecord } from "@dota/contracts";
export { Pool } from "pg";
export type { PoolClient } from "pg";
export { LocalStorage, STORAGE_LIMITS, registerArtifact, artifactById, storeStateSegments, readStateWindow } from "./storage.js";
export type { Storage, StoredFile, Perspective } from "./storage.js";

export function openDatabase(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error("DATABASE_URL_required");
  return new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
}
export async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function migrate(pool: Pool, directory = new URL("../migrations/", import.meta.url)): Promise<void> {
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(731082, 1)");
    await client.query("CREATE TABLE IF NOT EXISTS public.dota_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
    for (const name of files) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query("SELECT sha256 FROM public.dota_migrations WHERE name = $1", [name]);
      if (existing.rows.length) {
        if (existing.rows[0].sha256 !== hash) throw new Error(`migration_changed:${name}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO public.dota_migrations(name, sha256) VALUES ($1,$2)", [name, hash]);
    }
  });
}
export interface DatasetInput {
  id: string; matchId: string; parserRunId: string | null;
  normalizationVersion: string; inputSha256: string; versions: Record<string, unknown>;
}
function relatedSlots(record: ContractRecord): number[] {
  if (record.kind === "coverage") return record.participantSlots;
  if (record.kind !== "event") return [];
  const data = record.data;
  switch (data.type) {
    case "death": return [data.victimSlot, data.killerSlot].filter(slot => slot !== null);
    case "item": return [data.playerSlot];
    case "fight": return data.participantSlots;
    default: return [];
  }
}
export async function insertRecords(client: PoolClient, datasetId: string, input: unknown[]): Promise<void> {
  const records = input.map(validateRecord);
  for (const record of records) {
    if (record.kind === "job") throw new Error("job_is_not_dataset_record");
    await client.query("INSERT INTO dota.records(dataset_id,payload) VALUES ($1,$2)", [datasetId, record]);
    for (const slot of new Set(relatedSlots(record))) {
      await client.query("INSERT INTO dota.record_participants VALUES ($1,$2,$3,$4)", [datasetId, record.id, record.matchId, slot]);
    }
    if (record.kind === "episode" && record.review) await insertReview(client, datasetId, record.id, record.review);
  }
  for (const record of records) if (record.kind === "report") {
    for (const episode of record.episodeIds) await client.query(
      "INSERT INTO dota.report_episodes(dataset_id,report_id,episode_id) VALUES ($1,$2,$3)", [datasetId, record.id, episode]);
    for (const review of record.reviewRefs) await client.query(
      "INSERT INTO dota.report_reviews VALUES ($1,$2,$3,$4)", [datasetId, record.id, review.episodeId, review.reviewVersion]);
  }
}
export async function insertReview(client: PoolClient, datasetId: string, episodeId: string, review: unknown): Promise<void> {
  const result = await client.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND id=$2 AND kind='episode'", [datasetId, episodeId]);
  if (!result.rows.length) throw new Error("episode_not_found");
  const episode = validateRecord({ ...result.rows[0].payload, review });
  if (episode.kind !== "episode" || !episode.review) throw new Error("review_required");
  await client.query("INSERT INTO dota.episode_reviews(dataset_id,episode_id,version,payload) VALUES ($1,$2,$3,$4)", [datasetId, episodeId, episode.review.version, episode.review]);
}
export async function saveDataset(pool: Pool, dataset: DatasetInput, input: unknown[]): Promise<void> {
  const records = input.map(validateRecord);
  if (records.some(record => record.matchId !== dataset.matchId)) throw new Error("dataset_match_mismatch");
  await transaction(pool, async client => {
    const match = records.find(record => record.kind === "match");
    await client.query("INSERT INTO dota.matches(match_id,started_at) VALUES ($1,$2) ON CONFLICT (match_id) DO UPDATE SET started_at=coalesce(dota.matches.started_at,excluded.started_at)", [dataset.matchId, match?.kind === "match" ? match.startedAt : null]);
    for (const record of records) if (record.kind === "participant") {
      if (record.accountId !== null) await client.query("INSERT INTO dota.profiles(account_id) VALUES ($1) ON CONFLICT DO NOTHING", [record.accountId]);
      const saved = await client.query("INSERT INTO dota.participants VALUES ($1,$2,$3) ON CONFLICT (match_id,player_slot) DO UPDATE SET account_id=coalesce(dota.participants.account_id,excluded.account_id) WHERE dota.participants.account_id IS NULL OR excluded.account_id IS NULL OR dota.participants.account_id=excluded.account_id", [record.matchId, record.playerSlot, record.accountId]);
      if (!saved.rowCount) throw new Error("participant_account_conflict");
    }
    await client.query("INSERT INTO dota.datasets(id,match_id,parser_run_id,normalization_version,input_sha256,versions) VALUES ($1,$2,$3,$4,$5,$6)",
      [dataset.id, dataset.matchId, dataset.parserRunId, dataset.normalizationVersion, dataset.inputSha256, dataset.versions]);
    await insertRecords(client, dataset.id, records);
  });
}
export { SourceError, normalizePlayerId, openDota, parseProfile, selectProfile, selectedProfile } from "./profiles.js";
export type { PlayerProfile, SourceFetch } from "./profiles.js";
