import { Readable } from "node:stream";
import { persistence } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse } from "../../../../../lib/infrastructure";
import { replayStorage, replayParams } from "../../../../../lib/replays";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { matchId, accountId } = replayParams(request, (await context.params).id);
    const { pool } = await infrastructure(); const storage = replayStorage();
    const replay = await persistence.verifiedReplay(pool, storage, matchId, accountId);
    if (!replay) return json({ error: "replay_not_stored" }, 404);
    const file = await persistence.artifactById(pool, replay.artifactId);
    const source = await storage.stream(file.key);
    return new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>, { headers: {
      "Content-Type": "application/octet-stream", "Content-Length": String(file.sizeBytes),
      "Content-Disposition": `attachment; filename="${matchId}.dem"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return errorResponse(error); }
}
