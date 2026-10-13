import { type Pool, type Storage, artifactById } from "./index.js";
import { openDota, SourceError, type SourceFetch } from "./profiles.js";

export const REPLAY_MEDIA_TYPE = "application/x-dota-replay";
export function replayMatchId(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new SourceError("invalid_match_id", 400);
  return value;
}
// Do not accept arbitrary URLs, credentials, provider query parameters or ports.
// Apply the same rule before every request, including redirects.
export function replayUrl(value: string, matchId: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !/^replay[0-9]{1,5}\.valve\.net$/.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash
      || !new RegExp(`^/570/${replayMatchId(matchId)}_[0-9]+\\.dem(?:\\.bz2|\\.zst)?$`).test(url.pathname)) throw Error();
    return url.href;
  } catch { throw new SourceError("invalid_replay_source"); }
}
export async function replayRequest(url: string, matchId: string, method: "HEAD" | "GET", signal: AbortSignal, fetcher: SourceFetch = fetch): Promise<Response> {
  let current = replayUrl(url, matchId);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    let response: Response;
    try { response = await fetcher(current, { method, redirect: "manual", signal, headers: { "Accept-Encoding": "identity" } }); }
    catch { signal.throwIfAborted(); throw new SourceError("replay_temporarily_unavailable", 503); }
    if (![301,302,303,307,308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new SourceError("invalid_replay_source");
    current = replayUrl(new URL(location, current).href, matchId);
  }
  throw new SourceError("replay_redirect_limit");
}
export async function verifiedReplay(pool: Pool, storage: Storage, matchId: string, accountId?: string): Promise<{ artifactId: string; sha256: string } | null> {
  replayMatchId(matchId);
  const rows = (await pool.query(`SELECT id FROM dota.artifacts WHERE match_id=$1 AND media_type=$2
    AND source->>'validation'='replay-v1' AND ($3::text IS NULL OR source->'accountIds' ? $3) ORDER BY created_at DESC`, [matchId, REPLAY_MEDIA_TYPE, accountId ?? null])).rows;
  for (const row of rows) {
    try { const file = await artifactById(pool, row.id); await storage.verify(file); return { artifactId: row.id, sha256: file.sha256 }; }
    catch (error) {
      if (!['ENOENT','artifact_integrity_mismatch'].includes((error as NodeJS.ErrnoException).code ?? (error as Error).message)) throw error;
    }
  }
  return null;
}
export type ReplaySource = { status: "stored"; artifactId: string; sha256: string } | { status: "candidate"; url: string; checkedAt: string } | { status: "missing" | "unavailable"; checkedAt: string };
export async function resolveReplay(pool: Pool, storage: Storage, matchId: string, options: { force?: boolean; accountId?: string; signal?: AbortSignal; fetcher?: SourceFetch } = {}): Promise<ReplaySource> {
  replayMatchId(matchId);
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const stored = await verifiedReplay(pool, storage, matchId, options.accountId);
  signal.throwIfAborted();
  if (stored) return { status: "stored", ...stored };
  if (!options.force) {
    const saved = (await pool.query("SELECT * FROM dota.replay_sources WHERE match_id=$1 AND status='candidate' AND checked_at>now()-interval '5 minutes' AND ($2::text IS NULL OR checked_accounts ? $2)", [matchId, options.accountId ?? null])).rows[0];
    if (saved) return { status: "candidate", url: replayUrl(saved.url, matchId), checkedAt: saved.checked_at.toISOString() };
  }
  const fetcher: SourceFetch = (input, init) => (options.fetcher ?? fetch)(input, { ...init, signal });
  const raw = await openDota(`/matches/${matchId}`, fetcher);
  signal.throwIfAborted();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SourceError("invalid_provider_response");
  const data = raw as Record<string, unknown>;
  if (String(data.match_id) !== matchId || (typeof data.match_id === 'number' && !Number.isSafeInteger(data.match_id))) throw new SourceError("replay_match_mismatch");
  if (options.accountId && (!Array.isArray(data.players) || data.players.filter(p => p && String(p.account_id) === options.accountId).length !== 1)) throw new SourceError("replay_participant_mismatch");
  let status: "candidate" | "missing" | "unavailable" = "missing"; let url: string | null = null;
  if (data.replay_url != null && data.replay_url !== '') {
    if (typeof data.replay_url !== 'string') throw new SourceError("invalid_replay_source");
    url = replayUrl(data.replay_url, matchId);
    const response = await replayRequest(url, matchId, "HEAD", signal, options.fetcher);
    await response.body?.cancel();
    if ([404,410].includes(response.status)) { status = "unavailable"; url = null; }
    else if (response.ok || response.status === 405) status = "candidate";
    else throw new SourceError("replay_temporarily_unavailable", 503);
  }
  const checkedAt = new Date().toISOString();
  await pool.query("INSERT INTO dota.matches(match_id) VALUES ($1) ON CONFLICT DO NOTHING", [matchId]);
  await pool.query(`INSERT INTO dota.replay_sources(match_id,checked_at,source,status,url,checked_accounts) VALUES ($1,$2,'opendota',$3,$4,$5)
    ON CONFLICT(match_id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,url=excluded.url,checked_accounts=excluded.checked_accounts`, [matchId, checkedAt, status, url, JSON.stringify(options.accountId ? [options.accountId] : [])]);
  return status === "candidate" ? { status, url: url!, checkedAt } : { status, checkedAt };
}
