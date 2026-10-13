import type { GameEvent, Window } from "@dota/contracts";
import { completeWindow, PLAYER_SLOTS, positiveEvent, result, setView, teamOf, unique, within, type AnalysisContext, type RuleResult } from "./rules.js";

function deaths(context: AnalysisContext): GameEvent[] {
  return context.events.filter(e => e.data.type === "death" && e.data.victimSlot === context.player.playerSlot);
}
export function noAnchors(context: AnalysisContext, ruleId: "D01" | "D02" | "I01" | "F01", field: "deaths" | "items" | "fights", config: RuleResult["config"]): RuleResult {
  const clock = context.validation.coverage.filter(c => c.field === "time" && c.status === "present");
  const window = { startSeconds: Math.min(0, ...clock.map(c => c.window.startSeconds)), endSeconds: context.match.durationSeconds ?? 0 };
  const output = result(ruleId, null, window, config, [{ field, mode: "complete_window", participantSlots: PLAYER_SLOTS, window }]);
  const covered = completeWindow(context, field, window), time = completeWindow(context, "time", window);
  output.status = covered.usable && time.usable ? "no_signal" : "skipped";
  output.dataComplete = output.status === "no_signal";
  output.reasons = output.status === "no_signal" ? [] : [`${field}_anchors_or_coverage_missing`, ...covered.reasons, ...time.reasons];
  output.evidenceIds = unique([...covered.evidenceIds, ...time.evidenceIds]);
  return output;
}
const D01_CONFIG = { beforeSeconds: 15, afterSeconds: 30, viewBeforeSeconds: 30 };
const D02_CONFIG = { afterSeconds: 90, viewBeforeSeconds: 30, viewAfterObjectiveSeconds: 15 };

export function evaluateD01(context: AnalysisContext): RuleResult[] {
  const anchors = deaths(context);
  if (!anchors.length) return [noAnchors(context, "D01", "deaths", D01_CONFIG)];
  return anchors.map(anchor => {
    const t = anchor.gameTimeSeconds, window = { startSeconds: t - 15, endSeconds: t + 30 };
    const output = result("D01", anchor.id, window, D01_CONFIG, [{ field: "deaths", mode: "complete_window", participantSlots: PLAYER_SLOTS, window }]);
    const covered = completeWindow(context, "deaths", window), time = completeWindow(context, "time", window);
    output.evidenceIds = [anchor.id];
    if (!positiveEvent(context, anchor) || !covered.usable || !time.usable) {
      output.reasons = unique(["death_or_full_window_unverified", ...covered.reasons, ...time.reasons]); return output;
    }
    const enemies = context.events.filter(e => e.data.type === "death" && teamOf(e.data.victimSlot) !== context.player.team && within(e, window));
    output.status = enemies.length ? "no_signal" : "signal";
    output.dataComplete = true;
    output.evidenceIds = unique([anchor.id, ...covered.evidenceIds, ...time.evidenceIds]);
    output.eventIds = enemies.map(e => e.id);
    output.facts = enemies.length ? [`В окне зарегистрировано смертей героев противника: ${enemies.length}.`] : ["В ближайшем окне не зарегистрированы смерти героев противника."];
    output.limitations = ["Это не доказывает бесполезность смерти: возможны спасение союзника, отвлечение противников или размен на объект."];
    setView(context, output, { startSeconds: t - 30, endSeconds: t + 30 });
    return output;
  });
}

export function objectiveOutcome(event: GameEvent, team: "radiant" | "dire"): "lost" | "other" | "unknown" {
  if (event.data.type !== "objective") return "other";
  const { objectType, ownerTeam, beneficiaryTeam } = event.data;
  if (!["tower", "barracks", "roshan"].includes(objectType)) return "other";
  if (objectType === "roshan") return ownerTeam !== null || beneficiaryTeam === null ? "unknown" : beneficiaryTeam !== team ? "lost" : "other";
  if (ownerTeam === null || beneficiaryTeam === null) return "unknown";
  return ownerTeam === team && beneficiaryTeam !== team ? "lost" : "other";
}
export function evaluateD02(context: AnalysisContext): RuleResult[] {
  const anchors = deaths(context);
  if (!anchors.length) return [noAnchors(context, "D02", "deaths", D02_CONFIG)];
  return anchors.map(anchor => {
    const t = anchor.gameTimeSeconds, window: Window = { startSeconds: t, endSeconds: t + 90 };
    const output = result("D02", anchor.id, window, D02_CONFIG, [{ field: "objectives", mode: "positive_event", participantSlots: PLAYER_SLOTS, window }]);
    output.evidenceIds = [anchor.id];
    if (!positiveEvent(context, anchor)) { output.reasons = ["death_unverified"]; return output; }
    const objectives = context.events.filter(e => e.data.type === "objective" && within(e, window));
    const losses = objectives.filter(e => objectiveOutcome(e, context.player.team) === "lost" && positiveEvent(context, e));
    const covered = completeWindow(context, "objectives", window), time = completeWindow(context, "time", window);
    const ambiguous = objectives.some(e => objectiveOutcome(e, context.player.team) === "unknown" || !positiveEvent(context, e));
    if (!losses.length && (!covered.usable || !time.usable || ambiguous)) {
      output.reasons = unique(["objective_loss_not_established", ...(ambiguous ? ["objective_side_or_event_unverified"] : []), ...covered.reasons, ...time.reasons]); return output;
    }
    output.status = losses.length ? "signal" : "no_signal";
    output.dataComplete = covered.usable && time.usable && !ambiguous;
    output.eventIds = losses.map(e => e.id);
    output.evidenceIds = unique([anchor.id, ...losses.map(e => e.id), ...(!losses.length ? [...covered.evidenceIds, ...time.evidenceIds] : [])]);
    output.facts = losses.length ? ["Смерть игрока и подтверждённая потеря объекта близки по времени."] : ["В полном окне не зарегистрированы подходящие потери объектов."];
    output.limitations = ["Причинная связь не установлена. Требуется проверить возможность защиты и размен на карте."];
    if (!covered.usable || !time.usable) output.limitations.push("Журнал или окно неполны; показаны только подтверждённые положительные события.");
    setView(context, output, { startSeconds: t - 30, endSeconds: losses.length ? losses[losses.length - 1]!.gameTimeSeconds + 15 : t + 90 });
    return output;
  });
}
