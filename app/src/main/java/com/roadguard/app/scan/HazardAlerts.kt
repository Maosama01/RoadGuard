package com.roadguard.app.scan

import android.content.Context
import android.os.VibrationEffect
import android.os.Vibrator
import android.speech.tts.TextToSpeech
import com.roadguard.app.R
import com.roadguard.app.core.AlertEngine
import com.roadguard.app.core.GeoUtils
import com.roadguard.app.core.HazardKind
import com.roadguard.app.data.Settings
import com.roadguard.app.data.api.ApiResult
import com.roadguard.app.data.api.VoteRequest
import com.roadguard.app.data.api.apiCall
import com.roadguard.app.location.LocationData
import com.roadguard.app.ui.Ui
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Spoken and vibrating warnings for hazards other drivers already reported, shared by camera
 * drives and pocket mode. Loads hazards around the car from /api/hazards/nearby as it moves,
 * asks [AlertEngine] what is ahead, and sends "clean pass" votes when the car drives over a
 * known hazard without a jolt.
 *
 * Call everything on the main thread. [scope] runs the network calls (cancelled with it).
 */
class HazardAlerts(
    context: Context,
    private val scope: CoroutineScope,
    private val onAlert: (AlertEngine.Alert) -> Unit = {},
    private val onHazardsChanged: () -> Unit = {},
) {

    private val app = context.applicationContext
    private val engine = AlertEngine()

    /** Resources in the UI language (the application context doesn't follow it on Android 12 and below). */
    private val ui: Context = Ui.localized(app)

    private var tts: TextToSpeech? = null
    private var ttsReady = false

    /**
     * Where the spoken sentence comes from: the UI language, or English when the phone's
     * text-to-speech engine has no voice for it (many phones ship without a Hindi voice).
     */
    @Volatile
    private var speech: Context = ui

    private var lastFetch: LocationData? = null
    private var lastFetchAt = 0L
    private var lastAttemptAt = 0L
    private var fetching = false

    /** False until the first successful load (show "–" rather than 0 until then). */
    val hasLoaded: Boolean get() = lastFetch != null
    val hazardCount: Int get() = engine.hazardCount

    init {
        tts = TextToSpeech(app) { code ->
            ttsReady = code == TextToSpeech.SUCCESS
            if (ttsReady) chooseVoice()
        }
    }

    /** A jolt the car felt (wall-clock ms). A jolt at a known hazard means it's still there. */
    fun onShock(timestamp: Long) = engine.onShock(timestamp)

    fun onLocation(d: LocationData) {
        val now = System.currentTimeMillis()
        engine.checkAlert(d.latitude, d.longitude, d.speedKmh, d.bearing, now)?.let {
            announce(it)
            onAlert(it)
        }
        for (id in engine.checkCleanPasses(d.latitude, d.longitude, now)) {
            scope.launch { apiCall { vote(id, VoteRequest("pass")) } }
        }
        maybeFetch(d)
    }

    fun release() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
    }

    private fun maybeFetch(d: LocationData) {
        if (fetching) return
        val now = System.currentTimeMillis()
        // After a failed attempt (offline), wait before trying again.
        if (lastFetch == null && now - lastAttemptAt < 30_000) return
        val last = lastFetch
        val moved = last?.let { GeoUtils.distanceMeters(it.latitude, it.longitude, d.latitude, d.longitude) } ?: Double.MAX_VALUE
        if (moved < 600 && now - lastFetchAt < 120_000) return
        lastAttemptAt = now
        fetching = true
        scope.launch {
            val r = apiCall { nearby(d.latitude, d.longitude, 3000) }
            fetching = false
            lastFetchAt = System.currentTimeMillis()
            if (r is ApiResult.Ok) {
                lastFetch = d
                engine.setHazards(r.value.items.orEmpty().mapNotNull {
                    val kind = HazardKind.fromApiType(it.type)
                    // Cracks don't jolt and sewer covers aren't hazards: nothing to warn about.
                    if (kind == HazardKind.CRACK || kind == HazardKind.SEWER_COVER) return@mapNotNull null
                    AlertEngine.KnownHazard(
                        id = it.id,
                        kind = kind,
                        latitude = it.latitude,
                        longitude = it.longitude,
                        severityLevel = it.severityLevel ?: "LOW",
                        reportCount = maxOf(it.uniqueReporters, 1),
                    )
                })
                onHazardsChanged()
            }
        }
    }

    /** Speaks the UI language if the engine can, else Indian English with the English sentence. */
    private fun chooseVoice() {
        val voice = tts ?: return
        val result = voice.setLanguage(speechLocale())
        if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
            voice.setLanguage(Locale.forLanguageTag("en-IN"))
            speech = Ui.withLocale(app, Locale.ENGLISH)
        } else {
            speech = ui
        }
    }

    /**
     * The language the warning text is actually in. A phone set to a language the app has no
     * translation for shows English, and must not get an English sentence read by, say, a
     * Marathi voice.
     */
    private fun speechLocale(): Locale {
        val shown = Ui.uiLocale(ui)
        val textLanguage = ui.getString(R.string.speech_language_tag)
        return if (shown.language == textLanguage) shown else Locale.forLanguageTag(textLanguage)
    }

    private fun announce(alert: AlertEngine.Alert) {
        vibrate(longArrayOf(0, 120, 90, 120))
        if (Settings.voiceAlerts && ttsReady) {
            val meters = ((alert.distanceMeters / 10).toInt() * 10).coerceAtLeast(10)
            val words = speech
            val text = words.getString(R.string.alert_ahead_speech, Ui.kindName(words, alert.hazard.kind), meters)
            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "alert-${alert.hazard.id}")
        }
    }

    @Suppress("DEPRECATION")
    private fun vibrate(pattern: LongArray) {
        if (!Settings.vibrateAlerts) return
        val v = app.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        if (!v.hasVibrator()) return
        v.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }
}
