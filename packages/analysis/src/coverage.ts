import { validateRecord, type ContractRecord, type Coverage, type PlayerSlot, type Window } from "@dota/contracts";

export interface DatasetEvidence {
  datasetId: string; matchId: string; artifactId: string; inputSha256: string;
  /** Only the bounded adapter may attest these after successful transport and hash checks. */
  inputVerified: boolean; parserCompleted: boolean; parserVersion: string;
}
export interface CoverageIssue { code: string; field: Coverage["field"] | null; recordIds: string[] }
export interface DatasetValidation {
  version: "coverage-v1"; datasetId: string; matchId: string; inputSha256: string;
  complete: boolean; issues: CoverageIssue[]; coverage: Coverage[];
}
const fields: Coverage["field"][] = ["deaths", "items", "objectives", "fights", "positions", "visibility", "resources", "statistics", "time"];
function eventField(record: ContractRecord): Coverage["field"] | null {
  if (record.kind !== "event") return null;
  return ({ death: "deaths", item: "items", objective: "objectives", fight: "fights" } as const)[record.data.type];
}
function slotsOf(record: ContractRecord): number[] {
  if ("playerSlot" in record) return [record.playerSlot];
  if (record.kind === "event") {
    if (record.data.type === "death") return [record.data.victimSlot];
    if (record.data.type === "item") return [record.data.playerSlot];
    if (record.data.type === "fight") return record.data.participantSlots;
  }
  return [];
}
function relevant(record: ContractRecord, field: Coverage["field"]): boolean {
  return eventField(record) === field || field === "statistics" && record.kind === "participant" ||
    field === "time" && record.kind === "match" || field === "deaths" && record.kind === "participant" ||
    ["positions", "visibility", "resources"].includes(field) && record.kind === "hero_state";
}

