import { ContractError, validateMessage, validateRequest } from "./validation.js";
import type { ProtocolMessage, ProtocolRequest } from "./generated/types.js";

export const MAX_LINE_BYTES = 1_048_576;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parseLine(line: Uint8Array): unknown {
  if (line.byteLength === 0 || line.byteLength > MAX_LINE_BYTES) throw new ContractError("invalid_line_size");
  try { return JSON.parse(decoder.decode(line)) as unknown; }
  catch { throw new ContractError("invalid_json_or_utf8"); }
}

async function* lines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  let pending = Buffer.alloc(0);
  for await (const chunk of chunks) {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end);
      // The limit includes an optional CR, but excludes LF.
      yield parseLine(line);
      pending = pending.subarray(end + 1);
    }
    if (pending.length > MAX_LINE_BYTES) throw new ContractError("invalid_line_size");
  }
  if (pending.length > 0) throw new ContractError("missing_final_newline");
}

export async function readRequest(chunks: AsyncIterable<Uint8Array>): Promise<ProtocolRequest> {
  let result: ProtocolRequest | undefined;
  for await (const value of lines(chunks)) {
    if (result !== undefined) throw new ContractError("multiple_requests");
    result = validateRequest(value);
  }
  if (result === undefined) throw new ContractError("missing_request");
  return result;
}

export async function* readMessages(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<ProtocolMessage> {
  let requestId: string | undefined;
  let matchId: string | undefined;
  let count = 0;
  let terminal = false;
  const ids = new Set<string>();
  for await (const value of lines(chunks)) {
    if (terminal) throw new ContractError("message_after_terminal");
    const message = validateMessage(value);
    requestId ??= message.requestId;
    if (message.requestId !== requestId) throw new ContractError("request_id_mismatch");
    if (message.sequence !== count) throw new ContractError("sequence_mismatch");
    if (message.type === "record") {
      matchId ??= message.record.matchId;
      if (message.record.matchId !== matchId) throw new ContractError("match_id_mismatch");
      if (ids.has(message.record.id)) throw new ContractError("duplicate_record_id");
      ids.add(message.record.id);
      count++;
    } else {
      terminal = true;
      if (message.type === "complete" && message.recordCount !== count) throw new ContractError("record_count_mismatch");
    }
    yield message;
  }
  if (!terminal) throw new ContractError("missing_terminal");
}

function encode(value: ProtocolMessage | ProtocolRequest): string {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) throw new ContractError("invalid_line_size");
  return line + "\n";
}

export function encodeMessage(value: unknown): string { return encode(validateMessage(value)); }
export function encodeRequest(value: unknown): string { return encode(validateRequest(value)); }
