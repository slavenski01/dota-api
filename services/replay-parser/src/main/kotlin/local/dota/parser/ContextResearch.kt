package local.dota.parser

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.ObjectNode
import skadistats.clarity.model.CombatLogEntry
import skadistats.clarity.model.Entity
import skadistats.clarity.processor.entities.Entities
import skadistats.clarity.processor.entities.OnEntityCreated
import skadistats.clarity.processor.gameevents.OnCombatLogEntry
import skadistats.clarity.processor.reader.OnMessage
import skadistats.clarity.processor.reader.OnTickEnd
import skadistats.clarity.processor.runner.Context
import skadistats.clarity.processor.stringtables.StringTables
import skadistats.clarity.processor.stringtables.UsesStringTable
import skadistats.clarity.wire.shared.common.proto.CommonNetworkBaseTypes.CNETMsg_Tick
import skadistats.clarity.wire.shared.demo.proto.DemoNetMessages.CSVCMsg_ServerInfo
import kotlin.math.floor

internal const val CONTEXT_RESEARCH_VERSION = "context-research-v1"
internal val contextFields = listOf("position", "hp", "mana", "alive", "inventory", "resources")
internal fun visibilityBit(word: Long?, entityIndex: Int): Boolean? =
    if (word == null || entityIndex !in 0 until 16384) null else (word ushr (entityIndex % 64)) and 1L != 0L

/** Coordinate hypothesis is retained alongside original network cells; client calibration is still pending. */
internal fun coordinateCandidate(cell: Number?, offset: Number?): Double? {
    val c = cell?.toDouble() ?: return null
    val v = offset?.toDouble() ?: return null
    return if (c.isFinite() && v.isFinite() && c >= 0 && c == floor(c))
        (c * 128 + v - 16384).takeIf { it.isFinite() } else null
}

/** A zero timer alone never establishes target, range, mana, control or activation requirements. */
internal fun resourceUsability(): ObjectNode = unknown("Ability-use conditions have not been verified.")
internal fun unknown(reason: String): ObjectNode = ContractValidator.mapper.createObjectNode()
    .put("status", "unknown").putNull("value").put("reason", reason)

/** Whitelist projection: raw masks, unit flags and omniscient fields cannot escape into team output. */
internal fun teamProjection(sample: JsonNode, team: String, verifiedVisibility: Boolean?): ObjectNode {
    require(team in listOf("radiant", "dire"))
    return ContractValidator.mapper.createObjectNode().apply {
        put("playerSlot", sample["playerSlot"].asInt()); put("gameTimeSeconds", sample["gameTimeSeconds"].asDouble())
        putObject("perspective").put("mode", "team").put("team", team)
        if (verifiedVisibility == null) set<ObjectNode>("visibility", unknown("Client verification of team visibility is pending."))
        else putObject("visibility").put("status", "known").put("value", if (verifiedVisibility) "visible" else "hidden")
            .put("observedAtSeconds", sample["gameTimeSeconds"].asDouble())
        for (field in contextFields) {
            if (verifiedVisibility == true) set<JsonNode>(field, sample[field].deepCopy<JsonNode>())
            else set<ObjectNode>(field, unknown("Current state is not confirmed visible to this team."))
        }
        // No last-known value can be established from unverified visibility or a future snapshot.
        putNull("lastKnownPosition")
    }
}

/** Bounded, separate research format. This is intentionally not a production hero_state dataset. */
@UsesStringTable("EntityNames")
class ContextResearch(val fromSeconds: Double, val toSeconds: Double) {
    init {
        require(fromSeconds.isFinite() && toSeconds.isFinite() && fromSeconds >= 0 && toSeconds > fromSeconds &&
            toSeconds - fromSeconds <= 120) { "invalid_context_window" }
    }
    private val mapper = ContractValidator.mapper
    private val resources = mutableMapOf<String, Entity>()
    private var serverTick: Int? = null
    private var interval: Double? = null
    private var sampledBucket: Long? = null
    private var matchStarted = false
    private var visibilitySamples = 0
    private var ownVisible = 0
    private var ownNotVisible = 0
    private var unknownVisibility = 0
    private var visibilityTransitions = 0
    private var candidatesTruncated = false
    private val previousVisibility = mutableMapOf<Pair<Int, String>, Boolean>()
    private val samples = mutableListOf<ObjectNode>()
    private val candidates = mutableListOf<ObjectNode>()
    private val heroFields = sortedSetOf<String>()
    private val probeFields = listOf("m_iHealth", "m_flMana", "m_lifeState", "m_nUnitState64", "m_iTaggedAsVisibleByTeam",
        "CBodyComponent.m_cellX", "CBodyComponent.m_cellY", "CBodyComponent.m_cellZ", "CBodyComponent.m_vecX",
        "CBodyComponent.m_vecY", "CBodyComponent.m_vecZ", "m_hItems.0000", "m_vecAbilities.0000", "m_hAbilities.0000")

