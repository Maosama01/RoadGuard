package com.roadguard.app.data

import android.content.Context
import android.location.Geocoder
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.data.api.ensureGuestAccount
import com.roadguard.app.database.PendingReport
import com.roadguard.app.database.RoadGuardDatabase
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.Locale

/** Sends every saved report, oldest first. Retries with backoff while offline. */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        Session.init(applicationContext)
        Settings.init(applicationContext)
        if (!Session.canUseApp) return Result.success() // re-scheduled after sign-in
        // A guest who started offline gets their account now; until then the reports wait.
        if (!Session.isSignedIn && !ensureGuestAccount()) return Result.retry()
        val dao = RoadGuardDatabase.get(applicationContext).dao()

        // Re-query each round so reports added while we upload are sent too.
        var rounds = 0
        while (rounds++ < 20) {
            val batch = dao.pending()
            if (batch.isEmpty()) return Result.success()
            for (report in batch) {
                val withRoad = if (report.roadName.isNullOrBlank()) {
                    report.copy(roadName = roadNameFor(report.latitude, report.longitude))
                } else report

                when (val result = apiCall { uploadReport(fields(withRoad), imagePart(withRoad.imagePath)) }) {
                    is ApiResult.Ok -> {
                        dao.delete(report)
                        report.imagePath?.let { File(it).delete() }
                    }
                    is ApiResult.Err -> {
                        val code = result.code
                        // Signed out on the server: stop. Reports stay saved and go out after sign-in.
                        if (code == 401) return Result.success()
                        val permanent = code != null && code in 400..499 && code !in listOf(401, 408, 429)
                        if (permanent) {
                            dao.update(
                                withRoad.copy(
                                    state = PendingReport.STATE_REJECTED,
                                    attempts = report.attempts + 1,
                                    lastError = result.message
                                )
                            )
                        } else {
                            dao.update(withRoad.copy(attempts = report.attempts + 1, lastError = result.message))
                            Log.i("RoadGuardUpload", "Will retry: ${result.message}")
                            return Result.retry()
                        }
                    }
                }
            }
        }
        return Result.success()
    }

    private fun fields(r: PendingReport): Map<String, RequestBody> {
        val text = "text/plain".toMediaType()
        val map = linkedMapOf(
            "clientId" to r.clientId,
            "type" to r.type,
            "source" to r.source,
            "latitude" to r.latitude.toString(),
            "longitude" to r.longitude.toString(),
            "accuracy" to r.accuracy.toString(),
            "speed" to r.speed.toString(),
            "confidence" to r.confidence.toString(),
            "shock" to r.shock.toString(),
            "severityScore" to r.severityScore.toString(),
            "timestamp" to r.timestamp.toString(),
        )
        r.heading?.let { map["heading"] = it.toString() }
        r.roadName?.takeIf { it.isNotBlank() }?.let { map["roadName"] = it }
        return map.mapValues { it.value.toRequestBody(text) }
    }

    private fun imagePart(path: String?): MultipartBody.Part? {
        val file = path?.let { File(it) }?.takeIf { it.exists() && it.length() > 0 } ?: return null
        return MultipartBody.Part.createFormData("image", file.name, file.asRequestBody("image/jpeg".toMediaType()))
    }

    /** Best-effort street name so the city sees "Rajpur Road" instead of coordinates. */
    @Suppress("DEPRECATION")
    private fun roadNameFor(lat: Double, lng: Double): String? = try {
        if (!Geocoder.isPresent()) null
        else Geocoder(applicationContext, Locale.getDefault()).getFromLocation(lat, lng, 1)?.firstOrNull()?.let {
            it.thoroughfare ?: it.subLocality ?: it.featureName
        }
    } catch (_: Exception) {
        null
    }
}
