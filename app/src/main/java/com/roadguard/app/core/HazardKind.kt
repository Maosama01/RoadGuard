package com.roadguard.app.core

/**
 * What the detector can see, and whether it is worth reporting.
 *
 * The bundled model knows three classes (read from the model file itself):
 * "Drain Hole", "Pothole" and "Sewer Cover". Closed sewer covers are normal road furniture,
 * so they are drawn on screen but never reported.
 *
 * Road damage models trained on RDD use "Longitudinal Crack" (D00), "Transverse Crack" (D10),
 * "Alligator Crack" (D20) and "Pothole" (D40). Alligator cracking turns into potholes, so it is
 * reported; thin straight cracks are everywhere and are only drawn.
 *
 * [BUMP] is never seen by the camera: it is a rough patch felt by pocket mode and created by
 * the server once several drivers feel it.
 */
enum class HazardKind(val apiType: String, val displayName: String, val reportable: Boolean) {
    POTHOLE("pothole", "Pothole", true),
    DRAIN_HOLE("drain_hole", "Open drain", true),
    SEWER_COVER("sewer_cover", "Sewer cover", false),
    CRACK("crack", "Cracked surface", true),
    BUMP("bump", "Rough patch", false),
    OTHER("other", "Road hazard", false);

    companion object {
        fun fromModelLabel(label: String): HazardKind {
            val l = label.trim().lowercase()
            val words = l.split(Regex("[^a-z0-9]+")).toSet()
            return when {
                "pothole" in l || "d40" in words -> POTHOLE
                "alligator" in l || "d20" in words -> CRACK
                "longitudinal" in l || "transverse" in l || "d00" in words || "d10" in words -> OTHER
                "drain" in l -> DRAIN_HOLE
                "sewer" in l || "manhole" in l -> SEWER_COVER
                else -> OTHER
            }
        }

        fun fromApiType(type: String?): HazardKind =
            entries.firstOrNull { it.apiType == type } ?: OTHER
    }
}
