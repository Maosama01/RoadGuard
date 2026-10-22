package com.roadguard.app.core

import com.roadguard.app.utils.SeverityCalculator
import com.roadguard.app.utils.SeverityLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SeverityAndGeoTest {

    @Test
    fun `big pothole hit hard at speed is critical, small soft one is low`() {
        val bad = SeverityCalculator.calculateSeverity(0.92f, 0.07f, 16f, 60f)
        assertEquals(SeverityLevel.CRITICAL, bad.level)
        val mild = SeverityCalculator.calculateSeverity(0.6f, 0.005f, 0f, 15f)
        assertEquals(SeverityLevel.LOW, mild.level)
    }

    @Test
    fun `thresholds match the backend`() {
        assertEquals(SeverityLevel.CRITICAL, SeverityCalculator.levelFor(80f))
        assertEquals(SeverityLevel.HIGH, SeverityCalculator.levelFor(60f))
        assertEquals(SeverityLevel.MEDIUM, SeverityCalculator.levelFor(40f))
        assertEquals(SeverityLevel.LOW, SeverityCalculator.levelFor(39.9f))
    }

    @Test
    fun `model labels map to the right hazard kinds`() {
        assertEquals(HazardKind.DRAIN_HOLE, HazardKind.fromModelLabel("Drain Hole"))
        assertEquals(HazardKind.POTHOLE, HazardKind.fromModelLabel("Pothole"))
        assertEquals(HazardKind.SEWER_COVER, HazardKind.fromModelLabel("Sewer Cover"))
        assertTrue(!HazardKind.SEWER_COVER.reportable)
        assertEquals(HazardKind.CRACK, HazardKind.fromModelLabel("Alligator Crack"))
        assertEquals(HazardKind.OTHER, HazardKind.fromModelLabel("Longitudinal Crack"))
    }

    @Test
    fun `offset moves a point along a bearing`() {
        val (lat, lng) = GeoUtils.offset(30.0, 78.0, 90.0, 50.0)
        assertEquals(50.0, GeoUtils.distanceMeters(30.0, 78.0, lat, lng), 0.05)
        assertEquals(90.0, GeoUtils.bearingDegrees(30.0, 78.0, lat, lng), 0.1)
        val (lat2, lng2) = GeoUtils.offset(30.0, 78.0, 0.0, 111.2)
        assertEquals(30.001, lat2, 0.00001)
        assertEquals(78.0, lng2, 1e-9)
    }

    @Test
    fun `geo math`() {
        val d = GeoUtils.distanceMeters(30.0, 78.0, 30.001, 78.0)
        assertEquals(111.2, d, 0.5)
        assertEquals(0.0, GeoUtils.bearingDegrees(30.0, 78.0, 30.01, 78.0), 0.01)
        assertEquals(90.0, GeoUtils.bearingDegrees(30.0, 78.0, 30.0, 78.01), 0.1)
        assertEquals(20.0, GeoUtils.angleDifference(350.0, 10.0), 0.001)
    }
}
