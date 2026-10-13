import { type Pool } from "@dota/persistence";
import type { PlayerSlot } from "@dota/contracts";
import { readMatchExplorer, validateViewPoint, type ViewMode } from "./match-explorer.js";
import { JobError } from "./index.js";

export interface MatchNote { id: string; datasetId: string; matchId: string; accountId: string; playerSlot: PlayerSlot; time: number; mode: ViewMode; content: string; createdAt: string }
const fields = `id,dataset_id AS "datasetId",match_id AS "matchId",account_id AS "accountId",player_slot AS "playerSlot",game_time_seconds AS time,mode,content,created_at AS "createdAt"`;
export async function readMatchNotes(pool: Pool, datasetId: string, accountId: string, mode: ViewMode): Promise<MatchNote[]> {
  const view = await readMatchExplorer(pool,datasetId,accountId);
  validateViewPoint(view,mode,view.window.startSeconds);
  return (await pool.query(`SELECT ${fields} FROM dota.match_notes WHERE dataset_id=$1 AND account_id=$2 AND mode=$3 ORDER BY game_time_seconds,id`,[datasetId,accountId,mode])).rows;
}
export async function saveMatchNote(pool: Pool, datasetId: string, accountId: string, input: unknown): Promise<MatchNote> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new JobError("invalid_note");
  const value = input as Record<string,unknown>;
  if (Object.keys(value).some(k=>!["id","playerSlot","time","mode","content"].includes(k)) || typeof value.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) || typeof value.playerSlot !== "number" || typeof value.time !== "number" || !["decision","retrospective"].includes(String(value.mode)) || typeof value.content !== "string" || !value.content.trim() || value.content.length > 2000) throw new JobError("invalid_note");
  const view = await readMatchExplorer(pool,datasetId,accountId), mode = value.mode as ViewMode, content = value.content.trim();
  validateViewPoint(view,mode,value.time,value.playerSlot);
  const params = [value.id,datasetId,view.match.matchId,accountId,value.playerSlot,value.time,mode,content];
  const inserted = await pool.query(`INSERT INTO dota.match_notes(id,dataset_id,match_id,account_id,player_slot,game_time_seconds,mode,content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING ${fields}`,params);
  if (inserted.rows[0]) return inserted.rows[0];
  const existing: MatchNote | undefined = (await pool.query(`SELECT ${fields} FROM dota.match_notes WHERE id=$1 AND dataset_id=$2 AND account_id=$3`,[value.id,datasetId,accountId])).rows[0];
  if (!existing || existing.playerSlot !== value.playerSlot || existing.time !== value.time || existing.mode !== mode || existing.content !== content) throw new JobError("note_conflict");
  return existing;
}
