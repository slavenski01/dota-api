import { openDatabase, migrate } from "@dota/persistence";
const pool = openDatabase();
try { await migrate(pool); console.log("Database migrations applied."); }
catch { console.error("migration_failed"); process.exitCode = 1; }
finally { await pool.end(); }
