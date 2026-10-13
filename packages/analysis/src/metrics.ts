import type { Team } from "@dota/contracts";
import { completeWindow, unique, type AnalysisContext } from "./rules.js";

export interface Metric {
  status: "known" | "unknown"; value: number | null; formula: string; unit: string;
  inputs: Record<string, number | null>; evidenceIds: string[]; reason: string | null;
}
export function metric(value: number | null, formula: string, unit: string, inputs: Metric["inputs"], evidenceIds: string[], reason = "missing_or_invalid_input"): Metric {
  const known = value !== null && Number.isFinite(value) && evidenceIds.length > 0;
  return { status: known ? "known" : "unknown", value: known ? value : null, formula, unit, inputs, evidenceIds: unique(evidenceIds), reason: known ? null : reason };
}
const nonnegative = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0;
export function deathsPerTenMinutes(deaths: number | null, durationSeconds: number | null, evidenceIds: string[]): Metric {
  return metric(nonnegative(deaths) && nonnegative(durationSeconds) && durationSeconds > 0 ? deaths * 600 / durationSeconds : null,
    "deaths * 600 / durationSeconds", "deaths/10min", { deaths, durationSeconds }, evidenceIds);
}
export function killParticipation(kills: number | null, assists: number | null, teamKills: number | null, evidenceIds: string[]): Metric {
  return metric(nonnegative(kills) && nonnegative(assists) && nonnegative(teamKills) && teamKills > 0 && kills + assists <= teamKills ? (kills + assists) / teamKills : null,
    "(kills + assists) / teamKills", "ratio", { kills, assists, teamKills }, evidenceIds);
}
export function playerAdvantage(radiantMinusDire: number | null, team: Team, evidenceIds: string[]): Metric {
  return metric(radiantMinusDire !== null && Number.isFinite(radiantMinusDire) && ["radiant", "dire"].includes(team) ? radiantMinusDire * (team === "dire" ? -1 : 1) : null,
    team === "dire" ? "-(radiant - dire)" : "radiant - dire", "source_units", { radiantMinusDire }, evidenceIds);
}
export interface MetricSeries {
  semantic: "last_hits" | "experience" | "earned_gold" | "current_gold" | "net_worth";
  cumulative: boolean; timelineVerified: boolean; intervalSeconds: number | null; evidenceIds: string[];
  points: { gameTimeSeconds: number; value: number | null; evidenceIds: string[] }[];
}
export interface Snapshot { targetSeconds: number; observedAtSeconds: number | null; metric: Metric }
export function snapshotAt(series: MetricSeries, targetSeconds: number): Snapshot {
  const fail = (reason: string): Snapshot => ({ targetSeconds, observedAtSeconds: null,
    metric: metric(null, "last observation at or before target", series.semantic, { targetSeconds }, series.evidenceIds, reason) });
  if (!Number.isFinite(targetSeconds) || !series.timelineVerified || !series.evidenceIds.length || series.points.some(p => !Number.isFinite(p.gameTimeSeconds))) return fail("unverified_timeline");
  const eligible = series.points.filter(p => p.gameTimeSeconds <= targetSeconds).sort((a, b) => b.gameTimeSeconds - a.gameTimeSeconds);
  const point = eligible[0];
  if (!point || point.gameTimeSeconds !== targetSeconds && !(series.intervalSeconds !== null && Number.isFinite(series.intervalSeconds) && series.intervalSeconds > 0 && targetSeconds - point.gameTimeSeconds <= series.intervalSeconds)) return fail("snapshot_missing_or_stale");
  if (eligible.filter(p => p.gameTimeSeconds === point.gameTimeSeconds).length !== 1) return fail("conflicting_observations");
  if (!nonnegative(point.value) || !point.evidenceIds.length) return fail("unknown_observation");
  return { targetSeconds, observedAtSeconds: point.gameTimeSeconds, metric: metric(point.value, "last observation at or before target", series.semantic,
    { targetSeconds, observedAtSeconds: point.gameTimeSeconds, value: point.value }, [...series.evidenceIds, ...point.evidenceIds]) };
}
export function cumulativeGain(series: MetricSeries, startSeconds: number, endSeconds: number): Metric {
  const start = snapshotAt(series, startSeconds), end = snapshotAt(series, endSeconds);
  const a = start.metric.value, b = end.metric.value;
  return metric(series.cumulative && startSeconds <= endSeconds && a !== null && b !== null && b >= a ? b - a : null,
    "cumulative(end) - cumulative(start)", series.semantic, { startSeconds, endSeconds, startObservedAt: start.observedAtSeconds, endObservedAt: end.observedAtSeconds, start: a, end: b },
    [...start.metric.evidenceIds, ...end.metric.evidenceIds], "cumulative_meaning_or_endpoints_unconfirmed");
}
export function summaryMetrics(context: AnalysisContext): Record<string, Metric> {
  const duration = context.match.durationSeconds;
  const allies = context.participants.filter(p => p.team === context.player.team);
  const usable = duration !== null && completeWindow(context, "statistics", { startSeconds: duration, endSeconds: duration }, allies.map(p => p.playerSlot)).usable;
  const stats = context.player.statistics;
  const ids = [context.match.id, ...allies.map(p => p.id)];
  return {
    deathsPerTenMinutes: deathsPerTenMinutes(usable ? stats.deaths : null, duration, ids),
    killParticipation: killParticipation(usable ? stats.kills : null, usable ? stats.assists : null,
      usable && allies.every(p => p.statistics.kills !== null) ? allies.reduce((sum, p) => sum + p.statistics.kills!, 0) : null, ids),
  };
}
