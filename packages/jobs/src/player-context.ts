import { decisionContext } from "@dota/analysis";
import { readStateWindow, type Pool, type Storage } from "@dota/persistence";
import type { PlayerSlot } from "@dota/contracts";
import { JobError } from "./index.js";

export async function readDatasetContext(pool: Pool, storage: Storage, datasetId: string, mode: "decision" | "retrospective", time: number, playerSlot: PlayerSlot) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(datasetId) || !Number.isFinite(time) || ![0,1,2,3,4,128,129,130,131,132].includes(playerSlot) || !["decision","retrospective"].includes(mode)) throw new JobError("invalid_context_request");
  const checked = (await pool.query("SELECT c.payload->'complete' AS complete FROM dota.dataset_checks c JOIN dota.datasets d ON d.id=c.dataset_id WHERE d.id=$1", [datasetId])).rows[0];
  if (!checked) throw new JobError("dataset_not_validated");
  if (checked.complete !== true) throw new JobError("dataset_invalid");
  const team = playerSlot < 128 ? "radiant" : "dire";
  // No verified visibility producer exists yet. Stored raw bits and modifiers are never inputs.
  // Do not even read omniscient segments for this mode: their sampling density depends on future deaths.
  if (mode === "decision") return { ...decisionContext([], team, playerSlot, time),
    limitations: ["Командный обзор, smoke и обнаружение пока не подтверждены. Текущие сведения и последняя известная позиция остаются неизвестными."] };
  const states = await readStateWindow(pool, storage, datasetId, time-60, time, "omniscient");
  return { mode: "retrospective" as const, perspective: "omniscient", window: { startSeconds: time-60, endSeconds: time },
    label: "Полное ретроспективное состояние. Не является информацией игрока на момент решения.", states };
}
