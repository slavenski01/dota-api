import { Ajv, type ValidateFunction } from "ajv";
import formats from "ajv-formats";
import { schema } from "./generated/schema.js";
import type { ContractRecord, ProtocolMessage, ProtocolRequest } from "./generated/types.js";

export const SCHEMA_VERSION = "0.1.0" as const;
export const PROTOCOL_VERSION = "1.0.0" as const;

export class ContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ContractError"; }
}

const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
formats.default(ajv);
ajv.addSchema(schema);
const compile = <T>(name: string): ValidateFunction<T> => ajv.compile<T>({ $ref: `${schema.$id}#/definitions/${name}` });
const recordSchema = compile<ContractRecord>("ContractRecord");
const messageSchema = compile<ProtocolMessage>("ProtocolMessage");
const requestSchema = compile<ProtocolRequest>("ProtocolRequest");

function requireCondition(condition: boolean, code: string): asserts condition {
  if (!condition) throw new ContractError(code);
}

// Relations between fields cannot be expressed in portable JSON Schema Draft 7.
// Keep these checks aligned with ContractValidator.kt and the shared fixture tests.
function checkTimes(value: unknown, stateTime?: number): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(item => checkTimes(item, stateTime)); return; }
  const item = value as Record<string, unknown>;
  if (typeof item.startSeconds === "number" && typeof item.endSeconds === "number") {
    requireCondition(item.startSeconds <= item.endSeconds, "reversed_window");
  }
  if (stateTime !== undefined && typeof item.observedAtSeconds === "number") {
    requireCondition(item.observedAtSeconds <= stateTime, "future_observation");
  }
  Object.values(item).forEach(child => checkTimes(child, stateTime));
}

export function validateRecord(input: unknown): ContractRecord {
  requireCondition(recordSchema(input), "invalid_record_schema");
  checkTimes(input, input.kind === "hero_state" ? input.gameTimeSeconds : undefined);
  switch (input.kind) {
    case "participant":
      requireCondition(input.team === (input.playerSlot < 128 ? "radiant" : "dire"), "slot_team_mismatch");
      break;
    case "hero_motion": {
      const rows = input.samples;
      requireCondition(rows.at(-1)!.time - rows[0]!.time < 30, "invalid_motion_window");
      rows.forEach((row, i) => {
        requireCondition((row.x === null) === (row.y === null), "partial_motion_position");
        requireCondition(row.x !== null || row.breakBefore !== null, "unknown_motion_boundary");
        if (i) requireCondition(row.time > rows[i-1]!.time && row.tick > rows[i-1]!.tick, "unordered_motion");
      });
      break;
    }
    case "hero_state":
      if (input.lane) {
        requireCondition(input.perspective.mode === "omniscient", "lane_requires_retrospective");
        for (const observation of [input.lane.lastHits,input.lane.experience]) requireCondition(observation.status !== "known" || observation.value >= 0, "negative_lane_counter");
      }
      if (input.perspective.mode === "team" && !(input.visibility.status === "known" && input.visibility.value === "visible")) {
        for (const field of [input.position, input.hp, input.mana, input.alive, input.inventory, input.resources]) {
          requireCondition(field.status !== "known", "hidden_current_state");
        }
      }
      break;
    case "coverage":
      if (input.status === "present" || input.status === "empty") {
        requireCondition(input.evidenceIds.length > 0, "coverage_requires_evidence");
      } else {
        requireCondition(input.reason !== null, "coverage_requires_reason");
      }
      break;
    case "job":
      requireCondition((input.status === "failed" || input.status === "unavailable") === (input.error !== null), "job_error_mismatch");
      requireCondition(input.status !== "ready" || input.dataLevel !== "none", "ready_without_data");
      break;
    case "episode":
      requireCondition(input.window.startSeconds <= input.decisionTimeSeconds && input.decisionTimeSeconds <= input.window.endSeconds, "decision_outside_window");
      requireCondition(input.review?.status !== "confirmed_error" || input.review.alternative !== null, "review_requires_alternative");
      break;
    case "report":
      requireCondition(input.reviewRefs.every(review => input.episodeIds.includes(review.episodeId)), "review_outside_report");
      break;
  }
  return input;
}

export function validateMessage(input: unknown): ProtocolMessage {
  requireCondition(messageSchema(input), "invalid_message_schema");
  if (input.type === "record") validateRecord(input.record);
  return input;
}

export function validateRequest(input: unknown): ProtocolRequest {
  requireCondition(requestSchema(input), "invalid_request_schema");
  return input;
}
