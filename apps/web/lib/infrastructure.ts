import { persistence, jobs } from "./backend";
const { openDatabase, migrate } = persistence;
const { startQueue, JobError } = jobs;

async function connect() {
  const connection = process.env.DATABASE_URL;
  if (!connection) throw new JobError("database_not_configured");
  const pool = openDatabase(connection);
  try {
    await migrate(pool);
    const boss = await startQueue(connection);
    return { pool, boss };
  } catch (error) { await pool.end(); throw error; }
}
const globalState = globalThis as typeof globalThis & { dotaInfrastructure?: ReturnType<typeof connect> };
export function infrastructure(): ReturnType<typeof connect> {
  return globalState.dotaInfrastructure ??= connect().catch(error => { delete globalState.dotaInfrastructure; throw error; });
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof persistence.SourceError) {
    const response = json({ error: error.code, retryAfter: error.retryAfter }, error.status);
    if (error.retryAfter !== null) response.headers.set("Retry-After", String(error.retryAfter));
    return response;
  }
  const code = error instanceof JobError ? error.code : "service_unavailable";
  const status = code === "job_not_found" || code === "dataset_not_validated" ? 404 : ["invalid_analysis_options", "invalid_context_request", "invalid_request", "invalid_json", "invalid_job_id", "artifact_match_mismatch", "request_too_large", "invalid_player_id", "player_required"].includes(code) ? 400 : code === "analysis_options_conflict" ? 409 : code === "origin_not_allowed" ? 403 : 503;
  return json({ error: code }, status);
}
export function checkOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  // Next.js may use its internal hostname in request.url. Compare with the
  // browser-facing Host, restricted to the loopback-only deployment contract.
  try {
    const expected = new URL(request.url);
    const host = request.headers.get("host");
    if (host) expected.host = host;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname) || origin !== expected.origin) throw new Error();
  } catch { throw new JobError("origin_not_allowed"); }
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new JobError("invalid_request");
  if (!request.body) throw new JobError("invalid_json");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 8192) { await reader.cancel(); throw new JobError("request_too_large"); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new JobError("invalid_json"); }
  } finally { reader.releaseLock(); }
}
