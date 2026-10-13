import { type Pool, transaction } from "./index.js";

export class SourceError extends Error {
  constructor(readonly code: string, readonly status = 502, readonly retryAfter: number | null = null) { super(code); }
}
export function normalizePlayerId(input: unknown, kind: unknown): { accountId: string; steamId64: string } {
  if (typeof input !== "string" || !/^[1-9][0-9]{0,19}$/.test(input.trim())) throw new SourceError("invalid_player_id", 400);
  const id = BigInt(input.trim());
  let account: bigint;
  if (kind === "account") account = id;
  else if (kind === "steam") {
    if (id >> 56n !== 1n || (id >> 52n & 15n) !== 1n || (id >> 32n & 1048575n) !== 1n) throw new SourceError("invalid_steam_type", 400);
    account = id & 4294967295n;
  } else throw new SourceError("invalid_id_kind", 400);
  // 0 and UINT32_MAX are anonymous/sentinel IDs, never a selected person.
  if (account <= 0n || account >= 4294967295n) throw new SourceError("invalid_player_id", 400);
  return { accountId: String(account), steamId64: String(76561197960265728n + account) };
}
export type SourceFetch = typeof fetch;
export async function openDota(path: string, fetcher: SourceFetch = fetch): Promise<unknown> {
  let response: Response;
  const url = new URL(`https://api.opendota.com/api${path}`);
  if (process.env.OPENDOTA_API_KEY) url.searchParams.set("api_key", process.env.OPENDOTA_API_KEY);
  try { response = await fetcher(url.href, { signal: AbortSignal.timeout(15000), headers: { Accept: "application/json" }, redirect: "error" }); }
  catch { throw new SourceError("provider_unavailable", 503); }
  if (!response.ok) {
    const raw = response.headers.get("retry-after");
    const delay = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? Math.ceil((Date.parse(raw) - Date.now()) / 1000) : 60;
    await response.body?.cancel();
    throw new SourceError(response.status === 429 ? "provider_rate_limited" : response.status === 403 ? "provider_access_restricted" : "provider_unavailable", response.status === 429 ? 429 : 503,
      response.status === 429 ? Math.max(1, Math.min(86400, Number.isFinite(delay) ? delay : 60)) : null);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("invalid_provider_response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new SourceError("invalid_provider_response"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof SourceError) throw error; throw new SourceError("invalid_provider_response"); }
  finally { reader.releaseLock(); }
}
export interface PlayerProfile {
  accountId: string; steamId64: string; name: string | null; avatar: string | null;
  access: "available" | "limited" | "unknown"; fetchedAt: string;
}
export function parseProfile(value: unknown, ids: ReturnType<typeof normalizePlayerId>): PlayerProfile {
  if (!value || typeof value !== "object" || Array.isArray(value) || "error" in value) throw new SourceError("invalid_provider_response");
  const body = value as Record<string, unknown>;
  const profile = body.profile;
  let name: string | null = null; let avatar: string | null = null;
  if (profile != null) {
    if (typeof profile !== "object" || Array.isArray(profile)) throw new SourceError("invalid_provider_response");
    const p = profile as Record<string, unknown>;
    if (String(p.account_id) !== ids.accountId || (p.steamid != null && p.steamid !== ids.steamId64)) throw new SourceError("profile_identity_mismatch");
    name = typeof p.personaname === "string" ? p.personaname.slice(0, 200) : null;
    if (typeof p.avatarfull === "string") {
      try { const url = new URL(p.avatarfull); if (url.protocol === "https:" && /(^|\.)steamstatic\.com$|(^|\.)steamusercontent\.com$/.test(url.hostname)) avatar = url.href; } catch { /* optional avatar */ }
    }
  }
  return { ...ids, name, avatar, access: body.fh_unavailable === true ? "limited" : profile && body.fh_unavailable === false ? "available" : "unknown", fetchedAt: new Date().toISOString() };
}
export async function selectProfile(pool: Pool, input: unknown, kind: unknown, fetcher: SourceFetch = fetch): Promise<PlayerProfile> {
  const ids = normalizePlayerId(input, kind);
  const profile = parseProfile(await openDota(`/players/${ids.accountId}`, fetcher), ids);
  await transaction(pool, async client => {
    await client.query(`INSERT INTO dota.profiles(account_id,steam_id64,fetched_at,source) VALUES ($1,$2,$3,$4)
      ON CONFLICT (account_id) DO UPDATE SET steam_id64=excluded.steam_id64,fetched_at=excluded.fetched_at,source=excluded.source`, [ids.accountId, ids.steamId64, profile.fetchedAt, profile]);
    await client.query("INSERT INTO dota.selected_profile(singleton,account_id) VALUES (true,$1) ON CONFLICT (singleton) DO UPDATE SET account_id=excluded.account_id", [ids.accountId]);
  });
  return profile;
}
export async function selectedProfile(pool: Pool): Promise<PlayerProfile | null> {
  return (await pool.query("SELECT p.source FROM dota.selected_profile s JOIN dota.profiles p USING(account_id)")).rows[0]?.source ?? null;
}
