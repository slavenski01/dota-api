package local.dota.parser

import kotlin.system.exitProcess

fun main(args: Array<String>) {
    when (args.toList()) {
        emptyList<String>(), listOf("--help") ->
            println("Usage: replay-parser [--help | --version | --check | --protocol | --validate-ndjson]\nScaffold only; .dem parsing is not implemented.")
        listOf("--version") -> println("replay-parser 0.0.0")
        listOf("--check") -> println("""{"service":"replay-parser","status":"ok","mode":"scaffold","replayParsing":false}""")
        listOf("--validate-ndjson") -> protocolCommand {
            Ndjson.validateStream(System.`in`) { node -> print(Ndjson.encode(node)) }
            0
        }
        listOf("--protocol") -> protocolCommand {
            val request = Ndjson.readRequest(System.`in`)
            val message = ContractValidator.mapper.createObjectNode()
                .put("protocolVersion", ContractValidator.PROTOCOL_VERSION)
                .put("schemaVersion", ContractValidator.SCHEMA_VERSION)
                .put("requestId", request["requestId"].asText())
                .put("sequence", 0)
                .put("type", "error")
                .put("code", "not_implemented")
                .put("message", "Replay parsing is not implemented; contract transport is available.")
            print(Ndjson.encode(message))
            3
        }
        else -> {
            System.err.println("Unsupported arguments. Use --help. Replay parsing is not implemented.")
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
