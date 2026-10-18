package local.dota.parser

import com.fasterxml.jackson.databind.node.ObjectNode
import skadistats.clarity.Clarity
import skadistats.clarity.model.CombatLogEntry
import skadistats.clarity.model.EngineId
import skadistats.clarity.model.Entity
import skadistats.clarity.processor.entities.OnEntityCreated
import skadistats.clarity.processor.gameevents.OnCombatLogEntry
import skadistats.clarity.processor.reader.OnMessage
import skadistats.clarity.processor.reader.OnTickEnd
import skadistats.clarity.processor.runner.Context
import skadistats.clarity.processor.runner.SimpleRunner
import skadistats.clarity.source.MappedFileSource
import skadistats.clarity.wire.shared.common.proto.CommonNetworkBaseTypes.CNETMsg_Tick
import skadistats.clarity.wire.shared.demo.proto.Demo
import skadistats.clarity.wire.shared.demo.proto.DemoNetMessages.CSVCMsg_ServerInfo
import java.nio.file.Files
import java.nio.file.Path
import java.security.DigestInputStream
import java.security.MessageDigest
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.math.abs
import kotlin.math.floor

class ReplayFailure(val code: String, message: String) : RuntimeException(message)

internal fun checkReplay(condition: Boolean, message: String) {
    if (!condition) throw ReplayFailure("parse_failed", message)
}

/** Server time excludes paused ticks. Demo ticks have a different origin. */
internal fun replayTime(serverTick: Int, interval: Double, paused: Boolean, pauseStart: Int, totalPaused: Int): Double {
    checkReplay(interval.isFinite() && interval > 0 && serverTick >= 0 && totalPaused >= 0, "Invalid replay clock.")
    val effective = if (paused) pauseStart else serverTick
    checkReplay(effective >= totalPaused, "Invalid replay pause counters.")
    return (effective - totalPaused) * interval
}

internal data class Death(val time: Double, val hero: String)
internal fun matchDeaths(deaths: List<Death>, start: Double, end: Double): List<Death> =
    deaths.filter { it.time in start..end }.sortedBy { it.time }
internal fun isCountedDeath(hero: Boolean?, illusion: Boolean?, reincarnating: Boolean?): Boolean =
    hero == true && illusion == false && reincarnating == false

internal fun rate(total: Number?, duration: Double): Long? = total?.toDouble()?.takeIf { it.isFinite() && it >= 0 }
    ?.let { floor(it * 60 / duration).toLong() }

class ReplayParser {
    fun parse(path: Path, expectedMatchId: String, research: ContextResearch? = null, states: Boolean = false, motionStep: Double = 0.25): List<ObjectNode> {
        val info = try {
            if (!Files.isRegularFile(path) || Files.size(path) < 16) throw IllegalArgumentException()
            Clarity.infoForFile(path.toString())
        } catch (_: Exception) {
            throw ReplayFailure("invalid_replay", "Replay is missing, unreadable, truncated or has an unsupported header.")
        }
        if (!info.hasGameInfo() || !info.gameInfo.hasDota() || !info.gameInfo.dota.hasMatchId())
            throw ReplayFailure("invalid_replay", "Dota match metadata is missing.")
        if (java.lang.Long.toUnsignedString(info.gameInfo.dota.matchId) != expectedMatchId)
            throw ReplayFailure("invalid_replay", "Replay match ID does not match expectedMatchId.")
        try {
            MappedFileSource(path.toString()).use { source ->
                val runner = SimpleRunner(source)
                if (runner.engineType.id != EngineId.DOTA_S2)
                    throw ReplayFailure("invalid_replay", "Only Dota Source 2 replays are supported.")
                val collector = BasicCollector(info)
                val stateCollector = if (states) StateCollector() else null
                val motionCollector = if (states) MotionCollector(motionStep) else null
                if (stateCollector != null) runner.runWith(collector, stateCollector, motionCollector)
                else if (research == null) runner.runWith(collector) else runner.runWith(collector, research)
                val digest = MessageDigest.getInstance("SHA-256")
                DigestInputStream(Files.newInputStream(path), digest).use { it.transferTo(java.io.OutputStream.nullOutputStream()) }
                val basic = collector.records(expectedMatchId, digest.digest().joinToString("") { "%02x".format(it) })
                return basic + (stateCollector?.records(basic) ?: emptyList()) + (motionCollector?.records(basic) ?: emptyList())
            }
        } catch (e: ReplayFailure) {
            throw e
        } catch (_: Exception) {
            // Clarity exception messages can contain paths or source data.
            throw ReplayFailure("parse_failed", "Replay decoding failed: corrupt or unsupported replay data.")
        }
    }
}

