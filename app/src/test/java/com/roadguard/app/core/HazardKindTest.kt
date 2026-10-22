package com.roadguard.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HazardKindTest {

    @Test
    fun `bundled model labels`() {
        assertEquals(HazardKind.DRAIN_HOLE, HazardKind.fromModelLabel("Drain Hole"))
        assertEquals(HazardKind.POTHOLE, HazardKind.fromModelLabel("Pothole"))
        assertEquals(HazardKind.SEWER_COVER, HazardKind.fromModelLabel("Sewer Cover"))
        assertEquals(HazardKind.SEWER_COVER, HazardKind.fromModelLabel("manhole"))
    }

    @Test
    fun `road damage dataset labels`() {
        assertEquals(HazardKind.POTHOLE, HazardKind.fromModelLabel("D40"))
        assertEquals(HazardKind.POTHOLE, HazardKind.fromModelLabel("pothole"))
        assertEquals(HazardKind.CRACK, HazardKind.fromModelLabel("Alligator Crack"))
        assertEquals(HazardKind.CRACK, HazardKind.fromModelLabel("D20"))
        assertEquals(HazardKind.OTHER, HazardKind.fromModelLabel("Longitudinal Crack"))
        assertEquals(HazardKind.OTHER, HazardKind.fromModelLabel("Transverse Crack"))
        assertEquals(HazardKind.OTHER, HazardKind.fromModelLabel("D00"))
        assertEquals(HazardKind.OTHER, HazardKind.fromModelLabel("D10"))
        assertEquals(HazardKind.OTHER, HazardKind.fromModelLabel("Class 7"))
    }

    @Test
    fun `what gets reported`() {
        assertTrue(HazardKind.POTHOLE.reportable)
        assertTrue(HazardKind.DRAIN_HOLE.reportable)
        assertTrue(HazardKind.CRACK.reportable)
        assertTrue(!HazardKind.SEWER_COVER.reportable)
        assertTrue(!HazardKind.BUMP.reportable)
        assertTrue(!HazardKind.OTHER.reportable)
    }

    @Test
    fun `api types round trip`() {
        for (k in HazardKind.entries) assertEquals(k, HazardKind.fromApiType(k.apiType))
        assertEquals("Cracked surface", HazardKind.fromApiType("crack").displayName)
        assertEquals("Rough patch", HazardKind.fromApiType("bump").displayName)
        assertEquals(HazardKind.OTHER, HazardKind.fromApiType(null))
    }
}
