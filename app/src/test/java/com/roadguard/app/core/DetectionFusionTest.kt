package com.roadguard.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DetectionFusionTest {

    private val fix = DetectionFusion.Fix(30.3165, 78.0322, 6f, 36f, 90f, 0L)
    private fun fixAt(metersNorth: Double, at: Long = 0L) =
        fix.copy(latitude = fix.latitude + metersNorth / 111_320.0, timestamp = at)

    @Test
    fun `jolt after the camera saw it confirms with shock`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.62f, 0.02f, 1_000, fix)
        f.onDetection(HazardKind.POTHOLE, 0.66f, 0.03f, 1_200, fix)
        assertNull("still waiting for the car to reach it", f.poll(1_300))
        f.onShock(9.5f, 2_400) // car hits it ~1.2 s later
        val c = f.poll(2_450)
        assertNotNull(c)
        assertEquals(9.5f, c!!.shock, 0.001f)
        assertEquals(2, c.hits)
        assertEquals(0.66f, c.confidence, 0.001f)
    }

    @Test
    fun `driver steers around a clear pothole and it is still reported`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.81f, 0.04f, 1_000, fix)
        assertNull(f.poll(2_000))
        val c = f.poll(1_000 + 2_600)
        assertNotNull(c)
        assertEquals(0f, c!!.shock, 0.0f)
    }

    @Test
    fun `single weak frame is ignored`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.58f, 0.02f, 1_000, fix)
        assertNull(f.poll(5_000))
        assertEquals(DetectionFusion.Outcome.DROPPED_WEAK, f.lastOutcome)
    }

    @Test
    fun `require shock setting drops visual-only`() {
        val f = DetectionFusion(DetectionFusion.Config(requireShock = true))
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 1_000, fix)
        assertNull(f.poll(10_000))
        assertEquals(DetectionFusion.Outcome.DROPPED_WEAK, f.lastOutcome)
    }

    @Test
    fun `sewer covers are never reported`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.SEWER_COVER, 0.95f, 0.05f, 1_000, fix)
        f.onShock(12f, 1_500)
        assertNull(f.poll(5_000))
        assertTrue(!f.hasCandidate)
    }

    @Test
    fun `poor gps blocks the report`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 1_000, fix.copy(accuracyMeters = 60f))
        f.onShock(10f, 1_800)
        assertNull(f.poll(1_900))
        assertEquals(DetectionFusion.Outcome.DROPPED_NO_GPS, f.lastOutcome)
    }

    @Test
    fun `same pothole twice in a minute is reported once, a different one is not blocked`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 1_000, fix)
        assertNotNull(f.poll(4_000))
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 10_000, fixAt(5.0, at = 9_000))
        assertNull(f.poll(13_000))
        assertEquals(DetectionFusion.Outcome.DROPPED_DUPLICATE, f.lastOutcome)
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 20_000, fixAt(80.0, at = 19_000))
        assertNotNull(f.poll(23_000))
    }

    @Test
    fun `a jolt confirms only one hazard`() {
        val f = DetectionFusion(DetectionFusion.Config(requireShock = true))
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 1_000, fix)
        f.onShock(10f, 1_500)
        assertNotNull(f.poll(1_600))
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 1_700, fixAt(40.0))
        assertNull(f.poll(1_800))
    }

    @Test
    fun `a new pothole while the old one waits for its jolt keeps both, each with its own id`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.85f, 0.04f, 1_000, fix)
        val firstId = f.currentCandidateId
        // 1.8 s later: beyond the merge window but still inside the jolt wait.
        f.onDetection(HazardKind.POTHOLE, 0.82f, 0.04f, 2_800, fixAt(30.0))
        val secondId = f.currentCandidateId
        assertTrue(firstId != secondId)
        val first = f.poll(2_850)
        assertNotNull("old candidate flushed, not lost", first)
        assertEquals(firstId, first!!.candidateId)
        val second = f.poll(2_800 + 2_600)
        assertNotNull(second)
        assertEquals(secondId, second!!.candidateId)
    }

    @Test
    fun `best frame wins the photo`() {
        val f = DetectionFusion()
        assertTrue(f.onDetection(HazardKind.POTHOLE, 0.6f, 0.02f, 1_000, fix))
        assertTrue(f.onDetection(HazardKind.POTHOLE, 0.8f, 0.03f, 1_200, fix))
        assertTrue(!f.onDetection(HazardKind.POTHOLE, 0.7f, 0.03f, 1_400, fix))
    }

    @Test
    fun `nothing is reported while the car is standing still`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.95f, 0.05f, 1_000, fix.copy(speedKmh = 0f))
        f.onShock(9f, 1_400)
        assertNull(f.poll(1_500))
        assertEquals(DetectionFusion.Outcome.DROPPED_NOT_MOVING, f.lastOutcome)
    }

    @Test
    fun `an old gps fix cannot place a report`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.95f, 0.05f, 30_000, fix) // fix from 30 s earlier
        assertNull(f.poll(30_000 + 2_600))
        assertEquals(DetectionFusion.Outcome.DROPPED_NO_GPS, f.lastOutcome)
    }

    @Test
    fun `a jolt-confirmed report sits where the wheels hit it, not where the camera saw it`() {
        // 36 km/h = 10 m/s heading east; the jolt comes 1.5 s after the fix.
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 200, fix)
        f.onShock(9f, 1_500)
        val c = f.poll(1_600)!!
        val moved = GeoUtils.distanceMeters(fix.latitude, fix.longitude, c.fix.latitude, c.fix.longitude)
        assertEquals(15.0, moved, 1.0)
        assertTrue("moved east", c.fix.longitude > fix.longitude)
    }

    @Test
    fun `a visual-only report is moved ahead by the camera lead, and never too far`() {
        val f = DetectionFusion()
        f.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 500, fix)
        val c = f.poll(500 + 2_600)!!
        val moved = GeoUtils.distanceMeters(fix.latitude, fix.longitude, c.fix.latitude, c.fix.longitude)
        assertEquals(20.0, moved, 1.0) // (0.5 s + 1.5 s lead) x 10 m/s
        val fast = DetectionFusion()
        fast.onDetection(HazardKind.POTHOLE, 0.9f, 0.04f, 3_000, fix.copy(speedKmh = 120f))
        val far = fast.poll(3_000 + 2_600)!!
        assertTrue(GeoUtils.distanceMeters(fix.latitude, fix.longitude, far.fix.latitude, far.fix.longitude) <= 40.5)
    }

    @Test
    fun `the app's own calibrated settings still ignore a single weak frame`() {
        val f = DetectionFusion(DetectionFusion.Config.forModel(singleHitConfidence = 0.55f, reportConfidence = 0.4f, requireShock = false))
        f.onDetection(HazardKind.POTHOLE, 0.45f, 0.02f, 1_000, fix)
        assertNull(f.poll(1_000 + 6_000))
        assertEquals(DetectionFusion.Outcome.DROPPED_WEAK, f.lastOutcome)
    }
}
