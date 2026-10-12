package local.dota.parser

import com.fasterxml.jackson.databind.JsonNode
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

object Ndjson {
    const val MAX_LINE_BYTES = 1_048_576

    fun readLines(input: InputStream, consume: (JsonNode) -> Unit) {
        val stream = input.buffered()
        val line = ByteArrayOutputStream()
        while (true) {
            val value = stream.read()
            if (value == -1) break
            if (value == 10) {
                ContractValidator.requireValid(line.size() > 0, "invalid_line_size")
                val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                val text = decoder.decode(ByteBuffer.wrap(line.toByteArray())).toString()
                // The optional CR is JSON whitespace; no trimming of the payload is needed.
                val node = ContractValidator.mapper.readTree(text)
                ContractValidator.requireValid(node != null, "invalid_json_or_utf8")
                consume(node)
                line.reset()
            } else {
                ContractValidator.requireValid(line.size() < MAX_LINE_BYTES, "invalid_line_size")
                line.write(value)
            }
        }
        ContractValidator.requireValid(line.size() == 0, "missing_final_newline")
    }

    fun encode(node: JsonNode): String {
        ContractValidator.validateMessage(node)
        val text = ContractValidator.mapper.writeValueAsString(node)
        ContractValidator.requireValid(text.toByteArray(Charsets.UTF_8).size <= MAX_LINE_BYTES, "invalid_line_size")
        return text + "\n"
    }

    fun validateStream(input: InputStream, emit: (JsonNode) -> Unit) {
        var requestId: String? = null
        var matchId: String? = null
        var count = 0L
        var terminal = false
        val ids = mutableSetOf<String>()
        readLines(input) { node ->
            ContractValidator.requireValid(!terminal, "message_after_terminal")
            ContractValidator.validateMessage(node)
            if (requestId == null) requestId = node["requestId"].asText()
            ContractValidator.requireValid(requestId == node["requestId"].asText(), "request_id_mismatch")
            ContractValidator.requireValid(node["sequence"].asLong() == count, "sequence_mismatch")
            if (node["type"].asText() == "record") {
                val record = node["record"]
                if (matchId == null) matchId = record["matchId"].asText()
                ContractValidator.requireValid(matchId == record["matchId"].asText(), "match_id_mismatch")
                ContractValidator.requireValid(ids.add(record["id"].asText()), "duplicate_record_id")
                count++
            } else {
                terminal = true
                if (node["type"].asText() == "complete") {
                    ContractValidator.requireValid(node["recordCount"].asLong() == count, "record_count_mismatch")
                }
            }
            emit(node)
        }
        ContractValidator.requireValid(terminal, "missing_terminal")
    }

    fun readRequest(input: InputStream): JsonNode {
        var request: JsonNode? = null
        readLines(input) { node ->
            ContractValidator.requireValid(request == null, "multiple_requests")
            request = ContractValidator.validateRequest(node)
        }
        return request ?: throw ContractViolation("missing_request")
    }
}
