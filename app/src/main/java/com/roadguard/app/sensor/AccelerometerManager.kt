package com.roadguard.app.sensor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.math.sqrt

class AccelerometerManager(
    context: Context,
    private val onShockDetected: (ShockEvent) -> Unit
) : SensorEventListener {

    companion object {

        // Configurable values
        const val DEFAULT_SHOCK_THRESHOLD = 6.0f

        const val DEFAULT_COOLDOWN_MS = 1500L

        const val GYRO_REJECTION_THRESHOLD = 8.0f

        // Gravity filter
        private const val ALPHA = 0.8f
    }

    private val sensorManager =
        context.getSystemService(
            Context.SENSOR_SERVICE
        ) as SensorManager

    // Preferred sensor
    private val linearAccelerometer =
        sensorManager.getDefaultSensor(
            Sensor.TYPE_LINEAR_ACCELERATION
        )

    // Fallback sensor
    private val rawAccelerometer =
        sensorManager.getDefaultSensor(
            Sensor.TYPE_ACCELEROMETER
        )

    // Gyroscope
    private val gyroscope =
        sensorManager.getDefaultSensor(
            Sensor.TYPE_GYROSCOPE
        )

    private var lastShockTime = 0L

    private var currentGyroMagnitude = 0f

    private var shockThreshold =
        DEFAULT_SHOCK_THRESHOLD

    // Gravity values used for fallback filtering
    private val gravity = FloatArray(3)

    fun setShockThreshold(
        threshold: Float
    ) {
        shockThreshold = threshold
    }

    fun start() {

        if (linearAccelerometer != null) {

            sensorManager.registerListener(
                this,
                linearAccelerometer,
                SensorManager.SENSOR_DELAY_GAME
            )

        } else if (rawAccelerometer != null) {

            sensorManager.registerListener(
                this,
                rawAccelerometer,
                SensorManager.SENSOR_DELAY_GAME
            )
        }

        // Register gyroscope if available
        gyroscope?.let {

            sensorManager.registerListener(
                this,
                it,
                SensorManager.SENSOR_DELAY_GAME
            )
        }
    }

    fun stop() {

        sensorManager.unregisterListener(
            this
        )
    }

    override fun onSensorChanged(
        event: SensorEvent?
    ) {

        event ?: return

        when (event.sensor.type) {

            Sensor.TYPE_LINEAR_ACCELERATION -> {

                processAcceleration(
                    event.values[0],
                    event.values[1],
                    event.values[2]
                )
            }

            Sensor.TYPE_ACCELEROMETER -> {

                processRawAccelerometer(
                    event
                )
            }

            Sensor.TYPE_GYROSCOPE -> {

                processGyroscope(
                    event
                )
            }
        }
    }

    private fun processAcceleration(
        x: Float,
        y: Float,
        z: Float
    ) {

        val magnitude = sqrt(
            x * x +
                    y * y +
                    z * z
        )

        checkForShock(
            magnitude
        )
    }

    private fun processRawAccelerometer(
        event: SensorEvent
    ) {

        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]

        gravity[0] =
            ALPHA * gravity[0] +
                    (1 - ALPHA) * x

        gravity[1] =
            ALPHA * gravity[1] +
                    (1 - ALPHA) * y

        gravity[2] =
            ALPHA * gravity[2] +
                    (1 - ALPHA) * z

        val linearX =
            x - gravity[0]

        val linearY =
            y - gravity[1]

        val linearZ =
            z - gravity[2]

        val magnitude = sqrt(
            linearX * linearX +
                    linearY * linearY +
                    linearZ * linearZ
        )

        checkForShock(
            magnitude
        )
    }

    private fun checkForShock(
        magnitude: Float
    ) {

        val now =
            System.currentTimeMillis()

        if (
            magnitude <
            shockThreshold
        ) {
            return
        }

        if (
            currentGyroMagnitude >
            GYRO_REJECTION_THRESHOLD
        ) {
            return
        }

        if (
            now - lastShockTime <
            DEFAULT_COOLDOWN_MS
        ) {
            return
        }

        lastShockTime = now

        onShockDetected(
            ShockEvent(
                magnitude = magnitude,
                timestamp = now
            )
        )
    }

    private fun processGyroscope(
        event: SensorEvent
    ) {

        val x = event.values[0]
        val y = event.values[1]
        val z = event.values[2]

        currentGyroMagnitude = sqrt(
            x * x +
                    y * y +
                    z * z
        )
    }

    override fun onAccuracyChanged(
        sensor: Sensor?,
        accuracy: Int
    ) {
        // Not required
    }
}