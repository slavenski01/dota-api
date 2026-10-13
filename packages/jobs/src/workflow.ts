import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { type ContractRecord, validateRecord } from "@dota/contracts";
import { transaction, artifactById, type Pool, type PoolClient, type Storage, selectedProfile, normalizePlayerId } from "@dota/persistence";
import { PgBoss, QUEUE, JobError, type WorkContext } from "./index.js";
import { analysisOptions, type AnalysisOptions } from "@dota/analysis";

type JobRecord = Extract<ContractRecord, { kind: "job" }>;
export const STAGES = ["resolving", "downloading", "parsing", "validating", "analysing"] as const;
export type Stage = typeof STAGES[number];
const TERMINAL = new Set(["ready", "failed", "unavailable", "cancelled"]);
export interface PipelineVersions {
  parser: string; normalization: string; rules: string; skillSha256: string;
  model: string | null; contextSha256: string | null; configSha256: string;
}
export interface WorkflowRequest { matchId: string; artifactId?: string; accountId?: string; uploadId?: string; analysisOptions?: AnalysisOptions | null }
export interface WorkflowRow {
  id: string; match_id: string; queue_job_id: string; payload: JobRecord;
  artifact_id: string | null; dataset_id: string | null; input_sha256: string | null; versions: PipelineVersions;
  account_id: string | null; upload_id: string | null; progress: import("./replay.js").ReplayProgress | null;
  analysis_options: AnalysisOptions | null;
}
const db = (client: PoolClient) => ({ executeSql: (text: string, values?: unknown[]) => client.query(text, values) });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
export async function defaultVersions(): Promise<PipelineVersions> {
  const root = new URL("../../../.agents/skills/dota-match-analysis/", import.meta.url);
  const names = ["SKILL.md", ...(await readdir(new URL("references/", root))).filter(name=>name.endsWith(".md")).sort().map(name=>`references/${name}`)];
  const skill = await Promise.all(names.map(async name=>`${name}\n${await readFile(new URL(name,root),"utf8")}`));
  return { parser: "normalized-v1/clarity-5.0.1", normalization: "e05-v4", rules: "not-connected", skillSha256: hash(skill.join("\n")), model: null, contextSha256: null, configSha256: hash("e05-normalization-v4") };
}
function validateVersions(versions: PipelineVersions): void {
  if (![versions.parser,versions.normalization,versions.rules].every(value=>typeof value==="string" && value.length>0 && value.length<=128)
    || ![versions.skillSha256,versions.configSha256].every(value=>/^[a-f0-9]{64}$/.test(value))
    || !(versions.model===null || typeof versions.model==="string")
    || !(versions.contextSha256===null || /^[a-f0-9]{64}$/.test(versions.contextSha256))) throw new JobError("invalid_pipeline_versions");
}
export async function requestWorkflow(pool: Pool, boss: PgBoss, request: WorkflowRequest, versions: PipelineVersions): Promise<{ id: string; reused: boolean }> {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(request.matchId) || Object.keys(request).some(key=>!["matchId","artifactId","accountId","uploadId","analysisOptions"].includes(key))) throw new JobError("invalid_request");
  if(request.artifactId!==undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.artifactId)) throw new JobError("invalid_request");
  validateVersions(versions);
  let options: AnalysisOptions | null;
  try { options = analysisOptions(request.analysisOptions); } catch { throw new JobError("invalid_analysis_options"); }
  versions = { ...versions, configSha256: hash(canonical({ pipelineConfig: versions.configSha256, analysisOptions: options })) };
  const accountId = request.accountId !== undefined ? normalizePlayerId(request.accountId,"account").accountId : (await selectedProfile(pool))?.accountId ?? null;
  const upload = request.uploadId ? await artifactById(pool,request.uploadId) : null;
  if (upload && (upload.matchId !== request.matchId || upload.mediaType !== "application/x-dota-upload")) throw new JobError("artifact_match_mismatch");
  const file = request.artifactId ? await artifactById(pool,request.artifactId) : null;
  if (file && file.matchId !== request.matchId) throw new JobError("artifact_match_mismatch");
  const fingerprint=hash(canonical({matchId:request.matchId,inputSha256:file?.sha256 ?? upload?.sha256 ?? null,accountId,versions}));
  return transaction(pool,async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,731082))",[request.matchId]);
    const existing=await client.query("SELECT id,analysis_options,account_id FROM dota.workflow_jobs WHERE (match_id=$1 AND status IN ('queued','resolving','downloading','parsing','validating','analysing')) OR ($3::boolean AND request_sha256=$2 AND status='ready') ORDER BY created_at DESC LIMIT 1",[request.matchId,fingerprint,file!==null]);
    if(existing.rows.length) {
      if (canonical(existing.rows[0].analysis_options) !== canonical(options) || existing.rows[0].account_id !== accountId) throw new JobError("analysis_options_conflict");
      return {id:existing.rows[0].id,reused:true};
    }
    await client.query("INSERT INTO dota.matches(match_id) VALUES ($1) ON CONFLICT DO NOTHING",[request.matchId]);
    const previous=(await client.query("SELECT d.id FROM dota.datasets d WHERE d.match_id=$1 AND EXISTS (SELECT 1 FROM dota.records r WHERE r.dataset_id=d.id AND r.kind='match') ORDER BY d.created_at DESC LIMIT 1",[request.matchId])).rows[0];
    const summary = previous || (await client.query("SELECT 1 FROM dota.player_matches WHERE match_id=$1 AND account_id=$2",[request.matchId,accountId])).rowCount;
    const id=randomUUID(), queueId=randomUUID();
    const payload=validateRecord({schemaVersion:"0.1.0",kind:"job",id,matchId:request.matchId,
      provenance:{source:"derived",acquiredAt:new Date().toISOString(),artifactId:request.artifactId??null,sourceVersion:"e02-v1",inputIds:previous?[previous.id]:[]},
      status:"queued",dataLevel:summary?"summary":"none",reportStatus:"not_requested",limitations:[],error:null});
    await client.query("INSERT INTO dota.workflow_jobs(id,match_id,queue_job_id,request_sha256,input_sha256,artifact_id,dataset_id,versions,payload,account_id,upload_id,analysis_options) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [id,request.matchId,queueId,fingerprint,file?.sha256??null,request.artifactId??null,previous?.id??null,versions,payload,accountId,request.uploadId??null,options]);
    await client.query("INSERT INTO dota.job_history(job_id,payload) VALUES ($1,$2)",[id,payload]);
    const sent=await boss.send(QUEUE,{kind:"process_match",workflowId:id},{id:queueId,db:db(client)});
    if(!sent) throw new JobError("queue_submission_failed",true);
    return {id,reused:false};
  });
}
async function locked(client: PoolClient,id: string): Promise<WorkflowRow> {
  const result=await client.query("SELECT * FROM dota.workflow_jobs WHERE id=$1 FOR UPDATE",[id]);
  if(!result.rows.length) throw new JobError("job_not_found");
  return result.rows[0];
}
async function change(client: PoolClient,row: WorkflowRow,patch: Partial<JobRecord>): Promise<JobRecord> {
  const payload=validateRecord({...row.payload,...patch}) as JobRecord;
  const from=row.payload.status, to=payload.status;
  const index=STAGES.indexOf(from as Stage), next=STAGES.indexOf(to as Stage);
  const allowed=from===to || (!TERMINAL.has(from) && (TERMINAL.has(to) ? to!=="ready" || from==="analysing" : (from==="queued" && to==="resolving") || next===index+1));
  if(!allowed) throw new JobError("invalid_job_transition");
  await client.query("UPDATE dota.workflow_jobs SET payload=$2,updated_at=now() WHERE id=$1",[row.id,payload]);
  await client.query("INSERT INTO dota.job_history(job_id,payload) VALUES ($1,$2)",[row.id,payload]);
  row.payload=payload; return payload;
}
async function fence(client: PoolClient,boss: PgBoss,context: WorkContext<WorkflowMessage>): Promise<void> {
  context.signal.throwIfAborted();
  const result=await boss.touch(QUEUE,context.job,{db:db(client)}) as {affected?:number};
  if(result.affected!==1) throw new JobError("claim_lost",true);
}
export interface WorkflowMessage { kind: "process_match"; workflowId: string }
export interface StageResult {
  dataLevel?: JobRecord["dataLevel"]; reportStatus?: JobRecord["reportStatus"]; limitations?: string[];
  datasetId?: string; inputSha256?: string; artifactId?: string; skipReason?: string;
  unavailable?: string;
  commit?: (client: PoolClient) => Promise<void>;
}
export type StageHandler = (context: { row: WorkflowRow; signal: AbortSignal; steps: Partial<Record<Stage, Omit<StageResult,"commit">>> }) => Promise<StageResult>;
export type StageHandlers = Record<Stage, StageHandler>;
export async function executeWorkflow(pool: Pool,boss: PgBoss,context: WorkContext<WorkflowMessage>,handlers: StageHandlers): Promise<object> {
  const id=context.job.data.workflowId;
  const log=(event:string,matchId:string,stage?:string)=>console.log(JSON.stringify({service:"worker",event,job_id:id,match_id:matchId,...(stage?{stage}:{})}));
  try {
    for(const stage of STAGES) {
      const prepared=await transaction(pool,async client=>{
        const row=await locked(client,id);
        if(TERMINAL.has(row.payload.status)) return {row,skip:true,terminal:true,steps:{}};
        await fence(client,boss,context);
        const checkpoints=(await client.query("SELECT stage,result FROM dota.job_steps WHERE job_id=$1",[id])).rows;
        const steps=Object.fromEntries(checkpoints.map(item=>[item.stage,item.result]));
        if(steps[stage]) return {row,skip:true,terminal:false,steps};
        await change(client,row,{status:stage,error:null});
        return {row,skip:false,terminal:false,steps};
      });
      if(prepared.terminal) return {status:prepared.row.payload.status};
      if(prepared.skip) continue;
      log("job.stage_started",prepared.row.match_id,stage);
      const {commit,...result}=await handlers[stage]({row:prepared.row,signal:context.signal,steps:prepared.steps});
      await transaction(pool,async client=>{
        const row=await locked(client,id); await fence(client,boss,context);
        if(TERMINAL.has(row.payload.status)) throw new JobError("claim_lost",true);
        if(commit) await commit(client);
        await client.query("INSERT INTO dota.job_steps(job_id,stage,result) VALUES ($1,$2,$3)",[id,stage,result]);
        await client.query("UPDATE dota.workflow_jobs SET dataset_id=coalesce($2,dataset_id),input_sha256=coalesce($3,input_sha256),artifact_id=coalesce($4,artifact_id) WHERE id=$1",[id,result.datasetId??null,result.inputSha256??null,result.artifactId??null]);
        if(result.inputSha256) await client.query("UPDATE dota.workflow_jobs SET request_sha256=$2 WHERE id=$1",[id,hash(canonical({matchId:row.match_id,inputSha256:result.inputSha256,accountId:row.account_id,versions:row.versions}))]);
        const terminal=result.unavailable?"unavailable":stage==="analysing"?"ready":stage;
        await change(client,row,{...(result.artifactId ? {provenance:{...row.payload.provenance,artifactId:result.artifactId}} : {}),status:terminal,dataLevel:result.dataLevel??row.payload.dataLevel,reportStatus:result.reportStatus??row.payload.reportStatus,
          limitations:[...new Set([...row.payload.limitations,...(result.limitations??[])])],error:result.unavailable?{code:result.unavailable,message:"Этап обработки пока недоступен",retryable:false}:null});
        if(terminal==="ready" || terminal==="unavailable") {
          const settled=await boss.complete(QUEUE,context.job,{status:terminal},{db:db(client)}) as {affected?:number};
          if(settled.affected!==1) throw new JobError("claim_lost",true);
        }
      });
      log("job.stage_completed",prepared.row.match_id,stage);
      if(result.unavailable) return {status:"unavailable"};
    }
    return {status:"ready"};
  } catch(error) {
    const known=error instanceof JobError;
    const final=known&&!error.retryable || context.job.retryCount>=context.job.retryLimit;
    if(final && !context.signal.aborted) await transaction(pool,async client=>{
      const row=await locked(client,id); if(TERMINAL.has(row.payload.status)) return;
      await fence(client,boss,context);
      await change(client,row,{status:"failed",error:{code:known?error.code:"processing_failed",message:"Обработка завершилась ошибкой",retryable:known?error.retryable:true}});
    });
    throw error;
  }
}
export async function getWorkflow(pool: Pool,boss: PgBoss,id:string): Promise<{job:JobRecord;queueState:string|null;attempt:number;datasetId:string|null;versions:PipelineVersions; artifactId:string|null; accountId:string|null; progress:WorkflowRow["progress"]; analysisOptions: AnalysisOptions | null}> {
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new JobError("invalid_job_id");
  return transaction(pool,async client=>{
    const row=await locked(client,id);
    const queued=await boss.getJobById(QUEUE,row.queue_job_id,{db:db(client)});
    if(!TERMINAL.has(row.payload.status) && (!queued || queued.state==="failed" || queued.state==="cancelled")) {
      await change(client,row,queued?.state==="cancelled"?{status:"cancelled",error:null}:{status:"failed",error:{code:"queue_attempts_exhausted",message:"Очередь завершила попытки обработки",retryable:true}});
    }
    return {job:row.payload,queueState:queued?.state??null,attempt:queued?.retryCount??0,datasetId:row.dataset_id,versions:row.versions,artifactId:row.artifact_id,accountId:row.account_id,progress:row.progress,analysisOptions:row.analysis_options};
  });
}
export async function cancelWorkflow(pool:Pool,boss:PgBoss,id:string): Promise<void> {
  await transaction(pool,async client=>{
    const row=await locked(client,id); if(TERMINAL.has(row.payload.status)) return;
    await boss.cancel(QUEUE,row.queue_job_id,{db:db(client)});
    await change(client,row,{status:"cancelled",error:null});
  });
}
export function infrastructureHandlers(pool:Pool,storage:Storage): StageHandlers {
  return {
    resolving:async ({row})=>row.artifact_id?{}:{unavailable:"source_adapter_not_connected",limitations:["Получение реплея пока не подключено"]},
    downloading:async ({row,signal})=>{
      if(!row.artifact_id) throw new JobError("artifact_required");
      const artifact=await artifactById(pool,row.artifact_id);
      signal.throwIfAborted(); await storage.verify(artifact); signal.throwIfAborted();
      return {artifactId:row.artifact_id,inputSha256:artifact.sha256,skipReason:"existing_verified_artifact"};
    },
    parsing:async ()=>({unavailable:"parser_adapter_not_connected",limitations:["Запуск парсера из приложения пока не подключён"]}),
    validating:async ()=>({unavailable:"validation_adapter_not_connected"}),
    analysing:async ()=>({unavailable:"analysis_adapter_not_connected"}),
  };
}
