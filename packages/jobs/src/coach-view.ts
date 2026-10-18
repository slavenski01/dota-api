import type { Pool } from "@dota/persistence";
import type { PgBoss } from "./index.js";
import { JobError } from "./index.js";
import { enqueueCoach, readCoachRuns } from "./coach.js";
import { buildCoachInput, COACH_SCHEMA_VERSION, type CoachContext, type CoachOutput } from "./coach-context.js";
import { coachHash, coachInstructions, type CoachUsage } from "./coach-provider.js";
import { readEpisode } from './analysis.js';
import { readMatchExplorer, type ViewMode } from './match-explorer.js';
import { episodeViewingWindow } from './episode-window.js';
import type { Review } from '@dota/contracts';

export interface CoachReportView {
  id: string; version: number; status: string; context: CoachContext; output: CoachOutput | null; error: string | null;
  model: string; reasoning: string; cliVersion: string | null; usage: CoachUsage | null; durationMs: number | null;
  createdAt: string; finishedAt: string | null; stale: boolean; staleReasons: string[];
  versions: { schema: string; contextSha256: string; skillSha256: string };
  reviewSources: {episodeId:string;review:Review|null}[];
}
export async function requestCoachReport(pool: Pool, boss: PgBoss, datasetId: string, accountId: string, analysisId: string, value: unknown) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['requestKey','settings'].includes(k))) throw new JobError('coach_invalid_request');
  const v=value as {requestKey: string; settings: unknown};
  const input=await buildCoachInput(pool,datasetId,accountId,analysisId,v.settings);
  return enqueueCoach(pool,boss,{datasetId,accountId,analysisId,requestKey:v.requestKey},input);
}
export async function readCoachReports(pool: Pool, boss: PgBoss, datasetId: string, accountId: string, analysisId: string, reportId?: string): Promise<CoachReportView[]> {
  const rows=await readCoachRuns(pool,boss,datasetId,accountId,analysisId,reportId);
  const skill=await coachInstructions();
  const latest=(await pool.query('SELECT episode_id,max(version)::int AS version FROM dota.episode_reviews WHERE dataset_id=$1 GROUP BY episode_id',[datasetId])).rows;
  const reviews=new Map(latest.map(r=>[r.episode_id,r.version]));
  const history:{episode_id:string;payload:Review}[]=(await pool.query('SELECT episode_id,payload FROM dota.episode_reviews WHERE dataset_id=$1',[datasetId])).rows;
  return rows.map(row=>{
    const c=row.input.context as CoachContext;
    if (row.input.schemaVersion!==COACH_SCHEMA_VERSION || c.schemaVersion!==COACH_SCHEMA_VERSION || coachHash(c)!==row.input.contextSha256) throw new JobError('coach_version_unsupported');
    const staleReasons:string[]=[];
    if(c.episodes.some(e=>(reviews.get(e.id)??0)!==(e.review?.version??0))) staleReasons.push('review_changed');
    if(row.input.instructions.sha256!==skill.sha256) staleReasons.push('method_changed');
    const result=row.result as {output: CoachOutput;cliVersion:string}|null;
    const reviewSources=c.episodes.filter(e=>e.review).map(e=>{
      const snapshot=e.review!,saved=history.find(r=>r.episode_id===e.id&&r.payload.version===snapshot.version)?.payload;
      const matches=saved&&saved.status===snapshot.status&&saved.explanation===snapshot.explanation&&saved.alternative===snapshot.alternative;
      return {episodeId:e.id,review:matches?saved:null};
    });
    return {id:row.id,version:row.version,status:row.status,context:c,output:row.status==='ready'?result!.output:null,error:row.error_code,
      model:row.config.model,reasoning:row.config.reasoning,cliVersion:result?.cliVersion??null,usage:row.usage,durationMs:row.duration_ms,
      createdAt:new Date(row.created_at).toISOString(),finishedAt:row.finished_at?new Date(row.finished_at).toISOString():null,
      stale:staleReasons.length>0,staleReasons,reviewSources,versions:{schema:row.input.schemaVersion,contextSha256:row.input.contextSha256,skillSha256:row.input.instructions.sha256}};
  });
}

export interface CoachEpisodeView {
  matchId: string; datasetId: string; analysisId: string; reportId: string; version: number; episodeId: string;
  playerSlot: number; time: number; window: {startSeconds:number;endSeconds:number}; requestedWindow: {startSeconds:number;endSeconds:number};
  retrospective: {hypothesis:string;question:string;facts:CoachContext['facts'];evidence:CoachContext['evidence'];limitations:string[]} | null;
}
export async function readCoachEpisode(pool: Pool, boss: PgBoss, datasetId: string, accountId: string, analysisId: string, reportId: string, episodeId: string, mode: ViewMode): Promise<CoachEpisodeView> {
  if (!['decision','retrospective'].includes(mode)) throw new JobError('coach_invalid_request');
  const report=(await readCoachReports(pool,boss,datasetId,accountId,analysisId,reportId))[0]!;
  const c=report.context, snapshot=c.episodes.find(e=>e.id===episodeId), recommendation=report.output?.episodes.find(e=>e.episodeId===episodeId);
  if (report.status!=='ready'||!snapshot||!recommendation) throw new JobError('coach_episode_unavailable');
  const detail=await readEpisode(pool,datasetId,accountId,episodeId), view=await readMatchExplorer(pool,datasetId,accountId);
  if (c.datasetId!==datasetId||c.analysisId!==analysisId||detail.analysisId!==analysisId||c.matchId!==view.match.matchId||c.playerSlot!==view.player.playerSlot||detail.episode.playerSlot!==c.playerSlot||snapshot.time!==detail.episode.decisionTimeSeconds||coachHash(snapshot.window)!==coachHash(detail.episode.window)) throw new JobError('coach_version_unsupported');
  const facts=c.facts.filter(f=>recommendation.factIds.includes(f.id)), ids=new Set(facts.flatMap(f=>f.evidenceIds));
  const evidence=c.evidence.filter(e=>ids.has(e.id));
  const records=(await pool.query('SELECT payload FROM dota.records WHERE dataset_id=$1 AND id=ANY($2::text[])',[datasetId,[...ids]])).rows.map(r=>r.payload);
  if (evidence.length!==ids.size || evidence.some(e=>!records.some(r=>r.id===e.id&&r.matchId===c.matchId&&coachHash(r)===e.sha256))) throw new JobError('coach_evidence_missing');
  return {matchId:c.matchId,datasetId,analysisId,reportId,version:report.version,episodeId,playerSlot:c.playerSlot,time:snapshot.time,
    window:episodeViewingWindow(detail.episode,view.window),requestedWindow:snapshot.window,
    retrospective:mode==='retrospective'?{hypothesis:recommendation.hypothesis,question:recommendation.question,facts,evidence,limitations:snapshot.limitations}:null};
}
