package com.roadguard.app.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.roadguard.app.R

/** Vertical lane-marking dashes: the app's signature visual. */
class LaneDashView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(context, R.color.lane) }
    private val density = resources.displayMetrics.density
    var dashLength = 22f * density
    var gapLength = 14f * density

    fun setDashColor(color: Int) {
        paint.color = color
        invalidate()
    }

    /**
     * Only take a height that the parent fixes. A plain View claims ALL the room it is offered,
     * so inside a ScrollView with fillViewport it would stretch the hero to the full screen.
     * As a decoration, the dashes should follow their container's height, never set it.
     */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = resolveSize(suggestedMinimumWidth, widthMeasureSpec)
        val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(heightMeasureSpec) else suggestedMinimumHeight
        setMeasuredDimension(w, h)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val r = w / 3f
        var y = 0f
        while (y < height) {
            canvas.drawRoundRect(0f, y, w, minOf(y + dashLength, height.toFloat()), r, r, paint)
            y += dashLength + gapLength
        }
    }
}
