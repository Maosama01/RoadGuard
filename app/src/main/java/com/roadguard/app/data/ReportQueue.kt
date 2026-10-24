package com.roadguard.app.data

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import com.roadguard.app.database.PendingReport
import com.roadguard.app.database.RoadGuardDatabase
import java.util.concurrent.TimeUnit

/** Save-first, send-later. */
object ReportQueue {

    private const val WORK_NAME = "roadguard-upload"

    suspend fun add(context: Context, report: PendingReport) {
        RoadGuardDatabase.get(context).dao().insert(report)
        scheduleUpload(context)
    }

    suspend fun retryRejected(context: Context) {
        if (RoadGuardDatabase.get(context).dao().retryRejected() > 0) scheduleUpload(context)
    }

    fun scheduleUpload(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(if (Settings.wifiOnlyUploads) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
        val request = OneTimeWorkRequestBuilder<UploadWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(
                WORK_NAME,
                // REPLACE, not APPEND: a waiting job keeps its old network rule (Wi-Fi only) and its
                // growing retry delay, so "Send now" or a new report would sit behind it for hours.
                // Interrupting a running upload is harmless: the worker re-reads the queue and the
                // server ignores repeats of the same clientId.
                ExistingWorkPolicy.REPLACE,
                request,
            )
        // Pocket mode jolts and drive routes go out on the same occasions (start, sign-in, "Send now").
        SensorQueue.scheduleUpload(context)
    }
}
