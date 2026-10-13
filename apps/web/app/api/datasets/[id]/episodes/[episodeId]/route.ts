import { jobs } from "../../../../../../lib/backend";
import { infrastructure, json, errorResponse } from "../../../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; episodeId: string }> }): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(k => k !== "accountId" || query.getAll(k).length !== 1)) throw new jobs.JobError("invalid_analysis_request");
    const { pool } = await infrastructure(), params = await context.params;
    return json(await jobs.readEpisode(pool, params.id, query.get("accountId") ?? "", params.episodeId));
  } catch (error) { return errorResponse(error); }
}
