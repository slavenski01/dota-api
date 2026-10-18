import { randomUUID } from "node:crypto";
import { transaction, type Pool, type PoolClient } from "@dota/persistence";
import { JobError, QUEUE, type PgBoss, type WorkContext } from "./index.js";
import { readAnalysis } from "./analysis.js";
import { coachConfig, coachHash, invokeCoachBridge, type CoachConfig, type CoachInput, type CoachResponse } from "./coach-provider.js";

export interface CoachMessage { kind: "coach_report"; runId: string }
export interface CoachRun {
  id: string; request_key: string; queue_job_id: string; dataset_id: string; analysis_id: string; player_slot: number; version: number;
  status: "queued" | "running" | "ready" | "failed"; input: CoachInput; config: CoachConfig;
  result: unknown; usage: CoachResponse["usage"] | null; error_code: string | null; duration_ms: number | null;
  created_at: Date; finished_at: Date | null;
}
const db = (client: PoolClient) => ({ executeSql: (text: string, values?: unknown[]) => client.query(text, values) });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function enqueueCoach(pool: Pool, boss: PgBoss, request: { datasetId: string; analysisId: string; accountId: string; requestKey: string }, input: CoachInput, config = coachConfig()) {
  if (!uuid.test(request.requestKey) || coachHash(input.context) !== input.contextSha256 || coachHash(input.instructions.files) !== input.instructions.sha256) throw new JobError("coach_invalid_request");
  if (Buffer.byteLength(input.prompt) > config.maxPromptBytes) throw new JobError("coach_context_limit");
  const analysis = await readAnalysis(pool, request.datasetId, request.accountId, request.analysisId);
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(731082,8)");
    const previous: CoachRun | undefined = (await client.query("SELECT * FROM dota.coach_runs WHERE request_key=$1 OR (dataset_id=$2 AND player_slot=$3 AND status IN ('queued','running')) ORDER BY created_at DESC LIMIT 1", [request.requestKey,request.datasetId,analysis.playerSlot])).rows[0];
    if (previous) {
      if (previous.dataset_id !== request.datasetId || previous.analysis_id !== request.analysisId || previous.player_slot !== analysis.playerSlot || previous.input.contextSha256 !== input.contextSha256) throw new JobError("coach_request_conflict");
      return { id: previous.id, reused: true };
    }
    const counts = (await client.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS daily FROM dota.coach_runs")).rows[0];
    if (counts.total >= config.totalRuns || counts.daily >= config.dailyRuns) throw new JobError("coach_budget_exhausted");
    const version = (await client.query("SELECT coalesce(max(version),0)+1 AS version FROM dota.coach_runs WHERE dataset_id=$1 AND player_slot=$2", [request.datasetId,analysis.playerSlot])).rows[0].version;
    const id = randomUUID(), queueId = randomUUID();
    await client.query("INSERT INTO dota.coach_runs(id,request_key,queue_job_id,dataset_id,analysis_id,player_slot,version,input,config) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id,request.requestKey,queueId,request.datasetId,request.analysisId,analysis.playerSlot,version,input,config]);
    const sent = await boss.send(QUEUE, { kind: "coach_report", runId: id }, { id: queueId, retryLimit: 1, expireInSeconds: 300, db: db(client) });
    if (!sent) throw new JobError("queue_submission_failed", true);
    return { id, reused: false };
  });
}
export async function executeCoach(pool: Pool, boss: PgBoss, context: WorkContext<CoachMessage>,
  invoke = invokeCoachBridge, validate: (output: unknown, input: CoachInput) => unknown = output => output): Promise<object> {
  const id = context.job.data.runId;
  async function fenced<T>(action: (client: PoolClient, row: CoachRun) => Promise<T>): Promise<T> {
    return transaction(pool, async client => {
      context.signal.throwIfAborted();
      const row: CoachRun | undefined = (await client.query("SELECT * FROM dota.coach_runs WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row || row.queue_job_id !== context.job.id) throw new JobError("coach_run_not_found");
      const touched = await boss.touch(QUEUE,context.job,{ db: db(client) }) as { affected?: number };
      if (touched.affected !== 1) throw new JobError("claim_lost",true);
      return action(client,row);
    });
  }
  const row = await fenced(async (client,r) => {
    if (["ready","failed"].includes(r.status)) return r;
    await client.query("UPDATE dota.coach_runs SET status='running' WHERE id=$1", [id]); return r;
  });
  if (["ready","failed"].includes(row.status)) return { status: row.status };
  let response: CoachResponse | undefined;
  try {
    response = await invoke(id,row.input,row.config,context.signal);
    const output = validate(response.output,row.input);
    await fenced(async (client,r) => {
      if (["ready","failed"].includes(r.status)) return;
      await client.query("UPDATE dota.coach_runs SET status='ready',result=$2,usage=$3,duration_ms=$4,finished_at=now() WHERE id=$1", [id,{ output, cliVersion: response!.cliVersion },response!.usage,response!.durationMs]);
    });
    return { status: "ready" };
  } catch (error) {
    if (context.signal.aborted) throw new JobError("coach_interrupted",true);
    const code = error instanceof JobError ? error.code : "coach_provider_failed";
    await fenced(async (client,r) => {
      if (["ready","failed"].includes(r.status)) return;
      await client.query("UPDATE dota.coach_runs SET status='failed',error_code=$2,usage=$3,duration_ms=$4,finished_at=now() WHERE id=$1", [id,code,response?.usage ?? null,response?.durationMs ?? null]);
    });
    return { status: "failed", code };
  }
}
export async function readCoachRuns(pool: Pool, boss: PgBoss, datasetId: string, accountId: string, analysisId: string, reportId?: string): Promise<CoachRun[]> {
  if (reportId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(reportId)) throw new JobError('coach_invalid_request');
  const analysis = await readAnalysis(pool,datasetId,accountId,analysisId);
  const rows: CoachRun[] = (await pool.query("SELECT * FROM dota.coach_runs WHERE dataset_id=$1 AND player_slot=$2 AND analysis_id=$3 AND ($4::uuid IS NULL OR id=$4) ORDER BY version DESC LIMIT 100", [datasetId,analysis.playerSlot,analysisId,reportId??null])).rows;
  if (reportId && !rows.length) throw new JobError('coach_report_not_found');
  for (const row of rows.filter(r => ["queued","running"].includes(r.status))) {
    const job = await boss.getJobById(QUEUE,row.queue_job_id);
    if (!job || ["failed","cancelled"].includes(job.state)) {
      const updated = await pool.query("UPDATE dota.coach_runs SET status='failed',error_code='coach_interrupted',finished_at=now() WHERE id=$1 AND status IN ('queued','running') RETURNING *", [row.id]);
      if (updated.rows[0]) Object.assign(row,updated.rows[0]);
    }
  }
  return rows;
}
