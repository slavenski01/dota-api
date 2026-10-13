import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { infrastructure, json } from "../../../lib/infrastructure";
import { persistence } from "../../../lib/backend";

export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  try {
    const { pool } = await infrastructure();
    const query = { text: "SELECT name FROM pgboss.queue WHERE name='match-processing'", query_timeout: 5000 };
    const queue = await pool.query(query);
    if (queue.rowCount !== 1) throw new Error();
    await access(persistence.configuredStorageRoot(), constants.R_OK | constants.W_OK);
    return json({ service: "web", status: "ready" });
  } catch { return json({ service: "web", status: "not_ready" }, 503); }
}
