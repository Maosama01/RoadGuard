package com.roadguard.app.ui

import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.text.format.DateUtils
import android.view.View
import android.widget.TextView
import androidx.annotation.ColorInt
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.content.ContextCompat
import com.roadguard.app.R
import com.roadguard.app.core.HazardKind
import com.roadguard.app.utils.SeverityLevel
import java.util.Calendar
import java.util.Locale
import kotlin.math.roundToInt

/** Small formatting and styling helpers shared by every screen. */
object Ui {

    // ------------------------------------------------------------------ language

    /**
     * [context] with the language picked in Settings. Activities get it from AppCompat already;
     * on Android 12 and below the application context, services and workers don't, so text built
     * there (notifications, spoken warnings, network errors) goes through this.
     */
    fun localized(context: Context): Context {
        val picked = AppCompatDelegate.getApplicationLocales()
        if (picked.isEmpty()) return context
        val locale = picked.get(0) ?: return context
        if (uiLocale(context).language == locale.language) return context
        return withLocale(context, locale)
    }

    /** [context] with its resources in [locale], e.g. English for a voice that can't speak Hindi. */
    fun withLocale(context: Context, locale: Locale): Context {
        val config = Configuration(context.resources.configuration)
        config.setLocale(locale)
        return context.createConfigurationContext(config)
    }

    /** The locale [context]'s resources are in. */
    fun uiLocale(context: Context): Locale = context.resources.configuration.locales.get(0) ?: Locale.getDefault()

    // ------------------------------------------------------------------ words

    @ColorInt
    fun severityColor(context: Context, level: String?): Int = ContextCompat.getColor(
        context,
        when (SeverityLevel.from(level)) {
            SeverityLevel.CRITICAL -> R.color.sev_critical
            SeverityLevel.HIGH -> R.color.sev_high
            SeverityLevel.MEDIUM -> R.color.sev_medium
            SeverityLevel.LOW -> R.color.sev_low
        }
    )

    /** "High", "Critical"... in the UI language. [SeverityLevel.label] stays English for logs. */
    fun severityWord(context: Context, level: String?): String = context.getString(
        when (SeverityLevel.from(level)) {
            SeverityLevel.CRITICAL -> R.string.severity_critical
            SeverityLevel.HIGH -> R.string.severity_high
            SeverityLevel.MEDIUM -> R.string.severity_medium
            SeverityLevel.LOW -> R.string.severity_low
        }
    )

    fun isOpen(status: String?): Boolean = status in listOf("reported", "verified", "assigned", "in_progress", null)

    fun statusLabel(context: Context, status: String?): String = context.getString(
        when (status) {
            "verified" -> R.string.status_verified
            "assigned" -> R.string.status_assigned
            "in_progress" -> R.string.status_in_progress
            "resolved" -> R.string.status_resolved
            "rejected" -> R.string.status_rejected
            else -> R.string.status_reported
        }
    )

    @StringRes
    fun kindRes(kind: HazardKind): Int = when (kind) {
        HazardKind.POTHOLE -> R.string.kind_pothole
        HazardKind.DRAIN_HOLE -> R.string.kind_drain_hole
        HazardKind.SEWER_COVER -> R.string.kind_sewer_cover
        HazardKind.CRACK -> R.string.kind_crack
        HazardKind.BUMP -> R.string.kind_bump
        HazardKind.OTHER -> R.string.kind_other
    }

    /** The hazard's name in the UI language. [HazardKind.displayName] stays English for logs. */
    fun kindName(context: Context, kind: HazardKind): String = context.getString(kindRes(kind))

    fun kindName(context: Context, apiType: String?): String = kindName(context, HazardKind.fromApiType(apiType))

    /** "Pothole, high severity" */
    fun hazardSummary(context: Context, type: String?, level: String?): String = context.getString(
        R.string.hazard_summary,
        kindName(context, type),
        severityWord(context, level).lowercase(uiLocale(context)),
    )

    fun roadOrFallback(context: Context, road: String?): String =
        road?.takeIf { it.isNotBlank() } ?: context.getString(R.string.road_unnamed)

    fun timeAgo(context: Context, ts: Long): String {
        if (ts <= 0) return ""
        val now = System.currentTimeMillis()
        if (now - ts < DateUtils.MINUTE_IN_MILLIS) return context.getString(R.string.time_just_now)
        return DateUtils.getRelativeTimeSpanString(ts, now, DateUtils.MINUTE_IN_MILLIS).toString()
    }

    fun distance(context: Context, meters: Double): String =
        if (meters < 1000) context.getString(R.string.distance_m, ((meters / 10).roundToInt() * 10).coerceAtLeast(10))
        else context.getString(R.string.distance_km, meters / 1000)

    fun drivers(context: Context, n: Int): String = context.resources.getQuantityString(R.plurals.drivers, n, n)

    fun greeting(context: Context): String = context.getString(
        when (Calendar.getInstance().get(Calendar.HOUR_OF_DAY)) {
            in 5..11 -> R.string.greeting_morning
            in 12..16 -> R.string.greeting_afternoon
            else -> R.string.greeting_evening
        }
    )

    /**
     * A bare number with one decimal, e.g. "12.5". Always Western digits (what Indian drivers
     * read on every road sign), whatever the UI language.
     */
    fun oneDecimal(value: Double): String = String.format(Locale.ENGLISH, "%.1f", value)

    fun firstName(name: String): String = name.trim().split(" ").firstOrNull()?.takeIf { it.isNotBlank() } ?: name

    fun initials(name: String): String = name.trim().split(Regex("\\s+"))
        .filter { it.isNotEmpty() }
        .take(2)
        .joinToString("") { it.first().uppercase() }
        .ifEmpty { "R" }

    fun dp(context: Context, value: Int): Int = (value * context.resources.displayMetrics.density).roundToInt()

    /** Colours a chip-style TextView (background tint + readable text). */
    fun tintChip(view: TextView, @ColorInt bg: Int, @ColorInt fg: Int) {
        view.backgroundTintList = ColorStateList.valueOf(bg)
        view.setTextColor(fg)
    }

    /** Status chip colours that match the dashboard. */
    fun styleStatusChip(view: TextView, status: String?) {
        val ctx = view.context
        view.text = statusLabel(ctx, status)
        val (bg, fg) = when (status) {
            "resolved" -> R.color.sev_low to R.color.on_asphalt
            "assigned", "in_progress" -> R.color.lane to R.color.lane_ink
            "verified" -> R.color.sev_high to R.color.on_asphalt
            "rejected" -> R.color.done to R.color.on_asphalt
            else -> R.color.asphalt_2 to R.color.on_asphalt
        }
        tintChip(view, ContextCompat.getColor(ctx, bg), ContextCompat.getColor(ctx, fg))
    }

    fun styleSeverityChip(view: TextView, level: String?) {
        view.text = severityWord(view.context, level)
        val color = severityColor(view.context, level)
        val fg = if (SeverityLevel.from(level) == SeverityLevel.MEDIUM) {
            ContextCompat.getColor(view.context, R.color.lane_ink)
        } else ContextCompat.getColor(view.context, R.color.on_asphalt)
        tintChip(view, color, fg)
    }
}

fun View.visible(show: Boolean) {
    visibility = if (show) View.VISIBLE else View.GONE
}
