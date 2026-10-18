import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JobError } from "./index.js";

export const COACH_PROVIDER_VERSION = "codex-cli-bridge-v1";
export interface CoachConfig {
  provider: "codex_subscription"; model: string; reasoning: "low" | "medium" | "high";
  timeoutMs: number; maxPromptBytes: number; maxResultBytes: number; dailyRuns: number; totalRuns: number;
}
export interface CoachUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number; costUsd: null; billing: "subscription" }
export interface CoachResponse { output: unknown; usage: CoachUsage; cliVersion: string; durationMs: number }
export interface CoachInput {
  prompt: string; schema: Record<string, unknown>; context: unknown;
  instructions: { sha256: string; files: { name: string; content: string }[] };
  contextSha256: string; schemaVersion: string;
}
export const coachHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function coachConfig(env: NodeJS.ProcessEnv = process.env): CoachConfig {
  function positive(name: string, fallback: number, maximum: number): number {
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new JobError("coach_invalid_config");
    return value;
  }
  const model = env.DOTA_COACH_MODEL || "gpt-6-astra", reasoning = env.DOTA_COACH_REASONING || "medium";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model) || !["low","medium","high"].includes(reasoning)) throw new JobError("coach_invalid_config");
  return { provider: "codex_subscription", model, reasoning: reasoning as CoachConfig["reasoning"],
    timeoutMs: positive("DOTA_COACH_TIMEOUT_MS", 180000, 240000), maxPromptBytes: 128 * 1024, maxResultBytes: 48 * 1024,
    dailyRuns: positive("DOTA_COACH_DAILY_RUNS", 10, 1000), totalRuns: positive("DOTA_COACH_TOTAL_RUNS", 100, 100000) };
}
export async function coachInstructions(): Promise<CoachInput["instructions"]> {
  const root = new URL("../../../.agents/skills/dota-match-analysis/", import.meta.url);
  const names = ["SKILL.md", "references/data-requirements.md", "references/analysis-rules.md", "references/report-template.md"];
  const files = await Promise.all(names.map(async name => ({ name, content: await readFile(new URL(name, root), "utf8") })));
  return { files, sha256: coachHash(files) };
}
export function coachBridgeRoot(): string { return resolve(process.env.DOTA_COACH_BRIDGE_DIR || "data/coach-bridge"); }
export async function atomicCoachFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path);
}
export async function readCoachFile(path: string, limit: number): Promise<unknown> {
  if ((await stat(path)).size > limit) throw new JobError("coach_output_limit");
  return JSON.parse(await readFile(path, "utf8"));
}
export function validateCoachResponse(value: unknown, config: CoachConfig): CoachResponse {
  const r = value as CoachResponse | undefined;
  if (!r || !r.usage || r.usage.billing !== "subscription" || r.usage.costUsd !== null ||
    ![r.usage.inputTokens,r.usage.cachedInputTokens,r.usage.outputTokens,r.durationMs].every(n => Number.isSafeInteger(n) && n >= 0) ||
    r.usage.cachedInputTokens > r.usage.inputTokens || typeof r.cliVersion !== "string" || r.cliVersion.length > 150 ||
    r.output === undefined || Buffer.byteLength(JSON.stringify(r.output)) > config.maxResultBytes) throw new JobError("coach_invalid_response");
  return r;
}
export async function invokeCoachBridge(id: string, input: CoachInput, config: CoachConfig, signal: AbortSignal): Promise<CoachResponse> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new JobError("coach_invalid_request");
  if (Buffer.byteLength(input.prompt) > config.maxPromptBytes) throw new JobError("coach_context_limit");
  const root = coachBridgeRoot(); await mkdir(root, { recursive: true, mode: 0o700 });
  const request = { id, input: { prompt: input.prompt, schema: input.schema }, config, expiresAt: Date.now() + config.timeoutMs + 15000 };
  // A retry always joins the same spool entry. Never overwrite its deadline or invoke twice.
  try { await stat(join(root, `${id}.request.json`)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await atomicCoachFile(join(root, `${id}.request.json`), request); }
  const deadline = Date.now() + config.timeoutMs + 20000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const result = await readCoachFile(join(root, `${id}.result.json`), config.maxResultBytes + 4096) as { error?: string };
      if (result.error) throw new JobError(/^coach_[a-z_]+$/.test(result.error) ? result.error : "coach_provider_failed");
      return validateCoachResponse(result, config);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await delay(250, undefined, { signal });
  }
  throw new JobError("coach_bridge_timeout");
}
