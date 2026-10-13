import { artifactById, registerArtifact, REPLAY_MEDIA_TYPE, resolveReplay, verifiedReplay, SourceError, type Pool, type Storage, type SourceFetch } from "@dota/persistence";
import { downloadReplay, importReplay, type ImportedReplay, type ReplayProgress } from "./replay.js";
import { type StageHandlers, type StageResult } from "./workflow.js";
import { JobError } from "./index.js";
export function replayHandlers(pool: Pool, storage: Storage, fetcher?: SourceFetch): StageHandlers {
  const unavailable = new Set(["replay_link_missing", "replay_unavailable"]);
  const missing = (code: string): StageResult => ({ unavailable: code, limitations: ["Реплей недоступен у источника. Сохранённая статистика доступна; можно импортировать файл вручную."] });
  return {
    resolving: async ({ row, signal }) => {
      if (!row.account_id) return { unavailable: "player_required", limitations: ["Выберите профиль игрока перед загрузкой реплея."] };
      if (row.upload_id || row.artifact_id) return {};
      try {
        const source = await resolveReplay(pool, storage, row.match_id, { accountId: row.account_id, signal, ...(fetcher ? { fetcher } : {}) });
        if (source.status === "stored") return { artifactId: source.artifactId, inputSha256: source.sha256 };
        return source.status === "candidate" ? {} : missing(source.status === "missing" ? "replay_link_missing" : "replay_unavailable");
      } catch (error) { if (error instanceof SourceError) throw new JobError(error.code, [429,503].includes(error.status)); throw error; }
    },
    downloading: async ({ row, signal }) => {
      if (!row.account_id) throw new JobError("player_required");
      const progress = async (value: ReplayProgress) => {
        signal.throwIfAborted();
        await pool.query("UPDATE dota.workflow_jobs SET progress=$2,updated_at=now() WHERE id=$1 AND status='downloading'", [row.id, value]);
      };
      if (row.artifact_id) {
        const metadata = (await pool.query("SELECT 1 FROM dota.artifacts WHERE id=$1 AND match_id=$2 AND media_type=$3 AND source->>'validation'='replay-v1' AND source->'accountIds' ? $4", [row.artifact_id, row.match_id, REPLAY_MEDIA_TYPE, row.account_id])).rowCount;
        if (!metadata) throw new JobError("invalid_replay");
        const file = await artifactById(pool, row.artifact_id);
        await storage.verify(file); signal.throwIfAborted();
        return { artifactId: row.artifact_id, inputSha256: file.sha256, skipReason: "existing_verified_replay" };
      }
      const existing = await verifiedReplay(pool, storage, row.match_id, row.account_id);
      if (existing && !row.upload_id) return { artifactId: existing.artifactId, inputSha256: existing.sha256, skipReason: "existing_verified_replay" };
      let result: ImportedReplay | { artifactId: string; sha256: string };
      try {
        if (row.upload_id) {
          const upload = await artifactById(pool, row.upload_id);
          await storage.verify(upload); signal.throwIfAborted();
          result = await importReplay(storage, await storage.stream(upload.key), { matchId: row.match_id, accountId: row.account_id, signal, totalBytes: upload.sizeBytes, progress });
          result.source.provider = "manual";
        } else result = await downloadReplay(pool, storage, { matchId: row.match_id, accountId: row.account_id, signal, progress, ...(fetcher ? { fetcher } : {}) });
      } catch (error) { if (error instanceof JobError && unavailable.has(error.code)) return missing(error.code); throw error; }
      if (!("file" in result)) return { artifactId: result.artifactId, inputSha256: result.sha256 };
      const imported = result;
      return { artifactId: imported.artifactId, inputSha256: imported.file.sha256,
        commit: client => registerArtifact(client, { id: imported.artifactId, matchId: row.match_id, file: imported.file, mediaType: REPLAY_MEDIA_TYPE, source: imported.source }) };
    },
    parsing: async () => ({ unavailable: "analysis_not_connected", limitations: ["Реплей проверен и сохранён. Расширенные данные и анализ будут доступны после подключения E05–E08."] }),
    validating: async () => ({ unavailable: "analysis_not_connected" }),
    analysing: async () => ({ unavailable: "analysis_not_connected" }),
  };
}