/** Resolve evidence against this immutable dataset. Shape validation alone is not usability. */
export function validateDataset(input: unknown[], evidence: DatasetEvidence): DatasetValidation {
  const records = input.map(validateRecord);
  const report: DatasetValidation = { version: "coverage-v1", datasetId: evidence.datasetId, matchId: evidence.matchId,
    inputSha256: evidence.inputSha256, complete: true, issues: [], coverage: structuredClone(records.filter(r => r.kind === "coverage")) };
  const issue = (code: string, field: Coverage["field"] | null, ids: string[]) => {
    report.issues.push({ code, field, recordIds: ids });
    if (field === null) report.complete = false;
  };
  const supportedParser = ["normalized-v1/clarity-5.0.1", "normalized-v2/clarity-5.0.1"].includes(evidence.parserVersion);
  if (!evidence.inputVerified || !evidence.parserCompleted || !supportedParser || !/^[a-f0-9]{64}$/.test(evidence.inputSha256)) issue("unverified_parser_completion", null, []);
  const byId = new Map<string, ContractRecord>();
  const participants = records.filter(r => r.kind === "participant");
  const slots = participants.map(r => r.playerSlot);
  const matches = records.filter(r => r.kind === "match");
  if (matches.length !== 1 || slots.length !== 10 || new Set(slots).size !== 10) issue("dataset_identity_incomplete", null, []);
  for (const record of records) {
    if (byId.has(record.id)) issue("duplicate_record_id", null, [record.id]);
    byId.set(record.id, record);
    if (record.matchId !== evidence.matchId || record.provenance.artifactId !== evidence.artifactId || record.provenance.source !== "replay" ||
      record.provenance.sourceVersion !== `${evidence.parserVersion}/protobuf-7.1`) issue("source_conflict", null, [record.id]);
    if (slotsOf(record).some(slot => !slots.includes(slot as PlayerSlot))) issue("participant_not_found", null, [record.id]);
    if ("datasetId" in record && record.datasetId !== evidence.datasetId) issue("dataset_reference_mismatch", null, [record.id]);
    if ("gameTimeSeconds" in record && matches[0]?.durationSeconds != null && record.gameTimeSeconds > matches[0].durationSeconds) issue("postgame_record", eventField(record), [record.id]);
  }
  for (const coverage of report.coverage) {
    if (coverage.field === "statistics" && ["present", "empty"].includes(coverage.status) &&
      (coverage.status === "empty" || coverage.window.startSeconds !== matches[0]?.durationSeconds || coverage.window.endSeconds !== matches[0]?.durationSeconds ||
        participants.filter(p => coverage.participantSlots.includes(p.playerSlot)).some(p => Object.values(p.statistics).some(v => v === null) || !coverage.evidenceIds.includes(p.id))))
      issue("statistics_snapshot_incomplete", "statistics", [coverage.id]);
    if (coverage.field === "time" && (coverage.status === "empty" || matches[0]?.durationSeconds == null || coverage.window.endSeconds !== matches[0].durationSeconds || coverage.window.startSeconds >= 0))
      issue("clock_window_incomplete", "time", [coverage.id]);
    if (coverage.participantSlots.some(slot => !slots.includes(slot))) issue("coverage_participant_not_found", null, [coverage.id]);
    for (const id of coverage.evidenceIds) {
      const record = byId.get(id);
      if (!record) issue("evidence_not_found", null, [coverage.id, id]);
      else if (!relevant(record, coverage.field) || slotsOf(record).some(slot => !coverage.participantSlots.includes(slot as PlayerSlot)) ||
        "gameTimeSeconds" in record && (record.gameTimeSeconds < coverage.window.startSeconds || record.gameTimeSeconds > coverage.window.endSeconds)) issue("evidence_scope_mismatch", coverage.field, [coverage.id, id]);
    }
    if (["present", "empty"].includes(coverage.status) && coverage.evidenceIds.length === 0) issue("positive_coverage_without_evidence", coverage.field, [coverage.id]);
    if (coverage.status === "empty" && records.some(r => eventField(r) === coverage.field && "gameTimeSeconds" in r &&
      r.gameTimeSeconds >= coverage.window.startSeconds && r.gameTimeSeconds <= coverage.window.endSeconds &&
      (slotsOf(r).length === 0 || slotsOf(r).some(slot => coverage.participantSlots.includes(slot as PlayerSlot))))) issue("empty_coverage_has_events", coverage.field, [coverage.id]);
  }
  for (const record of records) if ("coverageIds" in record) {
    if (record.coverageIds.length === 0) issue("record_without_coverage", eventField(record), [record.id]);
    for (const id of record.coverageIds) {
      const coverage = byId.get(id);
      if (!coverage || coverage.kind !== "coverage") issue("coverage_not_found", null, [record.id, id]);
      else if (!relevant(record, coverage.field) || record.gameTimeSeconds < coverage.window.startSeconds || record.gameTimeSeconds > coverage.window.endSeconds ||
        slotsOf(record).some(slot => !coverage.participantSlots.includes(slot as PlayerSlot))) issue("record_coverage_mismatch", coverage.field, [record.id, id]);
    }
  }
  const seen = new Map<string, ContractRecord>();
  for (const record of records) {
    const field = eventField(record);
    let key: string | undefined;
    if (record.kind === "hero_state") key = `state:${record.playerSlot}:${record.gameTimeSeconds}:${JSON.stringify(record.perspective)}`;
    if (record.kind === "event" && record.data.type === "death") key = `death:${record.data.victimSlot}:${record.gameTimeSeconds}`;
    if (!key) continue;
    const previous = seen.get(key);
    if (previous) {
      if (record.kind === "hero_state") for (const f of ["positions", "visibility", "resources"] as const) issue("conflicting_observations", f, [previous.id, record.id]);
      else issue("duplicate_death", field, [previous.id, record.id]);
    }
    seen.set(key, record);
  }
  const duration = matches[0]?.durationSeconds;
  for (const participant of participants) {
    const deaths = records.filter(r => r.kind === "event" && r.data.type === "death" && r.data.victimSlot === participant.playerSlot);
    for (const coverage of report.coverage.filter(c => c.field === "deaths" && c.participantSlots.includes(participant.playerSlot) && ["present", "empty"].includes(c.status))) {
      if (duration == null || coverage.window.startSeconds > 0 || coverage.window.endSeconds < duration || participant.statistics.deaths === null || participant.statistics.deaths !== deaths.length)
        issue("death_counter_or_window_conflict", "deaths", [coverage.id, participant.id, ...deaths.map(r => r.id)]);
      if (deaths.some(r => !coverage.evidenceIds.includes(r.id)) || !coverage.evidenceIds.includes(participant.id)) issue("death_evidence_incomplete", "deaths", [coverage.id]);
    }
  }
  // Unsupported channels must remain explicitly unavailable to rules even when shape-valid.
  // Current parser proves log boundaries, zero baseline, event flags, clocks and final counters
  // for deaths; it makes no positive completeness claims for the other event/state channels.
  for (const coverage of report.coverage) {
    if (["present", "empty"].includes(coverage.status) && !["deaths", "time", "statistics"].includes(coverage.field)) {
      coverage.status = "unknown"; coverage.reason = "This parser version does not establish completeness of this channel.";
    }
    if (report.issues.some(i => i.field === coverage.field || i.field === null)) {
      coverage.status = "error"; coverage.reason = "Dataset evidence or source conflict; inspect validation issues.";
    }
  }
  const firstTime = Math.min(0, ...report.coverage.map(c => c.window.startSeconds));
  for (const field of fields) for (const slot of new Set(slots)) if (!report.coverage.some(c => c.field === field && c.participantSlots.includes(slot))) {
    report.coverage.push({ schemaVersion: "0.1.0", kind: "coverage", id: `check-${field}-${slot}`, matchId: evidence.matchId,
      provenance: { source: "derived", acquiredAt: matches[0]?.provenance.acquiredAt ?? new Date(0).toISOString(), artifactId: evidence.artifactId, sourceVersion: "coverage-v1", inputIds: [] },
      datasetId: evidence.datasetId, field, participantSlots: [slot], window: { startSeconds: firstTime, endSeconds: duration ?? 0 },
      status: field === "positions" || field === "visibility" ? "unknown" : "missing", resolutionSeconds: null, reason: "No verified coverage for this channel.", evidenceIds: [] });
  }
  return report;
}

