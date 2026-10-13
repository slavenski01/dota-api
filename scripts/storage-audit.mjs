// Read-only audit of every database reference; no garbage collection.
import { openDatabase, LocalStorage, configuredStorageRoot } from '@dota/persistence';
const pool = openDatabase();
try {
  const storage = new LocalStorage(configuredStorageRoot());
  const result = await pool.query('SELECT storage_key,sha256,size_bytes FROM dota.artifacts');
  let bytes = 0;
  for (const row of result.rows) {
    await storage.verify({ key: row.storage_key, sha256: row.sha256, sizeBytes: Number(row.size_bytes) });
    bytes += Number(row.size_bytes);
  }
  console.log(JSON.stringify({ event: 'storage.verified', references: result.rowCount, referenced_bytes: bytes }));
} catch { console.error('storage_audit_failed'); process.exitCode = 1; }
finally { await pool.end(); }
