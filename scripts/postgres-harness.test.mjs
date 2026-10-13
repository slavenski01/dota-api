import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("PostgreSQL harness propagates a failing test after cleaning up its cluster", async () => {
  const directory = await mkdtemp("/tmp/dota-harness-");
  try {
    const fixture = `${directory}/failure.mjs`;
    await writeFile(fixture, "import { test } from 'node:test'; test('intentional failure', () => { throw new Error('expected_failure'); });\n");
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["scripts/test-postgres.mjs", fixture], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const [code] = await once(child, "close");
    assert.match(output, /expected_failure/);
    assert.equal(code, 1);
  } finally { await rm(directory, { recursive: true }); }
});
