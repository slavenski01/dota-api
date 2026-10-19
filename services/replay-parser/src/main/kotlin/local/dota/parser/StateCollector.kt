package local.dota.parser

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import skadistats.clarity.model.Entity
import skadistats.clarity.processor.entities.Entities
import skadistats.clarity.processor.entities.OnEntityCreated
import skadistats.clarity.processor.reader.OnMessage
import skadistats.clarity.processor.reader.OnTickEnd
import skadistats.clarity.processor.runner.Context
import skadistats.clarity.processor.stringtables.StringTables
import skadistats.clarity.processor.stringtables.UsesStringTable
import skadistats.clarity.wire.shared.common.proto.CommonNetworkBaseTypes.CNETMsg_Tick
import skadistats.clarity.wire.shared.demo.proto.DemoNetMessages.CSVCMsg_ServerInfo
import kotlin.math.floor

internal fun lifeObservation(value: Int?): Boolean? = when(value) { 0 -> true; 1, 2 -> false; else -> null }
internal fun sampledTime(absolute: Double, start: Double): Double = absolute - start
private fun idxState(i: Int) = i.toString().padStart(4, '0')
private fun Entity.propState(name: String): Any? = getFieldPathForName(name)?.let { getPropertyForFieldPath<Any>(it) }
private fun Entity.numState(name: String) = propState(name) as? Number

/** Full-match sparse navigation (5 s), with 1 s samples within 10 s of a recorded death.
 * No interpolation: time is always the observed tick, including before the horn and pauses. */
