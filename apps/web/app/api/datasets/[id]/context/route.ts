import type { PlayerSlot } from "@dota/contracts";
import { jobs } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse } from "../../../../../lib/infrastructure";
import { replayStorage } from "../../../../../lib/replays";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    const mode = query.get("mode") ?? "decision";
    const time = query.get("time"), slot = query.get("playerSlot");
    if (!["decision", "retrospective"].includes(mode) || time === null || time.trim() === "" || slot === null || !/^(0|1|2|3|4|128|129|130|131|132)$/.test(slot) ||
      [...query.keys()].some(key => !["mode", "time", "playerSlot"].includes(key)) || [...new Set(query.keys())].some(key => query.getAll(key).length !== 1)) throw new jobs.JobError("invalid_context_request");
    const { pool } = await infrastructure();
    return json(await jobs.readDatasetContext(pool, replayStorage(), (await context.params).id, mode as "decision" | "retrospective", Number(time), Number(slot) as PlayerSlot));
  } catch (error) { return errorResponse(error); }
}
