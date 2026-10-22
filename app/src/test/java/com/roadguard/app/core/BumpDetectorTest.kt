package com.roadguard.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.PI
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt

class BumpDetectorTest {

    private val g = 9.81

    /** Gravity direction ("up") in the phone's own axes. */
    private data class Up(val x: Double, val y: Double, val z: Double) {
        fun norm(): Up {
            val n = sqrt(x * x + y * y + z * z)
            return Up(x / n, y / n, z / n)
        }
    }

    private val flat = Up(0.0, 0.0, 1.0)
    private val upright = Up(0.0, 1.0, 0.0)
    private val sideways = Up(1.0, 0.0, 0.0)
    private val pocket = Up(0.4, 0.7, -0.59).norm()

    /** A pothole: a short damped knock, mostly gone after ~150 ms. */
    private fun knock(t: Double, amplitude: Double = 14.0): Double =
        if (t < 0 || t > 0.3) 0.0 else amplitude * sin(2 * PI * t / 0.12) * exp(-t / 0.08)

    /**
     * Simulates [seconds] of samples at 50 Hz. [vertical] gives extra acceleration along "up",
     * [lateral] extra acceleration along a phone axis at right angles to it, [up] can change
     * over time (the phone being turned).
     */
    private fun run(
        d: BumpDetector,
        seconds: Double,
        speed: (Double) -> Float = { 40f },
        up: (Double) -> Up = { flat },
        vertical: (Double) -> Double = { 0.0 },
        lateral: (Double) -> Double = { 0.0 },
        noise: Double = 0.3,
        seed: Long = 7,
    ): List<BumpDetector.Hit> {
        val rnd = Random(seed)
        val hits = mutableListOf<BumpDetector.Hit>()
        var ms = 0L
        while (ms <= (seconds * 1000).toLong()) {
            val t = ms / 1000.0
            val u = up(t)
            // A unit vector at right angles to u.
            val side = (if (kotlin.math.abs(u.x) < 0.9) Up(0.0, -u.z, u.y) else Up(-u.z, 0.0, u.x)).norm()
            val v = g + vertical(t)
            val s = lateral(t)
            val x = u.x * v + side.x * s + rnd.nextGaussian() * noise
            val y = u.y * v + side.y * s + rnd.nextGaussian() * noise
            val z = u.z * v + side.z * s + rnd.nextGaussian() * noise
            d.onSample(x.toFloat(), y.toFloat(), z.toFloat(), 10_000L + ms, speed(t))?.let { hits += it }
            ms += 20
        }
        return hits
    }

    @Test
    fun `pothole at speed is felt in every phone orientation`() {
        for ((name, u) in listOf("flat" to flat, "upright" to upright, "sideways" to sideways, "pocket" to pocket)) {
            val hits = run(BumpDetector(), 6.0, up = { u }, vertical = { knock(it - 3.0) })
            assertEquals("$name: one hit", 1, hits.size)
            val h = hits.first()
            assertTrue("$name: at the knock (${h.timestamp})", h.timestamp in 13_000L..13_100L)
            assertTrue("$name: magnitude ${h.magnitude}", h.magnitude > 7f && h.magnitude < 14f)
        }
    }

    @Test
    fun `slow driving is ignored`() {
        val hits = run(BumpDetector(), 6.0, speed = { 8f }, vertical = { knock(it - 3.0) })
        assertEquals(0, hits.size)
    }

    @Test
    fun `smooth driving gives no hits`() {
        assertEquals(0, run(BumpDetector(), 30.0, up = { pocket }).size)
    }

    @Test
    fun `picking the phone up is not a pothole`() {
        // Lifted and turned from flat to upright over half a second, while driving.
        val turn = { t: Double ->
            val f = ((t - 3.0) / 0.5).coerceIn(0.0, 1.0) * (PI / 2)
            Up(0.0, sin(f), kotlin.math.cos(f))
        }
        val lift = { t: Double -> if (t in 3.0..3.4) 7.0 * sin(PI * (t - 3.0) / 0.4) else 0.0 }
        val swing = { t: Double -> if (t in 3.0..3.5) 12.0 * sin(2 * PI * (t - 3.0) / 0.5) else 0.0 }
        val hits = run(BumpDetector(), 8.0, up = turn, vertical = lift, lateral = swing)
        assertEquals(0, hits.size)

        // A hard sideways shove with a smaller vertical part (phone grabbed from a holder).
        val shove = run(
            BumpDetector(), 6.0, up = { upright },
            vertical = { t -> if (t in 3.0..3.1) 7.0 else 0.0 },
            lateral = { t -> if (t in 3.0..3.15) 15.0 else 0.0 },
        )
        assertEquals(0, shove.size)
    }

    @Test
    fun `rear wheels within the cooldown count once, later potholes count again`() {
        val close = run(BumpDetector(), 7.0, vertical = { knock(it - 3.0) + knock(it - 3.8) })
        assertEquals(1, close.size)
        val apart = run(BumpDetector(), 7.0, vertical = { knock(it - 3.0) + knock(it - 5.0) })
        assertEquals(2, apart.size)
        assertTrue(apart[1].timestamp - apart[0].timestamp >= 1_500)
    }

    @Test
    fun `continuous rough road vibration is not reported`() {
        val rough = { t: Double ->
            if (t < 2.0) 0.0 else 7.0 * sin(2 * PI * 14 * t) + 3.0 * sin(2 * PI * 21 * t + 1.0)
        }
        val hits = run(BumpDetector(), 14.0, up = { upright }, vertical = rough, noise = 0.5)
        assertEquals(0, hits.size)
    }

    @Test
    fun `a pothole still stands out on a mildly rough road`() {
        val texture = { t: Double -> 1.2 * sin(2 * PI * 11 * t) + 0.8 * sin(2 * PI * 17 * t) }
        val hits = run(BumpDetector(), 8.0, up = { pocket }, vertical = { texture(it) + knock(it - 5.0) })
        assertEquals(1, hits.size)
    }

    @Test
    fun `sensitivity threshold applies`() {
        val d = BumpDetector()
        d.threshold = 12f
        assertEquals(0, run(d, 6.0, vertical = { knock(it - 3.0) }).size)
        val sensitive = BumpDetector()
        sensitive.threshold = 4.5f
        assertEquals(1, run(sensitive, 6.0, vertical = { knock(it - 3.0, amplitude = 9.0) }).size)
    }
}
