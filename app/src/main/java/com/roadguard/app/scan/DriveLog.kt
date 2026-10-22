package com.roadguard.app.scan

import android.content.Context
import android.util.Log
import com.roadguard.app.RoadGuardApp
import com.roadguard.app.core.PathRecorder
import com.roadguard.app.data.SensorQueue
import com.roadguard.app.database.PendingDrive
import com.roadguard.app.database.RoadGuardDatabase
import com.roadguard.app.location.LocationData
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Records one drive's route and saves it for upload to /api/drives, so the city can tell
 * "no potholes here" from "nobody checked here".
 *
 * Saved to Room every minute while driving (state "recording") and once more at the end
 * (state "pending"), after which WorkManager sends it. Saves run one after another, so a late
 * checkpoint can never overwrite the final save.
 *
 * Call everything on the main thread.
 */
class DriveLog(context: Context, private val mode: String) {

    companion object {
        const val MODE_CAMERA = "camera"
        const val MODE_POCKET = "pocket"
        private const val TAG = "RoadGuardDrive"
        private const val CHECKPOINT_MS = 60_000L
        /** Shorter drives (a test in the car park) aren't worth sending. */
        private const val MIN_DISTANCE_M = 100.0
    }

    private val app = context.applicationContext
    private val recorder = PathRecorder()
    private val clientId = UUID.randomUUID().toString()
    private val startedAt = System.currentTimeMillis()
    private var lastCheckpointAt = startedAt
    private var lastSave: Job? = null
    private var finished = false

    val distanceMeters: Double get() = recorder.distanceMeters

    fun onLocation(d: LocationData) {
        if (finished) return
        recorder.onFix(d.latitude, d.longitude, d.accuracyMeters, System.currentTimeMillis())
        maybeCheckpoint()
    }

    /** Also called on a timer by pocket mode, so a long GPS outage still gets saved. */
    fun maybeCheckpoint() {
        if (finished) return
        val now = System.currentTimeMillis()
        if (now - lastCheckpointAt < CHECKPOINT_MS) return
        lastCheckpointAt = now
        save(final = false)
    }

    /** Ends the drive and queues it for upload. Safe to call more than once. */
    fun finish() {
        if (finished) return
        finished = true
        save(final = true)
    }

    private fun save(final: Boolean) {
        val points = recorder.points()
        if (points.size < 2 || recorder.distanceMeters < MIN_DISTANCE_M) return
        val drive = PendingDrive(
            clientId = clientId,
            mode = mode,
            startedAt = startedAt,
            endedAt = System.currentTimeMillis(),
            distanceMeters = recorder.distanceMeters,
            pathJson = PathRecorder.toJson(points),
            state = if (final) PendingDrive.STATE_PENDING else PendingDrive.STATE_RECORDING,
        )
        val previous = lastSave
        lastSave = RoadGuardApp.appScope.launch {
            previous?.join()
            try {
                RoadGuardDatabase.get(app).sensorDao().saveDrive(drive)
                if (final) SensorQueue.scheduleUpload(app)
            } catch (e: Exception) {
                Log.w(TAG, "Drive not saved", e)
            }
        }
    }
}
