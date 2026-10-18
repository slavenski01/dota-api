import { type Pool } from "@dota/persistence";
import type { PlayerSlot } from "@dota/contracts";
import { readMatchExplorer, validateViewPoint, type ViewMode } from "./match-explorer.js";
import { JobError } from "./index.js";
import { readEpisode } from './analysis.js';
import { episodeViewingWindow } from './episode-window.js';

export interface NoteCoachReference {reportId:string;analysisId:string;episodeId:string}
export interface MatchNote { id: string; datasetId: string; matchId: string; accountId: string; playerSlot: PlayerSlot; time: number; mode: ViewMode; content: string; createdAt: string; coach:NoteCoachReference|null }
const fields = `id,dataset_id AS "datasetId",match_id AS "matchId",account_id AS "accountId",player_slot AS "playerSlot",game_time_seconds AS time,mode,content,created_at AS "createdAt",
  CASE WHEN coach_report_id IS NULL THEN NULL ELSE jsonb_build_object('reportId',coach_report_id,'analysisId',coach_analysis_id,'episodeId',episode_id) END AS coach`;
export async function readMatchNotes(pool: Pool, datasetId: string, accountId: string, mode: ViewMode): Promise<MatchNote[]> {
  const view = await readMatchExplorer(pool,datasetId,accountId);
  validateViewPoint(view,mode,view.window.startSeconds);
  return (await pool.query(`SELECT ${fields} FROM dota.match_notes WHERE dataset_id=$1 AND account_id=$2 AND mode=$3 ORDER BY game_time_seconds,id`,[datasetId,accountId,mode])).rows;
}
export async function saveMatchNote(pool: Pool, datasetId: string, accountId: string, input: unknown): Promise<MatchNote> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new JobError("invalid_note");
  const value = input as Record<string,unknown>;
  if (Object.keys(value).some(k=>!["id","playerSlot","time","mode","content","coach"].includes(k)) || typeof value.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) || typeof value.playerSlot !== "number" || typeof value.time !== "number" || typeof value.mode !== "string" || !["decision","retrospective"].includes(value.mode) || typeof value.content !== "string" || !value.content.trim() || value.content.length > 2000) throw new JobError("invalid_note");
  const view = await readMatchExplorer(pool,datasetId,accountId), mode = value.mode as ViewMode, content = value.content.trim();
  validateViewPoint(view,mode,value.time,value.playerSlot);
  let coach:NoteCoachReference|null=null;
  if(value.coach!==undefined&&value.coach!==null){
    const ref=value.coach as NoteCoachReference;
    if(typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).length!==3||Object.keys(ref).some(k=>!['reportId','analysisId','episodeId'].includes(k))||typeof ref.reportId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ref.reportId)||typeof ref.analysisId!=='string'||typeof ref.episodeId!=='string')throw new JobError('invalid_note');
    const report=(await pool.query("SELECT id FROM dota.coach_runs WHERE id=$1 AND dataset_id=$2 AND analysis_id=$3 AND player_slot=$4 AND status='ready' AND result->'output'->'episodes' @> $5::jsonb",[ref.reportId,datasetId,ref.analysisId,view.player.playerSlot,JSON.stringify([{episodeId:ref.episodeId}])])).rows[0];
    if(!report)throw new JobError('coach_report_not_found');
    const detail=await readEpisode(pool,datasetId,accountId,ref.episodeId),window=episodeViewingWindow(detail.episode,view.window);
    if(detail.analysisId!==ref.analysisId||value.time<window.startSeconds||value.time>window.endSeconds)throw new JobError('invalid_note');
    coach={reportId:ref.reportId,analysisId:ref.analysisId,episodeId:ref.episodeId};
  }
  const params = [value.id,datasetId,view.match.matchId,accountId,value.playerSlot,value.time,mode,content,coach?.reportId??null,coach?.analysisId??null,coach?.episodeId??null];
  const inserted = await pool.query(`INSERT INTO dota.match_notes(id,dataset_id,match_id,account_id,player_slot,game_time_seconds,mode,content,coach_report_id,coach_analysis_id,episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING RETURNING ${fields}`,params);
  if (inserted.rows[0]) return inserted.rows[0];
  const existing: MatchNote | undefined = (await pool.query(`SELECT ${fields} FROM dota.match_notes WHERE id=$1 AND dataset_id=$2 AND account_id=$3`,[value.id,datasetId,accountId])).rows[0];
  if (!existing || existing.playerSlot !== value.playerSlot || existing.time !== value.time || existing.mode !== mode || existing.content !== content || existing.coach?.reportId!==coach?.reportId || existing.coach?.episodeId!==coach?.episodeId || existing.coach?.analysisId!==coach?.analysisId) throw new JobError("note_conflict");
  return existing;
}
