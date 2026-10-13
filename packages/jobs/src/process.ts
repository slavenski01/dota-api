import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { JobError } from "./index.js";
export const PROCESS_LIMITS = { timeoutMs: 120_000, memoryBytes: 1536 * 1024 ** 2, stdoutBytes: 64 * 1024 ** 2, stderrBytes: 64 * 1024, inputBytes: 1024 ** 3, javaHeap: "-Xmx1g" } as const;
export interface ProcessSpec {
  command: string; args: string[]; cwd?: string; input?: string; inputFile?: string;
  timeoutMs?: number; memoryBytes?: number; stdoutBytes?: number;
}
export async function runBoundedProcess(spec: ProcessSpec, signal: AbortSignal): Promise<{ stdout: Buffer; exitCode: number }> {
  signal.throwIfAborted();
  for (const value of [spec.timeoutMs ?? PROCESS_LIMITS.timeoutMs, spec.memoryBytes ?? PROCESS_LIMITS.memoryBytes, spec.stdoutBytes ?? PROCESS_LIMITS.stdoutBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new JobError("invalid_process_limit");
  }
  if (Buffer.byteLength(spec.input ?? "") > 1024 ** 2) throw new JobError("process_input_too_large");
  if (spec.inputFile) {
    const input = await stat(spec.inputFile);
    if (!input.isFile() || input.size > PROCESS_LIMITS.inputBytes) throw new JobError("process_input_file_limit");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "JAVA_HOME", "LANG", "HOME", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
  env.JAVA_OPTS = PROCESS_LIMITS.javaHeap;
  env.DOTA_PROCESS_SPEC = JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd, parentPid: process.pid,
    timeoutMs: spec.timeoutMs ?? PROCESS_LIMITS.timeoutMs, memoryBytes: spec.memoryBytes ?? PROCESS_LIMITS.memoryBytes });
  const child = spawn(process.execPath, ["--max-old-space-size=64", fileURLToPath(new URL("./supervisor.js", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = []; let size = 0; let stderrSize = 0; let failure: JobError | undefined;
  const abort = () => { failure ??= new JobError("process_cancelled", true); child.kill("SIGTERM"); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > (spec.stdoutBytes ?? PROCESS_LIMITS.stdoutBytes)) { failure = new JobError("process_output_limit"); child.kill("SIGTERM"); }
    else chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrSize += chunk.length;
    if (stderrSize > PROCESS_LIMITS.stderrBytes) { failure = new JobError("process_stderr_limit"); child.kill("SIGTERM"); }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(spec.input ?? "");
  try {
    const code = await new Promise<number>((accept, reject) => { child.once("error", reject); child.once("close", code => accept(code ?? 1)); });
    if (failure) throw failure;
    if (code === 70) throw new JobError("process_timeout", true);
    if (code === 71) throw new JobError("process_memory_limit");
    if (code === 72 || code === 73) throw new JobError("process_interrupted", true);
    if (code === 74) throw new JobError("process_spawn_failed");
    return { stdout: Buffer.concat(chunks), exitCode: code };
  } finally { signal.removeEventListener("abort", abort); }
}
