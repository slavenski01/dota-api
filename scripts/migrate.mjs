import { openDatabase, migrate } from "@dota/persistence";
const pool = openDatabase();
try { await migrate(pool); console.log("Database migrations applied."); }
catch (error) { console.error("Migration failed:", error.code ?? error.message); process.exitCode = 1; }
finally { await pool.end(); }
