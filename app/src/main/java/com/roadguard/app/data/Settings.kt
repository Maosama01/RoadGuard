package com.roadguard.app.data

import android.content.Context
import android.content.SharedPreferences

/** User preferences for drive mode and uploads. */
object Settings {

    private lateinit var prefs: SharedPreferences

    /** Safe to call more than once (WorkManager can start before Application.onCreate). */
    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences("roadguard_settings", Context.MODE_PRIVATE)
    }

    private fun bool(key: String, def: Boolean) = prefs.getBoolean(key, def)
    private fun setBool(key: String, v: Boolean) = prefs.edit().putBoolean(key, v).apply()

    var voiceAlerts: Boolean
        get() = bool("voice_alerts", true)
        set(v) = setBool("voice_alerts", v)

    var vibrateAlerts: Boolean
        get() = bool("vibrate_alerts", true)
        set(v) = setBool("vibrate_alerts", v)

    /** Only report potholes the car actually felt (fewer reports, almost no false ones). */
    var requireBump: Boolean
        get() = bool("require_bump", false)
        set(v) = setBool("require_bump", v)

    var wifiOnlyUploads: Boolean
        get() = bool("wifi_only", false)
        set(v) = setBool("wifi_only", v)

    var showMountTip: Boolean
        get() = bool("show_mount_tip", true)
        set(v) = setBool("show_mount_tip", v)

    /** Android hides its location dialog after repeated refusals; after that we send people to settings. */
    var askedLocationOnce: Boolean
        get() = bool("asked_location_once", false)
        set(v) = setBool("asked_location_once", v)

    /** 0 = low, 1 = normal, 2 = high. */
    var bumpSensitivity: Int
        get() = prefs.getInt("bump_sensitivity", 1)
        set(v) = prefs.edit().putInt("bump_sensitivity", v.coerceIn(0, 2)).apply()

    /** Linear acceleration (m/s²) that counts as a jolt. */
    val shockThreshold: Float
        get() = when (bumpSensitivity) {
            0 -> 8.0f
            2 -> 4.5f
            else -> 6.0f
        }
}
