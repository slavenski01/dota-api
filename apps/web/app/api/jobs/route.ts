import type { WorkflowRequest } from "@dota/jobs";
import { jobs, persistence } from "../../../lib/backend";
const { requestWorkflow, defaultVersions, JobError } = jobs;
import { infrastructure, json, errorResponse, readJson, checkOrigin } from "../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    checkOrigin(request);
    const input = await readJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input) || !("matchId" in input) || typeof input.matchId !== "string"
      || ("artifactId" in input && typeof input.artifactId !== "string")
      || ("accountId" in input && typeof input.accountId !== "string")
      || "uploadId" in input) throw new JobError("invalid_request");
    const { pool, boss } = await infrastructure();
    if ("artifactId" in input) {
      const valid = (await pool.query("SELECT 1 FROM dota.artifacts WHERE id=$1 AND media_type=$2 AND source->>'validation'='replay-v1'", [input.artifactId, persistence.REPLAY_MEDIA_TYPE])).rowCount;
      if (!valid) throw new JobError("invalid_request");
    }
    return json(await requestWorkflow(pool, boss, input as WorkflowRequest, await defaultVersions()), 202);
  } catch (error) { return errorResponse(error); }
}
