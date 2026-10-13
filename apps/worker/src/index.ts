import { openDatabase, migrate, LocalStorage, configuredStorageRoot, artifactById } from "@dota/persistence";
import { startQueue, consume, JobError, executeWorkflow, replayHandlers, type WorkflowMessage, type HistoryMessage, executeHistory } from "@dota/jobs";
import { startHealth } from "./health.js";

const args = process.argv.slice(2);
const log = (event: string, details: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ service: "worker", event, ...details }));
};
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  console.error("Usage: worker [--check]"); process.exitCode = 2;
} else if (args[0] === "--check") {
  log("worker.check", { queueConnected: false, databaseConfigured: Boolean(process.env.DATABASE_URL) });
} else if (!process.env.DATABASE_URL) {
  log("worker.configuration_error", { code: "DATABASE_URL_required" }); process.exitCode = 1;
} else {
  const pool = openDatabase();
  let boss: Awaited<ReturnType<typeof startQueue>> | undefined;
  let stopHealth: (() => Promise<void>) | undefined;
  let requestStop!: () => void;
  const stopping = new Promise<void>(accept => { requestStop = accept; });
  process.once("SIGTERM", requestStop); process.once("SIGINT", requestStop);
  try {
    await migrate(pool);
    const storage = new LocalStorage(configuredStorageRoot());
    await storage.cleanupTemporary();
    boss = await startQueue(process.env.DATABASE_URL);
    const queue = boss;
    const handlers = replayHandlers(pool, storage);
    const stopConsumer = await consume<WorkflowMessage | HistoryMessage | { kind: "verify_artifact"; artifactId: string }>(boss, pool, async ({ job, signal }) => {
      if (job.data.kind === "history_page") return executeHistory(pool, queue, { job: { ...job, data: job.data }, signal });
      if (job.data.kind === "process_match") return executeWorkflow(pool, queue, { job: { ...job, data: job.data }, signal }, handlers);
      log("job.started", { job_id: job.id });
      if (job.data.kind !== "verify_artifact") throw new JobError("handler_not_available");
      const file = await artifactById(pool, job.data.artifactId);
      signal.throwIfAborted(); await storage.verify(file); signal.throwIfAborted();
      log("job.completed", { job_id: job.id, match_id: file.matchId });
      return { verified: true };
    });
    stopHealth = await startHealth(pool, configuredStorageRoot());
    log("worker.started", { queueConnected: true });
    await stopping;
    await stopHealth(); stopHealth = undefined;
    await stopConsumer();
    log("worker.stopped");
  } catch { log("worker.failed", { code: "worker_infrastructure_failed" }); process.exitCode = 1; }
  finally {
    process.off("SIGTERM", requestStop); process.off("SIGINT", requestStop);
    await stopHealth?.(); await boss?.stop(); await pool.end();
  }
}
