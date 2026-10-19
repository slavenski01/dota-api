import { validateRecord, type Episode, type GameEvent, type PlayerSlot, type RuleId } from "@dota/contracts";
import { evaluateD01, evaluateD02 } from "./death-rules.js";
import { analysisOptions, evaluateF01, evaluateI01, purchaseJournal, type AnalysisOptions } from "./item-fight-rules.js";
import { summaryMetrics, type Metric } from "./metrics.js";
import { fingerprint, RULES_VERSION, unique, type AnalysisContext, type RuleResult } from "./rules.js";

export interface AnalysisRunVersions {
  parser: string; normalization: string; rules: string; skillSha256: string; configSha256: string;
  model: string | null; contextSha256: string | null;
}
export interface SelectedEpisode {
  episode: Episode; anchorId: string; priorityGroup: number; results: RuleResult[]; relatedEpisodeIds: string[];
}
export interface AnalysisRun {
  comparison?: { id: string; fingerprint: string };
  id: string; datasetId: string; matchId: string; playerSlot: PlayerSlot; mode: "retrospective";
  versions: AnalysisRunVersions; options: AnalysisOptions | null; metrics: Record<string, Metric>;
  outcome: "candidates" | "no_candidates" | "insufficient_data"; completeness: "complete" | "partial";
  results: RuleResult[]; episodes: SelectedEpisode[]; primaryEpisodeIds: string[]; purchases: GameEvent[];
  limitations: string[];
}
const priority: Record<RuleId, number> = { D02: 0, D01: 1, L01: 2, I01: 3, F01: 4 };
/** Group by the same anchor, never by overlapping windows. L01 is reserved for E09. */
export function selectEpisodes(context: AnalysisContext, results: RuleResult[], analysisId: string): SelectedEpisode[] {
  const recordIds = new Set(context.records.map(r => r.id));
  const groups = new Map<string, RuleResult[]>();
  for (const output of results.filter(r => r.status === "signal")) {
    if (!output.anchorId || !output.viewWindow) throw new Error("signal_without_anchor_or_view");
    const key = `${["D01", "D02"].includes(output.ruleId) ? "death" : output.ruleId}:${output.anchorId}`;
    groups.set(key, [...(groups.get(key) ?? []), output]);
  }
  const episodes: SelectedEpisode[] = [...groups.entries()].map(([key, group]) => {
    group.sort((a, b) => priority[a.ruleId] - priority[b.ruleId]);
    const anchorId = group[0]!.anchorId!, anchor = context.records.find(e => e.id === anchorId);
    if (!anchor) throw new Error("episode_anchor_missing");
    const evidenceIds = unique(group.flatMap(r => r.evidenceIds));
    if (evidenceIds.some(id => !recordIds.has(id))) throw new Error("episode_evidence_missing");
    const episode = validateRecord({ schemaVersion: "0.1.0", kind: "episode", id: `episode-${fingerprint({ analysisId, key })}`, matchId: context.match.matchId,
      provenance: { source: "derived", acquiredAt: context.match.provenance.acquiredAt, artifactId: context.match.provenance.artifactId, sourceVersion: RULES_VERSION, inputIds: evidenceIds },
      datasetId: context.validation.datasetId, playerSlot: context.player.playerSlot,
      window: { startSeconds: Math.min(...group.map(r => r.viewWindow!.startSeconds)), endSeconds: Math.max(...group.map(r => r.viewWindow!.endSeconds)) },
      decisionTimeSeconds: anchor.kind === "event" ? anchor.data.type === "fight" ? anchor.data.window.startSeconds : anchor.gameTimeSeconds : 0,
      signals: group.map(r => ({ ruleId: r.ruleId, ruleVersion: r.version, configSha256: r.configSha256, evidenceIds: r.evidenceIds })), evidenceIds, review: null }) as Episode;
    return { episode, anchorId, priorityGroup: Math.min(...group.map(r => priority[r.ruleId])), results: group, relatedEpisodeIds: [] };
  });
  for (const fight of episodes.filter(e => e.results.some(r => r.ruleId === "F01"))) {
    const window = fight.results.find(r => r.ruleId === "F01")!.window;
    for (const death of episodes.filter(e => e.results.some(r => r.ruleId === "D01" || r.ruleId === "D02"))) {
      if (death.episode.decisionTimeSeconds >= window.startSeconds && death.episode.decisionTimeSeconds <= window.endSeconds) {
        fight.relatedEpisodeIds.push(death.episode.id); death.relatedEpisodeIds.push(fight.episode.id);
      }
    }
  }
  for (const e of episodes) e.relatedEpisodeIds.sort();
  return episodes.sort((a, b) => a.priorityGroup - b.priorityGroup || a.episode.decisionTimeSeconds - b.episode.decisionTimeSeconds || a.episode.id.localeCompare(b.episode.id));
}
export function analyse(context: AnalysisContext, input: AnalysisOptions | null, versions: AnalysisRunVersions): AnalysisRun {
  if (versions.rules !== RULES_VERSION) throw new Error("analysis_version_unsupported");
  const options = analysisOptions(input);
  const id = `analysis-${fingerprint({ datasetId: context.validation.datasetId, playerSlot: context.player.playerSlot, versions, options })}`;
  const results = [...evaluateD01(context), ...evaluateD02(context), ...evaluateI01(context, options), ...evaluateF01(context)];
  const episodes = selectEpisodes(context, results, id);
  const incomplete = results.some(r => r.status === "skipped" || !r.dataComplete);
  return { id, datasetId: context.validation.datasetId, matchId: context.match.matchId, playerSlot: context.player.playerSlot, mode: "retrospective", versions, options,
    metrics: summaryMetrics(context), outcome: episodes.length ? "candidates" : incomplete ? "insufficient_data" : "no_candidates",
    completeness: incomplete ? "partial" : "complete", results, episodes, primaryEpisodeIds: episodes.slice(0, 3).map(e => e.episode.id), purchases: purchaseJournal(context),
    limitations: ["Порядок просмотра из методики не является шкалой тяжести. Автоматические эпизоды требуют проверки и не подтверждают ошибку.",
      "Это ретроспективный отбор по событиям. Его нельзя использовать как сведения, доступные игроку в момент решения.",
      "Сравнение линии с собственной базой запускается отдельно на странице сравнения. Старые наборы могут не иметь снимков добиваний и опыта."] };
}
