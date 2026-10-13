import { persistence } from "../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../lib/infrastructure";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  try { return json({ profile: await persistence.selectedProfile((await infrastructure()).pool) }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    checkOrigin(request);
    const input = await readJson(request) as { id?: unknown; kind?: unknown } | null;
    persistence.normalizePlayerId(input?.id, input?.kind);
    return json({ profile: await persistence.selectProfile((await infrastructure()).pool, input?.id, input?.kind) });
  } catch (error) { return errorResponse(error); }
}
