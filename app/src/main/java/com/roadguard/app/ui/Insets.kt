package com.roadguard.app.ui

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

/**
 * Edge-to-edge is enforced for apps targeting Android 15, so content must step out of the way
 * of the status and navigation bars itself.
 */
fun View.padForSystemBars(top: Boolean = true, bottom: Boolean = false, keyboard: Boolean = false) {
    val startTop = paddingTop
    val startBottom = paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val ime = if (keyboard) insets.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
        v.updatePadding(
            top = if (top) startTop + bars.top else startTop,
            bottom = if (bottom) startBottom + maxOf(bars.bottom, ime) else startBottom,
        )
        insets
    }
    ViewCompat.requestApplyInsets(this)
}

/** Screens that can reload when their tab is tapped again. */
interface Refreshable {
    fun refresh()
}
