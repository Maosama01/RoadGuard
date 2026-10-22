package com.roadguard.app.ui

import android.text.InputType
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.roadguard.app.R
import com.roadguard.app.data.Session
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.apiCall
import kotlinx.coroutines.launch

/** Lets the user point the app at their RoadGuard server, and checks it answers. */
object ServerDialog {

    fun show(activity: AppCompatActivity, onSaved: (String) -> Unit = {}) {
        val input = TextInputEditText(activity).apply {
            setText(Session.serverUrl)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSelection(text?.length ?: 0)
        }
        val layout = TextInputLayout(activity).apply {
            hint = activity.getString(R.string.server_hint)
            if (com.roadguard.app.BuildConfig.DEBUG) helperText = activity.getString(R.string.server_helper)
            addView(input)
        }
        val container = FrameLayout(activity).apply {
            val pad = Ui.dp(activity, 20)
            setPadding(pad, Ui.dp(activity, 8), pad, 0)
            addView(layout)
        }
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.server_title)
            .setView(container)
            .setNegativeButton(R.string.action_cancel, null)
            .setPositiveButton(R.string.server_save) { _, _ ->
                val previous = Session.serverUrl
                Session.serverUrl = input.text?.toString().orEmpty()
                val url = Session.serverUrl
                if (url != previous) {
                    // Accounts belong to a server. A guest just carries on: a new guest account is
                    // made on the new server automatically. A registered user signs in again.
                    val wasGuest = Session.isGuest || Session.offlineGuest
                    Session.signOut()
                    if (wasGuest) Session.offlineGuest = true
                }
                onSaved(url)
                test(activity)
            }
            .show()
    }

    fun test(activity: AppCompatActivity) {
        activity.lifecycleScope.launch {
            val msg = when (val r = apiCall { health() }) {
                is ApiResult.Ok -> activity.getString(R.string.server_connected, Session.serverUrl)
                is ApiResult.Err -> r.message
            }
            Toast.makeText(activity, msg, Toast.LENGTH_LONG).show()
        }
    }
}
