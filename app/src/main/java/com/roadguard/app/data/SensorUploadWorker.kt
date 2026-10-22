package com.roadguard.app.data

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.SensorHit
import com.roadguard.app.data.api.SensorHitsRequest
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.data.api.ensureGuestAccount
import com.roadguard.app.database.PendingDrive
import com.roadguard.app.database.RoadGuardDatabase

/**
 * Sends pocket mode jolts (POST /api/sensor-hits, up to 200 per call) and finished drive
 * routes (POST /api/drives). Retries with backoff while offline. Both are idempotent on
 * clientId, so a retry after a lost response never counts twice.
 */
class SensorUploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private companion object {
        const val TAG = "RoadGuardSensorUpload"
        const val BATCH = 200
        const val MAX_HIT_AGE_MS = 14L * 24 * 60 * 60 * 1000
        /** A drive still "recording" but not saved for this long belongs to an app that died. */
        const val STALE_RECORDING_MS = 30L * 60 * 1000
    }

    private enum class Next { CONTINUE, STOP, RETRY }

    override suspend fun doWork(): Result {
        Session.init(applicationContext)
        Settings.init(applicationContext)
        if (!Session.canUseApp) return Result.success() // re-scheduled after sign-in
        if (!Session.isSignedIn && !ensureGuestAccount()) return Result.retry()
        val dao = RoadGuardDatabase.get(applicationContext).sensorDao()
        dao.deleteHitsBefore(System.currentTimeMillis() - MAX_HIT_AGE_MS)

        // Re-query each round so hits saved while we upload are sent too.
        var rounds = 0
        while (rounds++ < 50) {
            val batch = dao.oldestHits(BATCH)
            if (batch.isEmpty()) break
            val body = SensorHitsRequest(batch.map {
                SensorHit(it.clientId, it.latitude, it.longitude, it.accuracy, it.speed, it.heading, it.shock, it.timestamp)
            })
            val ids = batch.map { it.id }
            when (val r = apiCall { sensorHits(body) }) {
                is ApiResult.Ok -> dao.deleteHits(ids)
                is ApiResult.Err -> when (outcome(r)) {
                    Next.CONTINUE -> {
                        // The server refused this batch for good; keeping it would block the rest.
                        Log.w(TAG, "Dropping ${batch.size} jolts: ${r.message}")
                        dao.deleteHits(ids)
                    }
                    Next.STOP -> return Result.success()
                    Next.RETRY -> return Result.retry()
                }
            }
        }

        for (pending in dao.drivesToSend(System.currentTimeMillis() - STALE_RECORDING_MS)) {
            val body = try {
                driveBody(pending)
            } catch (e: Exception) {
                Log.w(TAG, "Dropping unreadable drive ${pending.clientId}", e)
                dao.deleteDrive(pending.clientId)
                continue
            }
            when (val r = apiCall { drive(body) }) {
                is ApiResult.Ok -> dao.deleteDrive(pending.clientId)
                is ApiResult.Err -> when (outcome(r)) {
                    Next.CONTINUE -> {
                        Log.w(TAG, "Dropping drive ${pending.clientId}: ${r.message}")
                        dao.deleteDrive(pending.clientId)
                    }
                    Next.STOP -> return Result.success()
                    Next.RETRY -> return Result.retry()
                }
            }
        }
        return Result.success()
    }

    private fun outcome(err: ApiResult.Err): Next {
        val code = err.code
        return when {
            // Signed out on the server: data stays saved and goes out after sign-in.
            code == 401 -> Next.STOP
            // An older server without pocket mode: keep everything for when it's updated.
            code == 404 -> Next.STOP
            code != null && code in 400..499 && code != 408 && code != 429 -> Next.CONTINUE
            else -> {
                Log.i(TAG, "Will retry: ${err.message}")
                Next.RETRY
            }
        }
    }

    private fun driveBody(d: PendingDrive): JsonObject = JsonObject().apply {
        addProperty("clientId", d.clientId)
        addProperty("mode", d.mode)
        addProperty("startedAt", d.startedAt)
        addProperty("endedAt", d.endedAt)
        addProperty("distanceMeters", Math.round(d.distanceMeters))
        add("path", JsonParser.parseString(d.pathJson))
    }
}
