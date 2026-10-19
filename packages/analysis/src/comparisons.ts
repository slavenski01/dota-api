import { fingerprint } from "./rules.js";
import type { Snapshot } from "./metrics.js";

export const COMPARISON_VERSION = "e09-v1";
export const comparisonFields = ["heroId", "role", "patch", "mode", "aspect", "party", "plan"] as const;
export type ComparisonField = typeof comparisonFields[number];
export interface ComparisonContext {
  role: 1 | 2 | 3 | 4 | 5 | null; patch: string | null;
  aspect: string | null; party: "solo" | "party" | null; plan: string | null;
  earlyLeave: boolean | null; dataGap: boolean | null;
}
export interface ComparisonMatch extends ComparisonContext {
  analysisId?: string | null;
  matchId: string; datasetId: string | null; accountId: string; startedAt: string | null;
  heroId: string | null; mode: string | null; won: boolean | null;
  contextVersion: number; validated: boolean; conflict: boolean;
  metrics: Record<string, { value: number | null; evidenceIds: string[] }>;
  lane: Record<"last_hits" | "experience", Snapshot>;
}
export interface ComparisonFilters { relaxed: ComparisonField[]; additional: ComparisonField[] }
export interface ComparisonSelection {
  version: string; filters: ComparisonFilters; current: ComparisonMatch; included: ComparisonMatch[];
  excluded: { match: ComparisonMatch; reasons: string[] }[]; fingerprint: string;
}
export function selectComparison(current: ComparisonMatch, candidates: ComparisonMatch[], filters: ComparisonFilters): ComparisonSelection {
  const required: ComparisonField[] = ["heroId", "role", "patch", "mode"];
  const fields = [...new Set([...required, ...filters.additional])].filter(f => !filters.relaxed.includes(f));
  const included: ComparisonMatch[] = [], excluded: ComparisonSelection["excluded"] = [];
  const seen = new Set<string>();
  for (const match of candidates) {
    const reasons: string[] = [];
    if (match.accountId !== current.accountId) reasons.push("different_player");
    if (match.matchId === current.matchId) reasons.push("current_match");
    if (seen.has(match.matchId)) reasons.push("duplicate_match");
    seen.add(match.matchId);
    if (!current.startedAt || !match.startedAt) reasons.push("start_unknown");
    else if (Date.parse(match.startedAt) >= Date.parse(current.startedAt)) reasons.push("not_previous");
    if (!match.datasetId || !match.validated) reasons.push("dataset_unavailable");
    if (match.conflict || current.conflict) reasons.push("source_conflict");
    if (match.earlyLeave !== false) reasons.push(match.earlyLeave ? "early_leave" : "leave_unknown");
    if (match.dataGap !== false) reasons.push(match.dataGap ? "data_gap" : "gap_unknown");
    for (const field of fields) {
      if (current[field] === null || match[field] === null) reasons.push(`${field}_unknown`);
      else if (current[field] !== match[field]) reasons.push(`${field}_different`);
    }
    if (reasons.length) excluded.push({ match, reasons }); else included.push(match);
  }
  const data = { version: COMPARISON_VERSION, filters, current, included, excluded };
  return { ...data, fingerprint: fingerprint(data) };
}
export function quantile(values: number[], p: number): number | null {
  if (!values.length || values.some(v => !Number.isFinite(v)) || p < 0 || p > 1) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * p;
  const lower = Math.floor(index), weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[Math.ceil(index)]! * weight;
}
export function comparisonMetrics(selection: ComparisonSelection) {
  return Object.fromEntries(Object.entries(selection.current.metrics).map(([key, current]) => {
    const values = selection.included.flatMap(m => m.metrics[key]?.value === null || m.metrics[key]?.value === undefined ? [] : [m.metrics[key]!.value!]);
    return [key, { current, n: values.length, median: quantile(values, .5), q1: quantile(values, .25), q3: quantile(values, .75), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null }];
  }));
}
