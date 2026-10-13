import { analyse, analysisContext, RULES_VERSION, type AnalysisRun } from "@dota/analysis";
import { insertRecords, normalizePlayerId, type Pool } from "@dota/persistence";
import { datasetValidation } from "./dataset-validation.js";
import { JobError } from "./index.js";
import type { StageHandler } from "./workflow.js";

export function analysisHandler(pool: Pool): StageHandler {
  return async ({ row, signal }) => {
    if (!row.dataset_id) throw new JobError("dataset_required");
    if (row.versions.rules !== RULES_VERSION) return { unavailable: "analysis_version_unsupported" };
    const validation = await datasetValidation(pool, row.dataset_id);
    if (!validation || !validation.complete) throw new JobError("dataset_not_validated");
    const records = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND kind IN ('match','participant','event','coverage') ORDER BY kind,id", [row.dataset_id])).rows.map(r => r.payload);
    const players = records.filter(r => r.kind === "participant" && r.accountId !== null && r.accountId === row.account_id);
    if (players.length !== 1) return { unavailable: "analysis_player_unresolved", limitations: ["Не удалось однозначно сопоставить выбранный аккаунт участнику набора."] };
    const context = analysisContext(records, validation, players[0].playerSlot);
    const run = analyse(context, row.analysis_options, row.versions);
    signal.throwIfAborted();
    return { analysisId: run.id, reportStatus: "not_requested", limitations: ["Автоматический отбор эпизодов выполнен. Для оценки откройте эпизод и сохраните ручную проверку. Текстовый отчёт пока не подключён.",
      ...(run.completeness === "partial" ? ["Часть правил пропущена или имеет неполные окна данных; причины доступны в результате анализа."] : [])],
      commit: async client => {
        const inserted = await client.query("INSERT INTO dota.analysis_runs(id,dataset_id,match_id,player_slot,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id", [run.id, run.datasetId, run.matchId, run.playerSlot, run]);
        if (inserted.rowCount) await insertRecords(client, run.datasetId, run.episodes.map(e => e.episode));
      } };
  };
}
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export async function readAnalysis(pool: Pool, datasetId: string, accountId: string, analysisId: string | null = null): Promise<AnalysisRun> {
  normalizePlayerId(accountId, "account");
  if (!validId(datasetId) || analysisId !== null && !validId(analysisId)) throw new JobError("invalid_analysis_request");
  const result = await pool.query("SELECT a.payload FROM dota.analysis_runs a JOIN dota.records p ON p.dataset_id=a.dataset_id AND p.kind='participant' AND p.player_slot=a.player_slot WHERE a.dataset_id=$1 AND p.payload->>'accountId'=$2 AND ($3::text IS NULL OR a.id=$3) ORDER BY a.created_at DESC,a.id LIMIT 1", [datasetId, accountId, analysisId]);
  if (!result.rows.length) throw new JobError("analysis_not_found");
  return result.rows[0].payload;
}
export async function readEpisode(pool: Pool, datasetId: string, accountId: string, episodeId: string) {
  normalizePlayerId(accountId, "account");
  if (!validId(datasetId) || !validId(episodeId)) throw new JobError("invalid_analysis_request");
  const result = await pool.query("SELECT a.payload FROM dota.analysis_runs a JOIN dota.records p ON p.dataset_id=a.dataset_id AND p.kind='participant' AND p.player_slot=a.player_slot WHERE a.dataset_id=$1 AND p.payload->>'accountId'=$2 AND a.payload->'episodes' @> $3::jsonb", [datasetId, accountId, JSON.stringify([{ episode: { id: episodeId } }])]);
  const run: AnalysisRun | undefined = result.rows[0]?.payload;
  const selected = run?.episodes.find(e => e.episode.id === episodeId);
  if (!run || !selected) throw new JobError("episode_not_found");
  const evidence = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND id=ANY($2::text[]) ORDER BY kind,id", [datasetId, selected.episode.evidenceIds])).rows.map(r => r.payload);
  if (evidence.length !== selected.episode.evidenceIds.length) throw new JobError("episode_evidence_missing");
  return { mode: "retrospective", analysisId: run.id, ...selected, evidence };
}
