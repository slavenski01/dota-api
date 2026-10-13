import EmbeddedPostgres from "embedded-postgres";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";

const directory = await mkdtemp("/tmp/dota-pg-");
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const password = randomBytes(24).toString("hex");
let diagnostics = "";
const database = new EmbeddedPostgres({ databaseDir: `${directory}/db`, port, user: "dota_test", password,
  persistent: true, authMethod: "scram-sha-256", createPostgresUser: false,
  postgresFlags: ["-h", "127.0.0.1", "-k", directory],
  onLog: () => {}, onError: value => { diagnostics = `${diagnostics}${String(value)}`.slice(-4000); } });
let started = false;
try {
  await database.initialise();
  await database.start(); started = true;
  await database.createDatabase("dota_test");
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: `postgresql://dota_test:${password}@127.0.0.1:${port}/dota_test` },
  });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} catch (error) { console.error("Test PostgreSQL failed", error.message, diagnostics.replaceAll(password, "[redacted]")); process.exitCode = 1; }
finally {
  if (started) await database.stop();
  await rm(directory, { recursive: true, force: true });
}
// embedded-postgres's async-exit-hook registers beforeExit with a fixed code 0.
// Cleanup has completed; explicitly preserve the test child's real exit code.
process.exit(process.exitCode ?? 0);
