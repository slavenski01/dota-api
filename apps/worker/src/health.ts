import { constants } from "node:fs";
import { access, writeFile, rename, rm } from "node:fs/promises";
import type { Pool } from "@dota/persistence";

const path = "/tmp/dota-worker-ready.json";
export async function startHealth(pool: Pool, storageRoot: string): Promise<() => Promise<void>> {
  await rm(path, { force: true });
  let stopped = false, running: Promise<void> | undefined, ready = false;
  const check = async () => {
    try {
      const query = { text: "SELECT name FROM pgboss.queue WHERE name='match-processing'", query_timeout: 5000 };
      const result = await pool.query(query);
      if (result.rowCount !== 1) throw new Error();
      await access(storageRoot, constants.R_OK | constants.W_OK);
      if (stopped) return;
      await writeFile(`${path}.part`, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      await rename(`${path}.part`, path);
      ready = true;
    } catch {
      await rm(path, { force: true });
      if (ready) console.log(JSON.stringify({ service: "worker", event: "worker.not_ready", code: "infrastructure_unavailable" }));
      ready = false;
    }
  };
  await check();
  const timer = setInterval(() => { if (!running) running = check().finally(() => { running = undefined; }); }, 5000);
  timer.unref();
  return async () => {
    stopped = true; clearInterval(timer); await running;
    await rm(path, { force: true }); await rm(`${path}.part`, { force: true });
  };
}