    @OnEntityCreated(classPattern = "CDOTAGamerulesProxy|CDOTA_PlayerResource|CDOTA_DataRadiant|CDOTA_DataDire")
    fun onEntity(entity: Entity) { resources[entity.dtClass.dtName] = entity }

    @OnMessage(CNETMsg_Tick::class)
    fun onTickMessage(message: CNETMsg_Tick) { serverTick = message.tick }

    @OnMessage(CSVCMsg_ServerInfo::class)
    fun onServer(message: CSVCMsg_ServerInfo) { interval = message.tickInterval.toDouble().takeIf { message.hasTickInterval() } }

    @OnTickEnd
    fun onTick(context: Context, synthetic: Boolean) {
        if (synthetic) return
        val rules = resources["CDOTAGamerulesProxy"] ?: return
        if (rules.num("m_pGameRules.m_nGameState")?.toInt() != 5) return
        val start = rules.num("m_pGameRules.m_flGameStartTime")?.toDouble()?.takeIf { it > 0 } ?: return
        val tick = serverTick ?: return
        val step = interval ?: return
        val paused = rules.prop("m_pGameRules.m_bGamePaused") as? Boolean ?: return
        val pauseTick = rules.num("m_pGameRules.m_nPauseStartTick")?.toInt() ?: return
        val pausedTicks = rules.num("m_pGameRules.m_nTotalPausedTicks")?.toInt() ?: return
        val absolute = replayTime(tick, step, paused, pauseTick, pausedTicks)
        val time = absolute - start
        if (time < 0) return
        matchStarted = true
        // Sample the first observed tick in each one-second bucket; never duplicate a paused clock.
        val bucket = floor(time).toLong()
        if (sampledBucket == bucket) return
        sampledBucket = bucket
        val playerResource = resources["CDOTA_PlayerResource"] ?: return
        val entities = context.getProcessor(Entities::class.java)
        for (i in 0 until 24) {
            val playerData = "m_vecPlayerData.${idx(i)}."
            val teamData = "m_vecPlayerTeamData.${idx(i)}."
            val teamNumber = playerResource.num(playerData + "m_iPlayerTeam")?.toInt() ?: continue
            if (teamNumber !in 2..3) continue
            val teamSlot = playerResource.num(teamData + "m_iTeamSlot")?.toInt()?.takeIf { it in 0..4 } ?: continue
            val slot = teamSlot + if (teamNumber == 2) 0 else 128
            val handle = playerResource.num(teamData + "m_hSelectedHero")?.toInt() ?: continue
            val hero = entities.getByHandle(handle) ?: continue
            if (!hero.isActive || !hero.isExistent) continue
            for (field in probeFields) if (hero.prop(field) != null) heroFields.add(field)
            val radiant = bit(resources["CDOTA_DataRadiant"], hero.index)
            val dire = bit(resources["CDOTA_DataDire"], hero.index)
            val own = if (teamNumber == 2) radiant else dire
            visibilitySamples++
            when (own) { true -> ownVisible++; false -> ownNotVisible++; null -> unknownVisibility++ }
            for ((side, value) in listOf("radiant" to radiant, "dire" to dire)) {
                val key = slot to side
                val previous = previousVisibility[key]
                if (value != null) {
                    if (previous != null && previous != value) {
                        visibilityTransitions++
                        candidate(mapper.createObjectNode().put("kind", "visibility_transition").put("time", time)
                            .put("playerSlot", slot).put("observerTeam", side).put("from", previous).put("to", value)
                            .put("meaning", "unverified_team_bitset_transition"))
                    }
                    previousVisibility[key] = value
                } else previousVisibility.remove(key)
            }
            if (time < fromSeconds || time > toSeconds) continue
            checkReplay(samples.size < 1210, "Context sample limit exceeded.")
            val sample = mapper.createObjectNode().put("playerSlot", slot).put("gameTimeSeconds", time)
                .put("tick", context.tick).put("serverTick", tick).put("entityIndex", hero.index).put("entityHandle", hero.handle.toString())
            sample.putObject("visibilityEvidence").apply {
                put("source", "m_bNPCVisibleState[entityIndex / 64], bit entityIndex % 64")
                set<JsonNode>("radiantCandidate", mapper.valueToTree(radiant)); set<JsonNode>("direCandidate", mapper.valueToTree(dire))
                put("verification", "pending_client")
            }
            sample.putObject("position").apply {
                put("status", "candidate"); put("coordinateSystem", "world_hypothesis"); putNull("mapVersion")
                for (axis in listOf("X", "Y", "Z")) {
                    val cell = hero.num("CBodyComponent.m_cell$axis")
                    val offset = hero.num("CBodyComponent.m_vec$axis")
                    set<JsonNode>("cell$axis", mapper.valueToTree(cell)); set<JsonNode>("offset$axis", mapper.valueToTree(offset))
                    set<JsonNode>(axis.lowercase(), mapper.valueToTree(coordinateCandidate(cell, offset)))
                }
            }
            sample.set<JsonNode>("hp", mapper.valueToTree(hero.num("m_iHealth")))
            sample.set<JsonNode>("mana", mapper.valueToTree(hero.num("m_flMana")))
            val life = hero.num("m_lifeState")?.toInt()
            sample.set<JsonNode>("alive", mapper.valueToTree(life?.let { it == 0 }))
            sample.set<JsonNode>("lifeStateRaw", mapper.valueToTree(life))
            sample.put("unitState64Raw", hero.num("m_nUnitState64")?.toLong()?.let { java.lang.Long.toUnsignedString(it) })
            sample.set<JsonNode>("inventory", scanResources(context, hero, "item"))
            sample.set<JsonNode>("resources", scanResources(context, hero, "ability"))
            // Unverified candidate bits are deliberately never passed to this projection.
            sample.putObject("teamViews").apply {
                set<ObjectNode>("radiant", teamProjection(sample, "radiant", null))
                set<ObjectNode>("dire", teamProjection(sample, "dire", null))
            }
            samples.add(sample)
        }
    }

