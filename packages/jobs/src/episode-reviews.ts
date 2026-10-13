import type { Review } from "@dota/contracts";
import { insertReview, transaction, type Pool } from "@dota/persistence";
import { readEpisode } from "./analysis.js";
import { JobError } from "./index.js";

export interface ReviewHistory { datasetId: string; episodeId: string; reviews: Review[]; current: Review | null }
export async function readEpisodeReviews(pool: Pool, datasetId: string, accountId: string, episodeId: string): Promise<ReviewHistory> {
  await readEpisode(pool, datasetId, accountId, episodeId);
  const reviews: Review[] = (await pool.query("SELECT payload FROM dota.episode_reviews WHERE dataset_id=$1 AND episode_id=$2 ORDER BY version DESC", [datasetId, episodeId])).rows.map(r => r.payload);
  return { datasetId, episodeId, reviews, current: reviews[0] ?? null };
}
type ReviewInput = Omit<Review, "version" | "reviewedAt"> & { expectedVersion: number };
function parseReview(input: unknown, team: string): ReviewInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new JobError("invalid_review");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(k => !["expectedVersion","status","explanation","alternative","author","material","perspective"].includes(k)) ||
      !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0 || (value.expectedVersion as number) >= 2147483647 ||
      !["unreviewed","confirmed_error","justified","uncertain"].includes(String(value.status)) ||
      !["timeline","map","dota_client"].includes(String(value.material))) throw new JobError("invalid_review");
  const text = (v: unknown, max: number) => { if (typeof v !== "string" || !v.trim() || v.trim().length > max) throw new JobError("invalid_review"); return v.trim(); };
  const perspective = value.perspective as Review["perspective"] | undefined;
  if (!perspective || typeof perspective !== "object" || Array.isArray(perspective) ||
      !(perspective.mode === "omniscient" && Object.keys(perspective).length === 1 || perspective.mode === "team" && perspective.team === team && Object.keys(perspective).length === 2)) throw new JobError("invalid_review");
  // The current UI has no calibrated map; never record a map review that could not occur.
  if (value.material === "map") throw new JobError("review_map_unavailable");
  const alternative = value.alternative === null ? null : text(value.alternative, 2000);
  if (value.status === "confirmed_error" && alternative === null) throw new JobError("review_requires_alternative");
  return { expectedVersion: value.expectedVersion as number, status: value.status as Review["status"], explanation: text(value.explanation, 2000),
    alternative, author: text(value.author, 120), material: value.material as Review["material"], perspective };
}
export async function saveEpisodeReview(pool: Pool, datasetId: string, accountId: string, episodeId: string, input: unknown): Promise<ReviewHistory> {
  const { episode } = await readEpisode(pool, datasetId, accountId, episodeId);
  const { expectedVersion, ...fields } = parseReview(input, episode.playerSlot < 128 ? "radiant" : "dire");
  await transaction(pool, async client => {
    await client.query("SELECT id FROM dota.records WHERE dataset_id=$1 AND id=$2 FOR UPDATE", [datasetId, episodeId]);
    const latest: Review | undefined = (await client.query("SELECT payload FROM dota.episode_reviews WHERE dataset_id=$1 AND episode_id=$2 ORDER BY version DESC LIMIT 1", [datasetId, episodeId])).rows[0]?.payload;
    const version = latest?.version ?? 0;
    // Retrying the same completed request after a lost response is idempotent.
    if (latest && version === expectedVersion + 1 && Object.entries(fields).every(([key,value]) => {
      const prior = latest[key as keyof Review];
      return key === "perspective" ? latest.perspective.mode === fields.perspective.mode && (latest.perspective.mode === "omniscient" || fields.perspective.mode === "team" && latest.perspective.team === fields.perspective.team) : prior === value;
    })) return;
    if (version !== expectedVersion) throw new JobError("review_conflict");
    await insertReview(client, datasetId, episodeId, { ...fields, version: version + 1, reviewedAt: new Date().toISOString() });
  });
  return readEpisodeReviews(pool, datasetId, accountId, episodeId);
}
