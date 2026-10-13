import { type Pool, type PoolClient } from "./index.js";
import { normalizePlayerId, openDota, SourceError, type SourceFetch } from "./profiles.js";
export const HISTORY_PAGE_SIZE = 50;
export interface MatchSummary {
  matchId: string; startedAt: string; heroId: number | null; playerSlot: number | null;
  won: boolean | null; duration: number | null; kills: number | null; deaths: number | null; assists: number | null;
}
function integer(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new SourceError("invalid_provider_response");
  return value;
}
export function parseHistory(value: unknown): MatchSummary[] {
  if (!Array.isArray(value) || value.length > HISTORY_PAGE_SIZE) throw new SourceError("invalid_provider_response");
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new SourceError("invalid_provider_response");
    const id = item.match_id;
    if (!(typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id)) && !(typeof id === "number" && Number.isSafeInteger(id) && id > 0)) throw new SourceError("invalid_provider_response");
    const start = integer(item.start_time); if (start === null) throw new SourceError("invalid_provider_response");
    const slot = integer(item.player_slot);
    if (slot !== null && ![0,1,2,3,4,128,129,130,131,132].includes(slot)) throw new SourceError("invalid_provider_response");
    if (item.radiant_win != null && typeof item.radiant_win !== "boolean") throw new SourceError("invalid_provider_response");
    return { matchId: String(id), startedAt: new Date(start * 1000).toISOString(), heroId: integer(item.hero_id), playerSlot: slot,
      won: slot === null || item.radiant_win == null ? null : (slot < 128) === item.radiant_win,
      duration: integer(item.duration), kills: integer(item.kills), deaths: integer(item.deaths), assists: integer(item.assists) };
  });
}
export async function fetchHistory(accountId: string, offset: number, fetcher: SourceFetch = fetch): Promise<MatchSummary[]> {
  normalizePlayerId(accountId, "account");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new SourceError("invalid_history_offset", 400);
  return parseHistory(await openDota(`/players/${accountId}/matches?limit=${HISTORY_PAGE_SIZE}&offset=${offset}&significant=0&sort=start_time`, fetcher));
}
export async function saveHistoryPage(client: PoolClient, accountId: string, offset: number, rows: MatchSummary[]): Promise<void> {
  for (const row of rows) {
    await client.query("INSERT INTO dota.matches(match_id,started_at) VALUES ($1,$2) ON CONFLICT (match_id) DO UPDATE SET started_at=coalesce(dota.matches.started_at,excluded.started_at)", [row.matchId,row.startedAt]);
    if (row.playerSlot !== null) {
      const saved = await client.query(`INSERT INTO dota.participants VALUES ($1,$2,$3) ON CONFLICT (match_id,player_slot)
        DO UPDATE SET account_id=excluded.account_id WHERE dota.participants.account_id IS NULL OR dota.participants.account_id=excluded.account_id`, [row.matchId,row.playerSlot,accountId]);
      if (!saved.rowCount) throw new SourceError("participant_account_conflict");
    }
    await client.query(`INSERT INTO dota.player_matches(account_id,match_id,started_at,hero_id,won,summary) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (account_id,match_id) DO UPDATE SET started_at=excluded.started_at,hero_id=excluded.hero_id,won=excluded.won,summary=excluded.summary,fetched_at=now()`,
      [accountId,row.matchId,row.startedAt,row.heroId,row.won,row]);
  }
  await client.query(`INSERT INTO dota.history_pages(account_id,page_offset,row_count) VALUES ($1,$2,$3)
    ON CONFLICT (account_id,page_offset) DO UPDATE SET fetched_at=now(),row_count=excluded.row_count`, [accountId,offset,rows.length]);
}
export async function historyState(pool: Pool, accountId: string) {
  normalizePlayerId(accountId, "account");
  const pages = (await pool.query("SELECT page_offset,row_count,fetched_at FROM dota.history_pages WHERE account_id=$1 ORDER BY page_offset", [accountId])).rows;
  const last = pages.at(-1);
  return { pages, nextOffset: last ? last.page_offset + HISTORY_PAGE_SIZE : 0, sourceExhausted: last ? last.row_count < HISTORY_PAGE_SIZE : false,
    completeness: "available_pages_only" as const };
}
