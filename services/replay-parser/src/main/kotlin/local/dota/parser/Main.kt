package local.dota.parser

import kotlin.system.exitProcess

fun main(args: Array<String>) {
    if (args.firstOrNull() == "--research-context") {
        protocolCommand {
            val from = args.getOrNull(1)?.toDoubleOrNull()
            val to = args.getOrNull(2)?.toDoubleOrNull()
            if (args.size != 3 || from == null || to == null) throw ContractViolation("invalid_context_window")
            val research = try { ContextResearch(from, to) } catch (_: IllegalArgumentException) {
                throw ContractViolation("invalid_context_window")
            }
            val request = Ndjson.readRequest(System.`in`)
            try {
                val path = try { java.nio.file.Path.of(request["replayPath"].asText()) } catch (_: java.nio.file.InvalidPathException) {
                    throw ReplayFailure("invalid_replay", "Replay path is invalid.")
                }
                val basic = ReplayParser().parse(path, request["expectedMatchId"].asText(), research)
                println(ContractValidator.mapper.writeValueAsString(research.report(basic)))
                0
            } catch (failure: ReplayFailure) {
                println(ContractValidator.mapper.writeValueAsString(ContractValidator.mapper.createObjectNode()
                    .put("researchVersion", CONTEXT_RESEARCH_VERSION).put("status", "error")
                    .put("code", failure.code).put("message", failure.message)))
                3
            }
        }
        return
    }
    when (args.toList()) {
        emptyList<String>(), listOf("--help") ->
            println("Usage: replay-parser [--help | --version | --check | --protocol | --validate-ndjson | --research-context FROM TO]\nDota Source 2 basic replay extraction via NDJSON. Research mode emits a separate JSON document (maximum 120-second window).")
        listOf("--version") -> println("replay-parser 0.0.0")
        listOf("--check") -> println("""{"service":"replay-parser","status":"ok","mode":"basic","replayParsing":true}""")
        listOf("--validate-ndjson") -> protocolCommand {
            Ndjson.validateStream(System.`in`) { node -> print(Ndjson.encode(node)) }
            0
        }
        listOf("--protocol") -> protocolCommand {
            val request = Ndjson.readRequest(System.`in`)
            val messages = try {
                val path = try { java.nio.file.Path.of(request["replayPath"].asText()) } catch (_: java.nio.file.InvalidPathException) {
                    throw ReplayFailure("invalid_replay", "Replay path is invalid.")
                }
                val records = ReplayParser().parse(path, request["expectedMatchId"].asText())
                records.mapIndexed { index, record ->
                    envelope(request["requestId"].asText(), index, "record").apply { set<com.fasterxml.jackson.databind.JsonNode>("record", record) }
                } + listOf(envelope(request["requestId"].asText(), records.size, "complete").put("recordCount", records.size))
            } catch (failure: ReplayFailure) {
                listOf(envelope(request["requestId"].asText(), 0, "error").put("code", failure.code).put("message", failure.message))
            }
            // Encode the whole bounded basic result before exposing any successful records.
            val lines = messages.map { Ndjson.encode(it) }
            lines.forEach { print(it) }
            if (messages.last()["type"].asText() == "complete") 0 else 3
        }
        else -> {
            System.err.println("Unsupported arguments. Use --help.")
            exitProcess(2)
        }
    }
}

private fun protocolCommand(action: () -> Int) {
    val code = try {
        action()
    } catch (error: Exception) {
        // Do not echo input, paths, or source values into diagnostic logs.
        System.err.println("contract-error: " + if (error is ContractViolation) error.message else "invalid_json_or_utf8")
        2
    }
    System.out.flush()
    if (code != 0) exitProcess(code)
}

private fun envelope(requestId: String, sequence: Int, type: String) = ContractValidator.mapper.createObjectNode()
    .put("protocolVersion", ContractValidator.PROTOCOL_VERSION)
    .put("schemaVersion", ContractValidator.SCHEMA_VERSION)
    .put("requestId", requestId)
    .put("sequence", sequence)
    .put("type", type)
