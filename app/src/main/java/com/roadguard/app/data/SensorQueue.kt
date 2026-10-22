package com.roadguard.app.data

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.roadguard.app.database.PendingHit
import com.roadguard.app.database.RoadGuardDatabase
import java.util.concurrent.TimeUnit

/** Save-first, send-later for pocket mode jolts and drive routes (see [ReportQueue]). */
object SensorQueue {

    private const val WORK_NAME = "roadguard-sensor-upload"

    suspend fun addHit(context: Context, hit: PendingHit) {
        RoadGuardDatabase.get(context).sensorDao().insertHit(hit)
    }

    fun scheduleUpload(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (Settings.wifiOnlyUploads) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequestBuilder<SensorUploadWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
}
