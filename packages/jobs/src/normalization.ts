import { randomUUID, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { encodeRequest, readMessages, type ContractRecord } from "@dota/contracts";
import { artifactById, prepareStateSegments, saveDatasetInTransaction, type Pool, type Storage } from "@dota/persistence";
import { runBoundedProcess } from "./process.js";
import { JobError } from "./index.js";
import type { StageHandler } from "./workflow.js";

export async function decodeDataset(stdout: Buffer, requestId: string, matchId: string, sha256: string, artifactId: string, datasetId: string): Promise<ContractRecord[]> {
  const records: ContractRecord[] = [];
  for await (const message of readMessages(Readable.from([stdout]))) {
    if (message.requestId !== requestId || message.type === "error") throw new JobError("invalid_parser_output");
    if (message.type !== "record") continue;
    const record = message.record;
    if (record.matchId !== matchId || record.provenance.artifactId !== `replay-sha256-${sha256}` ||
      !["match", "participant", "event", "coverage", "hero_state"].includes(record.kind)) throw new JobError("invalid_parser_output");
    record.provenance.artifactId = artifactId;
    if (record.kind === "coverage") record.datasetId = datasetId;
    records.push(record);
  }
  const participants = records.filter(record => record.kind === "participant");
  if (records.filter(record => record.kind === "match").length !== 1 || participants.length !== 10 ||
      new Set(participants.map(record => record.playerSlot)).size !== 10) throw new JobError("invalid_parser_output");
  return records;
}

export function normalizationHandler(pool: Pool, storage: Storage): StageHandler {
  return async ({ row, signal }) => {
    if (!row.artifact_id) throw new JobError("artifact_required");
    const artifactId = row.artifact_id;
    const artifact = await artifactById(pool, artifactId);
    if (artifact.matchId !== row.match_id) throw new JobError("artifact_match_mismatch");
    const directory = await mkdtemp(join(tmpdir(), "dota-normalize-"));
    try {
      const path = join(directory, "replay.dem");
      const hash = createHash("sha256"); let bytes = 0;
      const check = new Transform({ transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > artifact.sizeBytes || bytes > 1024 ** 3) return done(new JobError("replay_size_limit"));
        hash.update(chunk); done(null, chunk);
      } });
      await pipeline(await storage.stream(artifact.key), check, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
      if (bytes !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256) throw new JobError("replay_integrity_mismatch");
      const requestId = randomUUID(), datasetId = randomUUID(), parserRunId = randomUUID();
      const result = await runBoundedProcess({
        command: fileURLToPath(new URL("../../../services/replay-parser/build/install/replay-parser/bin/replay-parser", import.meta.url)),
        args: ["--normalized"], inputFile: path,
        input: encodeRequest({ protocolVersion: "1.0.0", schemaVersion: "0.1.0", type: "parse", requestId, replayPath: path, expectedMatchId: row.match_id }),
      }, signal);
      if (result.exitCode !== 0) throw new JobError("parse_failed");
      const records = await decodeDataset(result.stdout, requestId, row.match_id, artifact.sha256, artifactId, datasetId);
      const states = records.filter(record => record.kind === "hero_state");
      const saveSegments = await prepareStateSegments(storage, datasetId, row.match_id, states);
      const buckets = new Set<string>();
      const indexed = records.filter(record => {
        if (record.kind !== "hero_state") return true;
        const key = `${record.playerSlot}:${Math.floor(record.gameTimeSeconds / 5)}`;
        if (buckets.has(key)) return false;
        buckets.add(key); return true;
      });
      signal.throwIfAborted();
      return { datasetId, dataLevel: "events", limitations: ["Получение предметов и полнота журналов предметов/объектов пока не подтверждены."],
        commit: async client => {
          await client.query("INSERT INTO dota.parser_runs(id,match_id,artifact_id,parser_version,parameters,outcome,diagnostics) VALUES ($1,$2,$3,$4,$5,'complete',$6)",
            [parserRunId, row.match_id, artifactId, row.versions.parser, { protocol: "1.0.0" }, { recordCount: records.length }]);
          await saveDatasetInTransaction(client, { id: datasetId, matchId: row.match_id, parserRunId,
            normalizationVersion: row.versions.normalization, inputSha256: artifact.sha256, versions: { ...row.versions } }, indexed);
          await saveSegments(client);
        } };
    } finally { await rm(directory, { recursive: true, force: true }); }
  };
}
