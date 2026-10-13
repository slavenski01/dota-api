import type { HeroState, Match, Participant } from "@dota/contracts";
import { normalizePlayerId, type Pool } from "@dota/persistence";
import { JobError } from "./index.js";

export interface MatchOverview {
  datasetId: string; match: Match; player: Participant;
  series: { time: number; hp: number | null; mana: number | null; evidenceId: string }[];
}
export async function readMatchOverview(pool: Pool, datasetId: string, accountId: string): Promise<MatchOverview> {
  normalizePlayerId(accountId, "account");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(datasetId)) throw new JobError("invalid_analysis_request");
  const players = (await pool.query("SELECT r.payload FROM dota.records r JOIN dota.dataset_checks c ON c.dataset_id=r.dataset_id WHERE r.dataset_id=$1 AND r.kind='participant' AND r.payload->>'accountId'=$2 AND c.payload->'complete'='true'::jsonb", [datasetId, accountId])).rows;
  if (players.length !== 1) throw new JobError("analysis_not_found");
  const player: Participant = players[0].payload;
  const match: Match | undefined = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind='match'", [datasetId])).rows[0]?.payload;
  if (!match) throw new JobError("analysis_not_found");
  const states: HeroState[] = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind='hero_state' AND player_slot=$2 AND payload->'perspective'->>'mode'='omniscient' ORDER BY game_time_seconds,id", [datasetId, player.playerSlot])).rows.map(r => r.payload);
  return { datasetId, match, player, series: states.map(s => ({ time: s.gameTimeSeconds, evidenceId: s.id,
    hp: s.hp.status === "known" && s.hp.observedAtSeconds === s.gameTimeSeconds ? s.hp.value : null,
    mana: s.mana.status === "known" && s.mana.observedAtSeconds === s.gameTimeSeconds ? s.mana.value : null })) };
}
