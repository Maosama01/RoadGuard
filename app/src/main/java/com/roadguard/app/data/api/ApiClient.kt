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
                Session.token?.let { builder.header("Authorization", "Bearer $it") }
                chain.proceed(builder.build())
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

/** Runs an API call off the main thread and turns every failure into a readable message. */
suspend fun <T> apiCall(block: suspend ApiService.() -> T): ApiResult<T> = withContext(Dispatchers.IO) {
    ensureGuestAccount()
    try {
        ApiResult.Ok(ApiClient.api.block())
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
