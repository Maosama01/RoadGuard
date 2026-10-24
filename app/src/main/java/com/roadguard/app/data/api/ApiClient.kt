package com.roadguard.app.data.api

import com.google.gson.Gson
import androidx.annotation.StringRes
import com.roadguard.app.BuildConfig
import com.roadguard.app.R
import com.roadguard.app.RoadGuardApp
import com.roadguard.app.data.Session
import com.roadguard.app.ui.Ui
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Retrofit client that follows the server address chosen in Settings. */
object ApiClient {

    private val gson = Gson()

    @Volatile
    private var cached: Pair<String, ApiService>? = null

    val api: ApiService
        get() {
            val url = Session.serverUrl
            cached?.let { if (it.first == url) return it.second }
            val service = build(url)
            cached = url to service
            return service
        }

    private fun build(baseUrl: String): ApiService {
        val http = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val builder = chain.request().newBuilder().header("Accept", "application/json")
                val sent = Session.token
                sent?.let { builder.header("Authorization", "Bearer $it") }
                val response = chain.proceed(builder.build())
                // Sliding session: the server hands out a fresh token before the old one expires.
                // Only take it if nobody signed in or out while this request was in flight.
                response.header("X-RoadGuard-Token")?.takeIf { it.isNotBlank() && sent != null && Session.token == sent }
                    ?.let { Session.token = it }
                response
            }
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .apply {
                if (BuildConfig.DEBUG) {
                    addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
                }
            }
            .build()

        return Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(http)
            .addConverterFactory(GsonConverterFactory.create(gson))
            .build()
            .create(ApiService::class.java)
    }

    internal fun errorMessage(e: HttpException): String {
        val body = try {
            e.response()?.errorBody()?.string()
        } catch (_: Exception) {
            null
        }
        val parsed = try {
            gson.fromJson(body, ErrorBody::class.java)?.message
        } catch (_: Exception) {
            null
        }
        // The server writes its messages in English. In Hindi, use our own words for the
        // common cases and keep the server's text only for detail we can't know (bad input).
        val hindi = Ui.uiLocale(Ui.localized(RoadGuardApp.instance)).language == "hi"
        if (hindi) {
            val path = e.response()?.raw()?.request?.url?.encodedPath.orEmpty()
            when (e.code()) {
                401 -> return text(if (path.endsWith("auth/login")) R.string.error_wrong_password else R.string.error_sign_in_again)
                409 -> return text(R.string.error_email_taken)
                429 -> return text(R.string.error_too_many)
                403 -> return text(R.string.error_forbidden)
                404 -> return text(R.string.error_not_found)
                in 500..599 -> return text(R.string.error_server)
            }
        }
        return parsed ?: when (e.code()) {
            401 -> text(R.string.error_sign_in_again)
            403 -> text(R.string.error_forbidden)
            404 -> text(R.string.error_not_found)
            in 500..599 -> text(R.string.error_server)
            else -> text(R.string.error_http, e.code())
        }
    }

    /** Error text in the language picked in Settings (there is no screen to take it from here). */
    internal fun text(@StringRes id: Int, vararg args: Any): String =
        Ui.localized(RoadGuardApp.instance).getString(id, *args)
}

sealed class ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>()
    data class Err(val message: String, val code: Int? = null, val offline: Boolean = false) : ApiResult<Nothing>()
}

private val guestLock = Mutex()

/**
 * For someone who started as a guest while offline: creates their guest account now, if the
 * server can be reached. Returns true when there is a usable account afterwards.
 */
suspend fun ensureGuestAccount(): Boolean = withContext(Dispatchers.IO) {
    if (Session.isSignedIn) return@withContext true
    if (!Session.offlineGuest) return@withContext false
    guestLock.withLock {
        if (Session.isSignedIn) return@withLock true
        try {
            val r = ApiClient.api.guest(GuestRequest(Session.deviceId))
            val token = r.token
            val user = r.user
            if (token != null && user != null) Session.saveAuth(token, user)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Still offline; the next call tries again.
        }
        Session.isSignedIn
    }
}

/**
 * The stored token stopped working (expired, or the server's secret changed). A guest gets
 * the same account back from its device id; a registered user has to sign in again, and their
 * unsent reports wait for that. Returns true when the call is worth retrying.
 */
private suspend fun recoverFromRejectedToken(rejected: String): Boolean = guestLock.withLock {
    if (Session.token != rejected) return@withLock Session.isSignedIn // someone already fixed it
    if (Session.isGuest) {
        Session.token = null
        Session.offlineGuest = true
        try {
            val r = ApiClient.api.guest(GuestRequest(Session.deviceId))
            val token = r.token
            val user = r.user
            if (token != null && user != null) Session.saveAuth(token, user)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Offline: ensureGuestAccount() tries again on the next call.
        }
        Session.isSignedIn
    } else {
        Session.expire()
        false
    }
}

/**
 * Runs an API call off the main thread and turns every failure into a readable message.
 * [reauth] = false for sign-in calls, where a 401 means a wrong password, not a dead session.
 */
suspend fun <T> apiCall(reauth: Boolean = true, block: suspend ApiService.() -> T): ApiResult<T> = withContext(Dispatchers.IO) {
    ensureGuestAccount()
    val tokenUsed = Session.token
    try {
        try {
            ApiResult.Ok(ApiClient.api.block())
        } catch (e: HttpException) {
            if (e.code() == 401 && reauth && tokenUsed != null && recoverFromRejectedToken(tokenUsed)) {
                ApiResult.Ok(ApiClient.api.block())
            } else {
                throw e
            }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: HttpException) {
        ApiResult.Err(ApiClient.errorMessage(e), e.code())
    } catch (e: IOException) {
        ApiResult.Err(ApiClient.text(R.string.error_offline), offline = true)
    } catch (e: IllegalArgumentException) {
        ApiResult.Err(ApiClient.text(R.string.error_bad_server_url))
    } catch (e: Exception) {
        ApiResult.Err(e.message ?: ApiClient.text(R.string.error_generic))
    }
}