/** Public class/methods allow Clarity's runtime annotation discovery from Kotlin. */
class BasicCollector(private val expectedInfo: Demo.CDemoFileInfo) {
    private val entities = mutableMapOf<String, Entity>()
    private var finalEntities: Map<String, Entity>? = null
    private val deaths = mutableListOf<Death>()
    private val extraEvents = EventCollector()
    private var infoSeen = false
    private var stopSeen = false
    private var serverTick: Int? = null
    private var interval: Double? = null
    private var combatStart: Double? = null
    private var combatEnd: Double? = null
    private var minTime = Double.POSITIVE_INFINITY
    private var maxTime = Double.NEGATIVE_INFINITY
    private var previousTime: Double? = null
    private var previousPaused = false
    private var pauseTime: Double? = null
    private var pauseCount = 0
    private var clockSamples = 0
    private var ignoredIllusions = 0
    private var ignoredReincarnations = 0
    private var ambiguousDeaths = false
    private var baselineDeaths: Map<Int, Int>? = null

    @OnEntityCreated(classPattern = "CDOTAGamerulesProxy|CDOTA_PlayerResource|CDOTA_DataRadiant|CDOTA_DataDire")
    fun onEntity(entity: Entity) {
        val previous = entities.put(entity.dtClass.dtName, entity)
        checkReplay(previous == null || !previous.isExistent, "Ambiguous resource entities.")
    }

    @OnMessage(CNETMsg_Tick::class)
    fun onServerTick(message: CNETMsg_Tick) { serverTick = message.tick }

    @OnMessage(CSVCMsg_ServerInfo::class)
    fun onServerInfo(message: CSVCMsg_ServerInfo) {
        checkReplay(message.hasTickInterval(), "Replay tick interval is missing.")
        interval = message.tickInterval.toDouble()
    }

    @OnMessage(Demo.CDemoStop::class)
    fun onStop(@Suppress("UNUSED_PARAMETER") message: Demo.CDemoStop) { stopSeen = true }

    @OnMessage(Demo.CDemoFileInfo::class)
    fun onInfo(message: Demo.CDemoFileInfo) {
        checkReplay(message == expectedInfo && !infoSeen, "Replay epilogue does not match metadata.")
        infoSeen = true
    }

