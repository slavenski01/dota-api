import { constants, createWriteStream, mkdirSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, realpath, lstat, open, link, unlink, readdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { validateRecord, type ContractRecord } from "@dota/contracts";
import { transaction, type Pool, type PoolClient } from "./index.js";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const STORAGE_LIMITS = { blobBytes: 1024 ** 3, segmentBytes: 4 * 1024 ** 2, decodedSegmentBytes: 16 * 1024 ** 2, windowSeconds: 120, temporaryAgeMs: 24 * 3600_000 } as const;
export interface StoredFile { key: string; sha256: string; sizeBytes: number }
export interface Storage {
  put(source: Readable, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<StoredFile>;
  stream(key: string): Promise<Readable>;
  read(key: string, maxBytes: number): Promise<Buffer>;
  verify(file: StoredFile): Promise<void>;
}

export class LocalStorage implements Storage {
  readonly root: string;
  private active = new Set<string>();
  constructor(root: string) {
    const path = resolve(root); mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink()) throw new Error("storage_symlink");
    this.root = realpathSync(path);
  }
  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error("storage_symlink");
  }
  private async path(key: string): Promise<string> {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key) || key.slice(0, 2) !== key.slice(3, 5)) throw new Error("invalid_storage_key");
    await this.directory(this.root);
    const path = join(this.root, key);
    await this.directory(dirname(path));
    return path;
  }
  async put(source: Readable, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<StoredFile> {
    const maxBytes = options.maxBytes ?? STORAGE_LIMITS.blobBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > STORAGE_LIMITS.blobBytes) throw new Error("invalid_size_limit");
    await this.directory(this.root);
    await this.directory(join(this.root, ".tmp"));
    const temporary = join(this.root, ".tmp", `${randomUUID()}.part`);
    this.active.add(temporary);
    const hash = createHash("sha256"); let sizeBytes = 0;
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) return callback(new Error("artifact_too_large"));
      hash.update(chunk); callback(null, chunk);
    } });
    const signal = AbortSignal.any([AbortSignal.timeout(600_000), ...(options.signal ? [options.signal] : [])]);
    try {
      await pipeline(source, counter, createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
      const handle = await open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      const sha256 = hash.digest("hex"); const key = `${sha256.slice(0, 2)}/${sha256}`;
      const destination = await this.path(key);
      signal.throwIfAborted();
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.verify({ key, sha256, sizeBytes });
      }
      const directory = await open(dirname(destination), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return { key, sha256, sizeBytes };
    } finally {
      this.active.delete(temporary);
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
  async stream(key: string): Promise<Readable> {
    const handle = await open(await this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("not_regular_file");
      return handle.createReadStream();
    } catch (error) { await handle.close(); throw error; }
  }
  async read(key: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_size_limit");
    const chunks: Buffer[] = []; let size = 0;
    const source = await this.stream(key);
    for await (const part of source) {
      const chunk = Buffer.from(part); size += chunk.length;
      if (size > maxBytes) { source.destroy(); throw new Error("artifact_too_large"); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async verify(file: StoredFile): Promise<void> {
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of await this.stream(file.key)) { hash.update(chunk); size += chunk.length; }
    if (size !== file.sizeBytes || hash.digest("hex") !== file.sha256) throw new Error("artifact_integrity_mismatch");
  }
  async cleanupTemporary(now = Date.now()): Promise<number> {
    await this.directory(this.root); await this.directory(join(this.root, ".tmp"));
    let removed = 0;
    for (const name of await readdir(join(this.root, ".tmp"))) {
      if (!/^[a-f0-9-]{36}\.part$/.test(name)) continue;
      const path = join(this.root, ".tmp", name); const stat = await lstat(path);
      if (stat.isFile() && !this.active.has(path) && now - stat.mtimeMs >= STORAGE_LIMITS.temporaryAgeMs) {
        await unlink(path); removed++;
      }
    }
    return removed;
  }
}

export async function registerArtifact(client: PoolClient, input: { id: string; matchId: string; file: StoredFile; mediaType: string; source: Record<string, unknown> }): Promise<void> {
  await client.query("INSERT INTO dota.artifacts(id,match_id,storage_key,sha256,size_bytes,media_type,source) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [input.id, input.matchId, input.file.key, input.file.sha256, input.file.sizeBytes, input.mediaType, input.source]);
}
export async function artifactById(pool: Pool, id: string): Promise<{ key: string; sha256: string; sizeBytes: number; mediaType: string; matchId: string }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error("invalid_artifact_id");
  const result = await pool.query("SELECT * FROM dota.artifacts WHERE id=$1", [id]);
  if (!result.rows.length) throw new Error("artifact_not_found");
  const row = result.rows[0];
  return { key: row.storage_key, sha256: row.sha256, sizeBytes: Number(row.size_bytes), mediaType: row.media_type, matchId: row.match_id };
}
type HeroState = Extract<ContractRecord, { kind: "hero_state" }>;
export type Perspective = "omniscient" | "radiant" | "dire";
function perspectiveOf(record: HeroState): Perspective { return record.perspective.mode === "omniscient" ? "omniscient" : record.perspective.team; }
export async function storeStateSegments(pool: Pool, storage: Storage, datasetId: string, input: unknown[]): Promise<void> {
  const dataset = (await pool.query("SELECT match_id FROM dota.datasets WHERE id=$1", [datasetId])).rows[0];
  if (!dataset) throw new Error("dataset_not_found");
  const groups = new Map<string, HeroState[]>();
  const ids = new Set<string>();
  for (const item of input) {
    const record = validateRecord(item);
    if (record.kind !== "hero_state" || record.matchId !== dataset.match_id || ids.has(record.id)) throw new Error("invalid_state_segment");
    ids.add(record.id);
    const bucket = `${perspectiveOf(record)}:${Math.floor(record.gameTimeSeconds / 30)}`;
    const group = groups.get(bucket) ?? []; group.push(record); groups.set(bucket, group);
  }
  const prepared: { id: string; artifactId: string; file: StoredFile; group: HeroState[] }[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.gameTimeSeconds - b.gameTimeSeconds || a.playerSlot - b.playerSlot);
    const json = Buffer.from(JSON.stringify(group));
    if (json.length > STORAGE_LIMITS.decodedSegmentBytes) throw new Error("segment_too_large");
    const file = await storage.put(Readable.from([await compress(json)]), { maxBytes: STORAGE_LIMITS.segmentBytes });
    prepared.push({ id: randomUUID(), artifactId: randomUUID(), file, group });
  }
  await transaction(pool, async client => {
    for (const entry of prepared) {
      const first = entry.group[0]!; const last = entry.group.at(-1)!;
      for (const slot of new Set(entry.group.map(row => row.playerSlot))) {
        if (!(await client.query("SELECT 1 FROM dota.participants WHERE match_id=$1 AND player_slot=$2", [dataset.match_id, slot])).rowCount) throw new Error("state_participant_not_found");
      }
      await registerArtifact(client, { id: entry.artifactId, matchId: dataset.match_id, file: entry.file, mediaType: "application/gzip", source: { datasetId, format: "hero-state-json-v1" } });
      await client.query("INSERT INTO dota.state_segments VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [entry.id, datasetId, dataset.match_id, entry.artifactId, perspectiveOf(first), first.gameTimeSeconds, last.gameTimeSeconds, entry.group.length]);
    }
  });
}
export async function readStateWindow(pool: Pool, storage: Storage, datasetId: string, from: number, to: number, perspective: Perspective): Promise<HeroState[]> {
  if (![from, to].every(Number.isFinite) || from > to || to - from > STORAGE_LIMITS.windowSeconds || !["omniscient", "radiant", "dire"].includes(perspective)) throw new Error("invalid_state_window");
  const rows = (await pool.query("SELECT a.storage_key,a.sha256,a.size_bytes,s.match_id FROM dota.state_segments s JOIN dota.artifacts a ON a.id=s.artifact_id WHERE s.dataset_id=$1 AND s.perspective=$2 AND s.start_seconds <= $4 AND s.end_seconds >= $3 ORDER BY s.start_seconds LIMIT 33", [datasetId, perspective, from, to])).rows;
  if (rows.length > 32) throw new Error("too_many_segments");
  const result: HeroState[] = []; let totalBytes = 0;
  for (const row of rows) {
    const compressed = await storage.read(row.storage_key, STORAGE_LIMITS.segmentBytes);
    if (compressed.length !== Number(row.size_bytes) || createHash("sha256").update(compressed).digest("hex") !== row.sha256) throw new Error("artifact_integrity_mismatch");
    const json = await decompress(compressed, { maxOutputLength: STORAGE_LIMITS.decodedSegmentBytes });
    totalBytes += json.length; if (totalBytes > 64 * 1024 ** 2) throw new Error("window_too_large");
    const decoded: unknown = JSON.parse(json.toString());
    if (!Array.isArray(decoded)) throw new Error("invalid_state_segment");
    for (const item of decoded) {
      const state = validateRecord(item);
      if (state.kind !== "hero_state" || state.matchId !== row.match_id || perspectiveOf(state) !== perspective) throw new Error("invalid_state_segment");
      if (state.gameTimeSeconds >= from && state.gameTimeSeconds <= to) result.push(state);
    }
  }
  return result.sort((a, b) => a.gameTimeSeconds - b.gameTimeSeconds || a.playerSlot - b.playerSlot);
}
