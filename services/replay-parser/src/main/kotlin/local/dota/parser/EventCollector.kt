package local.dota.parser

import com.fasterxml.jackson.databind.node.ObjectNode
import skadistats.clarity.model.CombatLogEntry

internal object ResourceIds {
    private val data = ContractValidator.mapper.readTree(requireNotNull(javaClass.getResourceAsStream("/resource-ids.json")))
    fun resolve(kind: String, name: String?): String? = name?.let { data[if (kind == "item") "items" else "abilities"][it]?.asText() }
}

internal fun objectiveType(name: String): String? = when {
    Regex("npc_dota_(goodguys|badguys)_tower[1-4]_(top|mid|bot)[12]?").matches(name) -> "tower"
    Regex("npc_dota_(goodguys|badguys)_(melee|range)_rax_(top|mid|bot)").matches(name) -> "barracks"
    name in listOf("npc_dota_goodguys_fort", "npc_dota_badguys_fort") -> "ancient"
    name == "npc_dota_roshan" -> "roshan"
    else -> null
}
private fun team(value: Int?): String? = when(value) { 2 -> "radiant"; 3 -> "dire"; else -> null }
internal class EventCollector {
    private data class Item(val time: Double, val hero: String?, val name: String?, val action: String)
    private data class Objective(val time: Double, val name: String, val owner: String?, val beneficiary: String?)
    private val items = mutableListOf<Item>()
    private val objectives = mutableListOf<Objective>()
    fun accept(entry: CombatLogEntry) {
        if (!entry.hasType() || !entry.hasTimestamp()) return
        val time = entry.timestamp.toDouble()
        checkReplay(time.isFinite(), "Invalid event clock.")
        when(entry.type.name) {
            "DOTA_COMBATLOG_PURCHASE" -> items.add(Item(time, entry.targetName.takeIf { entry.hasTargetName() },
                entry.valueName.takeIf { entry.hasValue() }, "purchased"))
            "DOTA_COMBATLOG_ITEM" -> items.add(Item(time, entry.attackerName.takeIf { entry.hasAttackerName() && entry.hasAttackerIllusion() && !entry.isAttackerIllusion },
                entry.inflictorName.takeIf { entry.hasInflictorName() }, "used"))
            "DOTA_COMBATLOG_DEATH" -> if (entry.hasTargetName() && objectiveType(entry.targetName) != null) {
                // Denies and neutral objectives make 'opposite of owner' an invalid inference.
                objectives.add(Objective(time, entry.targetName, team(entry.targetTeam.takeIf { entry.hasTargetTeam() }),
                    team(entry.attackerTeam.takeIf { entry.hasAttackerTeam() })))
            }
        }
        checkReplay(items.size + objectives.size <= 100_000, "Event limit exceeded.")
    }
    fun records(factory: ReplayRecords, slots: Map<String, Int>, min: Double, start: Double, end: Double): List<ObjectNode> {
        val out = mutableListOf<ObjectNode>()
        for ((i, item) in items.withIndex()) {
            if (item.time !in min..end) continue
            val slot = slots[item.hero] ?: continue
            val id = ResourceIds.resolve("item", item.name) ?: continue
            out += factory.base("event", "item-$i").apply {
                put("gameTimeSeconds", item.time - start); putNull("tick"); putArray("coverageIds").add(factory.id("items"))
                putObject("data").put("type", "item").put("playerSlot", slot).put("itemId", id).put("action", item.action)
            }
        }
        for ((i, objective) in objectives.withIndex()) {
            if (objective.time !in min..end) continue
            out += factory.base("event", "objective-$i").apply {
                put("gameTimeSeconds", objective.time - start); putNull("tick"); putArray("coverageIds").add(factory.id("objectives"))
                putObject("data").put("type", "objective").put("objectId", objective.name)
                    .put("objectType", objectiveType(objective.name)).put("ownerTeam", objective.owner).put("beneficiaryTeam", objective.beneficiary.takeIf { it != objective.owner })
            }
        }
        for (field in listOf("items", "objectives")) out += factory.coverage(field, field, slots.values.sorted(), min-start, end-start, "unknown",
            if (field == "items") "Observed purchases/uses only; receipt, assembly, unknown IDs and log completeness are not established. ID catalog: dotaconstants 5c0242df."
            else "Observed named objective deaths only; completeness and reward attribution are not established. Beneficiary denotes an opposing logged attacker team; denies remain unknown.",
            out.filter { it["data"]?.get("type")?.asText() == if (field == "items") "item" else "objective" }.map { it["id"].asText() })
        return out
    }
}
