package local.dota.parser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class WorldPositionTest {
    @Test fun `independent fountain and ancient landmarks confirm origin and axes`() {
        // Published gem-dota landmarks minus 16384; cells read independently from R1.
        val points = listOf(
            listOf(68, 224, 72, 230, -7456, -6938),
            listOf(184, 240, 180, 192, 7408, 6848),
            listOf(80, 224, 86, 24, -5920, -5352),
            listOf(170, 152, 166, 136, 5528, 5000))
        for (point in points) {
            val (cx, x, cy, y) = point
            val value = worldPosition(0xFFFFFF, cx, x, cy, y, 130, 0)!!
            assertEquals(point[4].toDouble(), value["x"])
            assertEquals(point[5].toDouble(), value["y"])
            assertEquals(256.0, value["z"])
            assertNull(value["mapVersion"])
        }
    }
    @Test fun `missing origin invalid cells and parent transforms remain unknown`() {
        for (parent in listOf(null, 42, -1)) assertNull(worldPosition(parent, 128, 0, 128, 0, 128, 0))
        assertNull(worldPosition(0xFFFFFF, null, 0, 128, 0, 128, 0))
        assertNull(worldPosition(0xFFFFFF, 128, 0, 128, Double.NaN, 128, 0))
        assertNull(worldPosition(0xFFFFFF, 128.5, 0, 128, 0, 128, 0))
        val zero = worldPosition(0xFFFFFF, 128, 0, 128, 0, null, null)!!
        assertEquals(0.0, zero["x"]); assertEquals(0.0, zero["y"]); assertNull(zero["z"])
    }
}