    @OnTickEnd
    fun onTick(@Suppress("UNUSED_PARAMETER") context: Context, synthetic: Boolean) {
        if (synthetic) return
        val rules = entities["CDOTAGamerulesProxy"] ?: return
        val state = rules.number("m_pGameRules.m_nGameState")?.toInt() ?: return
        if (state == 6 && finalEntities == null) {
            // Entities keep changing during the postgame animation; freeze the scoreboard at game end.
            finalEntities = entities.mapValues { (_, e) ->
                Entity(e.index, e.serial, e.handle, e.dtClass).apply { this.state = e.state.copy() }
            }
        }
        if (state !in 4..5) return
        val tick = serverTick ?: throw ReplayFailure("parse_failed", "Server clock is missing.")
        val step = interval ?: throw ReplayFailure("parse_failed", "Tick interval is missing.")
        val paused = rules.value("m_pGameRules.m_bGamePaused") as? Boolean
            ?: throw ReplayFailure("parse_failed", "Pause state is missing.")
        val pauseStart = rules.number("m_pGameRules.m_nPauseStartTick")?.toInt()
            ?: throw ReplayFailure("parse_failed", "Pause start is missing.")
        val total = rules.number("m_pGameRules.m_nTotalPausedTicks")?.toInt()
            ?: throw ReplayFailure("parse_failed", "Pause duration is missing.")
        val time = replayTime(tick, step, paused, pauseStart, total)
        previousTime?.let { checkReplay(time + step * 2 >= it, "Replay clock moved backwards.") }
        if (paused) {
            if (!previousPaused) { pauseCount++; pauseTime = time }
            checkReplay(abs(time - requireNotNull(pauseTime)) < step * 2, "Replay clock advanced during a pause.")
        }
        previousPaused = paused
        previousTime = time
        minTime = minOf(minTime, time)
        maxTime = maxOf(maxTime, time)
        clockSamples++
        if (baselineDeaths == null && state == 4) {
            val resource = entities["CDOTA_PlayerResource"] ?: return
            val baseline = (0 until 24).mapNotNull { i ->
                resource.number("m_vecPlayerTeamData.${index(i)}.m_iDeaths")?.toInt()?.let { i to it }
            }.toMap()
            if (baseline.size >= 10) baselineDeaths = baseline
        }
    }

    @OnCombatLogEntry
    fun onCombat(entry: CombatLogEntry) {
        extraEvents.accept(entry)
        if (!entry.hasType()) return
        when (entry.type.name) {
            "DOTA_COMBATLOG_GAME_STATE" -> if (entry.hasTimestamp() && entry.hasValue()) {
                if (entry.value == 5) combatStart = entry.timestamp.toDouble()
                if (entry.value == 6) combatEnd = entry.timestamp.toDouble()
            }
            "DOTA_COMBATLOG_DEATH" -> {
                if (entry.hasTargetIllusion() && entry.isTargetIllusion) { ignoredIllusions++; return }
                if (entry.hasWillReincarnate() && entry.isWillReincarnate) { ignoredReincarnations++; return }
                if (!entry.hasTargetHero() || !entry.isTargetHero) return
                if (!isCountedDeath(true, entry.isTargetIllusion.takeIf { entry.hasTargetIllusion() },
                        entry.isWillReincarnate.takeIf { entry.hasWillReincarnate() }) ||
                    !entry.hasTimestamp() || !entry.hasTargetName()) { ambiguousDeaths = true; return }
                checkReplay(deaths.size < 100_000, "Replay event limit exceeded.")
                val time = entry.timestamp.toDouble()
                checkReplay(time.isFinite(), "Invalid combat-log timestamp.")
                deaths.add(Death(time, entry.targetName))
            }
        }
    }

