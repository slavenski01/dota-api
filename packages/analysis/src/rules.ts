import { createHash } from "node:crypto";
import { validateRecord, type ContractRecord, type Coverage, type GameEvent, type Match, type Participant, type PlayerSlot, type RuleId, type Team, type Window } from "@dota/contracts";
import { windowUsability, type DatasetValidation } from "./coverage.js";

export const RULES_VERSION = "e06-v1";
export const PLAYER_SLOTS: PlayerSlot[] = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
export const teamOf = (slot: PlayerSlot): Team => slot < 128 ? "radiant" : "dire";
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const unique = (ids: string[]): string[] => [...new Set(ids)].sort();
export interface AnalysisContext {
  records: ContractRecord[]; events: GameEvent[]; match: Match; player: Participant;
  participants: Participant[]; validation: DatasetValidation;
}
/** Only a trusted source adapter supplies validation. HTTP clients cannot attest coverage. */
export function analysisContext(input: unknown[], validation: DatasetValidation, playerSlot: PlayerSlot): AnalysisContext {
  const records = input.map(validateRecord);
  const matches = records.filter(r => r.kind === "match");
  const participants = records.filter(r => r.kind === "participant");
  const player = participants.find(p => p.playerSlot === playerSlot);
  if (!player || matches.length !== 1 || participants.length !== 10 || new Set(participants.map(p => p.playerSlot)).size !== 10 ||
    new Set(records.map(r => r.id)).size !== records.length || records.some(r => r.matchId !== validation.matchId || "datasetId" in r && r.datasetId !== validation.datasetId) ||
    validation.coverage.some(c => c.datasetId !== validation.datasetId || c.matchId !== validation.matchId)) throw new Error("invalid_analysis_dataset");
  return { records, match: matches[0]!, participants, player, validation,
    events: records.filter(r => r.kind === "event").sort((a, b) => a.gameTimeSeconds - b.gameTimeSeconds || a.id.localeCompare(b.id)) };
}
export interface Requirement {
  field: Coverage["field"]; mode: "complete_window" | "positive_event"; participantSlots: PlayerSlot[]; window: Window;
}
export interface RuleResult {
  ruleId: RuleId; version: string; config: Record<string, string | number | null>; configSha256: string;
  anchorId: string | null; window: Window; requirements: Requirement[];
  status: "signal" | "no_signal" | "skipped"; reasons: string[]; evidenceIds: string[];
  facts: string[]; limitations: string[]; eventIds: string[]; viewWindow: Window | null; viewClipped: boolean;
}
export interface RuleDefinition {
  id: RuleId; version: string; evaluate(context: AnalysisContext): RuleResult[];
}
export function result(ruleId: RuleId, anchorId: string | null, window: Window, config: RuleResult["config"], requirements: Requirement[]): RuleResult {
  return { ruleId, version: RULES_VERSION, config, configSha256: fingerprint(config), anchorId, window, requirements,
    status: "skipped", reasons: [], evidenceIds: [], facts: [], limitations: [], eventIds: [], viewWindow: null, viewClipped: false };
}
export function completeWindow(context: AnalysisContext, field: Coverage["field"], window: Window, slots = PLAYER_SLOTS) {
  return windowUsability(context.validation, field, slots, window);
}
export function eventField(event: GameEvent): Coverage["field"] {
  return ({ death: "deaths", item: "items", objective: "objectives", fight: "fights" } as const)[event.data.type];
}
/** A partial journal can establish a positive event; conflicts cannot. */
export function positiveEvent(context: AnalysisContext, event: GameEvent): boolean {
  const field = eventField(event), report = context.validation;
  return report.complete && !report.issues.some(i => i.field === null || i.field === field || i.field === "time") &&
    completeWindow(context, "time", { startSeconds: event.gameTimeSeconds, endSeconds: event.gameTimeSeconds }).usable &&
    event.coverageIds.some(id => report.coverage.some(c => c.id === id && c.field === field && c.status !== "error" &&
      c.window.startSeconds <= event.gameTimeSeconds && c.window.endSeconds >= event.gameTimeSeconds && c.evidenceIds.includes(event.id))) &&
    !report.coverage.some(c => c.field === field && c.status === "error" && c.window.startSeconds <= event.gameTimeSeconds && c.window.endSeconds >= event.gameTimeSeconds);
}
export const within = (event: GameEvent, window: Window): boolean => event.gameTimeSeconds >= window.startSeconds && event.gameTimeSeconds <= window.endSeconds;
export function setView(context: AnalysisContext, output: RuleResult, wanted: Window): void {
  const clocks = context.validation.coverage.filter(c => c.field === "time" && ["present", "empty"].includes(c.status));
  const start = Math.max(wanted.startSeconds, ...clocks.map(c => c.window.startSeconds));
  const end = Math.min(wanted.endSeconds, context.match.durationSeconds ?? -Infinity, ...clocks.map(c => c.window.endSeconds));
  output.viewWindow = clocks.length && start <= end ? { startSeconds: start, endSeconds: end } : null;
  output.viewClipped = !output.viewWindow || start !== wanted.startSeconds || end !== wanted.endSeconds;
}
