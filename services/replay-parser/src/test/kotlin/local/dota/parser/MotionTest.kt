package local.dota.parser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class MotionTest {
    private val a = MotionPoint(10.0, 300, 0.0, 0.0, true, 1)
    @Test fun `ordinary movement differs from jumps life changes missing and stale positions`() {
        assertNull(motionBoundary(a, a.copy(time=10.03, tick=301, x=10.0)))
        assertEquals("jump", motionBoundary(a, a.copy(time=10.03, tick=301, x=60.0)))
        assertEquals("life", motionBoundary(a, a.copy(time=10.03, tick=301, alive=false)))
        assertEquals("life", motionBoundary(a, a.copy(time=10.03, tick=301, handle=2)))
        assertEquals("unknown", motionBoundary(a, a.copy(time=10.03, tick=301, x=null, y=null)))
        assertEquals("gap", motionBoundary(a, a.copy(time=11.0, tick=330)))
        assertEquals("gap", motionBoundary(a, a))
        assertEquals("start", motionBoundary(null, a))
    }
}
