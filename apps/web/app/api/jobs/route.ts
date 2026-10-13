import type { WorkflowRequest } from "@dota/jobs";
import { jobs } from "../../../lib/backend";
const { requestWorkflow, defaultVersions, JobError } = jobs;
import { infrastructure, json, errorResponse, readJson, checkOrigin } from "../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    checkOrigin(request);
    const input = await readJson(request);
    if (!input || typeof input !== "object" || Array.isArray(input) || !("matchId" in input) || typeof input.matchId !== "string"
      || ("artifactId" in input && typeof input.artifactId !== "string")) throw new JobError("invalid_request");
    const { pool, boss } = await infrastructure();
    return json(await requestWorkflow(pool, boss, input as WorkflowRequest, await defaultVersions()), 202);
  } catch (error) { return errorResponse(error); }
}
