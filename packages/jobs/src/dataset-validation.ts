import { validateDataset, type DatasetValidation } from "@dota/analysis";
import type { Pool } from "@dota/persistence";
import { JobError } from "./index.js";
import type { StageHandler } from "./workflow.js";

export function datasetValidationHandler(pool: Pool): StageHandler {
  return async ({ row, signal }) => {
    if (!row.dataset_id) throw new JobError("dataset_required");
    const dataset = (await pool.query("SELECT d.*,p.artifact_id,p.parser_version,p.outcome,p.diagnostics FROM dota.datasets d JOIN dota.parser_runs p ON p.id=d.parser_run_id WHERE d.id=$1 AND d.match_id=$2", [row.dataset_id,row.match_id])).rows[0];
    if (!dataset) throw new JobError("parser_run_required");
    const records = (await pool.query("SELECT payload FROM dota.records WHERE dataset_id=$1 ORDER BY kind,id", [row.dataset_id])).rows.map(r => r.payload);
    const report = validateDataset(records, { datasetId: row.dataset_id, matchId: row.match_id, artifactId: dataset.artifact_id,
      inputSha256: dataset.input_sha256, inputVerified: dataset.diagnostics.inputVerified === true,
      parserCompleted: dataset.outcome === "complete" && dataset.diagnostics.transportComplete === true,
      parserVersion: dataset.parser_version });
    signal.throwIfAborted();
    return { ...(report.complete ? { dataLevel: records.some(r => r.kind === "hero_state") ? "replay_context" as const : "events" as const } : { unavailable: "dataset_invalid" }),
      limitations: ["Пригодность определяется отдельно по полю, участнику и временному окну; неподтверждённые поля блокируют зависимые выводы."],
      commit: async client => { await client.query("INSERT INTO dota.dataset_checks(dataset_id,version,payload) VALUES ($1,$2,$3)", [row.dataset_id, report.version, report]); } };
  };
}
export async function datasetValidation(pool: Pool, datasetId: string): Promise<DatasetValidation | null> {
  return (await pool.query("SELECT payload FROM dota.dataset_checks WHERE dataset_id=$1", [datasetId])).rows[0]?.payload ?? null;
}
