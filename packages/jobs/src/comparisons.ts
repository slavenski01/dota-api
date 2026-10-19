import { analysisContext, compareLaning, evaluateL01, fingerprint, laneSnapshots, selectEpisodes, comparisonFields, comparisonMetrics, selectComparison, snapshotAt, type AnalysisRun, type ComparisonContext, type ComparisonFilters, type ComparisonMatch, type ComparisonSelection } from "@dota/analysis";
import type { Match, Participant } from "@dota/contracts";
import { insertRecords, normalizePlayerId, transaction, type Pool, type PoolClient } from "@dota/persistence";
import { JobError } from "./index.js";

type Database = Pick<Pool | PoolClient, "query">;
export const emptyComparisonContext: ComparisonContext = { role: null, patch: null, aspect: null, party: null, plan: null, earlyLeave: null, dataGap: null };
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
export function parseComparisonFilters(input: unknown): ComparisonFilters {
  const v = input as ComparisonFilters;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["relaxed", "additional"].includes(k)) ||
    !Array.isArray(v.relaxed) || !Array.isArray(v.additional) || [...v.relaxed, ...v.additional].some(f => !comparisonFields.includes(f)) ||
    new Set(v.relaxed).size !== v.relaxed.length || new Set(v.additional).size !== v.additional.length || v.relaxed.some(f => v.additional.includes(f))) throw new JobError("invalid_comparison");
  return { relaxed: [...v.relaxed].sort(), additional: [...v.additional].sort() };
}
function parseContext(input: unknown): { context: ComparisonContext; author: string; expectedVersion: number } {
  const v = input as ComparisonContext & { author: string; expectedVersion: number };
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => ![...Object.keys(emptyComparisonContext), "author", "expectedVersion"].includes(k)) ||
    ![null, 1, 2, 3, 4, 5].includes(v.role) || ![null, "solo", "party"].includes(v.party) || ![null, true, false].includes(v.earlyLeave) || ![null, true, false].includes(v.dataGap) ||
    !Number.isSafeInteger(v.expectedVersion) || v.expectedVersion < 0 || typeof v.author !== "string" || !v.author.trim() || v.author.length > 100 ||
    ["patch", "aspect", "plan"].some(k => { const value = v[k as "patch" | "aspect" | "plan"]; return value !== null && (typeof value !== "string" || !value.trim() || value.length > (k === "plan" ? 500 : 64)); })) throw new JobError("invalid_comparison");
  return { context: { role: v.role, patch: v.patch?.trim() ?? null, aspect: v.aspect?.trim() ?? null, party: v.party, plan: v.plan?.trim() ?? null, earlyLeave: v.earlyLeave, dataGap: v.dataGap }, author: v.author.trim(), expectedVersion: v.expectedVersion };
}
async function target(db: Database, datasetId: string, accountId: string) {
  normalizePlayerId(accountId, "account");
  if (!validId(datasetId)) throw new JobError("invalid_comparison");
  const rows = (await db.query(`SELECT d.match_id,p.payload AS player FROM dota.datasets d JOIN dota.records p ON p.dataset_id=d.id AND p.kind='participant'
    JOIN dota.dataset_checks c ON c.dataset_id=d.id WHERE d.id=$1 AND p.payload->>'accountId'=$2 AND c.payload->'complete'='true'::jsonb`, [datasetId, accountId])).rows;
  if (rows.length !== 1) throw new JobError("comparison_not_found");
  return rows[0] as { match_id: string; player: Participant };
}
export async function readComparisonContext(pool: Pool, datasetId: string, accountId: string) {
  const t = await target(pool, datasetId, accountId);
  const history = (await pool.query("SELECT version,payload,created_at FROM dota.comparison_contexts WHERE match_id=$1 AND account_id=$2 ORDER BY version DESC", [t.match_id, accountId])).rows;
  return { matchId: t.match_id, current: history[0] ?? null, history };
}
export async function saveComparisonContext(pool: Pool, datasetId: string, accountId: string, input: unknown) {
  const value = parseContext(input), t = await target(pool, datasetId, accountId);
  await transaction(pool, async db => {
    await db.query("SELECT match_id FROM dota.matches WHERE match_id=$1 FOR UPDATE", [t.match_id]);
    const last = (await db.query("SELECT version,payload FROM dota.comparison_contexts WHERE match_id=$1 AND account_id=$2 ORDER BY version DESC LIMIT 1", [t.match_id, accountId])).rows[0];
    const payload = { ...value.context, author: value.author, source: "user" };
    if (last?.version === value.expectedVersion + 1 && Object.entries(payload).every(([k, v]) => last.payload[k] === v)) return;
    if ((last?.version ?? 0) !== value.expectedVersion) throw new JobError("comparison_conflict");
    await db.query("INSERT INTO dota.comparison_contexts(match_id,account_id,version,payload) VALUES ($1,$2,$3,$4)", [t.match_id, accountId, value.expectedVersion + 1, payload]);
  });
  return readComparisonContext(pool, datasetId, accountId);
}

