import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { validateRecord, type HeroMotion } from "@dota/contracts";
import { registerArtifact, STORAGE_LIMITS, type Storage, type StoredFile } from "./storage.js";
import type { Pool, PoolClient } from "./index.js";

export async function prepareMotionSegments(storage: Storage, datasetId: string, matchId: string, tracks: HeroMotion[]) {
  const groups = new Map<number, HeroMotion[]>();
  const ids = new Set<string>(), observations = new Set<string>();
  for (const track of tracks) {
    validateRecord(track);
    if (track.matchId !== matchId || ids.has(track.id)) throw new Error("invalid_motion_segment");
    ids.add(track.id);
    const bucket = Math.floor(track.samples[0]!.time / 30);
    for (const row of track.samples) {
      const key = `${track.playerSlot}:${row.time}`;
      if (Math.floor(row.time / 30) !== bucket || observations.has(key)) throw new Error("invalid_motion_segment");
      observations.add(key);
    }
    const group = groups.get(bucket) ?? []; group.push(track); groups.set(bucket, group);
  }
  const prepared: { file: StoredFile; from: number; to: number; slots: number[] }[] = [];
  for (const tracks of groups.values()) {
    const body = Buffer.from(JSON.stringify(tracks));
    if (body.length > STORAGE_LIMITS.decodedSegmentBytes) throw new Error("motion_segment_too_large");
    const times = tracks.flatMap(t => t.samples.map(s => s.time));
    prepared.push({ file: await storage.put(Readable.from([gzipSync(body)]), { maxBytes: STORAGE_LIMITS.segmentBytes }), from: Math.min(...times), to: Math.max(...times), slots: tracks.map(t=>t.playerSlot) });
  }
  return async (client: PoolClient) => {
    for (const entry of prepared) {
      for (const slot of new Set(entry.slots)) {
        if (!(await client.query("SELECT 1 FROM dota.participants WHERE match_id=$1 AND player_slot=$2", [matchId,slot])).rowCount) throw new Error("motion_participant_not_found");
      }
      const artifactId = randomUUID();
      await registerArtifact(client, { id: artifactId, matchId, file: entry.file, mediaType: "application/gzip", source: { datasetId, format: "motion-v1" } });
      await client.query("INSERT INTO dota.motion_segments VALUES ($1,$2,$3,$4,$5,$6,'motion-v1')", [randomUUID(),datasetId,matchId,artifactId,entry.from,entry.to]);
    }
  };
}

/** Omniscient observations only; caller must authorize the retrospective context first. */
export async function readMotionWindow(pool: Pool, storage: Storage, datasetId: string, from: number, to: number): Promise<HeroMotion[]> {
  if (![from,to].every(Number.isFinite) || from > to || to-from > STORAGE_LIMITS.windowSeconds) throw new Error("invalid_motion_window");
  const rows = (await pool.query("SELECT a.storage_key,a.sha256,a.size_bytes,s.match_id FROM dota.motion_segments s JOIN dota.artifacts a ON a.id=s.artifact_id WHERE s.dataset_id=$1 AND s.start_seconds<=$3 AND s.end_seconds>=$2 ORDER BY s.start_seconds LIMIT 33", [datasetId,from,to])).rows;
  if (rows.length > 32) throw new Error("too_many_segments");
  const result: HeroMotion[] = []; let bytes = 0;
  for (const row of rows) {
    const compressed = await storage.read(row.storage_key, STORAGE_LIMITS.segmentBytes);
    if (compressed.length !== Number(row.size_bytes) || createHash("sha256").update(compressed).digest("hex") !== row.sha256) throw new Error("artifact_integrity_mismatch");
    const json = gunzipSync(compressed, { maxOutputLength: STORAGE_LIMITS.decodedSegmentBytes });
    bytes += json.length; if (bytes > 64*1024**2) throw new Error("window_too_large");
    const decoded: unknown = JSON.parse(json.toString());
    if (!Array.isArray(decoded)) throw new Error("invalid_motion_segment");
    for (const item of decoded) {
      const track = validateRecord(item);
      if (track.kind !== "hero_motion" || track.matchId !== row.match_id) throw new Error("invalid_motion_segment");
      const samples = track.samples.filter(s => s.time >= from && s.time <= to);
      if (samples.length) result.push({ ...track, samples: samples as HeroMotion["samples"] });
    }
  }
  return result;
}
