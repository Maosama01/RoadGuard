package com.roadguard.app.core

/**
 * Decides when what the camera sees becomes a report.
 *
 * Why this exists: the camera sees a pothole one to three seconds BEFORE the car reaches it,
 * and the accelerometer feels the jolt AFTER. So a detection is held as a candidate until
 * either a jolt arrives (confirmed with shock) or the car has clearly passed it (visual-only,
 * which also covers drivers who steer around the pothole).
 *
 * A candidate qualifies when it was seen in at least [minHits] frames or once with very high
 * confidence; this removes most single-frame false positives.
 *
 * Pure Kotlin: no Android types, fully unit-testable.
 */
class DetectionFusion(private val config: Config = Config()) {

    data class Config(
        val minHits: Int = 2,
        val singleHitConfidence: Float = 0.75f,
        /** Frames further apart than this belong to different candidates. */
        val mergeWindowMs: Long = 1_500,
        /** After the last sighting, how long to wait for the jolt. */
        val shockWaitMs: Long = 2_500,
        /**
         * A jolt this long before the first sighting still counts (the camera saw it late).
         * Kept short: the camera normally sees a hazard before the wheels reach it, so an
         * earlier jolt almost always belongs to a different bump.
         */
        val shockLookbackMs: Long = 300,
        /** Report without a jolt only when the model is this sure. */
        val visualOnlyMinConfidence: Float = 0.70f,
        val requireShock: Boolean = false,
        val maxGpsAccuracyMeters: Float = 25f,
        /** Don't report the same type again this close... */
        val dedupeRadiusMeters: Double = 15.0,
        /** ...within this time. */
        val dedupeWindowMs: Long = 60_000,
    )

    data class Fix(
        val latitude: Double,
        val longitude: Double,
        val accuracyMeters: Float,
        val speedKmh: Float,
        val bearing: Float?,
        val timestamp: Long,
    )

    data class Confirmed(
        val kind: HazardKind,
        val confidence: Float,
        val boxArea: Float,
        val shock: Float,
        val fix: Fix,
        val hits: Int,
        val detectedAt: Long,
        /** Matches [currentCandidateId] at the time the frame was kept, to pair the photo. */
        val candidateId: Long,
    )

    enum class Outcome { NONE, REPORTED, DROPPED_WEAK, DROPPED_NO_GPS, DROPPED_DUPLICATE }

    private class Candidate(
        val id: Long,
        var kind: HazardKind,
        var bestConfidence: Float,
        var bestArea: Float,
        var bestFix: Fix?,
        val firstSeen: Long,
        var lastSeen: Long,
        var bestAt: Long,
        var hits: Int,
    )

    private data class Shock(val magnitude: Float, val at: Long)

    private var candidate: Candidate? = null
    private var nextId = 1L
    /** A report flushed while a new candidate started; handed out by the next [poll]. */
    private var ready: Confirmed? = null
    private val shocks = ArrayDeque<Shock>()
    private val recent = ArrayDeque<Confirmed>()

    var lastOutcome: Outcome = Outcome.NONE
        private set

    val hasCandidate: Boolean get() = candidate != null

    /** Id of the candidate currently being tracked, or null. */
    val currentCandidateId: Long? @Synchronized get() = candidate?.id

    /**
     * Feed one detection from one frame. Returns true when this frame is now the candidate's
     * best view, so the caller should keep this frame's image for the report photo.
     */
    @Synchronized
    fun onDetection(kind: HazardKind, confidence: Float, boxArea: Float, now: Long, fix: Fix?): Boolean {
        if (!kind.reportable) return false
        val c = candidate
        if (c != null && now - c.lastSeen <= config.mergeWindowMs) {
            c.hits += 1
            c.lastSeen = now
            if (confidence > c.bestConfidence) {
                c.kind = kind
                c.bestConfidence = confidence
                c.bestArea = boxArea
                c.bestAt = now
                if (fix != null) c.bestFix = fix
                return true
            }
            if (c.bestFix == null && fix != null) c.bestFix = fix
            return false
        }
        // Either nothing pending, or the old candidate went stale: resolve it first.
        if (c != null) {
            val flushed = resolve(now, force = true)
            if (flushed != null) ready = flushed
        }
        candidate = Candidate(nextId++, kind, confidence, boxArea, fix, now, now, now, 1)
        return true
    }

    @Synchronized
    fun onShock(magnitude: Float, now: Long) {
        shocks.addLast(Shock(magnitude, now))
        while (shocks.isNotEmpty() && now - shocks.first().at > 10_000) shocks.removeFirst()
    }

    /** Call regularly (every frame is fine). Returns a report when one is ready. */
    @Synchronized
    fun poll(now: Long): Confirmed? {
        ready?.let {
            ready = null
            return it
        }
        return resolve(now, force = false)
    }

    private fun resolve(now: Long, force: Boolean): Confirmed? {
        val c = candidate ?: return null
        val qualified = c.hits >= config.minHits || c.bestConfidence >= config.singleHitConfidence
        val shock = shocks
            .filter { it.at >= c.firstSeen - config.shockLookbackMs && it.at <= now }
            .maxOfOrNull { it.magnitude } ?: 0f
        val waitedEnough = now - c.lastSeen >= config.shockWaitMs

        if (!qualified) {
            if (force || now - c.lastSeen > config.mergeWindowMs) finish(Outcome.DROPPED_WEAK, now)
            return null
        }
        if (shock > 0f) return emit(c, shock, now)
        if (!waitedEnough && !force) return null

        // Passed it without feeling anything.
        val visualOk = !config.requireShock && c.bestConfidence >= config.visualOnlyMinConfidence
        if (!visualOk) {
            finish(Outcome.DROPPED_WEAK, now)
            return null
        }
        return emit(c, 0f, now)
    }

    private fun emit(c: Candidate, shock: Float, now: Long): Confirmed? {
        val fix = c.bestFix
        if (fix == null || fix.accuracyMeters > config.maxGpsAccuracyMeters) {
            finish(Outcome.DROPPED_NO_GPS, now)
            return null
        }
        while (recent.isNotEmpty() && c.bestAt - recent.first().detectedAt > config.dedupeWindowMs) recent.removeFirst()
        val duplicate = recent.any {
            it.kind == c.kind && GeoUtils.distanceMeters(
                it.fix.latitude, it.fix.longitude, fix.latitude, fix.longitude
            ) < config.dedupeRadiusMeters
        }
        if (duplicate) {
            finish(Outcome.DROPPED_DUPLICATE, now)
            return null
        }
        val confirmed = Confirmed(c.kind, c.bestConfidence, c.bestArea, shock, fix, c.hits, c.bestAt, c.id)
        recent.addLast(confirmed)
        finish(Outcome.REPORTED, now)
        return confirmed
    }

    /** Ends the candidate. Jolts up to now are used up, whatever the outcome, so they can't confirm a later hazard. */
    private fun finish(outcome: Outcome, now: Long) {
        candidate = null
        lastOutcome = outcome
        while (shocks.isNotEmpty() && shocks.first().at <= now) shocks.removeFirst()
    }
}