    fun records(matchId: String, replaySha256: String): List<ObjectNode> {
        checkReplay(infoSeen && stopSeen, "Replay is incomplete: stop marker or epilogue is missing.")
        val rules = entities["CDOTAGamerulesProxy"] ?: throw ReplayFailure("parse_failed", "Game rules are missing.")
        val start = rules.number("m_pGameRules.m_flGameStartTime")?.toDouble()
        val end = rules.number("m_pGameRules.m_flGameEndTime")?.toDouble()
        checkReplay(start != null && end != null && start.isFinite() && end.isFinite() && end > start,
            "Completed-match clock is missing.")
        val startTime = requireNotNull(start)
        val endTime = requireNotNull(end)
        val duration = endTime - startTime
        val step = requireNotNull(interval)
        checkReplay(clockSamples > 0 && minTime < startTime && maxTime >= endTime - step * 4,
            "Replay clock does not cover the match.")
        checkReplay(combatStart != null && combatEnd != null && abs(requireNotNull(combatStart) - startTime) < step * 2 &&
            abs(requireNotNull(combatEnd) - endTime) < step * 2, "Combat-log and game-rule clocks disagree.")
        val dota = expectedInfo.gameInfo.dota
        val final = finalEntities ?: throw ReplayFailure("parse_failed", "Final scoreboard snapshot is missing.")
        val resource = final["CDOTA_PlayerResource"] ?: throw ReplayFailure("parse_failed", "Participants are missing.")
        val factory = ReplayRecords(matchId, replaySha256)
        val records = mutableListOf<ObjectNode>()
        records += factory.base("match", "match").apply {
            putNull("startedAt"); put("durationSeconds", duration)
            put("mode", dota.gameMode.toString().takeIf { dota.hasGameMode() }); putNull("patch")
            if (dota.hasGameWinner() && dota.gameWinner in 2..3) put("radiantWin", dota.gameWinner == 2) else putNull("radiantWin")
        }
        val heroSlots = mutableMapOf<String, Int>()
        val participantRows = mutableListOf<ObjectNode>()
        val baselineSlots = mutableSetOf<Int>()
        for (i in 0 until 24) {
            val data = "m_vecPlayerData.${index(i)}."
            val teamData = "m_vecPlayerTeamData.${index(i)}."
            val team = resource.number(data + "m_iPlayerTeam")?.toInt() ?: continue
            if (team !in 2..3) continue
            val teamSlot = resource.number(teamData + "m_iTeamSlot")?.toInt()
            checkReplay(teamSlot != null && teamSlot in 0..4, "Invalid participant team slot.")
            val slot = requireNotNull(teamSlot) + if (team == 2) 0 else 128
            val steam = resource.number(data + "m_iPlayerSteamID")?.toLong()
            val metadata = dota.playerInfoList.filter { it.hasSteamid() && it.steamid == steam && it.gameTeam == team }
            checkReplay(steam != null && steam > 0 && metadata.size == 1 && metadata[0].hasHeroName(),
                "Participant identity does not match the replay epilogue.")
            val heroName = metadata.single().heroName
            checkReplay(heroSlots.put(heroName, slot) == null, "Ambiguous hero identity.")
            if (baselineDeaths?.get(i) == 0) baselineSlots.add(slot)
            val teamEntity = final[if (team == 2) "CDOTA_DataRadiant" else "CDOTA_DataDire"]
            val statsPrefix = "m_vecDataTeam.${index(teamSlot)}."
            val stats = ContractValidator.mapper.createObjectNode()
            for ((field, property) in mapOf("kills" to "m_iKills", "deaths" to "m_iDeaths", "assists" to "m_iAssists"))
                stats.putNumber(field, resource.number(teamData + property))
            for ((field, property) in mapOf("lastHits" to "m_iLastHitCount", "denies" to "m_iDenyCount",
                "heroDamage" to "m_flHeroDamage", "towerDamage" to "m_flTowerDamage"))
                stats.putNumber(field, teamEntity?.number(statsPrefix + property))
            stats.putNumber("gpm", rate(teamEntity?.number(statsPrefix + "m_iTotalEarnedGold"), duration))
            stats.putNumber("xpm", rate(teamEntity?.number(statsPrefix + "m_iTotalEarnedXP"), duration))
            val participant = factory.base("participant", "participant-$slot").apply {
                put("playerSlot", slot); put("team", if (team == 2) "radiant" else "dire")
                put("steamId64", java.lang.Long.toUnsignedString(requireNotNull(steam)))
                val account = steam - 76561197960265728L
                put("accountId", account.toString().takeIf { account in 1..4294967295L })
                put("heroId", resource.number(teamData + "m_nSelectedHeroID")?.toInt()?.takeIf { it > 0 }?.toString())
                putNull("aspectId"); putNull("role"); set<ObjectNode>("statistics", stats)
            }
            participantRows.add(participant)
        }
        checkReplay(participantRows.size == 10 && participantRows.map { it["playerSlot"].asInt() }.toSet().size == 10,
            "Expected ten unique participants.")
        participantRows.sortBy { it["playerSlot"].asInt() }
        records += participantRows
        val included = matchDeaths(deaths, minTime - step * 2, endTime)
        val eventRows = included.mapIndexedNotNull { i, death ->
            val slot = heroSlots[death.hero] ?: return@mapIndexedNotNull null.also { ambiguousDeaths = true }
            factory.base("event", "death-$i").apply {
                put("gameTimeSeconds", death.time - startTime)
                // Combat-log messages can be delivered in batches; delivery tick is not the event tick.
                putNull("tick")
                putArray("coverageIds").add(factory.id("deaths-$slot"))
                putObject("data").put("type", "death").put("victimSlot", slot).putNull("killerSlot").putNull("afterBuyback")
            }
        }
        records += eventRows
        records += extraEvents.records(factory, heroSlots, minTime - step * 2, startTime, endTime)
        for (participant in participantRows) {
            val slot = participant["playerSlot"].asInt()
            val events = eventRows.filter { it["data"]["victimSlot"].asInt() == slot }
            val finalDeaths = participant["statistics"]["deaths"]
            val covered = !ambiguousDeaths && slot in baselineSlots && !finalDeaths.isNull && finalDeaths.asInt() == events.size
            records += factory.coverage("deaths-$slot", "deaths", listOf(slot), minTime - startTime, duration,
                if (covered) (if (events.isEmpty()) "empty" else "present") else "unknown",
                if (covered) null else "Death-log completeness or final counter could not be confirmed.",
                listOf(participant["id"].asText()) + events.map { it["id"].asText() })
        }
        val slots = participantRows.map { it["playerSlot"].asInt() }
        records += factory.coverage("time", "time", slots, minTime - startTime, duration, "present", null, listOf(factory.id("match")))
        val allStatisticsKnown = participantRows.all { row -> row["statistics"].all { !it.isNull } }
        records += factory.coverage("statistics", "statistics", slots, duration, duration, if (allStatisticsKnown) "present" else "unknown",
            "Final snapshot; individual unavailable fields remain null. GPM/XPM are derived from totals and duration.",
            participantRows.map { it["id"].asText() })
        records.forEach { ContractValidator.validateRecord(it) }
        System.err.println("parser-checks: clockSamples=$clockSamples pauses=$pauseCount ignoredIllusions=$ignoredIllusions " +
            "ignoredReincarnations=$ignoredReincarnations postgameDeaths=${deaths.count { it.time > endTime }}")
        return records
    }
}

