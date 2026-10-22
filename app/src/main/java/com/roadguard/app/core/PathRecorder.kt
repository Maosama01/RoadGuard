package com.roadguard.app.core

import java.util.Locale

/**
 * The route of one drive, for coverage ("which roads were actually checked").
 *
 * Keeps one point every [spacingMeters] and never more than [maxPoints]: when full, every
 * other point is dropped and the spacing doubles, so a long drive keeps its whole route at a
 * coarser grain instead of losing its end. Distance counts only accurate, plausible steps.
 *
 * Pure Kotlin: no Android types, fully unit-testable.
 */
class PathRecorder(
    private val spacingMeters: Double = 40.0,
    private val maxPoints: Int = 2000,
    private val maxAccuracyMeters: Float = 30f,
    /** Faster than this between two fixes is a GPS jump, not driving (about 216 km/h). */
    private val maxPlausibleSpeedMs: Double = 60.0,
) {

    data class Point(val latitude: Double, val longitude: Double, val timestamp: Long)

    private val kept = ArrayList<Point>()
    private var spacing = spacingMeters
    private var last: Point? = null

    var distanceMeters = 0.0
        private set

    val pointCount: Int get() = kept.size

    /** Returns true when the fix became a path point. */
    fun onFix(latitude: Double, longitude: Double, accuracyMeters: Float, timestamp: Long): Boolean {
        if (accuracyMeters > maxAccuracyMeters) return false
        val fix = Point(latitude, longitude, timestamp)
        last?.let { prev ->
            val step = GeoUtils.distanceMeters(prev.latitude, prev.longitude, latitude, longitude)
            val seconds = (timestamp - prev.timestamp) / 1000.0
            if (seconds > 0 && step / seconds <= maxPlausibleSpeedMs) distanceMeters += step
        }
        last = fix

        val tail = kept.lastOrNull()
        if (tail != null && GeoUtils.distanceMeters(tail.latitude, tail.longitude, latitude, longitude) < spacing) {
            return false
        }
        kept += fix
        if (kept.size > maxPoints) thin()
        return true
    }

    /** The kept points plus the latest accurate fix, so the path ends where the drive ended. */
    fun points(): List<Point> {
        val end = last ?: return kept.toList()
        val out = ArrayList<Point>(kept.size + 1)
        out.addAll(kept)
        if (out.lastOrNull() != end) {
            if (out.size >= maxPoints) out[out.size - 1] = end else out += end
        }
        return out
    }

    private fun thin() {
        val newest = kept.last()
        val thinned = kept.filterIndexed { i, _ -> i % 2 == 0 }.toMutableList()
        if (thinned.last() != newest) thinned += newest
        kept.clear()
        kept.addAll(thinned)
        spacing *= 2
    }

    companion object {
        /** `[[lat, lng, timestamp], ...]` as the server expects. */
        fun toJson(points: List<Point>): String = points.joinToString(",", "[", "]") {
            String.format(Locale.ROOT, "[%.6f,%.6f,%d]", it.latitude, it.longitude, it.timestamp)
        }
    }
}
