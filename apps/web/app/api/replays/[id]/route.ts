import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { jobs, persistence } from "../../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin } from "../../../../lib/infrastructure";
import { replayStorage, replayParams } from "../../../../lib/replays";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { matchId, accountId } = replayParams(request, (await context.params).id);
    const { pool } = await infrastructure();
    const summary = (await pool.query("SELECT summary FROM dota.player_matches WHERE match_id=$1 AND account_id=$2", [matchId, accountId])).rows[0]?.summary ?? null;
    const replay = (await pool.query("SELECT id,size_bytes FROM dota.artifacts WHERE match_id=$1 AND media_type=$2 AND source->>'validation'='replay-v1' AND source->'accountIds' ? $3 ORDER BY created_at DESC LIMIT 1", [matchId, persistence.REPLAY_MEDIA_TYPE, accountId])).rows[0];
    const jobId = (await pool.query("SELECT id FROM dota.workflow_jobs WHERE match_id=$1 AND account_id=$2 ORDER BY created_at DESC LIMIT 1", [matchId, accountId])).rows[0]?.id ?? null;
    return json({ matchId, accountId, summary, jobId, replay: replay ? { sizeBytes: Number(replay.size_bytes) } : null });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    checkOrigin(request);
    const { matchId, accountId } = replayParams(request, (await context.params).id);
    if (request.headers.get("content-type") !== "application/octet-stream" || !request.body) throw new jobs.JobError("invalid_request");
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > jobs.REPLAY_LIMITS.downloadBytes)) return json({ error: "replay_size_limit" }, 413);
    const { pool, boss } = await infrastructure();
    const file = await replayStorage().put(Readable.fromWeb(request.body as import("node:stream/web").ReadableStream), { maxBytes: jobs.REPLAY_LIMITS.downloadBytes, signal: AbortSignal.any([request.signal, AbortSignal.timeout(jobs.REPLAY_LIMITS.transferMs)]) });
    if (length && file.sizeBytes !== Number(length)) throw new jobs.JobError("replay_truncated");
    const uploadId = randomUUID();
    await persistence.transaction(pool, async client => {
      await client.query("INSERT INTO dota.matches(match_id) VALUES ($1) ON CONFLICT DO NOTHING", [matchId]);
      await persistence.registerArtifact(client, { id: uploadId, matchId, file, mediaType: "application/x-dota-upload", source: { provider: "manual", accountId, acquiredAt: new Date().toISOString(), validated: false } });
    });
    return json(await jobs.requestWorkflow(pool, boss, { matchId, accountId, uploadId }, await jobs.defaultVersions()), 202);
  } catch (error) {
    if (error instanceof Error && error.message === "artifact_too_large") return json({ error: "replay_size_limit" }, 413);
    return errorResponse(error);
  }
}
