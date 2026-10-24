package com.roadguard.app.sensor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import com.roadguard.app.core.BumpDetector

/**
 * Jolts for camera mode, felt the same way as pocket mode: [BumpDetector] on the raw
 * accelerometer. It looks at vertical movement only (braking and swerving are sideways), ignores
 * slow driving (speed breakers, parking), adapts to how rough the road usually is, and settles
 * for a second after starting, so there's no fake jolt the moment the screen opens.
 */
class AccelerometerManager(
    context: Context,
    private val onShockDetected: (ShockEvent) -> Unit,
) : SensorEventListener {

    private companion object {
        /** A GPS speed older than this is treated as "not moving" (lost fix, tunnel). */
        const val MAX_SPEED_AGE_MS = 3_000L
    }

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val detector = BumpDetector()

    @Volatile private var speedKmh = 0f
    @Volatile private var speedAt = 0L

    /** False on the rare phone without an accelerometer: then nothing can be "felt". */
    val available: Boolean get() = accelerometer != null

    fun setShockThreshold(threshold: Float) {
        detector.threshold = threshold
    }

    /** Latest GPS speed; jolts below the detector's minimum speed are ignored. */
    fun updateSpeed(kmh: Float) {
        speedKmh = kmh
        speedAt = SystemClock.elapsedRealtime()
    }

    fun start() {
        val sensor = accelerometer ?: return
        detector.reset()
        sensorManager?.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
    }

    fun stop() {
        sensorManager?.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent?) {
        event ?: return
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER || event.values.size < 3) return
        val speed = if (SystemClock.elapsedRealtime() - speedAt > MAX_SPEED_AGE_MS) 0f else speedKmh
        val sensorMs = event.timestamp / 1_000_000L
        val hit = detector.onSample(event.values[0], event.values[1], event.values[2], sensorMs, speed) ?: return
        // Sensor clock (time since boot) to wall clock, at the moment of the peak.
        val ageMs = ((SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000L).coerceIn(0L, 2_000L)
        val at = System.currentTimeMillis() - ageMs - (sensorMs - hit.timestamp)
        onShockDetected(ShockEvent(magnitude = hit.magnitude, timestamp = at))
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
