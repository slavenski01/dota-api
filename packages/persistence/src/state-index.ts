import { validateRecord, type HeroState, type PlayerSlot } from "@dota/contracts";
import type { Pool } from "./index.js";

/** Returns an observation, never an interpolated state at the requested instant. */
export async function stateAt(pool: Pool, datasetId: string, slot: PlayerSlot, time: number, maxAgeSeconds = 5): Promise<{ state: HeroState; ageSeconds: number } | null> {
  if (!Number.isFinite(time) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 0 || maxAgeSeconds > 5) throw new Error("invalid_state_time");
  const row = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind='hero_state' AND player_slot=$2 AND game_time_seconds<=$3 AND game_time_seconds>=$4 AND payload->'perspective'->>'mode'='omniscient' ORDER BY game_time_seconds DESC LIMIT 1",
    [datasetId, slot, time, time-maxAgeSeconds])).rows[0];
  if (!row) return null;
  const state = validateRecord(row.payload);
  if (state.kind !== "hero_state") throw new Error("invalid_state_index");
  return { state, ageSeconds: time-state.gameTimeSeconds };
}
