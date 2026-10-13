import type { GameEvent } from "@dota/contracts";
import { noAnchors } from "./death-rules.js";
import { completeWindow, PLAYER_SLOTS, positiveEvent, result, setView, teamOf, unique, within, type AnalysisContext, type RuleResult } from "./rules.js";

export interface AnalysisOptions { keyItemId: string; gamePlan: string }
export function analysisOptions(input: unknown): AnalysisOptions | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_analysis_options");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.keyItemId !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.keyItemId) ||
    typeof value.gamePlan !== "string" || !value.gamePlan.trim() || value.gamePlan.trim().length > 2000) throw new Error("invalid_analysis_options");
  return { keyItemId: value.keyItemId, gamePlan: value.gamePlan.trim() };
}
export function purchaseJournal(context: AnalysisContext): GameEvent[] {
  return context.events.filter(e => e.data.type === "item" && e.data.playerSlot === context.player.playerSlot && e.data.action === "purchased" && positiveEvent(context, e));
}
function verifiedFight(context: AnalysisContext, fight: GameEvent): boolean {
  return fight.data.type === "fight" && fight.data.definition.trim().length > 0 && fight.data.window.startSeconds < fight.data.window.endSeconds &&
    within(fight, fight.data.window) && new Set(fight.data.participantSlots.map(teamOf)).size === 2 && positiveEvent(context, fight) &&
    completeWindow(context, "fights", fight.data.window).usable && completeWindow(context, "time", fight.data.window).usable;
}
export function evaluateI01(context: AnalysisContext, input: AnalysisOptions | null = null): RuleResult[] {
  const options = analysisOptions(input), config = { afterSeconds: 180, keyItemId: options?.keyItemId ?? null, gamePlan: options?.gamePlan ?? null };
  if (!options) {
    const output = result("I01", null, { startSeconds: 0, endSeconds: context.match.durationSeconds ?? 0 }, config, []);
    output.reasons = ["key_item_and_game_plan_required"]; return [output];
  }
  const purchases = purchaseJournal(context).filter(e => e.data.type === "item" && e.data.itemId === options.keyItemId);
  if (!purchases.length) return [noAnchors(context, "I01", "items", config)];
  return purchases.map(purchase => {
    const window = { startSeconds: purchase.gameTimeSeconds, endSeconds: purchase.gameTimeSeconds + 180 };
    const output = result("I01", purchase.id, window, config, [{ field: "items", mode: "positive_event", participantSlots: [context.player.playerSlot], window: { startSeconds: purchase.gameTimeSeconds, endSeconds: purchase.gameTimeSeconds } }]);
    output.status = "signal";
    output.dataComplete = true;
    const events = context.events.filter(e => within(e, window) && ["death", "objective", "fight"].includes(e.data.type) && positiveEvent(context, e) && (e.data.type !== "fight" || verifiedFight(context, e)));
    output.eventIds = events.map(e => e.id);
    output.evidenceIds = unique([purchase.id, ...events.map(e => e.id)]);
    output.facts = ["Известная хронология 180 секунд после покупки выбранного ключевого предмета."];
    output.limitations = ["Покупка не подтверждает получение предмета героем или полезное применение. Хронология не доказывает пассивность либо упущенную возможность."];
    for (const field of ["deaths", "fights", "objectives", "time"] as const) {
      output.requirements.push({ field, mode: "complete_window", participantSlots: PLAYER_SLOTS, window });
      const covered = completeWindow(context, field, window);
      const label = { deaths: "Смерти", fights: "Бои", objectives: "Объекты", time: "Временная ось" }[field];
      if (!covered.usable) { output.dataComplete = false; output.limitations.push(`${label}: покрытие окна неполно; отсутствие событий не установлено.`); }
      else output.evidenceIds = unique([...output.evidenceIds, ...covered.evidenceIds]);
    }
    setView(context, output, window); return output;
  });
}
export function evaluateF01(context: AnalysisContext): RuleResult[] {
  const fights = context.events.filter(e => e.data.type === "fight");
  const config = { objectiveAfterSeconds: 90 };
  if (!fights.length) return [noAnchors(context, "F01", "fights", config)];
  return fights.map(fight => {
    if (fight.data.type !== "fight") throw new Error("fight_required");
    const window = fight.data.window;
    const output = result("F01", fight.id, window, config, ["fights", "deaths"].map(field => ({ field: field as "fights" | "deaths", mode: "complete_window", participantSlots: PLAYER_SLOTS, window })));
    output.evidenceIds = [fight.id];
    const covered = completeWindow(context, "deaths", window);
    if (!verifiedFight(context, fight) || !covered.usable) { output.reasons = ["fight_boundaries_definition_or_losses_unverified", ...covered.reasons]; return output; }
    const losses = context.events.filter(e => e.data.type === "death" && within(e, window));
    const own = losses.filter(e => e.data.type === "death" && teamOf(e.data.victimSlot) === context.player.team).length;
    const enemy = losses.length - own;
    output.status = enemy > own ? "signal" : "no_signal";
    const after = { startSeconds: window.endSeconds, endSeconds: window.endSeconds + 90 };
    const objects = context.events.filter(e => e.data.type === "objective" && within(e, after) && positiveEvent(context, e));
    output.eventIds = [...losses, ...objects].map(e => e.id);
    output.evidenceIds = unique([fight.id, ...covered.evidenceIds, ...output.eventIds, ...completeWindow(context, "fights", window).evidenceIds]);
    output.facts = [`Потери героев: своя команда — ${own}, противник — ${enemy}. Определение боя: ${fight.data.definition}`];
    if (enemy > own) output.facts.push("Бой с преимуществом по потерям героев.");
    const objectCoverage = completeWindow(context, "objectives", after), time = completeWindow(context, "time", after);
    output.dataComplete = objectCoverage.usable && time.usable;
    output.requirements.push({ field: "objectives", mode: "complete_window", participantSlots: PLAYER_SLOTS, window: after });
    output.limitations = ["Соотношение смертей не доказывает преимущество по золоту, объектам или стратегии. Повторные смерти после выкупа учтены."];
    if (objectCoverage.usable && time.usable) {
      output.evidenceIds = unique([...output.evidenceIds, ...objectCoverage.evidenceIds, ...time.evidenceIds]);
      if (!objects.length) output.facts.push("Объекты в этом окне не зарегистрированы.");
    } else output.limitations.push("Данных об объектах недостаточно для утверждения их отсутствия; показаны известные события.");
    setView(context, output, { startSeconds: window.startSeconds, endSeconds: after.endSeconds }); return output;
  });
}