    private fun scanResources(context: Context, hero: Entity, kind: String): ObjectNode {
        val out = mapper.createObjectNode().put("status", "observed").put("idSemantics", "replay_entity_handle_and_EntityNames_name")
        val entries = out.putArray("entries")
        val prefix = if (kind == "item") "m_hItems" else if (hero.getFieldPathForName("m_vecAbilities.0000") != null) "m_vecAbilities" else "m_hAbilities"
        // Enumerate this replay's array length; modern item arrays extend beyond the classic inventory slots.
        // A schema field path can resolve beyond the actual vector length; enumerate stored paths instead.
        val slotPattern = Regex("${Regex.escape(prefix)}\\.(\\d{4})")
        val slots = hero.state.fieldPathIterator().asSequence().mapNotNull { path ->
            slotPattern.matchEntire(hero.getNameForFieldPath(path))?.groupValues?.get(1)?.toInt()
        }.sorted().toList()
        val count = 64
        val truncated = slots.any { it >= count }
        var missing = if (slots.isEmpty()) 1 else minOf(count, slots.last() + 1) - slots.count { it < count }
        var slotsRead = 0
        for (slot in slots.filter { it < count }) {
            val handle = hero.num("$prefix.${idx(slot)}")?.toInt()
            if (handle == null) {
                missing++
                continue
            }
            slotsRead++
            if (handle == 0xFFFFFF) continue
            val entity = context.getProcessor(Entities::class.java).getByHandle(handle)
            if (entity == null || !entity.isActive || !entity.isExistent) { missing++; continue }
            val index = entity.num("m_pEntity.m_nameStringTableIndex")?.toInt()
            val table = context.getProcessor(StringTables::class.java).forName("EntityNames")
            val name = index?.takeIf { table?.hasIndex(it) == true }?.let { table?.getNameByIndex(it) }
            if (name == null) missing++
            entries.addObject().apply {
                put("kind", kind); put("slot", slot); put("entityHandle", handle.toString()); put("name", name)
                for ((label, field) in mapOf("level" to "m_iLevel", "charges" to "m_iCurrentCharges", "abilityCharges" to "m_nAbilityCurrentCharges",
                    "manaCost" to "m_iManaCost", "cooldownRaw" to "m_fCooldown", "cooldownLength" to "m_flCooldownLength",
                    "castStartTime" to "m_flCastStartTime", "activated" to "m_bActivated", "hidden" to "m_bHidden",
                    "frozenCooldown" to "m_bFrozenCooldown", "indefiniteCooldown" to "m_bInIndefiniteCooldown"))
                    set<JsonNode>(label, mapper.valueToTree(entity.prop(field)))
                set<ObjectNode>("canUse", resourceUsability())
            }
        }
        out.put("slotsRead", slotsRead).put("unresolvedSlots", missing).put("truncated", truncated)
        if (missing > 0 || truncated) out.put("status", "partial")
        return out
    }

