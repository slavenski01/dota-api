import type { GameEvent, Match, Participant, PlayerSlot } from "@dota/contracts";
import { PLAYER_SLOTS, decisionContext } from "@dota/analysis";
import { normalizePlayerId, readStateWindow, type Pool, type Storage } from "@dota/persistence";
import { JobError } from "./index.js";
import { datasetValidation } from "./dataset-validation.js";
import { EPISODE_MAP, episodeMapPoint } from "./episode-map.js";
import type { EpisodeFrame } from "./episode-view.js";

export type ViewMode = "decision" | "retrospective";
export type MatchFrame = Pick<EpisodeFrame, "datasetId" | "matchId" | "accountId" | "mode" | "time" | "playerSlot" | "window" | "heroes" | "states" | "map" | "limitations">;
export async function readMatchExplorer(pool: Pool, datasetId: string, accountId: string) {
  normalizePlayerId(accountId, "account");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(datasetId)) throw new JobError("invalid_analysis_request");
  const records = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind IN ('match','participant') ORDER BY player_slot", [datasetId])).rows.map(r => r.payload);
  const players: Participant[] = records.filter(r => r.kind === "participant");
  const selected = players.filter(p => p.accountId === accountId);
  const match: Match | undefined = records.find(r => r.kind === "match");
  if (!match || selected.length !== 1) throw new JobError("analysis_not_found");
  const validation = await datasetValidation(pool, datasetId);
  if (!validation?.complete) throw new JobError("dataset_not_validated");
  const bounds = (await pool.query(`SELECT min(start_time) AS start, max(end_time) AS end FROM (
    SELECT min(game_time_seconds) AS start_time, max(game_time_seconds) AS end_time FROM dota.records WHERE dataset_id=$1 AND kind IN ('event','hero_state')
    UNION ALL SELECT min(start_seconds),max(end_seconds) FROM dota.state_segments WHERE dataset_id=$1 AND perspective='omniscient'
  ) bounds`, [datasetId])).rows[0];
  const timeCoverage = validation.coverage.filter(c => c.field === "time" && c.status === "present");
  const window = { startSeconds: Math.min(0, bounds.start ?? 0, ...timeCoverage.map(c => c.window.startSeconds)),
    endSeconds: Math.max(match.durationSeconds ?? 0, bounds.end ?? 0, ...timeCoverage.map(c => c.window.endSeconds)) };
  return { datasetId, match, player: selected[0]!, players, window,
    coverage: validation.coverage, limitations: ["Доступные проверенные данные. Пропуски не означают отсутствие событий.", "Карта приблизительная; командный обзор и готовность способностей не подтверждены."] };
}
export type MatchExplorer = Awaited<ReturnType<typeof readMatchExplorer>>;
export function validateViewPoint(view: MatchExplorer, mode: ViewMode, time: number, slot: number = view.player.playerSlot): asserts slot is PlayerSlot {
  if (!["decision", "retrospective"].includes(mode) || !Number.isFinite(time) || time < view.window.startSeconds || time > view.window.endSeconds || !view.players.some(p => p.playerSlot === slot)) throw new JobError("invalid_context_request");
}
export async function readMatchFrame(pool: Pool, storage: Storage, datasetId: string, accountId: string, mode: ViewMode, time: number): Promise<MatchFrame> {
  const view = await readMatchExplorer(pool, datasetId, accountId);
  validateViewPoint(view, mode, time);
  const base = { datasetId, matchId: view.match.matchId, accountId, mode, time, playerSlot: view.player.playerSlot,
    window: view.window, heroes: view.players.map(p => ({ playerSlot: p.playerSlot, heroId: p.heroId })), map: EPISODE_MAP };
  if (mode === "decision") {
    const context = decisionContext([], view.player.team, view.player.playerSlot, time);
    return { ...base, states: context.states.map(state => ({ playerSlot: state.playerSlot, state, ageSeconds: null, mapPosition: null })),
      limitations: ["Перспектива команды выбранного игрока. Обзор и обнаружение не подтверждены: состояния неизвестны."] };
  }
  const observed = await readStateWindow(pool, storage, datasetId, time - 5, time, "omniscient");
  const states = PLAYER_SLOTS.map(playerSlot => {
    const rows = observed.filter(s => s.playerSlot === playerSlot).sort((a,b) => b.gameTimeSeconds - a.gameTimeSeconds);
    const latest = rows[0];
    const state = latest && rows.filter(s => s.gameTimeSeconds === latest.gameTimeSeconds).length === 1 ? latest : null;
    return { playerSlot, state, ageSeconds: state ? time - state.gameTimeSeconds : null, mapPosition: episodeMapPoint(state) };
  });
  return { ...base, states, limitations: ["Полный ретроспективный обзор. Не показывает, что игрок знал в момент решения.", "Последнее наблюдение не позже выбранного времени, возрастом до 5 секунд. Пропуски и промежуточные положения не интерполируются."] };
}
export interface EventFilters { mode: ViewMode; type?: GameEvent["data"]["type"]; playerSlot?: number; cursor?: string; limit?: number }
export async function readMatchEvents(pool: Pool, datasetId: string, accountId: string, filters: EventFilters) {
  const view = await readMatchExplorer(pool, datasetId, accountId);
  const limit = filters.limit ?? 100, type = filters.type ?? null, slot = filters.playerSlot ?? null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || type !== null && !["death","item","objective","fight"].includes(type) || slot !== null && !view.players.some(p => p.playerSlot === slot) || !["decision","retrospective"].includes(filters.mode)) throw new JobError("invalid_context_request");
  let after: { time: number; id: string } | null = null;
  if (filters.cursor !== undefined) {
    try {
      if (filters.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(filters.cursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(filters.cursor, "base64url").toString("utf8"));
      if (cursor.datasetId !== datasetId || cursor.type !== type || cursor.slot !== slot || !Number.isFinite(cursor.time) || typeof cursor.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cursor.id)) throw new Error();
      after = cursor;
    } catch { throw new JobError("invalid_context_request"); }
  }
  if (filters.mode === "decision") return { datasetId, mode: filters.mode, events: [] as GameEvent[], nextCursor: null,
    limitation: "Журнал полного обзора недоступен в перспективе команды: видимость событий не подтверждена." };
  const rows: GameEvent[] = (await pool.query(`SELECT r.payload FROM dota.records r WHERE r.dataset_id=$1 AND r.kind='event'
    AND ($2::text IS NULL OR r.payload->'data'->>'type'=$2)
    AND ($3::smallint IS NULL OR EXISTS (SELECT 1 FROM dota.record_participants p WHERE p.dataset_id=r.dataset_id AND p.record_id=r.id AND p.player_slot=$3))
    AND ($4::double precision IS NULL OR (r.game_time_seconds,r.id COLLATE "C") > ($4,$5::text COLLATE "C"))
    ORDER BY r.game_time_seconds,r.id COLLATE "C" LIMIT $6`, [datasetId,type,slot,after?.time ?? null,after?.id ?? null,limit+1])).rows.map(r => r.payload);
  const events = rows.slice(0,limit), last = events.at(-1);
  return { datasetId, mode: filters.mode, events,
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ datasetId, type, slot, time: last.gameTimeSeconds, id: last.id })).toString("base64url") : null,
    limitation: "Журнал может быть неполным. Фильтр героя включает только явно связанных участников (жертва/убийца, владелец предмета, участник боя); командные объекты не приписываются герою." };
}
export async function readMatchSeries(pool: Pool, datasetId: string, accountId: string, slot: number, mode: ViewMode) {
  const view = await readMatchExplorer(pool, datasetId, accountId);
  validateViewPoint(view, mode, view.window.startSeconds, slot);
  const series: { time: number; hp: number | null; mana: number | null; evidenceId: string }[] = [];
  if (mode === "retrospective") {
    const rows = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind='hero_state' AND player_slot=$2 AND payload->'perspective'->>'mode'='omniscient' ORDER BY game_time_seconds,id", [datasetId,slot])).rows;
    const counts = new Map<number, number>();
    for (const { payload: s } of rows) counts.set(s.gameTimeSeconds, (counts.get(s.gameTimeSeconds) ?? 0) + 1);
    for (const { payload: s } of rows) series.push({ time: s.gameTimeSeconds, evidenceId: s.id,
      hp: counts.get(s.gameTimeSeconds) === 1 && s.hp.status === "known" && s.hp.observedAtSeconds === s.gameTimeSeconds ? s.hp.value : null,
      mana: counts.get(s.gameTimeSeconds) === 1 && s.mana.status === "known" && s.mana.observedAtSeconds === s.gameTimeSeconds ? s.mana.value : null });
  }
  return { datasetId, playerSlot: slot, mode, series };
}
