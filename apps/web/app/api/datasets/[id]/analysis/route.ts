import { jobs } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse } from "../../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(k => !["accountId", "analysisId"].includes(k) || query.getAll(k).length !== 1)) throw new jobs.JobError("invalid_analysis_request");
    const { pool } = await infrastructure();
    return json(await jobs.readAnalysis(pool, (await context.params).id, query.get("accountId") ?? "", query.get("analysisId")));
  } catch (error) { return errorResponse(error); }
}