    @OnCombatLogEntry
    fun onCombat(entry: CombatLogEntry) {
        if (!entry.hasTimestamp() || !entry.hasType() || !entry.hasInflictorName()) return
        if (entry.type.name !in listOf("DOTA_COMBATLOG_MODIFIER_ADD", "DOTA_COMBATLOG_MODIFIER_REMOVE")) return
        val name = entry.inflictorName ?: return
        if (!listOf("smoke", "invis", "truesight", "dust").any { name.contains(it) }) return
        candidate(mapper.createObjectNode().put("kind", "modifier").put("time", entry.timestamp.toDouble())
            .put("timeBasis", "absolute_game_clock").put("modifier", name).put("action", entry.type.name)
            .put("targetHeroName", entry.targetName.takeIf { entry.hasTargetName() })
            .put("targetIllusion", entry.isTargetIllusion.takeIf { entry.hasTargetIllusion() })
            .put("meaning", "modifier_event_does_not_prove_detection_or_visibility"))
    }

    private fun candidate(node: ObjectNode) {
        if (candidates.size < 5000) candidates.add(node) else candidatesTruncated = true
    }

    fun report(basic: List<ObjectNode>): ObjectNode {
        checkReplay(matchStarted && samples.isNotEmpty(), "Requested context window has no usable hero samples.")
        val match = basic.single { it["kind"].asText() == "match" }
        // Game start is read from the same completed, independently checked BasicCollector run.
        val start = requireNotNull(resources["CDOTAGamerulesProxy"]?.num("m_pGameRules.m_flGameStartTime")).toDouble()
        val duration = match["durationSeconds"].asDouble()
        val adjusted = candidates.mapNotNull { original ->
            val c = original.deepCopy()
            val t = c["time"].asDouble() - if (c["timeBasis"]?.asText() == "absolute_game_clock") start else 0.0
            if (!t.isFinite() || t < 0 || t > duration) return@mapNotNull null
            c.remove("timeBasis"); c.put("time", t); c
        }.sortedBy { it["time"].asDouble() }
        return mapper.createObjectNode().apply {
            put("researchVersion", CONTEXT_RESEARCH_VERSION); put("status", "research_only"); put("clientVerified", false)
            put("matchId", match["matchId"].asText())
            set<ObjectNode>("provenance", (match["provenance"].deepCopy<JsonNode>() as ObjectNode)
                .put("sourceVersion", "$CONTEXT_RESEARCH_VERSION/clarity-5.0.1/protobuf-7.1"))
            putObject("window").put("fromSeconds", fromSeconds).put("toSeconds", toSeconds).put("samplePeriodSeconds", 1)
                .put("firstSampleSeconds", samples.first()["gameTimeSeconds"].asDouble())
                .put("lastSampleSeconds", samples.last()["gameTimeSeconds"].asDouble())
            put("matchDurationSeconds", duration)
            set<JsonNode>("participants", mapper.valueToTree(basic.filter { it["kind"].asText() == "participant" }))
            putObject("visibilityScan").put("sampledHeroObservations", visibilitySamples).put("ownTeamTrue", ownVisible)
                .put("ownTeamFalse", ownNotVisible).put("ownTeamUnknown", unknownVisibility).put("transitions", visibilityTransitions)
                .put("interpretation", "candidate_bitset_only_not_a_fog_map").put("samplingSeconds", 1)
            set<JsonNode>("heroFieldsObserved", mapper.valueToTree(heroFields))
            set<JsonNode>("samples", mapper.valueToTree(samples))
            set<JsonNode>("reviewCandidates", mapper.valueToTree(adjusted)); put("candidatesTruncated", candidatesTruncated)
            putArray("limitations").add("Client replay verification is pending.")
                .add("Coordinates and team visibility are hypotheses; no confirmed team history is exported.")
                .add("Entity handles and names are not stable Dota item/ability IDs.")
                .add("Cooldown raw values do not prove usability; canUse remains unknown.")
                .add("One-second sampling can miss brief transitions; modifier logs do not prove complete effect coverage.")
        }
    }
}

private fun idx(i: Int) = i.toString().padStart(4, '0')
private fun Entity.prop(name: String): Any? = getFieldPathForName(name)?.let { getPropertyForFieldPath<Any>(it) }
private fun Entity.num(name: String) = prop(name) as? Number
private fun bit(team: Entity?, index: Int): Boolean? = visibilityBit(team?.num("m_bNPCVisibleState.${idx(index / 64)}")?.toLong(), index)