private fun index(i: Int) = i.toString().padStart(4, '0')
private fun Entity.value(name: String): Any? = getFieldPathForName(name)?.let { getPropertyForFieldPath<Any>(it) }
private fun Entity.number(name: String) = value(name) as? Number
private fun ObjectNode.putNumber(name: String, value: Number?) {
    val number = value?.toDouble()
    if (number == null || !number.isFinite() || number < 0) putNull(name) else put(name, floor(number).toLong())
}

internal class ReplayRecords(private val matchId: String, private val replaySha256: String) {
    private val acquiredAt = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString()
    // Dataset IDs identify the extraction semantics, not a mutable wall-clock run.
    fun id(suffix: String) = "normalized-v2-$replaySha256-$suffix"
    fun base(kind: String, suffix: String): ObjectNode = ContractValidator.mapper.createObjectNode().apply {
        put("schemaVersion", ContractValidator.SCHEMA_VERSION); put("kind", kind); put("id", id(suffix)); put("matchId", matchId)
        putObject("provenance").apply {
            put("source", "replay"); put("acquiredAt", acquiredAt); put("artifactId", "replay-sha256-$replaySha256")
            put("sourceVersion", "normalized-v2/clarity-5.0.1/protobuf-7.1"); putArray("inputIds")
        }
    }
    fun coverage(suffix: String, field: String, slots: List<Int>, start: Double, end: Double, status: String,
                 reason: String?, evidence: List<String>) = base("coverage", suffix).apply {
        put("datasetId", id("dataset")); put("field", field); putArray("participantSlots").apply { slots.forEach { add(it) } }
        putObject("window").put("startSeconds", start).put("endSeconds", end)
        put("status", status); putNull("resolutionSeconds"); put("reason", reason)
        putArray("evidenceIds").apply { evidence.forEach { add(it) } }
    }
}
