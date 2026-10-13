package local.dota.parser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class ReplaySemanticsTest {
    @Test fun `unknown life states stay unknown and pregame clocks retain their sign`() {
        assertEquals(true, lifeObservation(0)); assertEquals(false, lifeObservation(1))
        assertEquals(false, lifeObservation(2)); assertEquals(null, lifeObservation(99))
        assertEquals(null, lifeObservation(null)); assertEquals(-10.0, sampledTime(90.0,100.0))
    }
    @Test fun `stable resource catalog and named objectives do not confuse ownership`() {
        assertEquals("1", ResourceIds.resolve("item", "item_blink"))
        assertEquals(null, ResourceIds.resolve("item", "unknown_item"))
        assertEquals("tower", objectiveType("npc_dota_goodguys_tower1_mid"))
        assertEquals("ancient", objectiveType("npc_dota_badguys_fort"))
        assertEquals(null, objectiveType("npc_dota_hero_razor"))
    }
    @Test fun `repeated deaths of same hero after buyback are retained`() {
        assertEquals(2, matchDeaths(listOf(Death(10.0,"hero"), Death(20.0,"hero")), 0.0, 30.0).size)
    }
    @Test fun `server clock freezes during pause and resumes without a jump`() {
        val start = 100.0
        assertEquals(-10.0, replayTime(2700, 1.0 / 30, false, 0, 0) - start)
        assertEquals(0.0, replayTime(3000, 1.0 / 30, false, 0, 0) - start)
        assertEquals(20.0, replayTime(3600, 1.0 / 30, true, 3600, 0) - start)
        assertEquals(20.0, replayTime(4500, 1.0 / 30, true, 3600, 0) - start)
        assertEquals(20.0, replayTime(4500, 1.0 / 30, false, 3600, 900) - start)
        assertEquals(21.0, replayTime(4530, 1.0 / 30, false, 3600, 900) - start)
        // A second pause must subtract the accumulated previous pause as well.
        assertEquals(30.0, replayTime(5100, 1.0 / 30, true, 4800, 900) - start)
        assertEquals(30.0, replayTime(5100, 1.0 / 30, false, 4800, 1200) - start)
    }
    @Test fun `clock uses replay interval rather than assuming 30 hertz`() {
        assertEquals(10.0, replayTime(640, 1.0 / 64, false, 0, 0))
        assertFailsWith<ReplayFailure> { replayTime(10, 0.0, false, 0, 0) }
        assertFailsWith<ReplayFailure> { replayTime(10, 1.0 / 30, false, 0, 20) }
    }
    @Test fun `illusion reincarnation and absent flags do not count as confirmed deaths`() {
        assertTrue(isCountedDeath(true, false, false))
        assertFalse(isCountedDeath(false, false, false))
        assertFalse(isCountedDeath(true, true, false))
        assertFalse(isCountedDeath(true, false, true))
        assertFalse(isCountedDeath(true, null, false))
        assertFalse(isCountedDeath(true, false, null))
    }
    @Test fun `rates preserve missing values measured zero and fractional duration`() {
        assertEquals(null, rate(null, 100.0))
        assertEquals(0, rate(0, 100.0))
        assertEquals(59, rate(100, 100.5))
    }
    @Test fun `postgame deaths are excluded while pregame deaths and end boundary are retained`() {
        val deaths = listOf(Death(100.1, "postgame"), Death(-15.0, "pregame"), Death(100.0, "boundary"), Death(-91.0, "outside"))
        assertEquals(listOf("pregame", "boundary"), matchDeaths(deaths, -90.0, 100.0).map { it.hero })
    }
}
