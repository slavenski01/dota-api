import { randomUUID } from "node:crypto";
import { transaction, normalizePlayerId, fetchHistory, saveHistoryPage, historyState, SourceError, type Pool, type PoolClient, type SourceFetch, type MatchSummary } from "@dota/persistence";
import { QUEUE, JobError, type PgBoss, type WorkContext } from "./index.js";
const db = (client: PoolClient) => ({ executeSql: (text: string, values?: unknown[]) => client.query(text, values) });
export interface HistoryMessage { kind: "history_page"; requestId: string }
export async function requestHistory(pool: Pool, boss: PgBoss, accountId: string, mode: unknown) {
  normalizePlayerId(accountId, "account");
  if (mode !== "refresh" && mode !== "older") throw new SourceError("invalid_history_mode",400);
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,731083))",[accountId]);
    if (!(await client.query("SELECT 1 FROM dota.profiles WHERE account_id=$1",[accountId])).rowCount) throw new SourceError("profile_not_found",404);
    const active = (await client.query("SELECT * FROM dota.history_requests WHERE account_id=$1 AND status='queued'",[accountId])).rows[0];
    if (active) {
      const job = await boss.getJobById(QUEUE,active.id,{db:db(client)});
      if (job && ["created","retry","active"].includes(job.state)) return { id: active.id, cached: false };
      await client.query("UPDATE dota.history_requests SET status='failed',error='history_interrupted',finished_at=now() WHERE id=$1",[active.id]);
    }
    const cooldown = (await client.query("SELECT extract(epoch FROM retry_at-now()) AS seconds FROM dota.provider_cooldowns WHERE provider='opendota' AND retry_at>now()")).rows[0];
    if (cooldown) throw new SourceError("provider_rate_limited",429,Math.ceil(Number(cooldown.seconds)));
    const pages = (await client.query("SELECT * FROM dota.history_pages WHERE account_id=$1 ORDER BY page_offset DESC LIMIT 1",[accountId])).rows[0];
    const offset = mode === "refresh" ? 0 : pages ? pages.page_offset + 50 : 0;
    if (mode === "older" && pages && pages.row_count < 50) return { id: null, cached: true };
    if ((await client.query("SELECT 1 FROM dota.history_pages WHERE account_id=$1 AND page_offset=$2 AND fetched_at>now()-interval '60 seconds'",[accountId,offset])).rowCount) return { id:null,cached:true };
    const id=randomUUID();
    await client.query("INSERT INTO dota.history_requests(id,account_id,page_offset,status) VALUES ($1,$2,$3,'queued')",[id,accountId,offset]);
    if (!await boss.send(QUEUE,{kind:"history_page",requestId:id},{id,db:db(client)})) throw new JobError("queue_submission_failed",true);
    return {id,cached:false};
  });
}
export async function executeHistory(pool: Pool, boss: PgBoss, context: WorkContext<HistoryMessage>, fetcher: SourceFetch = fetch): Promise<object> {
  const id=context.job.data.requestId;
  const request=(await pool.query("SELECT * FROM dota.history_requests WHERE id=$1",[id])).rows[0];
  if (!request || request.status !== "queued") return {skipped:true};
  let rows: MatchSummary[] | undefined; let failure: SourceError | undefined;
  try {
    const cooldown=(await pool.query("SELECT extract(epoch FROM retry_at-now()) AS seconds FROM dota.provider_cooldowns WHERE provider='opendota' AND retry_at>now()")).rows[0];
    if(cooldown) throw new SourceError("provider_rate_limited",429,Math.ceil(Number(cooldown.seconds)));
    rows=await fetchHistory(request.account_id,request.page_offset,fetcher);
  } catch(error) { if(!(error instanceof SourceError)) throw error; failure=error; }
  return transaction(pool,async client=>{
    context.signal.throwIfAborted();
    const locked=(await client.query("SELECT status FROM dota.history_requests WHERE id=$1 FOR UPDATE",[id])).rows[0];
    if(locked?.status!=="queued") return {skipped:true};
    const touched=await boss.touch(QUEUE,context.job,{db:db(client)}) as {affected?:number};
    if(touched.affected!==1) throw new JobError("claim_lost",true);
    if(rows) {
      await client.query("SAVEPOINT history_page");
      try { await saveHistoryPage(client,request.account_id,request.page_offset,rows); }
      catch(error) { await client.query("ROLLBACK TO SAVEPOINT history_page"); if(!(error instanceof SourceError)) throw error; failure=error; }
    }
    const retryAt=failure?.retryAfter ? new Date(Date.now()+failure.retryAfter*1000) : null;
    if(retryAt) await client.query("INSERT INTO dota.provider_cooldowns VALUES ('opendota',$1) ON CONFLICT(provider) DO UPDATE SET retry_at=greatest(dota.provider_cooldowns.retry_at,excluded.retry_at)",[retryAt]);
    const status=failure ? "failed" : "ready";
    await client.query("UPDATE dota.history_requests SET status=$2,error=$3,retry_at=$4,finished_at=now() WHERE id=$1",[id,status,failure?.code??null,retryAt]);
    const settled=await boss.complete(QUEUE,context.job,{status},{db:db(client)}) as {affected?:number};
    if(settled.affected!==1) throw new JobError("claim_lost",true);
    return {status};
  });
}
export async function getHistoryStatus(pool: Pool,boss: PgBoss,accountId: string) {
  const state=await historyState(pool,accountId);
  const latest=(await pool.query("SELECT id,status,error,retry_at,created_at,finished_at FROM dota.history_requests WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",[accountId])).rows[0]??null;
  if(latest?.status==="queued") {
    const job=await boss.getJobById(QUEUE,latest.id);
    if(!job || ["failed","cancelled","completed"].includes(job.state)) {latest.status="failed";latest.error="history_interrupted";}
  }
  return {...state,latest};
}
