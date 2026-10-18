package local.dota.parser

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import skadistats.clarity.model.Entity
import skadistats.clarity.processor.entities.Entities
import skadistats.clarity.processor.entities.OnEntityCreated
import skadistats.clarity.processor.reader.OnMessage
import skadistats.clarity.processor.reader.OnTickEnd
import skadistats.clarity.processor.runner.Context
import skadistats.clarity.wire.shared.common.proto.CommonNetworkBaseTypes.CNETMsg_Tick
import skadistats.clarity.wire.shared.demo.proto.DemoNetMessages.CSVCMsg_ServerInfo
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max

private fun Entity.motionNumber(name: String): Number? = getFieldPathForName(name)?.let { getPropertyForFieldPath<Any>(it) } as? Number
private fun Entity.motionBool(name: String): Boolean? = getFieldPathForName(name)?.let { getPropertyForFieldPath<Any>(it) } as? Boolean
internal data class MotionPoint(val time: Double, val tick: Int, val x: Double?, val y: Double?, val alive: Boolean?, val handle: Int?)
internal fun motionBoundary(a: MotionPoint?, b: MotionPoint): String? = when {
    a == null -> "start"
    b.x == null || b.y == null || a.x == null || a.y == null || b.alive == null || a.alive == null -> "unknown"
    b.handle != a.handle || b.alive != a.alive -> "life"
    b.time - a.time > 0.3 || b.time <= a.time -> "gap"
    hypot(b.x-a.x, b.y-a.y) > max(48.0, 900*(b.time-a.time)) -> "jump"
    else -> null
}

/** Light observations; inspect each tick to detect discontinuities between saved samples. */
class MotionCollector(private val step: Double = 0.25) {
    private val entities = mutableMapOf<String, Entity>()
    private var tick: Int? = null
    private var interval: Double? = null
    private val previous = mutableMapOf<Int, MotionPoint>()
    private val pending = mutableMapOf<Int, String>()
    private val buckets = mutableMapOf<Int, Long>()
    private val samples = mutableMapOf<Int, MutableList<Pair<MotionPoint, String?>>>()
    @OnEntityCreated(classPattern = "CDOTAGamerulesProxy|CDOTA_PlayerResource")
    fun entity(entity: Entity) { entities[entity.dtClass.dtName] = entity }
    @OnMessage(CNETMsg_Tick::class)
    fun clock(message: CNETMsg_Tick) { tick = message.tick }
    @OnMessage(CSVCMsg_ServerInfo::class)
    fun server(message: CSVCMsg_ServerInfo) { interval = message.tickInterval.toDouble().takeIf { message.hasTickInterval() } }
    @OnTickEnd
    fun sample(context: Context, synthetic: Boolean) {
        if (synthetic) return
        val rules = entities["CDOTAGamerulesProxy"] ?: return
        if (rules.motionNumber("m_pGameRules.m_nGameState")?.toInt() !in 4..5) return
        val time = replayTime(tick ?: return, interval ?: return, rules.motionBool("m_pGameRules.m_bGamePaused") ?: return,
            rules.motionNumber("m_pGameRules.m_nPauseStartTick")?.toInt() ?: return, rules.motionNumber("m_pGameRules.m_nTotalPausedTicks")?.toInt() ?: return)
        val players = entities["CDOTA_PlayerResource"] ?: return
        val processor = context.getProcessor(Entities::class.java)
        for (i in 0 until 24) {
            val index = i.toString().padStart(4, '0')
            val team = players.motionNumber("m_vecPlayerData.$index.m_iPlayerTeam")?.toInt() ?: continue
            if (team !in 2..3) continue
            val slot = players.motionNumber("m_vecPlayerTeamData.$index.m_iTeamSlot")?.toInt()?.takeIf { it in 0..4 }?.let { it + if(team == 2) 0 else 128 } ?: continue
            if (previous[slot]?.time == time) continue // paused game clock
            val handle = players.motionNumber("m_vecPlayerTeamData.$index.m_hSelectedHero")?.toInt()
            val hero = handle?.let { processor.getByHandle(it) }?.takeIf { it.isActive && it.isExistent }
            val position = hero?.let { worldPosition(it.motionNumber("CBodyComponent.m_hParent"),
                it.motionNumber("CBodyComponent.m_cellX"), it.motionNumber("CBodyComponent.m_vecX"),
                it.motionNumber("CBodyComponent.m_cellY"), it.motionNumber("CBodyComponent.m_vecY"),
                it.motionNumber("CBodyComponent.m_cellZ"), it.motionNumber("CBodyComponent.m_vecZ")) }
            val point = MotionPoint(time, context.tick, (position?.get("x") as? Number)?.toDouble(), (position?.get("y") as? Number)?.toDouble(), lifeObservation(hero?.motionNumber("m_lifeState")?.toInt()), handle)
            motionBoundary(previous[slot], point)?.let { pending[slot] = it }
            previous[slot] = point
            val bucket = floor(time / step).toLong()
            if (buckets[slot] == bucket) continue
            buckets[slot] = bucket
            val rows = samples.getOrPut(slot) { mutableListOf() }
            checkReplay(rows.size < 150_000, "Motion sample limit exceeded.")
            rows += point to pending.remove(slot)
        }
    }
    fun records(basic: List<ObjectNode>): List<ObjectNode> {
        val match = basic.single { it["kind"].asText() == "match" }
        val start = requireNotNull(entities["CDOTAGamerulesProxy"]?.motionNumber("m_pGameRules.m_flGameStartTime")).toDouble()
        val end = start + match["durationSeconds"].asDouble()
        val factory = ReplayRecords(match["matchId"].asText(), match["provenance"]["artifactId"].asText().removePrefix("replay-sha256-"))
        return samples.flatMap { (slot, rows) ->
            rows.filter { it.first.time <= end }.groupBy { floor((it.first.time-start)/30).toLong() }.map { (bucket, group) ->
                factory.base("hero_motion", "motion-$slot-$bucket").apply {
                    put("playerSlot", slot); put("formatVersion", "motion-v1"); put("stepSeconds", step)
                    set<JsonNode>("samples", ContractValidator.mapper.valueToTree(group.map { (p, boundary) ->
                        mapOf("time" to p.time-start, "tick" to p.tick, "x" to p.x, "y" to p.y, "alive" to p.alive, "breakBefore" to boundary)
                    }))
                }.also { ContractValidator.validateRecord(it) }
            }
        }
    }
}
