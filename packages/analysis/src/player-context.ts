import { validateRecord, type HeroState, type PlayerSlot, type Team } from "@dota/contracts";

const slots: PlayerSlot[] = [0,1,2,3,4,128,129,130,131,132];
const unknown = () => ({ status: "unknown" as const, value: null, reason: "No verified observation available to this team at this time." });
type DecisionState = Pick<HeroState, "playerSlot" | "gameTimeSeconds" | "visibility" | "position" | "hp" | "mana" | "alive" | "inventory" | "resources" | "lastKnownPosition">;
export interface DecisionContext {
  mode: "decision"; team: Team; playerSlot: PlayerSlot; decisionTimeSeconds: number;
  states: DecisionState[]; camera: { status: "unavailable" }; limitations: string[];
}

/** Current production policy: no supported verification of team bits, smoke or detection.
 * This intentionally has no boolean switch that promotes candidate bits to facts. */
export function maskUnverifiedState(input: HeroState, team: Team): HeroState {
  if (!["radiant", "dire"].includes(team)) throw new Error("invalid_team");
  const record = validateRecord(input);
  if (record.kind !== "hero_state" || record.perspective.mode !== "omniscient") throw new Error("omniscient_state_required");
  return { schemaVersion: "0.1.0", kind: "hero_state", id: record.id, matchId: record.matchId,
    provenance: { source: "derived", acquiredAt: record.provenance.acquiredAt, artifactId: null, sourceVersion: "team-mask-v1", inputIds: [] },
    playerSlot: record.playerSlot, gameTimeSeconds: record.gameTimeSeconds, tick: null, perspective: { mode: "team", team },
    visibility: unknown(), position: unknown(), hp: unknown(), mana: unknown(), alive: unknown(), inventory: unknown(), resources: unknown(),
    lastKnownPosition: null, coverageIds: [] };
}

/** Accepts only already established team observations, never full-state records or raw bits.
 * Whitelist output excludes final stats, future events, coverage/provenance references and
 * the sampling pattern (production samples near deaths are selected retrospectively). */
export function decisionContext(input: HeroState[], team: Team, playerSlot: PlayerSlot, time: number): DecisionContext {
  if (!Number.isFinite(time) || !slots.includes(playerSlot) || (playerSlot < 128 ? "radiant" : "dire") !== team) throw new Error("invalid_decision_context");
  const records = input.map(r => validateRecord(r) as HeroState);
  if (records.some(r => r.kind !== "hero_state" || r.perspective.mode !== "team" || r.perspective.team !== team) || new Set(records.map(r => r.matchId)).size > 1) throw new Error("team_observations_required");
  const states: DecisionState[] = slots.map(slot => {
    const history = records.filter(r => r.playerSlot === slot && r.gameTimeSeconds <= time).sort((a,b) => a.gameTimeSeconds-b.gameTimeSeconds);
    const at = history.filter(r => r.gameTimeSeconds === time);
    // Conflicting simultaneous records cannot select a convenient positive observation.
    const current = at.length === 1 ? at[0] : undefined;
    const visible = current?.visibility.status === "known" && current.visibility.value === "visible" && current.visibility.observedAtSeconds === time;
    function observed<K extends "position" | "hp" | "mana" | "alive" | "inventory" | "resources">(key: K): HeroState[K] {
      const field = current?.[key];
      if (!visible || field?.status !== "known" || field.observedAtSeconds !== time) return unknown();
      if (key === "resources" && (slot < 128 ? "radiant" : "dire") !== team) return unknown();
      const safe = structuredClone(field);
      if (key === "resources" && safe.status === "known") {
        for (const item of (safe as Extract<HeroState["resources"], { status: "known" }>).value) {
          if (item.cooldownRemainingSeconds.status !== "known" || item.cooldownRemainingSeconds.observedAtSeconds !== time) item.cooldownRemainingSeconds = unknown();
          if (item.canUse.status !== "known" || item.canUse.observedAtSeconds !== time) item.canUse = unknown();
        }
      }
      return safe;
    }
    let lastKnownPosition: HeroState["lastKnownPosition"] = null;
    const times = new Map<number, number>();
    for (const r of history) times.set(r.gameTimeSeconds, (times.get(r.gameTimeSeconds) ?? 0)+1);
    for (const r of history) if (times.get(r.gameTimeSeconds) === 1 && r.visibility.status === "known" && r.visibility.value === "visible" &&
      r.visibility.observedAtSeconds === r.gameTimeSeconds && r.position.status === "known" && r.position.observedAtSeconds === r.gameTimeSeconds)
      lastKnownPosition = { position: structuredClone(r.position.value), observedAtSeconds: r.gameTimeSeconds };
    const visibility = current?.visibility.status === "known" && current.visibility.observedAtSeconds === time ? structuredClone(current.visibility) : unknown();
    return { playerSlot: slot, gameTimeSeconds: time, visibility, position: observed("position"), hp: observed("hp"), mana: observed("mana"), alive: observed("alive"),
      inventory: observed("inventory"), resources: observed("resources"), lastKnownPosition: visible ? null : lastKnownPosition };
  });
  return { mode: "decision", team, playerSlot, decisionTimeSeconds: time, states, camera: { status: "unavailable" },
    limitations: ["Only verified team observations at or before the decision are eligible. Unknown visibility is not hidden visibility.",
      "Last-known positions are historical observations, not current positions. Enemy cooldowns and action availability are not disclosed."] };
}
