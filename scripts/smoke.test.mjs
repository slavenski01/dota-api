import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const parser = resolve(root, "services/replay-parser/build/install/replay-parser/bin/replay-parser");

function launch(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const closed = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => accept({ code, signal }));
  });
  // Keep early startup failures observed while readiness is being checked.
  closed.catch(() => {});
  return { child, closed, output: () => output };
}

async function waitFor(predicate, running, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`Process stopped before readiness:\n${running.output()}`);
    }
    await delay(100);
  }
  throw new Error(`Readiness timed out:\n${running.output()}`);
}

async function stop(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return running.closed;
  running.child.kill("SIGTERM");
  const forced = setTimeout(() => running.child.kill("SIGKILL"), 5000);
  try {
    const result = await running.closed;
    assert.notEqual(result.signal, "SIGKILL", "Process did not stop on SIGTERM");
    return result;
  } finally { clearTimeout(forced); }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  return result;
}

test("built workspace packages resolve through npm workspaces", async () => {
  await import("@dota/contracts");
  await import("@dota/analysis");
});

test("worker checks configuration without credentials and rejects unsupported arguments", async () => {
  const entry = resolve(root, "apps/worker/dist/index.js");
  const checked = run(process.execPath, [entry, "--check"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).queueConnected, false);
  const invalid = run(process.execPath, [entry, "--unknown"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage/);
  const missing = spawnSync(process.execPath, [entry], { cwd: root, env: { ...process.env, DATABASE_URL: "" }, encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /DATABASE_URL_required/);
});

test("installed Kotlin CLI advertises parsing and rejects unsupported positional arguments", () => {
  const checked = run(parser, ["--check"]);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).replayParsing, true);
  assert.equal(run(parser, ["--version"]).stdout.trim(), "replay-parser 0.0.0");
  const invalid = run(parser, ["nonexistent.dem"]);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Unsupported arguments/);
});

test("documented npm commands forward CLI arguments", () => {
  assert.ok(process.env.npm_execpath, "Run this suite with npm run smoke");
  for (const [script, marker] of [["start:worker", /worker.check/], ["start:parser", /replayParsing/]]) {
    const result = run(process.execPath, [process.env.npm_execpath, "run", script, "--", "--check"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, marker);
  }
});

test("production web serves the landing page and uncached liveness endpoint on loopback", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  const running = launch(process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], resolve(root, "apps/web"));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      try { return (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, running);
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.deepEqual(await response.json(), { service: "web", status: "ok", mode: "scaffold" });
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<html lang="ru"/);
    assert.match(html, /Сервис в разработке/);
    assert.equal((await fetch(`${base}/not-a-route`)).status, 404);
  } finally { await stop(running); }
});
