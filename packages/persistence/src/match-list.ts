import { createHash } from "node:crypto";
import { type Pool } from "./index.js";
import { normalizePlayerId, SourceError } from "./profiles.js";
import type { MatchSummary } from "./history.js";
export interface MatchFilters { accountId: string; from: string | null; to: string | null; heroId: number | null; result: "win" | "loss" | "unknown" | null; limit: number; cursor: string | null }
export interface MatchListItem extends MatchSummary { replayAvailability: "unchecked"; storedArtifact: boolean; processing: string; jobId: string | null; dataLevel: string; reportStatus: string }
function date(value: string | null): string | null {
  if (value === null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SourceError("invalid_match_filters",400);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) throw new SourceError("invalid_match_filters",400);
  return value;
}
export function parseMatchFilters(params: URLSearchParams): MatchFilters {
  const allowed=["accountId","from","to","heroId","result","limit","cursor"];
  for(const key of params.keys()) if(!allowed.includes(key)||params.getAll(key).length!==1) throw new SourceError("invalid_match_filters",400);
  const {accountId}=normalizePlayerId(params.get("accountId"),"account");
  const from=date(params.get("from")),to=date(params.get("to"));
  if(from && to && from>to) throw new SourceError("invalid_match_filters",400);
  const hero=params.get("heroId");
  if(hero && (!/^[1-9][0-9]{0,5}$/.test(hero))) throw new SourceError("invalid_match_filters",400);
  const result=params.get("result")||null;
  if(result!==null && result!=="win" && result!=="loss" && result!=="unknown") throw new SourceError("invalid_match_filters",400);
  const rawLimit=params.get("limit")??"25";
  if(!/^[1-9][0-9]?$|^100$/.test(rawLimit)) throw new SourceError("invalid_match_filters",400);
  return {accountId,from,to,heroId:hero?Number(hero):null,result,limit:Number(rawLimit),cursor:params.get("cursor")||null};
}
export async function listMatches(pool: Pool, filters: MatchFilters): Promise<{items: MatchListItem[]; nextCursor: string | null; timezone: "UTC"; coverage: "stored_matches_only"}> {
  const {accountId,from,to,heroId,result,limit,cursor}=filters;
  const scope=createHash("sha256").update(JSON.stringify([accountId,from,to,heroId,result])).digest("hex");
  let after: {time:string;id:string}|null=null;
  if(cursor) {
    try {
      if(cursor.length>1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
      const decoded=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
      if(decoded.v!==1 || decoded.scope!==scope || typeof decoded.time!=="string" || new Date(decoded.time).toISOString()!==decoded.time || typeof decoded.id!=="string" || !/^[1-9][0-9]{0,19}$/.test(decoded.id)) throw Error();
      after=decoded;
    } catch { throw new SourceError("invalid_match_cursor",400); }
  }
  const values: unknown[]=[accountId]; const where=["m.account_id=$1"];
  const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  if(from) where.push(`m.started_at>=${bind(`${from}T00:00:00.000Z`)}::timestamptz`);
  if(to) where.push(`m.started_at<${bind(new Date(Date.parse(`${to}T00:00:00.000Z`) + 86400000).toISOString())}::timestamptz`);
  if(heroId!==null) where.push(`m.hero_id=${bind(heroId)}`);
  if(result) where.push(result==="unknown"?"m.won IS NULL":`m.won=${bind(result==="win")}`);
  if(after) where.push(`(m.started_at,m.match_id)<(${bind(after.time)}::timestamptz,${bind(after.id)}::text)`);
  const rows=(await pool.query(`SELECT m.summary,m.started_at,m.match_id,
    EXISTS(SELECT 1 FROM dota.artifacts a WHERE a.match_id=m.match_id AND a.media_type='application/x-dota-replay' AND a.source->>'validation'='replay-v1' AND a.source->'accountIds' ? m.account_id::text) AS stored_artifact,
    j.id AS job_id,j.status AS processing,j.payload->>'dataLevel' AS data_level,coalesce(c.status,j.payload->>'reportStatus') AS report_status
    FROM dota.player_matches m LEFT JOIN LATERAL (SELECT id,status,payload FROM dota.workflow_jobs WHERE match_id=m.match_id ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
    LEFT JOIN LATERAL (SELECT CASE WHEN c.status IN ('queued','running') THEN 'pending' ELSE c.status END AS status
      FROM dota.coach_runs c JOIN dota.datasets d ON d.id=c.dataset_id JOIN dota.records p ON p.dataset_id=c.dataset_id AND p.kind='participant' AND p.player_slot=c.player_slot
      WHERE d.match_id=m.match_id AND p.payload->>'accountId'=m.account_id::text ORDER BY c.created_at DESC LIMIT 1) c ON true
    WHERE ${where.join(" AND ")} ORDER BY m.started_at DESC,m.match_id DESC LIMIT ${bind(limit+1)}`,values)).rows;
  const page=rows.slice(0,limit); const last=page.at(-1);
  return {items:page.map(row=>({...row.summary,replayAvailability:"unchecked",storedArtifact:row.stored_artifact,processing:row.processing??"not_requested",jobId:row.job_id??null,dataLevel:row.data_level??"summary",reportStatus:row.report_status??"not_requested"})),
    nextCursor:rows.length>limit && last ? Buffer.from(JSON.stringify({v:1,scope,time:last.started_at.toISOString(),id:last.match_id})).toString("base64url"):null,
    timezone:"UTC",coverage:"stored_matches_only"};
}
