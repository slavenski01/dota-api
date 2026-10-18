import type { Pool } from "@dota/persistence";
import type { PgBoss } from "./index.js";
import { JobError } from "./index.js";
import { enqueueCoach, readCoachRuns } from "./coach.js";
import { buildCoachInput, type CoachContext, type CoachOutput } from "./coach-context.js";
import { coachInstructions, type CoachUsage } from "./coach-provider.js";

export interface CoachReportView {
  id: string; version: number; status: string; context: CoachContext; output: CoachOutput | null; error: string | null;
  model: string; reasoning: string; cliVersion: string | null; usage: CoachUsage | null; durationMs: number | null;
  createdAt: string; finishedAt: string | null; stale: boolean; staleReasons: string[];
  versions: { schema: string; contextSha256: string; skillSha256: string };
}
export async function requestCoachReport(pool: Pool, boss: PgBoss, datasetId: string, accountId: string, analysisId: string, value: unknown) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['requestKey','settings'].includes(k))) throw new JobError('coach_invalid_request');
  const v=value as {requestKey: string; settings: unknown};
  const input=await buildCoachInput(pool,datasetId,accountId,analysisId,v.settings);
  return enqueueCoach(pool,boss,{datasetId,accountId,analysisId,requestKey:v.requestKey},input);
}
export async function readCoachReports(pool: Pool, boss: PgBoss, datasetId: string, accountId: string, analysisId: string): Promise<CoachReportView[]> {
  const rows=await readCoachRuns(pool,boss,datasetId,accountId,analysisId);
  const skill=await coachInstructions();
  const latest=(await pool.query('SELECT episode_id,max(version)::int AS version FROM dota.episode_reviews WHERE dataset_id=$1 GROUP BY episode_id',[datasetId])).rows;
  const reviews=new Map(latest.map(r=>[r.episode_id,r.version]));
  return rows.map(row=>{
    const c=row.input.context as CoachContext;
    const staleReasons:string[]=[];
    if(c.episodes.some(e=>(reviews.get(e.id)??0)!==(e.review?.version??0))) staleReasons.push('review_changed');
    if(row.input.instructions.sha256!==skill.sha256) staleReasons.push('method_changed');
    const result=row.result as {output: CoachOutput;cliVersion:string}|null;
    return {id:row.id,version:row.version,status:row.status,context:c,output:row.status==='ready'?result!.output:null,error:row.error_code,
      model:row.config.model,reasoning:row.config.reasoning,cliVersion:result?.cliVersion??null,usage:row.usage,durationMs:row.duration_ms,
      createdAt:new Date(row.created_at).toISOString(),finishedAt:row.finished_at?new Date(row.finished_at).toISOString():null,
      stale:staleReasons.length>0,staleReasons,versions:{schema:row.input.schemaVersion,contextSha256:row.input.contextSha256,skillSha256:row.input.instructions.sha256}};
  });
}
