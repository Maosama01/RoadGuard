package com.roadguard.app.core

import kotlin.math.max

/**
 * In-car warnings for hazards other drivers already reported, plus "clean pass" evidence.
 *
 * Alerts: a hazard is announced once when it is ahead of the car (within [Config.coneDegrees]
 * of the direction of travel) and closer than a look-ahead distance that grows with speed.
 *
 * Clean passes: if the car drives right over a known hazard and the accelerometer feels
 * nothing, that is weak evidence the hazard was fixed. Many such passes flag it for the city.
 *
 * Pure Kotlin: no Android types, fully unit-testable.
 */
class AlertEngine(private val config: Config = Config()) {

    data class Config(
        val minAlertDistanceMeters: Double = 120.0,
        /** Look this many seconds ahead at the current speed. */
        val lookAheadSeconds: Double = 9.0,
        val maxAlertDistanceMeters: Double = 400.0,
        val coneDegrees: Double = 35.0,
        val minSpeedKmh: Float = 8f,
        val realertAfterMs: Long = 5 * 60_000,
        /** Counts as "drove over it". */
        val passRadiusMeters: Double = 10.0,
        /** Must get this far away again to finish the pass. */
        val passExitMeters: Double = 30.0,
        val passShockWindowMs: Long = 2_500,
        /**
         * Below this speed a pothole can't be felt (the jolt detector ignores slow driving), so
         * crawling over one in traffic must not count as "drove over it, nothing there".
         */
        val minPassSpeedKmh: Float = 15f,
    )

    data class KnownHazard(
        val id: Long,
        val kind: HazardKind,
        val latitude: Double,
        val longitude: Double,
        val severityLevel: String,
        val reportCount: Int,
        /** For the spoken and on-screen warning ("on Rajpur Road"). */
        val roadName: String? = null,
    )

    data class Alert(val hazard: KnownHazard, val distanceMeters: Double)

    private var hazards: List<KnownHazard> = emptyList()
    private val alertedAt = HashMap<Long, Long>()
    private val approaching = HashMap<Long, Long>() // hazard id -> time of closest approach
    private val tooSlow = HashSet<Long>() // hazards crossed below minPassSpeedKmh on this approach
    private var lastShockAt = Long.MIN_VALUE / 2

    fun setHazards(list: List<KnownHazard>) {
        hazards = list
        val ids = list.map { it.id }.toSet()
        approaching.keys.retainAll(ids)
        tooSlow.retainAll(ids)
    }

    val hazardCount: Int get() = hazards.size

    fun onShock(now: Long) {
        lastShockAt = now
    }

    fun alertDistanceFor(speedKmh: Float): Double {
        val ahead = (speedKmh / 3.6) * config.lookAheadSeconds
        return max(config.minAlertDistanceMeters, ahead).coerceAtMost(config.maxAlertDistanceMeters)
    }

    /** Returns the nearest new hazard ahead, or null. */
    fun checkAlert(lat: Double, lng: Double, speedKmh: Float, bearing: Float?, now: Long): Alert? {
        if (bearing == null || speedKmh < config.minSpeedKmh) return null
        val range = alertDistanceFor(speedKmh)
        var best: Alert? = null
        for (h in hazards) {
            val last = alertedAt[h.id]
            if (last != null && now - last < config.realertAfterMs) continue
            val d = GeoUtils.distanceMeters(lat, lng, h.latitude, h.longitude)
            if (d > range || d < 5.0) continue
            val toHazard = GeoUtils.bearingDegrees(lat, lng, h.latitude, h.longitude)
            if (GeoUtils.angleDifference(toHazard, bearing.toDouble()) > config.coneDegrees) continue
            if (best == null || d < best.distanceMeters) best = Alert(h, d)
        }
        best?.let { alertedAt[it.hazard.id] = now }
        return best
    }

    /**
     * Returns ids of hazards the car just drove over without any jolt nearby in time.
     * Call on every location update.
     */
    fun checkCleanPasses(lat: Double, lng: Double, now: Long, speedKmh: Float = Float.MAX_VALUE): List<Long> {
        val passed = mutableListOf<Long>()
        for (h in hazards) {
            val d = GeoUtils.distanceMeters(lat, lng, h.latitude, h.longitude)
            if (d <= config.passRadiusMeters) {
                approaching[h.id] = now
                if (speedKmh < config.minPassSpeedKmh) tooSlow += h.id
            } else if (d >= config.passExitMeters) {
                val at = approaching.remove(h.id) ?: continue
                if (tooSlow.remove(h.id)) continue
                val joltNearby = lastShockAt >= at - config.passShockWindowMs &&
                    lastShockAt <= at + config.passShockWindowMs
                if (!joltNearby) passed += h.id
            }
        }
        return passed
    }
}
