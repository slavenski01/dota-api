import type { HeroState, Participant, GameEvent } from "@dota/contracts";
import { decisionContext, PLAYER_SLOTS } from "@dota/analysis";
import { readStateWindow, type Pool, type Storage } from "@dota/persistence";
import { readEpisode } from "./analysis.js";
import { JobError } from "./index.js";
import { EPISODE_MAP, episodeMapPoint, type MapPoint } from "./episode-map.js";
import { readMatchExplorer } from './match-explorer.js';
import { episodeViewingWindow } from './episode-window.js';

export type ViewerState = Pick<HeroState, "playerSlot" | "gameTimeSeconds" | "visibility" | "position" | "hp" | "mana" | "alive" | "inventory" | "resources" | "lastKnownPosition">;
export interface EpisodeFrame {
  datasetId: string; episodeId: string; matchId: string; accountId: string;
  mode: "decision" | "retrospective"; time: number; playerSlot: HeroState["playerSlot"];
  window: { startSeconds: number; endSeconds: number }; decisionTimeSeconds: number;
  heroes: { playerSlot: HeroState["playerSlot"]; heroId: string | null }[];
  states: { playerSlot: HeroState["playerSlot"]; state: ViewerState | null; ageSeconds: number | null; mapPosition: MapPoint | null }[];
  events: GameEvent[]; facts: string[]; limitations: string[];
  map: typeof EPISODE_MAP;
}
export async function readEpisodeFrame(pool: Pool, storage: Storage, datasetId: string, accountId: string, episodeId: string, mode: "decision" | "retrospective", time: number | null): Promise<EpisodeFrame> {
  if (!["decision", "retrospective"].includes(mode) || time !== null && !Number.isFinite(time)) throw new JobError("invalid_context_request");
  const detail = await readEpisode(pool, datasetId, accountId, episodeId);
  const episode = detail.episode;
  const window = episodeViewingWindow(episode, (await readMatchExplorer(pool,datasetId,accountId)).window);
  const at = time ?? episode.decisionTimeSeconds;
  if (at < window.startSeconds || at > window.endSeconds) throw new JobError("invalid_context_request");
  const checked = (await pool.query("SELECT payload FROM dota.dataset_checks WHERE dataset_id=$1", [datasetId])).rows[0]?.payload;
  if (checked?.complete !== true) throw new JobError("dataset_not_validated");
  const participants: Participant[] = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind='participant' ORDER BY player_slot", [datasetId])).rows.map(r => r.payload);
  const base = { datasetId, episodeId, matchId: episode.matchId, accountId, mode, time: at, playerSlot: episode.playerSlot,
    window, decisionTimeSeconds: episode.decisionTimeSeconds,
    heroes: participants.map(p => ({ playerSlot: p.playerSlot, heroId: p.heroId })),
    map: EPISODE_MAP };
  if (mode === "decision") {
    // No retrospective sampling, event log, resource values or evidence is sent to this view.
    const context = decisionContext([], episode.playerSlot < 128 ? "radiant" : "dire", episode.playerSlot, at);
    return { ...base, states: context.states.map(state => ({ playerSlot: state.playerSlot, state, ageSeconds: null, mapPosition: null })), events: [], facts: [],
      limitations: ["Перспектива команды выбранного игрока. Обзор и обнаружение не подтверждены: значения неизвестны, а не скрыты.", "Выбор самого эпизода выполнен ретроспективно; его наличие не является информацией игрока."] };
  }
  const observed = await readStateWindow(pool, storage, datasetId, at - 5, at, "omniscient");
  const states = PLAYER_SLOTS.map(playerSlot => {
    const rows = observed.filter(s => s.playerSlot === playerSlot).sort((a,b) => b.gameTimeSeconds - a.gameTimeSeconds);
    const latest = rows[0];
    const state = latest && rows.filter(s => s.gameTimeSeconds === latest.gameTimeSeconds).length === 1 ? latest : null;
    return { playerSlot, state, ageSeconds: state ? at - state.gameTimeSeconds : null, mapPosition: episodeMapPoint(state) };
  });
  const events: GameEvent[] = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind='event' AND game_time_seconds BETWEEN $2 AND $3 ORDER BY game_time_seconds,id", [datasetId, window.startSeconds, window.endSeconds])).rows.map(r => r.payload);
  return { ...base, states, events, facts: [...new Set(detail.results.flatMap(r => r.facts))],
    limitations: ["Полный ретроспективный обзор. Не является информацией игрока на момент решения.", "Показано последнее наблюдение не позже выбранного времени с возрастом до 5 секунд. Пропуски не интерполируются.", ...new Set(detail.results.flatMap(r => r.limitations))] };
}