async function loadMatch(db: Database, matchId: string, accountId: string, exactDatasetId: string | null = null): Promise<ComparisonMatch> {
  const row = (await db.query(`SELECT m.started_at,h.summary,d.id AS dataset_id,p.payload AS player,r.payload AS match,c.payload AS validation,x.version,x.payload AS context
    FROM dota.matches m LEFT JOIN dota.player_matches h ON h.match_id=m.match_id AND h.account_id=$2
    LEFT JOIN LATERAL (SELECT d.id FROM dota.datasets d JOIN dota.records p ON p.dataset_id=d.id AND p.kind='participant' AND p.payload->>'accountId'=$2
      WHERE d.match_id=m.match_id AND ($3::text IS NULL OR d.id=$3) ORDER BY d.created_at DESC,d.id DESC LIMIT 1) d ON true
    LEFT JOIN dota.records p ON p.dataset_id=d.id AND p.kind='participant' AND p.payload->>'accountId'=$2
    LEFT JOIN dota.records r ON r.dataset_id=d.id AND r.kind='match' LEFT JOIN dota.dataset_checks c ON c.dataset_id=d.id
    LEFT JOIN LATERAL (SELECT version,payload FROM dota.comparison_contexts WHERE match_id=m.match_id AND account_id=$2 ORDER BY version DESC LIMIT 1) x ON true
    WHERE m.match_id=$1`, [matchId, accountId, exactDatasetId])).rows[0];
  if (!row) throw new JobError("comparison_not_found");
  const player = row.player as Participant | undefined, match = row.match as Match | undefined;
  const context: ComparisonContext = { ...emptyComparisonContext, ...row.context };
  const validated = row.validation?.complete === true;
  const analysis: AnalysisRun | undefined = row.dataset_id ? (await db.query("SELECT payload FROM dota.analysis_runs WHERE dataset_id=$1 AND player_slot=$2 AND NOT(payload ? 'comparison') ORDER BY created_at DESC,id DESC LIMIT 1", [row.dataset_id, player?.playerSlot])).rows[0]?.payload : undefined;
  const metrics = Object.fromEntries(Object.entries(player?.statistics ?? {}).map(([key, value]) => [key, { value: validated ? value : null, evidenceIds: player ? [player.id] : [] }]));
  const missing = (semantic: "last_hits" | "experience") => snapshotAt({ semantic, cumulative: true, timelineVerified: false, intervalSeconds: null, evidenceIds: [], points: [] }, 600);
  let lane = {last_hits:missing('last_hits'),experience:missing('experience')};
  if(validated && player && row.dataset_id){
    const records=(await db.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND (kind IN ('match','participant','coverage') OR kind='hero_state' AND player_slot=$2 AND game_time_seconds BETWEEN 595 AND 600) ORDER BY id",[row.dataset_id,player.playerSlot])).rows.map(r=>r.payload);
    lane=laneSnapshots(analysisContext(records,row.validation,player.playerSlot));
  }
  return { ...context, matchId, accountId, datasetId: row.dataset_id ?? null, startedAt: match?.startedAt ?? row.started_at?.toISOString() ?? null,
    heroId: player?.heroId ?? (row.summary?.heroId ? String(row.summary.heroId) : null), mode: match?.mode ?? null,
    role: context.role ?? (player?.role?.source === "manual" ? player.role.position as ComparisonContext["role"] : null),
    patch: context.patch ?? match?.patch ?? null, aspect: context.aspect ?? player?.aspectId ?? null,
    won: match?.radiantWin == null || !player ? row.summary?.won ?? null : (player.team === "radiant") === match.radiantWin,
    contextVersion: row.version ?? 0, validated,
    conflict: Boolean(context.patch && match?.patch && context.patch !== match.patch || context.aspect && player?.aspectId && context.aspect !== player.aspectId ||
      player?.heroId && row.summary?.heroId && player.heroId !== String(row.summary.heroId) || row.validation?.issues?.some((i: { field: string | null }) => i.field === null || i.field === "time" || i.field === "statistics")),
    analysisId: analysis?.id ?? null, metrics, lane };
}
export async function loadComparisonMatch(db: Database, datasetId: string, accountId: string): Promise<ComparisonMatch> {
  const t=await target(db,datasetId,accountId);
  return loadMatch(db,t.match_id,accountId,datasetId);
}
export interface ComparisonView {
  lane: ReturnType<typeof compareLaning>; analysisId: string | null;
  id: string; selection: ComparisonSelection; metrics: ReturnType<typeof comparisonMetrics>; createdAt: string;
  inspectedLimit: number; truncated: boolean;
}
export async function createComparison(pool: Pool, datasetId: string, accountId: string, input: unknown): Promise<ComparisonView> {
  const filters = parseComparisonFilters(input);
  return transaction(pool, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const t = await target(db, datasetId, accountId), current = await loadMatch(db, t.match_id, accountId, datasetId);
    const rows = (await db.query(`SELECT m.match_id FROM dota.matches m WHERE EXISTS(SELECT 1 FROM dota.player_matches h WHERE h.match_id=m.match_id AND h.account_id=$1)
      OR EXISTS(SELECT 1 FROM dota.participants p WHERE p.match_id=m.match_id AND p.account_id=$1)
      ORDER BY m.started_at DESC NULLS LAST,m.match_id DESC LIMIT 1001`, [accountId])).rows;
    const candidates: ComparisonMatch[] = [];
    for (const row of rows.slice(0, 1000)) candidates.push(await loadMatch(db, row.match_id, accountId));
    const selection = selectComparison(current, candidates, filters);
    const id = `comparison-${selection.fingerprint}`;
    let analysisId: string|null = null;
    if(current.analysisId){
      const base:AnalysisRun=(await db.query('SELECT payload FROM dota.analysis_runs WHERE id=$1',[current.analysisId])).rows[0].payload;
      const records=(await db.query("SELECT payload FROM dota.records WHERE dataset_id=$1 AND (kind IN ('match','participant','event','coverage') OR kind='hero_state' AND player_slot=$2 AND game_time_seconds BETWEEN 595 AND 600) ORDER BY id",[datasetId,base.playerSlot])).rows.map(r=>r.payload);
      const validation=(await db.query('SELECT payload FROM dota.dataset_checks WHERE dataset_id=$1',[datasetId])).rows[0].payload;
      const ctx=analysisContext(records,validation,base.playerSlot),results=[...base.results.filter(r=>r.ruleId!=='L01'),...evaluateL01(ctx,selection)];
      analysisId=`analysis-${fingerprint({base:base.id,comparison:id})}`;
      const episodes=selectEpisodes(ctx,results,analysisId);
      const run:AnalysisRun={...base,id:analysisId,comparison:{id,fingerprint:selection.fingerprint},results,episodes,primaryEpisodeIds:episodes.slice(0,3).map(e=>e.episode.id),
        completeness:results.some(r=>r.status==='skipped'||!r.dataComplete)?'partial':'complete',outcome:episodes.length?'candidates':results.some(r=>r.status==='skipped')?'insufficient_data':'no_candidates',
        limitations:[...base.limitations.filter(l=>!l.startsWith('Сравнение линии')), 'Сравнение линии — предварительный сигнал собственной базы; оно не устанавливает ошибку или причину результата.']};
      const saved=await db.query('INSERT INTO dota.analysis_runs(id,dataset_id,match_id,player_slot,payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[analysisId,datasetId,run.matchId,run.playerSlot,run]);
      if(saved.rowCount)await insertRecords(db as PoolClient,datasetId,episodes.map(e=>e.episode));
    }
    const payload: ComparisonView = { id, selection, lane:compareLaning(selection),analysisId,metrics: comparisonMetrics(selection), createdAt: new Date().toISOString(), inspectedLimit: 1000, truncated: rows.length > 1000 };
    await db.query("INSERT INTO dota.comparison_runs(id,dataset_id,account_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [id, datasetId, accountId, payload]);
    return (await db.query("SELECT payload FROM dota.comparison_runs WHERE id=$1", [id])).rows[0].payload;
  });
}
export async function readComparisons(pool: Pool, datasetId: string, accountId: string): Promise<ComparisonView[]> {
  await target(pool, datasetId, accountId);
  return (await pool.query("SELECT payload FROM dota.comparison_runs WHERE dataset_id=$1 AND account_id=$2 ORDER BY created_at DESC,id DESC LIMIT 50", [datasetId, accountId])).rows.map(r => r.payload);
}
