import { jobs } from "../../../../../../../lib/backend";
import { infrastructure, json, errorResponse } from "../../../../../../../lib/infrastructure";
import { replayStorage } from "../../../../../../../lib/replays";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string; episodeId: string }> }): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams, rawTime = query.get("time"), mode = query.get("mode") ?? "decision";
    if ([...query.keys()].some(k => !["accountId", "time", "mode"].includes(k) || query.getAll(k).length !== 1) || rawTime !== null && rawTime.trim() === "" || !["decision", "retrospective"].includes(mode)) throw new jobs.JobError("invalid_context_request");
    const { pool } = await infrastructure(), params = await context.params;
    return json(await jobs.readEpisodeFrame(pool, replayStorage(), params.id, query.get("accountId") ?? "", params.episodeId, mode as "decision" | "retrospective", rawTime === null ? null : Number(rawTime)));
  } catch (error) { return errorResponse(error); }
}
