import { comparisonFields, summarizePractice, type ComparisonFilters, type ComparisonMatch, type PracticeCounts } from "@dota/analysis";
import { normalizePlayerId, transaction, type Pool } from "@dota/persistence";
import { loadComparisonMatch, parseComparisonFilters } from "./comparisons.js";
import { JobError } from "./index.js";

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text=(v:unknown,min:number,max:number):v is string=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
export interface PracticeSeries {
  id:string; accountId:string; datasetId:string; action:string; scope:string; author:string; reportId:string|null;
  filters:ComparisonFilters; reference:ComparisonMatch; createdAt:string; kind:"experiment";
}
export interface PracticeObservation extends PracticeCounts {
  mmr:number|null;
  seriesId:string; matchId:string; datasetId:string; version:number; note:string; author:string;
  match:ComparisonMatch; recordedAt:string;
}
export interface PracticeView {
  series:PracticeSeries; observations:PracticeObservation[]; history:PracticeObservation[];
  totals:ReturnType<typeof summarizePractice>; complete:boolean; eligibility:string[];
}
export function practiceEligibility(series:PracticeSeries,match:ComparisonMatch):string[] {
  const reasons:string[]=[];
  if(match.accountId!==series.accountId)reasons.push('different_player');
  if(!match.startedAt||!series.reference.startedAt)reasons.push('start_unknown');
  else if(Date.parse(match.startedAt)<=Math.max(Date.parse(series.reference.startedAt),Date.parse(series.createdAt)))reasons.push('before_experiment');
  if(match.matchId===series.reference.matchId)reasons.push('current_match');
  if(!match.validated||match.conflict)reasons.push('dataset_unavailable');
  if(match.earlyLeave!==false)reasons.push('leave_unknown_or_early');
  if(match.dataGap!==false)reasons.push('gap_unknown_or_present');
  const fields=[...new Set([...comparisonFields.slice(0,4),...series.filters.additional])].filter(f=>!series.filters.relaxed.includes(f));
  for(const field of fields)if(match[field]===null||series.reference[field]===null||match[field]!==series.reference[field])reasons.push(`${field}_mismatch`);
  return reasons;
}
export async function createPractice(pool:Pool,datasetId:string,accountId:string,input:unknown):Promise<PracticeSeries> {
  const v=input as {id:string;action:string;scope:string;author:string;filters:ComparisonFilters;reportId:string|null};
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['id','action','scope','author','filters','reportId'].includes(k))||
    !uuid(v.id)||!text(v.action,8,1000)||!text(v.scope,8,1000)||!text(v.author,1,100)||v.reportId!==null&&!uuid(v.reportId))throw new JobError('invalid_progress');
  const filters=parseComparisonFilters(v.filters);
  const match=await loadComparisonMatch(pool,datasetId,accountId);
  const payload={action:v.action.trim(),scope:v.scope.trim(),author:v.author.trim(),filters,reportId:v.reportId};
  const same=(s:PracticeSeries)=>s.datasetId===datasetId&&s.accountId===accountId&&Object.entries(payload).every(([k,value])=>JSON.stringify(s[k as keyof PracticeSeries])===JSON.stringify(value));
  const existing=(await pool.query('SELECT payload FROM dota.practice_series WHERE id=$1',[v.id])).rows[0]?.payload;
  if(existing){if(!same(existing))throw new JobError('progress_conflict');return existing;}
  if(!match.startedAt||match.conflict||[...new Set([...comparisonFields.slice(0,4),...filters.additional])].some(f=>!filters.relaxed.includes(f)&&match[f]===null))throw new JobError('invalid_progress');
  if(v.reportId){
    const report=(await pool.query("SELECT c.result FROM dota.coach_runs c JOIN dota.records p ON p.dataset_id=c.dataset_id AND p.kind='participant' AND p.player_slot=c.player_slot WHERE c.id=$1 AND c.dataset_id=$2 AND p.payload->>'accountId'=$3 AND c.status='ready'",[v.reportId,datasetId,accountId])).rows[0];
    if(!report)throw new JobError('progress_not_found');
  }
  const series:PracticeSeries={id:v.id,accountId,datasetId,...payload,reference:match,createdAt:new Date().toISOString(),kind:'experiment'};
  const result=await pool.query('INSERT INTO dota.practice_series(id,account_id,dataset_id,payload) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING payload',[v.id,accountId,datasetId,series]);
  const saved=result.rows[0]?.payload??(await pool.query('SELECT payload FROM dota.practice_series WHERE id=$1',[v.id])).rows[0].payload;
  if(!same(saved))throw new JobError('progress_conflict');return saved;
}
export async function savePracticeObservation(pool:Pool,datasetId:string,accountId:string,input:unknown):Promise<PracticeObservation> {
  const v=input as PracticeCounts&{seriesId:string;expectedVersion:number;note:string;author:string;mmr:number|null};
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['seriesId','expectedVersion','done','missed','uncertain','note','author','mmr'].includes(k))||!uuid(v.seriesId)||
    v.mmr!==null&&(!Number.isSafeInteger(v.mmr)||v.mmr<0||v.mmr>30000)||
    !Number.isSafeInteger(v.expectedVersion)||v.expectedVersion<0||!text(v.note,1,2000)||!text(v.author,1,100)||
    [v.done,v.missed,v.uncertain].some(n=>!Number.isSafeInteger(n)||n<0||n>10000))throw new JobError('invalid_progress');
  normalizePlayerId(accountId,'account');
  return transaction(pool,async db=>{
    const series:PracticeSeries|undefined=(await db.query('SELECT payload FROM dota.practice_series WHERE id=$1 AND account_id=$2 FOR UPDATE',[v.seriesId,accountId])).rows[0]?.payload;
    if(!series)throw new JobError('progress_not_found');
    const match=await loadComparisonMatch(db,datasetId,accountId);
    const rows:PracticeObservation[]=(await db.query('SELECT DISTINCT ON(match_id) payload FROM dota.practice_observations WHERE series_id=$1 ORDER BY match_id,version DESC',[v.seriesId])).rows.map(r=>r.payload);
    const prior=rows.find(r=>r.matchId===match.matchId),content={done:v.done,missed:v.missed,uncertain:v.uncertain,note:v.note.trim(),author:v.author.trim(),mmr:v.mmr};
    if(prior?.version===v.expectedVersion+1&&prior.datasetId===datasetId&&Object.entries(content).every(([k,val])=>prior[k as keyof PracticeObservation]===val))return prior;
    if((prior?.version??0)!==v.expectedVersion||!prior&&rows.length>=5)throw new JobError('progress_conflict');
    if(practiceEligibility(series,match).length)throw new JobError('invalid_progress');
    const saved:PracticeObservation={...content,seriesId:series.id,matchId:match.matchId,datasetId,version:v.expectedVersion+1,match,recordedAt:new Date().toISOString()};
    await db.query('INSERT INTO dota.practice_observations(series_id,match_id,dataset_id,version,payload) VALUES ($1,$2,$3,$4,$5)',[series.id,match.matchId,datasetId,saved.version,saved]);
    return saved;
  });
}
export async function readPractice(pool:Pool,datasetId:string,accountId:string):Promise<PracticeView[]> {
  const match=await loadComparisonMatch(pool,datasetId,accountId);
  const rows:PracticeSeries[]=(await pool.query('SELECT payload FROM dota.practice_series WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[accountId])).rows.map(r=>r.payload);
  const result:PracticeView[]=[];
  for(const series of rows){
    const history:PracticeObservation[]=(await pool.query('SELECT payload FROM dota.practice_observations WHERE series_id=$1 ORDER BY created_at DESC,version DESC',[series.id])).rows.map(r=>r.payload);
    const latest=new Map<string,PracticeObservation>();for(const row of history)if(!latest.has(row.matchId))latest.set(row.matchId,row);
    const observations=[...latest.values()].sort((a,b)=>a.match.startedAt!.localeCompare(b.match.startedAt!));
    result.push({series,history,observations,totals:summarizePractice(observations),complete:observations.length===5,eligibility:practiceEligibility(series,match)});
  }
  return result;
}
