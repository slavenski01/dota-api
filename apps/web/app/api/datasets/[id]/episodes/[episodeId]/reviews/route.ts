import { jobs } from "../../../../../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; episodeId: string }> };
function account(request: Request): string {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(k => k !== "accountId" || query.getAll(k).length !== 1)) throw new jobs.JobError("invalid_review");
  return query.get("accountId") ?? "";
}
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const accountId = account(request), params = await context.params, { pool } = await infrastructure();
    return json(await jobs.readEpisodeReviews(pool, params.id, accountId, params.episodeId));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    checkOrigin(request);
    const accountId = account(request), input = await readJson(request), params = await context.params, { pool } = await infrastructure();
    return json(await jobs.saveEpisodeReview(pool, params.id, accountId, params.episodeId, input));
  } catch (error) { return errorResponse(error); }
}
