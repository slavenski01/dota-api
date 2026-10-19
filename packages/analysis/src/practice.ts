export interface PracticeCounts { done:number; missed:number; uncertain:number }
export function summarizePractice(rows: PracticeCounts[]) {
  const totals=rows.reduce((a,r)=>({done:a.done+r.done,missed:a.missed+r.missed,uncertain:a.uncertain+r.uncertain}),{done:0,missed:0,uncertain:0});
  const known=totals.done+totals.missed;
  return {...totals,reviewed:known+totals.uncertain,known,rate:known?totals.done/known:null,noOpportunityGames:rows.filter(r=>r.done+r.missed+r.uncertain===0).length};
}
