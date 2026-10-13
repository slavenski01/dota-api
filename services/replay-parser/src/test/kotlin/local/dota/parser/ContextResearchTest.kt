package local.dota.parser

import com.fasterxml.jackson.databind.node.ObjectNode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ContextResearchTest {
    @Test fun `visibility preserves absent words and handles unsigned bit boundaries`() {
        assertNull(visibilityBit(null, 63))
        assertEquals(false, visibilityBit(0L, 63))
        assertEquals(true, visibilityBit(Long.MIN_VALUE, 63))
        assertEquals(false, visibilityBit(Long.MIN_VALUE, 62))
        assertEquals(true, visibilityBit(1L, 64))
        assertEquals(false, visibilityBit(1L, 65))
        assertEquals(true, visibilityBit(Long.MIN_VALUE, 16383))
        assertNull(visibilityBit(-1L, -1))
        assertNull(visibilityBit(-1L, 16384))
    }

    private fun sample(): ObjectNode = ContractValidator.mapper.createObjectNode().apply {
        put("playerSlot", 128); put("gameTimeSeconds", 50.0)
        put("entityHandle", "999"); put("unitState64Raw", "123")
        putObject("visibilityEvidence").put("radiantCandidate", true)
        putObject("lastKnownPosition").put("observedAtSeconds", 100.0).put("x", 777)
        for (field in contextFields) putObject(field).put("privateValue", "opponent-secret")
    }

    @Test fun `hidden and unknown team views redact every current field and raw evidence`() {
        for (visible in listOf(false, null)) for (team in listOf("radiant", "dire")) {
            val view = teamProjection(sample(), team, visible)
            assertEquals(setOf("playerSlot", "gameTimeSeconds", "perspective", "visibility", "lastKnownPosition") + contextFields, view.fieldNames().asSequence().toSet())
            for (field in contextFields) {
                assertEquals("unknown", view[field]["status"].asText())
                assertTrue(view[field]["value"].isNull)
            }
            assertFalse(view.toString().contains("opponent-secret"))
            assertTrue(view["lastKnownPosition"].isNull)
            if (visible == null) assertEquals("unknown", view["visibility"]["status"].asText())
            else assertEquals("hidden", view["visibility"]["value"].asText())
        }
    }

    @Test fun `confirmed visibility only copies whitelisted fields without shared mutable nodes`() {
        val input = sample()
        val view = teamProjection(input, "radiant", true)
        assertEquals("visible", view["visibility"]["value"].asText())
        assertEquals(50.0, view["visibility"]["observedAtSeconds"].asDouble())
        assertNull(view["visibilityEvidence"])
        assertNull(view["unitState64Raw"])
        assertTrue(view["lastKnownPosition"].isNull)
        (input["hp"] as ObjectNode).put("privateValue", "later-state")
        assertEquals("opponent-secret", view["hp"]["privateValue"].asText())
    }

    @Test fun `usability never defaults to true or false when conditions are unverified`() {
        val observation = resourceUsability()
        assertEquals("unknown", observation["status"].asText())
        assertTrue(observation["value"].isNull)
    }

    @Test fun `coordinate candidate preserves missing values and rejects invalid network cells`() {
        assertEquals(-16384.0, coordinateCandidate(0, 0))
        assertEquals(0.0, coordinateCandidate(128, 0))
        assertEquals(129.5, coordinateCandidate(129, 1.5))
        assertNull(coordinateCandidate(null, 0))
        assertNull(coordinateCandidate(0, null))
        assertNull(coordinateCandidate(-1, 0))
        assertNull(coordinateCandidate(1.5, 0))
        assertNull(coordinateCandidate(0, Double.NaN))
        assertNull(coordinateCandidate(Double.MAX_VALUE, 0))
    }

    @Test fun `research windows must be finite ordered and bounded`() {
        ContextResearch(0.0, 120.0)
        for ((from, to) in listOf(-1.0 to 1.0, 0.0 to 0.0, 2.0 to 1.0, 0.0 to 120.001,
            Double.NaN to 10.0, 0.0 to Double.POSITIVE_INFINITY)) {
            assertFailsWith<IllegalArgumentException> { ContextResearch(from, to) }
        }
    }
}
