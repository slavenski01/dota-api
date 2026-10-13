import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  validateRecord, validateMessage, validateRequest, encodeMessage, encodeRequest,
  readMessages, readRequest, MAX_LINE_BYTES,
} from "@dota/contracts";

const root = new URL("../", import.meta.url);
const fixtures = new URL("packages/contracts/fixtures/", root);
const records = JSON.parse(readFileSync(new URL("records.json", fixtures), "utf8"));
const invalidCases = JSON.parse(readFileSync(new URL("invalid-cases.json", fixtures), "utf8"));
const requestText = readFileSync(new URL("request.ndjson", fixtures), "utf8");
const parser = fileURLToPath(new URL("services/replay-parser/build/install/replay-parser/bin/replay-parser", root));
const base = { protocolVersion: "1.0.0", schemaVersion: "0.1.0", requestId: "request-fixture" };
const complete = count => ({ ...base, type: "complete", sequence: count, recordCount: count });
const message = (record, sequence = 0) => ({ ...base, type: "record", sequence, record });
const wire = items => items.map(item => JSON.stringify(item) + "\n").join("");
const validMessages = [...records.map(message), complete(records.length)];
const validStream = wire(validMessages);

async function* chunks(input, size = 97) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size);
}

async function read(input, size) {
  const result = [];
  for await (const value of readMessages(chunks(input, size))) result.push(value);
  return result;
}

function kotlin(input, mode = "--validate-ndjson") {
  // Prove the installed distribution embeds schemas and works outside the checkout.
  const result = spawnSync(parser, [mode], { cwd: tmpdir(), input, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * MAX_LINE_BYTES });
  assert.ifError(result.error);
  return result;
}

test("all eight record kinds validate and round-trip through Kotlin without changing IDs, null, zero or time", async () => {
  assert.equal(new Set(records.map(record => record.kind)).size, 8);
  records.forEach(record => assert.deepEqual(validateRecord(record), record));
  assert.deepEqual(await read(validMessages.map(encodeMessage).join(""), 1), validMessages);
  const result = kotlin(validStream);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await read(result.stdout, 7), validMessages);
  const participant = records.find(record => record.kind === "participant");
  assert.equal(participant.steamId64, "76561198000000001");
  assert.equal(participant.accountId, null);
  assert.equal(participant.statistics.kills, 0);
  assert.equal(records.find(record => record.kind === "event").gameTimeSeconds, -12.25);
  assert.equal(records[0].matchId, "9007199254740993");
});

for (const fixture of invalidCases) {
  test(`both languages reject record: ${fixture.name}`, async () => {
    const record = structuredClone(records.find(value => value.id === fixture.recordId));
    const path = fixture.path.split(".");
    const field = path.pop();
    const parent = path.reduce((value, key) => value[key], record);
    if (fixture.op === "delete") delete parent[field];
    else parent[field] = fixture.value;
    assert.throws(() => validateRecord(record));
    const input = wire([message(record), complete(1)]);
    await assert.rejects(() => read(input));
    const result = kotlin(input);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /contract-error:/);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /do-not-echo-fixture/);
  });
}

test("manual review withdrawal and timeline material round-trip in both languages", async () => {
  const episode = structuredClone(records.find(r => r.kind === "episode"));
  episode.review = { version: 2, status: "unreviewed", explanation: "Recheck the basis", alternative: null,
    author: "Reviewer", reviewedAt: "2026-10-13T00:00:00Z", material: "timeline", perspective: { mode: "omniscient" } };
  assert.deepEqual(validateRecord(episode), episode);
  const input = wire([message(episode), complete(1)]), result = kotlin(input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await read(result.stdout), [message(episode), complete(1)]);
});

test("CRLF and split UTF-8 are supported without changing the document", async () => {
  const input = validStream.replaceAll("\n", "\r\n");
  assert.deepEqual(await read(input, 1), validMessages);
  const result = kotlin(input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await read(result.stdout), validMessages);
});

test("error is a valid terminal frame, separate from successful completion", async () => {
  const error = { ...base, sequence: 0, type: "error", code: "parse_failed", message: "Synthetic parse failure" };
  const input = encodeMessage(error);
  assert.deepEqual(await read(input), [error]);
  assert.equal(kotlin(input).status, 0);
});

const badStreams = [
  ["empty stream", ""],
  ["invalid JSON", "{\n"],
  ["two JSON documents in a line", "{}{}\n"],
  ["empty line", "\n"],
  ["whitespace-only line", " \r\n"],
  ["missing final newline", validStream.trimEnd()],
  ["missing terminal", wire([message(records[0])])],
  ["record count mismatch", wire([message(records[0]), complete(2)])],
  ["sequence gap", wire([message(records[0], 1), complete(1)])],
  ["request ID mismatch", wire([message(records[0]), { ...complete(1), requestId: "other" }])],
  ["match ID mismatch", wire([message(records[0]), message({ ...records[1], matchId: "42" }, 1), complete(2)])],
  ["duplicate record ID", wire([message(records[0]), message(records[0], 1), complete(2)])],
  ["message after terminal", wire([complete(0), complete(0)])],
  ["unsupported protocol version", wire([{ ...complete(0), protocolVersion: "2.0.0" }])],
  ["numeric string sequence", wire([{ ...complete(0), sequence: "0" }])],
  ["UTF-8 BOM", "\uFEFF" + wire([complete(0)])],
  ["malformed UTF-8", Buffer.from([0xff, 10])],
  ["oversize line", " ".repeat(MAX_LINE_BYTES + 1) + "\n"],
];

for (const [name, input] of badStreams) {
  test(`both languages reject stream: ${name}`, async () => {
    await assert.rejects(() => read(input, 4096));
    const result = kotlin(input);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /contract-error:/);
  });
}

test("request transport rejects a missing replay without exposing its path", async () => {
  const request = JSON.parse(requestText);
  assert.deepEqual(validateRequest(request), request);
  const encoded = encodeRequest(request);
  assert.deepEqual(await readRequest(chunks(encoded, 1)), request);
  const result = kotlin(encoded, "--protocol");
  assert.equal(result.status, 3, result.stderr);
  const messages = await read(result.stdout);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "error");
  assert.equal(messages[0].code, "invalid_replay");
  assert.equal(messages[0].requestId, request.requestId);
  assert.doesNotMatch(result.stderr + result.stdout, /not-a-real-replay/);
});

for (const [name, input] of [
  ["no request", ""],
  ["multiple requests", requestText + requestText],
  ["missing LF", requestText.trimEnd()],
  ["unknown version", requestText.replace('"1.0.0"', '"99.0.0"')],
  ["wrong schema", wire([complete(0)])],
]) {
  test(`both languages reject request: ${name}`, async () => {
    await assert.rejects(() => readRequest(chunks(input)));
    const result = kotlin(input, "--protocol");
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
  });
}

test("encoders validate before writing and reject non-finite numbers", () => {
  assert.throws(() => encodeMessage({ ...complete(0), sequence: Number.NaN }));
  assert.throws(() => encodeRequest({ ...JSON.parse(requestText), expectedMatchId: 42 }));
  assert.throws(() => validateMessage(message({ ...records[0], durationSeconds: Infinity })));
});