export function windowUsability(report: DatasetValidation, field: Coverage["field"], slots: PlayerSlot[], window: Window): { usable: boolean; reasons: string[]; evidenceIds: string[] } {
  if (!fields.includes(field) || slots.length === 0 || ![window.startSeconds, window.endSeconds].every(Number.isFinite) || window.startSeconds > window.endSeconds) throw new Error("invalid_coverage_query");
  const reasons = new Set<string>(); const evidenceIds = new Set<string>();
  if (!report.complete) reasons.add("dataset_incomplete_or_conflicted");
  for (const slot of slots) {
    const candidates = report.coverage.filter(c => c.field === field && c.participantSlots.includes(slot) && c.window.startSeconds <= window.endSeconds && c.window.endSeconds >= window.startSeconds);
    for (const c of candidates) if (!["present", "empty"].includes(c.status)) reasons.add(`${slot}:${c.status}:${c.reason}`);
    const covering = candidates.filter(c => ["present", "empty"].includes(c.status) && c.window.startSeconds <= window.startSeconds && c.window.endSeconds >= window.endSeconds);
    if (covering.length === 0) reasons.add(`${slot}:window_not_covered`);
    for (const c of covering) for (const id of c.evidenceIds) evidenceIds.add(id);
  }
  return { usable: reasons.size === 0, reasons: [...reasons], evidenceIds: reasons.size ? [] : [...evidenceIds] };
}
