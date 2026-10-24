package com.roadguard.app.data

import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.lifecycle.LifecycleCoroutineScope
import androidx.work.WorkManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.roadguard.app.R
import com.roadguard.app.activities.LoginActivity
import com.roadguard.app.database.RoadGuardDatabase
import com.roadguard.app.service.PocketScanService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Signing out, done completely. Reports still on the phone belong to the account that made
 * them, so they are either sent first or deleted: otherwise the next person to sign in on this
 * phone would upload them under their own name. Pocket mode stops too.
 */
object SignOut {

    fun confirm(context: Context, scope: LifecycleCoroutineScope) {
        scope.launch {
            val unsent = withContext(Dispatchers.IO) { RoadGuardDatabase.get(context).dao().count() }
            val builder = MaterialAlertDialogBuilder(context)
                .setTitle(R.string.sign_out_title)
                .setNegativeButton(R.string.action_cancel, null)
            if (unsent > 0) {
                builder
                    .setMessage(context.resources.getQuantityString(R.plurals.sign_out_unsent, unsent, unsent))
                    .setNeutralButton(R.string.settings_send_now) { _, _ ->
                        ReportQueue.scheduleUpload(context)
                        Toast.makeText(context, R.string.sign_out_sending, Toast.LENGTH_LONG).show()
                    }
                    .setPositiveButton(R.string.sign_out_delete_and_leave) { _, _ -> scope.launch { signOut(context) } }
            } else {
                builder
                    .setMessage(if (Session.isGuest) R.string.sign_out_message_guest else R.string.sign_out_message)
                    .setPositiveButton(R.string.action_sign_out) { _, _ -> scope.launch { signOut(context) } }
            }
            builder.show()
        }
    }

    private suspend fun signOut(context: Context) {
        val app = context.applicationContext
        PocketScanService.stop(app)
        WorkManager.getInstance(app).cancelAllWork()
        withContext(Dispatchers.IO) {
            val db = RoadGuardDatabase.get(app)
            db.dao().all().forEach { r -> r.imagePath?.let { File(it).delete() } }
            db.dao().deleteAll()
            db.sensorDao().deleteAllHits()
            db.sensorDao().deleteAllDrives()
        }
        Session.signOut()
        context.startActivity(
            Intent(context, LoginActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        )
    }
}
