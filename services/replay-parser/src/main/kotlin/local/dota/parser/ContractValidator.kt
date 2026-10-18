package local.dota.parser

import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.networknt.schema.SchemaRegistry
import com.networknt.schema.SchemaRegistryConfig
import com.networknt.schema.SpecificationVersion

class ContractViolation(message: String) : IllegalArgumentException(message)

object ContractValidator {
    const val SCHEMA_VERSION = "0.1.0"
    const val PROTOCOL_VERSION = "1.0.0"
    val mapper: ObjectMapper = ObjectMapper()
        .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
        .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
    private val definition = mapper.readTree(requireNotNull(javaClass.getResourceAsStream("/contracts.schema.json")))
    private val registry = SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_7) { builder ->
        builder.schemaRegistryConfig(SchemaRegistryConfig.builder().formatAssertionsEnabled(true).build())
    }
    private val schemas = listOf("ContractRecord", "ProtocolMessage", "ProtocolRequest").associateWith { name ->
        val document = definition.deepCopy<ObjectNode>()
        document.remove("oneOf")
        document.put("\$id", "https://dota.invalid/schema/$name-0.1.0.json")
        document.put("\$ref", "#/definitions/$name")
        registry.getSchema(document)
    }

    fun requireValid(condition: Boolean, code: String) {
        if (!condition) throw ContractViolation(code)
    }

    fun validateRecord(node: JsonNode): JsonNode {
        requireValid(schemas.getValue("ContractRecord").validate(node).isEmpty(), "invalid_record_schema")
        checkTimes(node, if (node["kind"].asText() == "hero_state") node["gameTimeSeconds"].asDouble() else null)
        when (node["kind"].asText()) {
            "participant" -> requireValid(node["team"].asText() == if (node["playerSlot"].asInt() < 128) "radiant" else "dire", "slot_team_mismatch")
            "hero_motion" -> {
                val rows = node["samples"].toList()
                requireValid(rows.last()["time"].asDouble() - rows.first()["time"].asDouble() < 30, "invalid_motion_window")
                rows.forEachIndexed { i, row ->
                    requireValid(row["x"].isNull == row["y"].isNull, "partial_motion_position")
                    requireValid(!row["x"].isNull || !row["breakBefore"].isNull, "unknown_motion_boundary")
                    if (i > 0) requireValid(row["time"].asDouble() > rows[i-1]["time"].asDouble() && row["tick"].asInt() > rows[i-1]["tick"].asInt(), "unordered_motion")
                }
            }
            "hero_state" -> {
                val visible = node["visibility"]["status"].asText() == "known" && node["visibility"]["value"].asText() == "visible"
                if (node["perspective"]["mode"].asText() == "team" && !visible) {
                    for (field in listOf("position", "hp", "mana", "alive", "inventory", "resources")) {
                        requireValid(node[field]["status"].asText() != "known", "hidden_current_state")
                    }
                }
            }
            "coverage" -> if (node["status"].asText() in listOf("present", "empty")) {
                requireValid(!node["evidenceIds"].isEmpty, "coverage_requires_evidence")
            } else requireValid(!node["reason"].isNull, "coverage_requires_reason")
            "job" -> {
                requireValid((node["status"].asText() in listOf("failed", "unavailable")) == !node["error"].isNull, "job_error_mismatch")
                requireValid(node["status"].asText() != "ready" || node["dataLevel"].asText() != "none", "ready_without_data")
            }
            "episode" -> {
                val time = node["decisionTimeSeconds"].asDouble()
                requireValid(time >= node["window"]["startSeconds"].asDouble() && time <= node["window"]["endSeconds"].asDouble(), "decision_outside_window")
                val review = node["review"]
                requireValid(review.isNull || review["status"].asText() != "confirmed_error" || !review["alternative"].isNull, "review_requires_alternative")
            }
            "report" -> requireValid(node["reviewRefs"].all { review -> node["episodeIds"].any { it.asText() == review["episodeId"].asText() } }, "review_outside_report")
        }
        return node
    }

    private fun checkTimes(node: JsonNode, stateTime: Double?) {
        if (node.isObject) {
            if (node.has("startSeconds") && node.has("endSeconds")) {
                requireValid(node["startSeconds"].asDouble() <= node["endSeconds"].asDouble(), "reversed_window")
            }
            if (stateTime != null && node.has("observedAtSeconds")) {
                requireValid(node["observedAtSeconds"].asDouble() <= stateTime, "future_observation")
            }
        }
        if (node.isContainerNode) node.forEach { checkTimes(it, stateTime) }
    }

    fun validateMessage(node: JsonNode): JsonNode {
        requireValid(schemas.getValue("ProtocolMessage").validate(node).isEmpty(), "invalid_message_schema")
        if (node["type"].asText() == "record") validateRecord(node["record"])
        return node
    }

    fun validateRequest(node: JsonNode): JsonNode {
        requireValid(schemas.getValue("ProtocolRequest").validate(node).isEmpty(), "invalid_request_schema")
        return node
    }
}
