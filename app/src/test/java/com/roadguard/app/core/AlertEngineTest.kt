package com.roadguard.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertEngineTest {

    private val lat0 = 30.3165
    private val lng0 = 78.0322
    private fun north(m: Double) = lat0 + m / 111_320.0

    private fun hazard(id: Long, metersNorth: Double) =
        AlertEngine.KnownHazard(id, HazardKind.POTHOLE, north(metersNorth), lng0, "HIGH", 4)

    @Test
    fun `alerts once for a hazard ahead, never for one behind`() {
        val e = AlertEngine()
        e.setHazards(listOf(hazard(1, 100.0), hazard(2, -60.0)))
        val a = e.checkAlert(lat0, lng0, 40f, 0f, 0)
        assertNotNull(a)
        assertEquals(1L, a!!.hazard.id)
        assertEquals(100.0, a.distanceMeters, 1.0)
        assertNull("no repeat alert", e.checkAlert(lat0, lng0, 40f, 0f, 1_000))
    }

    @Test
    fun `heading away means no alert`() {
        val e = AlertEngine()
        e.setHazards(listOf(hazard(1, 100.0)))
        assertNull(e.checkAlert(lat0, lng0, 40f, 180f, 0))
    }

    @Test
    fun `faster driving looks further ahead`() {
        val e = AlertEngine()
        e.setHazards(listOf(hazard(1, 200.0)))
        assertNull(e.checkAlert(lat0, lng0, 30f, 0f, 0))
        assertNotNull(e.checkAlert(lat0, lng0, 90f, 0f, 0))
        assertTrue(e.alertDistanceFor(200f) <= 400.0)
    }

    @Test
    fun `parked or slow car gets no alerts`() {
        val e = AlertEngine()
        e.setHazards(listOf(hazard(1, 50.0)))
        assertNull(e.checkAlert(lat0, lng0, 3f, 0f, 0))
    }

    @Test
    fun `driving over a hazard without a jolt is a clean pass`() {
        val e = AlertEngine()
        e.setHazards(listOf(hazard(7, 0.0)))
        assertTrue(e.checkCleanPasses(north(-50.0), lng0, 0).isEmpty())
        assertTrue(e.checkCleanPasses(north(-2.0), lng0, 5_000).isEmpty())
        assertEquals(listOf(7L), e.checkCleanPasses(north(40.0), lng0, 9_000))
    }

    @Test
    fun `a jolt at the hazard means it is still there`() {
        val e = AlertEngine()
        e.setHazards(listOf(hazard(7, 0.0)))
        e.checkCleanPasses(north(-2.0), lng0, 5_000)
        e.onShock(5_600)
        assertTrue(e.checkCleanPasses(north(40.0), lng0, 9_000).isEmpty())
    }
}