@UsesStringTable("EntityNames")
class StateCollector {
    private val entities = mutableMapOf<String, Entity>()
    private var tick: Int? = null
    private var interval: Double? = null
    private var bucket: Long? = null
    private data class Item(val id: String, val slot: Int, val charges: Int?)
    private data class Resource(val id: String, val kind: String)
    private data class Sample(val time: Double, val tick: Int, val slot: Int, val hp: Double?, val mana: Double?, val alive: Boolean?,
        val items: List<Item>?, val resources: List<Resource>?, val position: Map<String, Any?>?, val lastHits: Double?, val experience: Double?)
    private val samples = mutableListOf<Sample>()
    @OnEntityCreated(classPattern = "CDOTAGamerulesProxy|CDOTA_PlayerResource|CDOTA_DataRadiant|CDOTA_DataDire")
    fun entity(entity: Entity) { entities[entity.dtClass.dtName] = entity }
    @OnMessage(CNETMsg_Tick::class)
    fun clock(message: CNETMsg_Tick) { tick = message.tick }
    @OnMessage(CSVCMsg_ServerInfo::class)
    fun server(message: CSVCMsg_ServerInfo) { interval = message.tickInterval.toDouble().takeIf { message.hasTickInterval() } }
    @OnTickEnd
    fun sample(context: Context, synthetic: Boolean) {
        if (synthetic) return
        val rules = entities["CDOTAGamerulesProxy"] ?: return
        if (rules.numState("m_pGameRules.m_nGameState")?.toInt() !in 4..5) return
        val time = replayTime(tick ?: return, interval ?: return, rules.propState("m_pGameRules.m_bGamePaused") as? Boolean ?: return,
            rules.numState("m_pGameRules.m_nPauseStartTick")?.toInt() ?: return, rules.numState("m_pGameRules.m_nTotalPausedTicks")?.toInt() ?: return)
        val start = rules.numState("m_pGameRules.m_flGameStartTime")?.toDouble()?.takeIf { it > 0 } ?: 0.0
        val next = floor(time - start).toLong()
        if (bucket == next) return
        bucket = next
        val players = entities["CDOTA_PlayerResource"] ?: return
        val processor = context.getProcessor(Entities::class.java)
        for (i in 0 until 24) {
            val team = players.numState("m_vecPlayerData.${idxState(i)}.m_iPlayerTeam")?.toInt() ?: continue
            if (team !in 2..3) continue
            val prefix = "m_vecPlayerTeamData.${idxState(i)}."
            val teamSlot = players.numState(prefix + "m_iTeamSlot")?.toInt()?.takeIf { it in 0..4 } ?: continue
            val hero = players.numState(prefix + "m_hSelectedHero")?.toInt()?.let { processor.getByHandle(it) } ?: continue
            if (!hero.isActive || !hero.isExistent) continue
            val items = mutableListOf<Item>(); val resources = mutableListOf<Resource>()
            var allItems = true; var allAbilities = true
            for (kind in listOf("item", "ability")) {
                val field = if (kind == "item") "m_hItems" else if (hero.getFieldPathForName("m_vecAbilities.0000") != null) "m_vecAbilities" else "m_hAbilities"
                val pattern = Regex("${Regex.escape(field)}\\.(\\d{4})")
                val slots = hero.state.fieldPathIterator().asSequence().mapNotNull { pattern.matchEntire(hero.getNameForFieldPath(it))?.groupValues?.get(1)?.toInt() }.sorted().toList()
                var complete = slots.isNotEmpty() && slots.last() < 64 && slots == (0..slots.last()).toList()
                for (slot in slots.filter { it < 64 }) {
                    val handle = hero.numState("$field.${idxState(slot)}")?.toInt()
                    if (handle == 0xFFFFFF) continue
                    val entity = handle?.let { processor.getByHandle(it) }
                    if (entity == null || !entity.isActive || !entity.isExistent) { complete = false; continue }
                    val table = context.getProcessor(StringTables::class.java).forName("EntityNames")
                    val index = entity.numState("m_pEntity.m_nameStringTableIndex")?.toInt()
                    val name = index?.takeIf { table?.hasIndex(it) == true }?.let { table?.getNameByIndex(it) }
                    val id = ResourceIds.resolve(kind, name)
                    if (id == null) { complete = false; continue }
                    if (kind == "item") items += Item(id, slot, entity.numState("m_iCurrentCharges")?.toInt()?.takeIf { it >= 0 })
                    resources += Resource(id, kind)
                }
                if (kind == "item") allItems = complete else allAbilities = complete
            }
            checkReplay(samples.size < 120_000, "State sample limit exceeded.")
            val teamData = entities[if (team == 2) "CDOTA_DataRadiant" else "CDOTA_DataDire"]
            val statsPrefix = "m_vecDataTeam.${idxState(teamSlot)}."
            samples += Sample(time, context.tick, teamSlot + if (team == 2) 0 else 128,
                hero.numState("m_iHealth")?.toDouble()?.takeIf { it.isFinite() && it >= 0 },
                hero.numState("m_flMana")?.toDouble()?.takeIf { it.isFinite() && it >= 0 },
                lifeObservation(hero.numState("m_lifeState")?.toInt()), if (allItems) items else null,
                if (allItems && allAbilities) resources else null,
                worldPosition(hero.numState("CBodyComponent.m_hParent"),
                    hero.numState("CBodyComponent.m_cellX"), hero.numState("CBodyComponent.m_vecX"),
                    hero.numState("CBodyComponent.m_cellY"), hero.numState("CBodyComponent.m_vecY"),
                    hero.numState("CBodyComponent.m_cellZ"), hero.numState("CBodyComponent.m_vecZ")),
                teamData?.numState(statsPrefix + "m_iLastHitCount")?.toDouble(),
                teamData?.numState(statsPrefix + "m_iTotalEarnedXP")?.toDouble())
        }
    }
    fun records(basic: List<ObjectNode>): List<ObjectNode> {
        val match = basic.single { it["kind"].asText() == "match" }
        val rules = requireNotNull(entities["CDOTAGamerulesProxy"])
        val start = requireNotNull(rules.numState("m_pGameRules.m_flGameStartTime")).toDouble()
        val end = start + match["durationSeconds"].asDouble()
        val hash = match["provenance"]["artifactId"].asText().removePrefix("replay-sha256-")
        val factory = ReplayRecords(match["matchId"].asText(), hash)
        val deaths = basic.filter { it["kind"].asText() == "event" && it["data"]["type"].asText() == "death" }.map { it["gameTimeSeconds"].asDouble() }
        val output = mutableListOf<ObjectNode>()
        val lastSparse = mutableMapOf<Int, Long>()
        // These are the same cumulative counters used by the final scoreboard.
        // A regression or value exceeding the epilogue invalidates that metric for the slot.
        val validCounters = mutableMapOf<Pair<Int, String>, Boolean>()
        for (player in basic.filter { it["kind"].asText() == "participant" }) {
            val slot = player["playerSlot"].asInt()
            for (name in listOf("lastHits", "experience")) {
                val field = player["statistics"][if (name == "lastHits") "lastHits" else "xpm"]
                val teamData = entities[if (slot < 128) "CDOTA_DataRadiant" else "CDOTA_DataDire"]
                val finalValue = if (!field.isNumber) null else if (name == "lastHits") field.asDouble() else
                    teamData?.numState("m_vecDataTeam.${idxState(slot % 128)}.m_iTotalEarnedXP")?.toDouble()?.takeIf {
                        rate(it, match["durationSeconds"].asDouble()) == field.asLong()
                    }
                val values = samples.filter { it.slot == slot && it.time in start..end }.mapNotNull { if (name == "lastHits") it.lastHits else it.experience }
                validCounters[slot to name] = finalValue != null && finalValue.isFinite() && values.isNotEmpty() &&
                    values.all { it.isFinite() && it >= 0 && it <= finalValue + 0.001 } && values.zipWithNext().all { (a, b) -> b >= a }
            }
        }
        for ((i, sample) in samples.withIndex()) {
            if (sample.time > end) continue
            val time = sampledTime(sample.time, start)
            val sparse = floor(time / 5).toLong()
            val navigation = lastSparse[sample.slot] != sparse
            if (!navigation && deaths.none { kotlin.math.abs(it-time) <= 10 }) continue
            lastSparse[sample.slot] = sparse
            fun observation(value: Any?, reason: String): ObjectNode = if (value == null) unknown(reason) else
                ContractValidator.mapper.createObjectNode().put("status", "known").put("observedAtSeconds", time).apply {
                    set<JsonNode>("value", ContractValidator.mapper.valueToTree(value))
                }
            output += factory.base("hero_state", "state-$i").apply {
                put("playerSlot", sample.slot); put("gameTimeSeconds", time); put("tick", sample.tick)
                putObject("perspective").put("mode", "omniscient")
                set<ObjectNode>("visibility", unknown("Team visibility has not been verified."))
                set<ObjectNode>("position", observation(sample.position, "World origin unavailable: missing network coordinates or an unresolved parent transform."))
                set<ObjectNode>("hp", observation(sample.hp, "Health field unavailable."))
                set<ObjectNode>("mana", observation(sample.mana, "Mana field unavailable."))
                putObject("lane").apply {
                    put("formatVersion", "lane-v1")
                    set<ObjectNode>("lastHits", observation(sample.lastHits?.takeIf { validCounters[sample.slot to "lastHits"] == true }, "Cumulative last-hit counter unavailable or inconsistent with final scoreboard."))
                    set<ObjectNode>("experience", observation(sample.experience?.takeIf { validCounters[sample.slot to "experience"] == true }, "Cumulative earned experience unavailable or inconsistent with final scoreboard."))
                }
                set<ObjectNode>("alive", observation(sample.alive, "Unknown lifeState value."))
                set<ObjectNode>("inventory", observation(sample.items?.map { mapOf("itemId" to it.id, "slot" to it.slot, "charges" to it.charges) }, "Inventory slots or stable IDs incomplete."))
                set<ObjectNode>("resources", observation(sample.resources?.map { mapOf("resourceId" to it.id, "kind" to it.kind,
                    "cooldownRemainingSeconds" to unknown("Timer semantics including frozen and charge timers are not verified."),
                    "canUse" to resourceUsability()) }, "Resource slots or stable IDs incomplete."))
                putNull("lastKnownPosition"); putArray("coverageIds").add(factory.id("states-${sample.slot}"))
            }
        }
        for (slot in samples.map { it.slot }.distinct().sorted()) {
            val rows = output.filter { it["kind"].asText() == "hero_state" && it["playerSlot"].asInt() == slot }
            if (rows.isEmpty()) continue
            // 'resources' includes usability and timers: numeric HP alone cannot establish it.
            output += factory.coverage("states-$slot", "resources", listOf(slot), rows.first()["gameTimeSeconds"].asDouble(), rows.last()["gameTimeSeconds"].asDouble(),
                "unknown", "Observed HP/mana/lifeState and resolvable inventory. Timers and canUse unverified; 5-second navigation, 1-second death windows; no interpolation.", emptyList()).put("resolutionSeconds", 5)
        }
        output.forEach { ContractValidator.validateRecord(it) }
        return output
    }
}
