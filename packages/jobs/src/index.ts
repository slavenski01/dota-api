import { PgBoss, type JobWithMetadata } from "pg-boss";
import { type Pool } from "@dota/persistence";
export { PgBoss } from "pg-boss";
export { runBoundedProcess, PROCESS_LIMITS } from "./process.js";
export type { ProcessSpec } from "./process.js";
export { requestWorkflow, executeWorkflow, getWorkflow, cancelWorkflow, defaultVersions, infrastructureHandlers, STAGES } from "./workflow.js";
export type { WorkflowRequest, WorkflowMessage, StageHandlers, StageResult, PipelineVersions } from "./workflow.js";
export const QUEUE = "match-processing";
export { enqueueCoach, executeCoach, readCoachRuns } from "./coach.js";
export type { CoachMessage, CoachRun } from "./coach.js";
export { coachConfig, coachInstructions, coachHash, coachBridgeRoot, atomicCoachFile, readCoachFile, validateCoachResponse, invokeCoachBridge } from "./coach-provider.js";
export type { CoachConfig, CoachInput, CoachResponse, CoachUsage } from "./coach-provider.js";
export { buildCoachInput, validateCoachOutput, parseCoachSettings, COACH_OUTPUT_SCHEMA } from "./coach-context.js";
export type { CoachContext, CoachSettings, CoachOutput } from "./coach-context.js";
export { requestCoachReport, readCoachReports, readCoachEpisode } from "./coach-view.js";
export type { CoachReportView, CoachEpisodeView } from "./coach-view.js";
export class JobError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = "JobError"; }
}
export interface QueueSettings { retryDelay?: number; expireInSeconds?: number; heartbeatSeconds?: number }
export async function startQueue(connectionString: string, settings: QueueSettings = {}): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, max: 5, connectionTimeoutMillis: 5000, superviseIntervalSeconds: 1, monitorIntervalSeconds: 5 });
  boss.on("error", () => { console.error(JSON.stringify({ service: "queue", event: "queue.error" })); });
  await boss.start();
  const config = { retryLimit: 2, retryDelay: settings.retryDelay ?? 5, retryBackoff: true, retryDelayMax: 60,
    expireInSeconds: settings.expireInSeconds ?? 600, heartbeatSeconds: settings.heartbeatSeconds ?? 10, deleteAfterSeconds: 7 * 86400, retentionSeconds: 30 * 86400 };
  await boss.createQueue(QUEUE, { policy: "singleton", ...config });
  await boss.updateQueue(QUEUE, config);
  return boss;
}
export type WorkContext<T> = { job: JobWithMetadata<T>; signal: AbortSignal };
export async function consume<T>(boss: PgBoss, pool: Pool, handler: (context: WorkContext<T>) => Promise<object | void>): Promise<() => Promise<void>> {
  let stopping = false;
  const active = new Set<AbortController>();
  const running = new Set<Promise<unknown>>();
  await boss.work<T, unknown, { includeMetadata: true; perJobResults: true; batchSize: number; pollingIntervalSeconds: number }>(QUEUE,
    { includeMetadata: true, perJobResults: true, batchSize: 1, pollingIntervalSeconds: 0.5 }, async jobs => {
      const job = jobs[0]!;
      const controller = new AbortController(); active.add(controller);
      const signal = AbortSignal.any([controller.signal, job.signal]);
      const execute = async () => {
        if (stopping) throw new JobError("worker_stopping", true);
        const client = await pool.connect(); let locked = false;
        const disconnected = () => controller.abort(new JobError("database_disconnected", true));
        client.on("error", disconnected);
        let monitoring = false;
        const poll = setInterval(async () => {
          if (monitoring) return; monitoring = true;
          try {
            const current = await boss.getJobById(QUEUE, job.id);
            if (!current || current.state !== "active" || current.retryCount !== job.retryCount) controller.abort(new JobError("claim_lost", true));
          } catch { disconnected(); } finally { monitoring = false; }
        }, 500);
        try {
          locked = (await client.query("SELECT pg_try_advisory_lock(731082,2) AS locked")).rows[0].locked;
          if (!locked) throw new JobError("heavy_worker_busy", true);
          signal.throwIfAborted();
          return await handler({ job, signal });
        } finally {
          clearInterval(poll);
          try { if (locked) await client.query("SELECT pg_advisory_unlock(731082,2)"); }
          finally { client.off("error", disconnected); client.release(); }
        }
      };
      const task = execute(); running.add(task);
      try { return [{ id: job.id, status: "completed", output: await task ?? {} }]; }
      catch (error) {
        const known = error instanceof JobError;
        return [{ id: job.id, status: known && !error.retryable ? "deadletter" : "failed", output: { code: known ? error.code : "worker_error" } }];
      } finally { active.delete(controller); running.delete(task); }
    });
  return async () => {
    stopping = true; for (const controller of active) controller.abort(new JobError("worker_stopping", true));
    await boss.offWork(QUEUE);
    await Promise.allSettled([...running]);
  };
}
export { requestHistory, executeHistory, getHistoryStatus } from "./history.js";
export type { HistoryMessage } from "./history.js";
export { REPLAY_LIMITS, importReplay, downloadReplay, validateReplay } from "./replay.js";
export type { ReplayProgress, ImportedReplay } from "./replay.js";
export { replayHandlers } from "./replay-workflow.js";
export { readDatasetContext } from "./player-context.js";
export { datasetValidation } from "./dataset-validation.js";
export { analysisHandler, readAnalysis, readEpisode } from "./analysis.js";
export { readMatchOverview } from "./match-view.js";
export type { MatchOverview } from "./match-view.js";
export { readMatchExplorer, readMatchFrame, readMatchEvents, readMatchSeries } from "./match-explorer.js";
export type { MatchExplorer, MatchFrame, EventFilters, ViewMode } from "./match-explorer.js";
export { readMatchNotes, saveMatchNote } from "./match-notes.js";
export type { MatchNote, NoteCoachReference } from "./match-notes.js";
export { readEpisodeFrame } from "./episode-view.js";
export type { EpisodeFrame, ViewerState } from "./episode-view.js";
export { readEpisodeReviews, saveEpisodeReview } from "./episode-reviews.js";
export type { ReviewHistory } from "./episode-reviews.js";

export { readPlaybackWindow } from "./playback.js";
export type { PlaybackWindow } from "./playback.js";
