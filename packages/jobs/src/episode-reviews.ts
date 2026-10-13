import type { Review, Episode } from "@dota/contracts";
import { insertReview, transaction, type Pool } from "@dota/persistence";
import { readEpisode } from "./analysis.js";
import { JobError } from "./index.js";
import { EPISODE_MAP, POSITION_SOURCE_VERSION, episodeMapPoint } from "./episode-map.js";

export interface ReviewHistory { datasetId: string; episodeId: string; reviews: Review[]; current: Review | null; mapAvailable: boolean }
async function mapAvailable(pool: Pool, datasetId: string, episode: Episode): Promise<boolean> {
  const rows = (await pool.query(`SELECT r.payload FROM dota.records r JOIN dota.dataset_checks c ON c.dataset_id=r.dataset_id
    WHERE r.dataset_id=$1 AND r.kind='hero_state' AND r.game_time_seconds BETWEEN $2 AND $3
    AND c.payload->>'complete'='true' AND r.payload->'provenance'->>'sourceVersion'=$4`,
    [datasetId,episode.window.startSeconds-5,episode.window.endSeconds,POSITION_SOURCE_VERSION])).rows;
  return rows.some(r => episodeMapPoint(r.payload) !== null);
}
export async function readEpisodeReviews(pool: Pool, datasetId: string, accountId: string, episodeId: string): Promise<ReviewHistory> {
  const { episode } = await readEpisode(pool, datasetId, accountId, episodeId);
  const reviews: Review[] = (await pool.query("SELECT payload FROM dota.episode_reviews WHERE dataset_id=$1 AND episode_id=$2 ORDER BY version DESC", [datasetId, episodeId])).rows.map(r => r.payload);
  return { datasetId, episodeId, reviews, current: reviews[0] ?? null, mapAvailable: await mapAvailable(pool, datasetId, episode) };
}
type ReviewInput = Omit<Review, "version" | "reviewedAt" | "mapContext"> & { expectedVersion: number };
function parseReview(input: unknown, team: string): ReviewInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new JobError("invalid_review");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(k => !["expectedVersion","status","explanation","alternative","author","material","perspective"].includes(k)) ||
      !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0 || (value.expectedVersion as number) >= 2147483647 ||
      typeof value.status !== "string" || !["unreviewed","confirmed_error","justified","uncertain"].includes(value.status) ||
      typeof value.material !== "string" || !["timeline","map","dota_client"].includes(value.material)) throw new JobError("invalid_review");
  const text = (v: unknown, max: number) => { if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw new JobError("invalid_review"); return v.trim(); };
  const perspective = value.perspective as Review["perspective"] | undefined;
  if (!perspective || typeof perspective !== "object" || Array.isArray(perspective) ||
      !(perspective.mode === "omniscient" && Object.keys(perspective).length === 1 || perspective.mode === "team" && perspective.team === team && Object.keys(perspective).length === 2)) throw new JobError("invalid_review");
  if (value.material === "map" && perspective.mode !== "omniscient") throw new JobError("review_map_unavailable");
  const alternative = value.alternative === null ? null : text(value.alternative, 2000);
  if (value.status === "confirmed_error" && alternative === null) throw new JobError("review_requires_alternative");
  return { expectedVersion: value.expectedVersion as number, status: value.status as Review["status"], explanation: text(value.explanation, 2000),
    alternative, author: text(value.author, 120), material: value.material as Review["material"], perspective };
}
export async function saveEpisodeReview(pool: Pool, datasetId: string, accountId: string, episodeId: string, input: unknown): Promise<ReviewHistory> {
  const { episode } = await readEpisode(pool, datasetId, accountId, episodeId);
  const { expectedVersion, ...parsed } = parseReview(input, episode.playerSlot < 128 ? "radiant" : "dire");
  if (parsed.material === "map" && !await mapAvailable(pool, datasetId, episode)) throw new JobError("review_map_unavailable");
  const fields: Omit<Review, "version" | "reviewedAt"> = { ...parsed, ...(parsed.material === "map" ? { mapContext: {
    backgroundVersion: EPISODE_MAP.backgroundVersion, projectionVersion: EPISODE_MAP.projectionVersion, imageSha256: EPISODE_MAP.imageSha256 } } : {}) };
  await transaction(pool, async client => {
    await client.query("SELECT id FROM dota.records WHERE dataset_id=$1 AND id=$2 FOR UPDATE", [datasetId, episodeId]);
    const latest: Review | undefined = (await client.query("SELECT payload FROM dota.episode_reviews WHERE dataset_id=$1 AND episode_id=$2 ORDER BY version DESC LIMIT 1", [datasetId, episodeId])).rows[0]?.payload;
    const version = latest?.version ?? 0;
    // Retrying the same completed request after a lost response is idempotent.
    if (latest && version === expectedVersion + 1 && Object.entries(fields).every(([key,value]) => {
      const prior = latest[key as keyof Review];
      return key === "perspective" ? latest.perspective.mode === fields.perspective.mode && (latest.perspective.mode === "omniscient" || fields.perspective.mode === "team" && latest.perspective.team === fields.perspective.team) : key === "mapContext" ?
        latest.mapContext?.backgroundVersion === fields.mapContext?.backgroundVersion && latest.mapContext?.projectionVersion === fields.mapContext?.projectionVersion && latest.mapContext?.imageSha256 === fields.mapContext?.imageSha256 : prior === value;
    })) return;
    if (version !== expectedVersion) throw new JobError("review_conflict");
    await insertReview(client, datasetId, episodeId, { ...fields, version: version + 1, reviewedAt: new Date().toISOString() });
  });
  return readEpisodeReviews(pool, datasetId, accountId, episodeId);
}
