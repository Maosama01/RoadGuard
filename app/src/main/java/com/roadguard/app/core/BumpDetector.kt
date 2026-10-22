package com.roadguard.app.core

import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Feels potholes with the accelerometer alone, wherever the phone is: flat on a seat, upright
 * in a holder or sideways in a pocket.
 *
 * How it works:
 * 1. A slow low-pass filter tracks gravity. Its direction is "up" in the phone's own axes, so
 *    projecting the rest of the signal onto it gives the vertical jolt whatever the orientation.
 * 2. A jolt is a short burst (under [Config.maxImpulseMs]) of vertical acceleration above the
 *    threshold. Bursts end after [Config.quietGapMs] of calm.
 * 3. It is ignored when the car is slow (speed breakers, parking), when most of the energy is
 *    sideways (the phone is being picked up or handled), when it doesn't stand out from the
 *    road's usual roughness (rolling RMS baseline), or within the cooldown after the last jolt
 *    (the rear wheels hitting the same pothole).
 *
 * Pure Kotlin: no Android types, fully unit-testable. Not thread-safe; feed it from one thread.
 */
class BumpDetector(private val config: Config = Config()) {

    data class Config(
        /** Vertical acceleration (m/s², gravity removed) that counts as a jolt. */
        val threshold: Float = 6f,
        /** Longer than this is vibration or handling, not a pothole. */
        val maxImpulseMs: Long = 400,
        val minSpeedKmh: Float = 15f,
        val cooldownMs: Long = 1_500,
        /** Gravity filter time constant. Slow enough that a jolt barely moves it. */
        val gravityTimeConstantMs: Float = 1_000f,
        /** How quickly the "usual roughness" baseline follows the road. */
        val baselineTimeConstantMs: Float = 3_000f,
        /** The peak must be this many times the baseline RMS. */
        val peakOverBaseline: Float = 3f,
        val minBaselineRms: Float = 0.3f,
        /** Sideways share of the burst's energy above which it's the phone moving, not the car. */
        val maxLateralShare: Float = 0.5f,
        /** A burst ends after this long below the threshold. */
        val quietGapMs: Long = 100,
        /** Time for the gravity estimate to settle after (re)starting. */
        val warmupMs: Long = 1_000,
        /** A longer pause between samples (sensor stopped) restarts the filters. */
        val maxSampleGapMs: Long = 1_000,
    )

    data class Hit(val magnitude: Float, val timestamp: Long)

    /** Can be changed while running (Settings, bump sensitivity). */
    var threshold: Float = config.threshold
        set(value) {
            field = value.coerceAtLeast(1f)
        }

    private var gx = 0.0
    private var gy = 0.0
    private var gz = 0.0
    private var started = false
    private var startedAt = 0L
    private var lastAt = 0L
    private var baselineSq = 0.0
    private var lastHitAt = Long.MIN_VALUE / 2

    private var inBurst = false
    private var burstStart = 0L
    private var burstLastAbove = 0L
    private var burstPeak = 0.0
    private var burstPeakAt = 0L
    private var burstSpeed = 0f
    private var burstBaselineRms = 0.0
    private var burstVerticalEnergy = 0.0
    private var burstLateralEnergy = 0.0

    fun reset() {
        started = false
        inBurst = false
    }

    /**
     * One accelerometer sample: [x], [y], [z] in m/s² including gravity, [timestampMs] from a
     * monotonic clock, [speedKmh] the latest GPS speed. Returns a hit when a jolt just ended.
     */
    fun onSample(x: Float, y: Float, z: Float, timestampMs: Long, speedKmh: Float): Hit? {
        if (!started || timestampMs < lastAt || timestampMs - lastAt > config.maxSampleGapMs) {
            gx = x.toDouble()
            gy = y.toDouble()
            gz = z.toDouble()
            started = true
            startedAt = timestampMs
            lastAt = timestampMs
            baselineSq = (config.minBaselineRms * config.minBaselineRms).toDouble()
            inBurst = false
            return null
        }
        val dt = (timestampMs - lastAt).coerceAtLeast(1L).toDouble()
        lastAt = timestampMs

        // Split against the gravity estimate from before this sample.
        val gNorm = sqrt(gx * gx + gy * gy + gz * gz)
        val lx = x - gx
        val ly = y - gy
        val lz = z - gz
        val vertical = if (gNorm > 1e-3) (lx * gx + ly * gy + lz * gz) / gNorm else 0.0
        val lateralSq = (lx * lx + ly * ly + lz * lz - vertical * vertical).coerceAtLeast(0.0)

        val a = dt / (config.gravityTimeConstantMs + dt)
        gx += a * (x - gx)
        gy += a * (y - gy)
        gz += a * (z - gz)

        val baselineRms = sqrt(baselineSq).coerceAtLeast(config.minBaselineRms.toDouble())
        val b = dt / (config.baselineTimeConstantMs + dt)
        baselineSq += b * (vertical * vertical - baselineSq)

        if (timestampMs - startedAt < config.warmupMs) return null

        val strength = abs(vertical)
        if (strength >= threshold) {
            if (!inBurst) {
                inBurst = true
                burstStart = timestampMs
                burstPeak = 0.0
                burstVerticalEnergy = 0.0
                burstLateralEnergy = 0.0
                burstBaselineRms = baselineRms
                burstSpeed = speedKmh
            }
            burstLastAbove = timestampMs
            if (strength > burstPeak) {
                burstPeak = strength
                burstPeakAt = timestampMs
                burstSpeed = speedKmh
            }
        }
        if (!inBurst) return null

        burstVerticalEnergy += vertical * vertical * dt
        burstLateralEnergy += lateralSq * dt
        return if (timestampMs - burstLastAbove >= config.quietGapMs) finishBurst() else null
    }

    private fun finishBurst(): Hit? {
        inBurst = false
        if (burstLastAbove - burstStart > config.maxImpulseMs) return null
        if (burstSpeed < config.minSpeedKmh) return null
        if (burstPeakAt - lastHitAt < config.cooldownMs) return null
        if (burstPeak < config.peakOverBaseline * burstBaselineRms) return null
        val total = burstVerticalEnergy + burstLateralEnergy
        if (total > 0 && burstLateralEnergy / total > config.maxLateralShare) return null
        lastHitAt = burstPeakAt
        return Hit(burstPeak.toFloat(), burstPeakAt)
    }
}
