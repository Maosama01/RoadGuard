package com.roadguard.app.data

import android.content.Context
import android.content.SharedPreferences
import com.roadguard.app.BuildConfig
import com.roadguard.app.data.api.ApiUser
import java.util.UUID

/** Who is signed in, and which server the app talks to. */
object Session {

    private lateinit var prefs: SharedPreferences

    /** Safe to call more than once (WorkManager can start before Application.onCreate). */
    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences("roadguard_session", Context.MODE_PRIVATE)
    }

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    val isSignedIn: Boolean get() = !token.isNullOrBlank()

    /**
     * Chose "Start scanning" while the server couldn't be reached. The app works fully offline;
     * the guest account is created automatically the first time the server answers.
     */
    var offlineGuest: Boolean
        get() = prefs.getBoolean("offline_guest", false)
        set(value) = prefs.edit().putBoolean("offline_guest", value).apply()

    /** Signed in, or using the app as a guest that isn't registered with the server yet. */
    val canUseApp: Boolean get() = isSignedIn || offlineGuest

    /** Pre-fills the sign-in form. */
    var lastEmail: String?
        get() = prefs.getString("last_email", null)
        set(value) = prefs.edit().putString("last_email", value).apply()

    var userId: Long
        get() = prefs.getLong("user_id", 0)
        private set(value) = prefs.edit().putLong("user_id", value).apply()

    /** Empty for guests and unnamed accounts; screens use a neutral greeting then. */
    var userName: String
        get() = prefs.getString("user_name", null) ?: ""
        set(value) = prefs.edit().putString("user_name", value).apply()

    var userEmail: String?
        get() = prefs.getString("user_email", null)
        private set(value) = prefs.edit().putString("user_email", value).apply()

    var isGuest: Boolean
        get() = prefs.getBoolean("is_guest", true)
        private set(value) = prefs.edit().putBoolean("is_guest", value).apply()

    /** Always ends with "/" and has a scheme, as Retrofit requires. */
    var serverUrl: String
        get() = prefs.getString("server_url", null) ?: BuildConfig.DEFAULT_SERVER_URL
        set(value) = prefs.edit().putString("server_url", normalizeUrl(value)).apply()

    /** Stable per-install id, used for zero-friction guest accounts. */
    val deviceId: String
        get() {
            prefs.getString("device_id", null)?.let { return it }
            val id = UUID.randomUUID().toString()
            prefs.edit().putString("device_id", id).apply()
            return id
        }

    fun saveAuth(token: String, user: ApiUser) {
        this.token = token
        offlineGuest = false
        saveUser(user)
        user.email?.let { lastEmail = it }
    }

    fun saveUser(user: ApiUser) {
        userId = user.id
        userName = user.name?.takeIf { it.isNotBlank() && !user.isGuest } ?: ""
        userEmail = user.email
        isGuest = user.isGuest
    }

    fun signOut() {
        prefs.edit()
            .remove("token").remove("user_id").remove("user_name").remove("user_email").remove("is_guest")
            .remove("offline_guest").remove("session_expired")
            .apply()
    }

    /**
     * A registered account's token stopped working. Back to the sign-in screen, with the email
     * pre-filled and a note saying why; unsent reports stay queued for the same account.
     */
    fun expire() {
        val email = userEmail
        signOut()
        prefs.edit().putBoolean("session_expired", true).apply()
        if (email != null) lastEmail = email
    }

    /** True once after [expire]: the sign-in screen explains why it is showing. */
    fun consumeExpiredNotice(): Boolean {
        val v = prefs.getBoolean("session_expired", false)
        if (v) prefs.edit().remove("session_expired").apply()
        return v
    }

    fun normalizeUrl(input: String): String {
        var url = input.trim()
        if (url.isEmpty()) return BuildConfig.DEFAULT_SERVER_URL
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
        if (!url.endsWith("/")) url += "/"
        return url
    }
}
