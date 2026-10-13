import { jobs } from "../../../../../lib/backend";
import type { EventFilters } from "@dota/jobs";
import { infrastructure, json, errorResponse } from "../../../../../lib/infrastructure";
import { replayStorage } from "../../../../../lib/replays";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const query = new URL(request.url).searchParams;
    const resource = query.get("resource") ?? "match";
    const fields: Record<string, string[]> = { match: [], frame: ["mode","time"], events: ["mode","type","playerSlot","limit","cursor"], series: ["mode","playerSlot"] };
    if (!Object.hasOwn(fields, resource) || [...query.keys()].some(k => !["accountId","resource",...fields[resource]!].includes(k) || query.getAll(k).length !== 1 || !query.get(k)?.trim())) throw new jobs.JobError("invalid_context_request");
    const mode = query.get("mode") ?? "retrospective";
    if (!["decision","retrospective"].includes(mode)) throw new jobs.JobError("invalid_context_request");
    const number = (key: string) => { const raw = query.get(key); if (raw === null || !/^-?\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) throw new jobs.JobError("invalid_context_request"); return Number(raw); };
    const { pool } = await infrastructure(), { id } = await context.params, account = query.get("accountId") ?? "";
    if (resource === "frame") return json(await jobs.readMatchFrame(pool, replayStorage(), id, account, mode as "decision" | "retrospective", number("time")));
    if (resource === "events") return json(await jobs.readMatchEvents(pool, id, account, {
      mode: mode as "decision" | "retrospective", ...(query.has("type") ? { type: query.get("type") as NonNullable<EventFilters["type"]> } : {}),
      ...(query.has("playerSlot") ? { playerSlot: number("playerSlot") } : {}), ...(query.has("limit") ? { limit: number("limit") } : {}),
      ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {}),
    }));
    if (resource === "series") return json(await jobs.readMatchSeries(pool, id, account, number("playerSlot"), mode as "decision" | "retrospective"));
    return json(await jobs.readMatchExplorer(pool, id, account));
  } catch (error) { return errorResponse(error); }
}
