package com.roadguard.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PathRecorderTest {

    private val lat0 = 30.3165
    private val lng0 = 78.0322
    private fun north(m: Double) = lat0 + m / 111_195.0

    @Test
    fun `keeps one point every 40 m and measures the distance`() {
        val r = PathRecorder()
        // 5 km north at 11 m/s, one fix a second.
        var t = 0L
        var m = 0.0
        while (m <= 5_000.0) {
            r.onFix(north(m), lng0, 5f, t)
            m += 11.0
            t += 1_000
        }
        assertEquals(4_994.0, r.distanceMeters, 15.0)
        val pts = r.points()
        assertTrue("about 5000/44 points, got ${pts.size}", pts.size in 100..130)
        for (i in 1 until pts.size - 1) {
            val d = GeoUtils.distanceMeters(pts[i - 1].latitude, pts[i - 1].longitude, pts[i].latitude, pts[i].longitude)
            assertTrue("spacing $d", d >= 40.0)
        }
        assertEquals(north(4_994.0), pts.last().latitude, 1e-6)
    }

    @Test
    fun `inaccurate fixes and GPS jumps are ignored`() {
        val r = PathRecorder()
        r.onFix(lat0, lng0, 5f, 0)
        r.onFix(north(3_000.0), lng0, 80f, 1_000) // poor accuracy
        r.onFix(north(10.0), lng0, 5f, 2_000)
        r.onFix(north(2_010.0), lng0, 5f, 3_000) // 2 km in one second
        r.onFix(north(2_020.0), lng0, 5f, 4_000)
        assertEquals(20.0, r.distanceMeters, 1.0)
    }

    @Test
    fun `a very long drive is thinned, never truncated`() {
        val r = PathRecorder(maxPoints = 2000)
        var t = 0L
        var m = 0.0
        while (m <= 200_000.0) {
            r.onFix(north(m), lng0, 5f, t)
            m += 20.0
            t += 1_000
        }
        val pts = r.points()
        assertTrue("at most 2000 points, got ${pts.size}", pts.size <= 2000)
        assertTrue("still detailed, got ${pts.size}", pts.size > 900)
        assertEquals(lat0, pts.first().latitude, 1e-9)
        assertEquals(north(200_000.0), pts.last().latitude, 1e-6)
    }

    @Test
    fun `json is what the server expects`() {
        val json = PathRecorder.toJson(listOf(PathRecorder.Point(30.31, 78.03, 1792482000000)))
        assertEquals("[[30.310000,78.030000,1792482000000]]", json)
        assertEquals("[]", PathRecorder.toJson(emptyList()))
    }
}
