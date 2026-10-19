import type { HeroState } from "@dota/contracts";
import { snapshotAt, type Snapshot } from "./metrics.js";
import { quantile, type ComparisonSelection } from "./comparisons.js";
import { completeWindow, positiveEvent, result, setView, unique, type AnalysisContext, type RuleResult } from "./rules.js";

export function laneSnapshots(context: AnalysisContext): Record<"last_hits" | "experience", Snapshot> {
  const states = context.records.filter((r): r is HeroState => r.kind === "hero_state" && r.playerSlot === context.player.playerSlot && r.perspective.mode === "omniscient");
  const verified = context.validation.complete && completeWindow(context,"time",{startSeconds:595,endSeconds:600},[context.player.playerSlot]).usable;
  return Object.fromEntries((["last_hits","experience"] as const).map(semantic => {
    const key=semantic==='last_hits'?'lastHits':'experience';
    return [semantic,snapshotAt({semantic,cumulative:true,timelineVerified:verified,intervalSeconds:5,evidenceIds:[context.match.id],
      points:states.map(s=>({gameTimeSeconds:s.gameTimeSeconds,value:s.lane?.formatVersion==='lane-v1' && s.provenance.sourceVersion==='normalized-v2/clarity-5.0.1/protobuf-7.1' && s.lane[key].status==='known' && s.lane[key].observedAtSeconds===s.gameTimeSeconds ? s.lane[key].value:null,evidenceIds:[s.id]}))},600)];
  })) as Record<"last_hits" | "experience", Snapshot>;
}
export interface LaneComparison {
  metric: "last_hits" | "experience"; current: Snapshot; n: number; median: number | null; q1: number | null; q3: number | null;
  status: "signal" | "no_signal" | "skipped"; reasons: string[];
  samples: {matchId:string;datasetId:string|null;snapshot:Snapshot}[];
}
export function compareLaning(selection: ComparisonSelection): LaneComparison[] {
  return (["last_hits","experience"] as const).map(metric=>{
    const current=selection.current.lane[metric];
    const samples=selection.included.filter(m=>m.lane[metric].metric.status==='known' && m.lane[metric].metric.value!==null).map(m=>({matchId:m.matchId,datasetId:m.datasetId,snapshot:m.lane[metric]}));
    const values=samples.map(s=>s.snapshot.metric.value!),q1=quantile(values,.25),q3=quantile(values,.75),median=quantile(values,.5);
    const reasons:string[]=[];
    if(current.metric.status!=='known'||current.metric.value===null)reasons.push('snapshot_unavailable');
    if(samples.length<10)reasons.push('fewer_than_ten');
    if(selection.current.role===null||selection.current.patch===null||selection.current.heroId===null||selection.current.mode===null)reasons.push('context_unknown');
    if(selection.filters.relaxed.length)reasons.push('relaxed_comparison');
    if(selection.current.earlyLeave!==false||selection.current.dataGap!==false||selection.current.conflict||!selection.current.validated)reasons.push('current_not_typical');
    if(q1!==null&&q1===q3)reasons.push('zero_iqr');
    return {metric,current,n:samples.length,median,q1,q3,samples,reasons,status:reasons.length?'skipped':current.metric.value!<q1!?'signal':'no_signal'};
  });
}
export function evaluateL01(context: AnalysisContext, selection: ComparisonSelection): RuleResult[] {
  return compareLaning(selection).flatMap(comparison=>{
    const config={comparisonId:`comparison-${selection.fingerprint}`,metric:comparison.metric,minimumN:10,quantileMethod:'linear-(n-1)*p',targetSeconds:600};
    const base=()=>{const r=result('L01',null,{startSeconds:0,endSeconds:600},config,[]);r.version='e09-l01-v1';r.status=comparison.status;r.reasons=comparison.reasons;r.dataComplete=comparison.status!=='skipped';
      r.evidenceIds=comparison.current.metric.evidenceIds;
      r.limitations=['Предварительный сигнал собственной выборки не доказывает ошибку или её причину. Учитывайте сложность линии, саппортов, смерти и перемещения.',`База и фильтры сохранены: ${config.comparisonId}.`];
      if(comparison.current.metric.value!==null)r.facts.push(`${comparison.metric==='last_hits'?'Добивания':'Накопленный опыт'} к 600 с: ${comparison.current.metric.value}; фактическое наблюдение ${comparison.current.observedAtSeconds} с.`);
      if(comparison.n)r.facts.push(`Собственная база: n=${comparison.n}, медиана ${comparison.median}, Q1=${comparison.q1}, Q3=${comparison.q3}.`);
      return r;};
    if(comparison.status!=='signal')return [base()];
    const deaths=context.events.filter(e=>e.data.type==='death' && e.data.victimSlot===context.player.playerSlot && e.gameTimeSeconds>=0 && e.gameTimeSeconds<=600 && positiveEvent(context,e));
    if(deaths.length)return deaths.map(death=>{const r=base();r.anchorId=death.id;r.eventIds=[death.id];r.evidenceIds=unique([...r.evidenceIds,death.id]);setView(context,r,{startSeconds:death.gameTimeSeconds-30,endSeconds:death.gameTimeSeconds+15});r.facts.push('Показатель ниже Q1 этой выборки; предлагается проверить известную смерть на линии, причинная связь не установлена.');return r;});
    const r=base();r.anchorId=comparison.current.metric.evidenceIds.find(id=>context.records.some(record=>record.id===id&&record.kind==='hero_state'))??null;
    setView(context,r,{startSeconds:0,endSeconds:600});r.facts.push('Показатель ниже Q1 этой выборки. Предлагается обзор первых десяти минут без выдуманного момента ошибки.');
    if(!r.anchorId||!r.viewWindow){r.status='skipped';r.reasons=['lane_view_unavailable'];r.dataComplete=false;}
    return [r];
  });
}
