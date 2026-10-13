import { randomUUID, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress, constants as zstdConstants } from "node:zlib";
import { spawn } from "node:child_process";
import { encodeRequest, readMessages } from "@dota/contracts";
import { resolveReplay, replayRequest, replayMatchId, type Pool, type Storage, type StoredFile, type SourceFetch, SourceError } from "@dota/persistence";
import { JobError, runBoundedProcess } from "./index.js";

export const REPLAY_LIMITS = { downloadBytes: 256 * 1024 ** 2, decodedBytes: 1024 ** 3, transferMs: 180000, validationMs: 120000 } as const;
export interface ReplayProgress { phase: "receiving" | "decompressing" | "checking" | "stored"; bytes: number; totalBytes: number | null }
export interface ImportedReplay { artifactId: string; file: StoredFile; source: Record<string, unknown> }
interface ImportOptions {
  matchId: string; accountId: string; signal: AbortSignal; totalBytes?: number | null;
  progress?: (value: ReplayProgress) => Promise<void>;
  // Dependency injection for isolated boundary tests; never accepted from HTTP input.
  validate?: typeof validateReplay;
  limits?: { downloadBytes: number; decodedBytes: number; transferMs: number };
}
export async function validateReplay(path: string, matchId: string, accountId: string, sha256: string, signal: AbortSignal): Promise<string[]> {
  const requestId = randomUUID();
  const result = await runBoundedProcess({
    command: fileURLToPath(new URL("../../../services/replay-parser/build/install/replay-parser/bin/replay-parser", import.meta.url)),
    args: ["--protocol"], inputFile: path, timeoutMs: REPLAY_LIMITS.validationMs,
    input: encodeRequest({ protocolVersion: "1.0.0", schemaVersion: "0.1.0", type: "parse", requestId, replayPath: path, expectedMatchId: matchId }),
  }, signal);
  if (result.exitCode !== 0) throw new JobError("invalid_replay");
  const accounts: string[] = []; const slots = new Set<number>(); let matches = 0; let complete = false;
  try {
    for await (const message of readMessages(Readable.from([result.stdout]))) {
      if (message.requestId !== requestId || message.type === "error") throw new JobError("invalid_replay");
      if (message.type === "complete") complete = true;
      if (message.type !== "record") continue;
      const record = message.record;
      if (record.matchId !== matchId || record.provenance.artifactId !== `replay-sha256-${sha256}`) throw new JobError("replay_match_mismatch");
      if (record.kind === "match") matches++;
      if (record.kind === "participant") {
        if (slots.has(record.playerSlot)) throw new JobError("invalid_replay");
        slots.add(record.playerSlot);
        if (record.accountId !== null) accounts.push(record.accountId);
      }
    }
  } catch (error) { if (error instanceof JobError) throw error; throw new JobError("invalid_replay"); }
  if (!complete || matches !== 1 || slots.size !== 10) throw new JobError("invalid_replay");
  if (accounts.filter(id => id === accountId).length !== 1) throw new JobError("replay_participant_mismatch");
  return accounts;
}
function limiter(max: number, update: (bytes: number) => Promise<void>): Transform {
  let bytes = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    if (bytes > max) return done(new JobError("replay_size_limit"));
    update(bytes).then(() => done(null, chunk), error => done(error));
  } });
}
async function decompressBzip(input: string, output: string, counter: Transform, signal: AbortSignal): Promise<void> {
  const child = spawn("bzip2", ["-dc"], { stdio: ["pipe", "pipe", "ignore"] });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new JobError("bzip2_not_available")));
    child.once("close", code => code === 0 ? resolve() : reject(new JobError("invalid_replay_compression")));
  });
  const abort = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // Observe all streams immediately, terminate the decoder if any boundary fails.
  const tasks = [completion, pipeline(createReadStream(input), child.stdin, { signal }),
    pipeline(child.stdout, counter, createWriteStream(output, { flags: "wx", mode: 0o600 }), { signal })];
  try { await Promise.all(tasks); }
  catch (error) { abort(); await Promise.allSettled(tasks); throw error; }
  finally { signal.removeEventListener("abort", abort); }
}
export async function importReplay(storage: Storage, input: Readable, options: ImportOptions): Promise<ImportedReplay> {
  replayMatchId(options.matchId);
  if (!/^[1-9][0-9]{0,9}$/.test(options.accountId) || BigInt(options.accountId) >= 4294967295n) throw new JobError("invalid_player_id");
  const limits = options.limits ?? REPLAY_LIMITS;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(limits.transferMs)]);
  const directory = await mkdtemp(join(tmpdir(), "dota-replay-"));
  const archive = join(directory, "input"), replay = join(directory, "replay.dem");
  let received = 0, decoded = 0, lastProgress = 0;
  const progress = async (phase: ReplayProgress["phase"], bytes: number, totalBytes: number | null, force = false) => {
    if (force || Date.now() - lastProgress > 500) { lastProgress = Date.now(); await options.progress?.({ phase, bytes, totalBytes }); }
  };
  try {
    const total = options.totalBytes ?? null;
    if (total !== null && (!Number.isSafeInteger(total) || total < 0 || total > limits.downloadBytes)) throw new JobError("replay_size_limit");
    await progress("receiving", 0, total, true);
    await pipeline(input, limiter(limits.downloadBytes, async bytes => { received = bytes; await progress("receiving", bytes, total); }), createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
    if (total !== null && received !== total) throw new JobError("replay_truncated", true);
    const handle = await open(archive, "r"); const magic = Buffer.alloc(8);
    try { await handle.read(magic, 0, 8, 0); } finally { await handle.close(); }
    const compression = magic.subarray(0,4).equals(Buffer.from([0x28,0xb5,0x2f,0xfd])) ? "zstd" : magic.subarray(0,3).toString() === "BZh" ? "bzip2" : magic.equals(Buffer.from("PBDEMS2\0")) ? "none" : null;
    if (!compression) throw new JobError("invalid_replay_format");
    await progress("decompressing", 0, null, true);
    const hash = createHash("sha256");
    const counter = limiter(limits.decodedBytes, async bytes => { decoded = bytes; await progress("decompressing", bytes, null); });
    counter.on("data", chunk => hash.update(chunk));
    if (compression === "bzip2") await decompressBzip(archive, replay, counter, signal);
    else if (compression === "zstd") await pipeline(createReadStream(archive), createZstdDecompress({ params: { [zstdConstants.ZSTD_d_windowLogMax]: 27 } }), counter, createWriteStream(replay, { flags: "wx", mode: 0o600 }), { signal });
    else await pipeline(createReadStream(archive), counter, createWriteStream(replay, { flags: "wx", mode: 0o600 }), { signal });
    const replayHandle = await open(replay, "r"); const header = Buffer.alloc(8);
    try { await replayHandle.read(header, 0, 8, 0); } finally { await replayHandle.close(); }
    if (decoded < 16 || !header.equals(Buffer.from("PBDEMS2\0"))) throw new JobError("invalid_replay_format");
    const sha256 = hash.digest("hex");
    options.signal.throwIfAborted();
    await progress("checking", decoded, decoded, true);
    const accountIds = await (options.validate ?? validateReplay)(replay, options.matchId, options.accountId, sha256, options.signal);
    options.signal.throwIfAborted();
    const file = await storage.put(createReadStream(replay), { maxBytes: limits.decodedBytes, signal: options.signal });
    if (file.sha256 !== sha256 || file.sizeBytes !== decoded) throw new JobError("replay_integrity_mismatch");
    await progress("stored", decoded, decoded, true);
    return { artifactId: randomUUID(), file, source: { validation: "replay-v1", accountIds, compression, acquiredAt: new Date().toISOString() } };
  } catch (error) {
    if (error instanceof JobError) throw error;
    options.signal.throwIfAborted();
    if (signal.aborted) throw new JobError("replay_transfer_timeout", true);
    throw new JobError("replay_transfer_failed", true);
  } finally { input.destroy(); await rm(directory, { recursive: true, force: true }); }
}
export async function downloadReplay(pool: Pool, storage: Storage, options: ImportOptions & { fetcher?: SourceFetch }): Promise<ImportedReplay | { artifactId: string; sha256: string }> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const source = await resolveReplay(pool, storage, options.matchId, { accountId: options.accountId, signal: options.signal, force: attempt > 0, ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
      if (source.status === "stored") return { artifactId: source.artifactId, sha256: source.sha256 };
      if (source.status !== "candidate") throw new JobError(source.status === "missing" ? "replay_link_missing" : "replay_unavailable");
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(REPLAY_LIMITS.transferMs)]);
      const response = await replayRequest(source.url, options.matchId, "GET", signal, options.fetcher);
      if ([403,404,410].includes(response.status)) { await response.body?.cancel(); if (attempt === 0) continue; throw new JobError("replay_unavailable"); }
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new JobError("replay_temporarily_unavailable", true); }
      const rawLength = response.headers.get("content-length");
      const totalBytes = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
      const imported = await importReplay(storage, Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), { ...options, totalBytes });
      imported.source.provider = "opendota"; imported.source.sourceCheckedAt = source.checkedAt;
      return imported;
    }
    throw new JobError("replay_unavailable");
  } catch (error) {
    if (error instanceof SourceError) throw new JobError(error.code, [429,503].includes(error.status));
    throw error;
  }
}
