package com.roadguard.app.overlay

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.content.res.ResourcesCompat
import com.roadguard.app.R
import com.roadguard.app.core.HazardKind
import com.roadguard.app.ml.Detection
import com.roadguard.app.ui.Ui
import kotlin.math.max

/**
 * Draws detections on top of the camera preview.
 *
 * Boxes come in analysed-frame pixels; the preview is scaled with FILL_CENTER, so the same
 * scale and crop offset is applied here. (Previously frame pixels were drawn straight onto
 * the view, so boxes landed in the wrong place.)
 */
class OverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : View(context, attrs) {

    private var detections: List<Detection> = emptyList()
    private var imageWidth = 0
    private var imageHeight = 0
    private val mapped = RectF()
    /** Box labels in the UI language, looked up once rather than on every frame. */
    private val kindNames: Map<HazardKind, String> = HazardKind.entries.associateWith { Ui.kindName(context, it) }
    private val density = resources.displayMetrics.density

    private val boxPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 3f * density
    }
    private val labelBg = Paint(Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 14f * resources.displayMetrics.scaledDensity
        typeface = ResourcesCompat.getFont(context, R.font.barlow_semibold)
    }

    private val lane = Color.rgb(242, 194, 48)
    private val drain = Color.rgb(232, 116, 42)
    private val neutral = Color.argb(200, 255, 255, 255)
    /** Cracks: a quiet grey-blue, so they never compete with potholes for attention. */
    private val crack = Color.argb(220, 169, 186, 204)
    /** Thin straight cracks: drawn faintly, never reported. */
    private val faint = Color.argb(110, 255, 255, 255)

    fun setResults(results: List<Detection>, frameWidth: Int, frameHeight: Int) {
        detections = results
        imageWidth = frameWidth
        imageHeight = frameHeight
        invalidate()
    }

    fun clear() = setResults(emptyList(), imageWidth, imageHeight)

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (imageWidth == 0 || imageHeight == 0 || detections.isEmpty()) return
        val scale = max(width.toFloat() / imageWidth, height.toFloat() / imageHeight)
        val dx = (width - imageWidth * scale) / 2f
        val dy = (height - imageHeight * scale) / 2f
        val r = 6f * density

        for (d in detections) {
            val b = d.boundingBox
            mapped.set(b.left * scale + dx, b.top * scale + dy, b.right * scale + dx, b.bottom * scale + dy)
            val color = when (d.kind) {
                HazardKind.POTHOLE -> lane
                HazardKind.DRAIN_HOLE -> drain
                HazardKind.CRACK -> crack
                HazardKind.OTHER -> faint
                else -> neutral
            }
            boxPaint.color = color
            boxPaint.strokeWidth = when {
                d.kind == HazardKind.CRACK -> 2f
                d.kind.reportable -> 3f
                else -> 1.5f
            } * density
            canvas.drawRoundRect(mapped, r, r, boxPaint)

            if (!d.kind.reportable) continue
            // Just the name: a percentage means nothing to a driver.
            val label = context.getString(R.string.overlay_label, kindNames[d.kind] ?: d.kind.displayName)
            val tw = textPaint.measureText(label)
            val th = textPaint.textSize
            val padH = 8f * density
            val padV = 4f * density
            val top = if (mapped.top - th - padV * 2 > 0) mapped.top - th - padV * 2 - 4f * density else mapped.top + 4f * density
            labelBg.color = color
            canvas.drawRoundRect(mapped.left, top, mapped.left + tw + padH * 2, top + th + padV * 2, r, r, labelBg)
            textPaint.color = if (d.kind == HazardKind.POTHOLE || d.kind == HazardKind.CRACK) Color.rgb(28, 32, 38) else Color.WHITE
            canvas.drawText(label, mapped.left + padH, top + padV + th * 0.82f, textPaint)
        }
    }
}
