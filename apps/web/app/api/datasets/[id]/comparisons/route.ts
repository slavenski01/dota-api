import { jobs } from "../../../../../lib/backend";
import { infrastructure, json, errorResponse, checkOrigin, readJson } from "../../../../../lib/infrastructure";
export const dynamic = "force-dynamic";
function query(request: Request) {
  const q = new URL(request.url).searchParams;
  if ([...q.keys()].some(k => !["accountId"].includes(k) || q.getAll(k).length !== 1)) throw new jobs.JobError("invalid_comparison");
  return q.get("accountId") ?? "";
}
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const account = query(request), { pool } = await infrastructure(), { id } = await context.params;
    return json({ runs: await jobs.readComparisons(pool, id, account), context: await jobs.readComparisonContext(pool, id, account) });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { checkOrigin(request); const account = query(request), input = await readJson(request) as { action: string; value: unknown };
    if (!input || typeof input !== "object" || Object.keys(input).some(k => !["action", "value"].includes(k)) || !["context", "compare"].includes(input.action)) throw new jobs.JobError("invalid_comparison");
    const { pool } = await infrastructure(), { id } = await context.params;
    return json(input.action === "context" ? await jobs.saveComparisonContext(pool, id, account, input.value) : await jobs.createComparison(pool, id, account, input.value));
  } catch (error) { return errorResponse(error); }
}
