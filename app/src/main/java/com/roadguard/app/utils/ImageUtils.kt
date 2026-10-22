package com.roadguard.app.utils

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import androidx.camera.core.ImageProxy
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min

object ImageUtils {

    /**
     * Camera frame -> upright Bitmap.
     *
     * The old converter assumed YUV with three planes, but the analyzer is configured for
     * RGBA_8888 (one plane), so it threw on every frame and nothing was ever detected.
     * CameraX's toBitmap() handles both formats.
     */
    fun imageProxyToBitmap(image: ImageProxy): Bitmap {
        val bitmap = image.toBitmap()
        val rotation = image.imageInfo.rotationDegrees
        if (rotation == 0) return bitmap
        val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
        val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (rotated !== bitmap) bitmap.recycle()
        return rotated
    }

    /** The hazard box is grown by this much (around its centre) before the rest is blurred. */
    private const val SHARP_BOX_SCALE = 1.6f

    /**
     * Saves the report photo (max 1280 px on the long side, JPEG) into app-private storage.
     *
     * Privacy (DPDP Act 2023): only the hazard stays sharp. Everything else is blurred hard
     * enough that faces and number plates can't be read. With a detection [box] the sharp area
     * is the box grown 1.6x; for a manual report (no box) it's the road just ahead, the
     * bottom-centre 60% x 45% of the frame. The detected hazard is outlined so the city crew
     * sees exactly what was flagged.
     */
    fun saveReportPhoto(context: Context, source: Bitmap, box: RectF?): String {
        val longSide = max(source.width, source.height)
        val scale = min(1f, 1280f / longSide)
        val w = (source.width * scale).toInt().coerceAtLeast(1)
        val h = (source.height * scale).toInt().coerceAtLeast(1)
        val sharp = Bitmap.createScaledBitmap(source, w, h, true).let {
            if (it === source || !it.isMutable || it.config != Bitmap.Config.ARGB_8888) {
                val copy = it.copy(Bitmap.Config.ARGB_8888, true)
                if (it !== source) it.recycle()
                copy
            } else it
        }

        val scaledBox = box?.let { RectF(it.left * scale, it.top * scale, it.right * scale, it.bottom * scale) }
        val keep = sharpRegion(w, h, scaledBox)

        val out = blurred(sharp)
        val canvas = Canvas(out)
        canvas.drawBitmap(sharp, keep, keep, null)

        if (scaledBox != null) {
            val stroke = max(3f, w / 220f)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.STROKE
                strokeWidth = stroke
                color = Color.rgb(242, 194, 48)
            }
            val r = RectF(scaledBox)
            r.inset(-stroke * 2, -stroke * 2)
            canvas.drawRoundRect(r, stroke * 2, stroke * 2, paint)
        }
        sharp.recycle()

        val dir = File(context.filesDir, "reports").apply { mkdirs() }
        val file = File(dir, "RG_${System.currentTimeMillis()}.jpg")
        FileOutputStream(file).use { out.compress(Bitmap.CompressFormat.JPEG, 82, it) }
        out.recycle()
        return file.absolutePath
    }

    /** The part of a [w] x [h] photo that stays sharp. */
    internal fun sharpRegion(w: Int, h: Int, box: RectF?): Rect {
        val r = if (box != null && box.width() > 0f && box.height() > 0f) {
            val halfW = box.width() * SHARP_BOX_SCALE / 2f
            val halfH = box.height() * SHARP_BOX_SCALE / 2f
            Rect(
                (box.centerX() - halfW).toInt(),
                (box.centerY() - halfH).toInt(),
                (box.centerX() + halfW).toInt(),
                (box.centerY() + halfH).toInt(),
            )
        } else {
            // The road just ahead of the car.
            Rect((w * 0.2f).toInt(), (h * 0.55f).toInt(), (w * 0.8f).toInt(), h)
        }
        if (!r.intersect(0, 0, w, h)) r.set(0, 0, 0, 0)
        return r
    }

    /**
     * A strongly blurred, mutable copy: shrunk to 1/16 in two filtered steps and grown back the
     * same way. At 1280 px wide that leaves 80 px across the whole frame, so a face or a number
     * plate becomes a few soft pixels.
     */
    private fun blurred(src: Bitmap): Bitmap {
        val w = src.width
        val h = src.height
        val quarterW = max(1, w / 4)
        val quarterH = max(1, h / 4)
        val a = Bitmap.createScaledBitmap(src, quarterW, quarterH, true)
        val b = Bitmap.createScaledBitmap(a, max(1, w / 16), max(1, h / 16), true)
        val c = Bitmap.createScaledBitmap(b, quarterW, quarterH, true)
        val grown = Bitmap.createScaledBitmap(c, w, h, true)
        for (tmp in listOf(a, b, c)) if (tmp !== src && tmp !== grown) tmp.recycle()
        if (grown.isMutable && grown.config == Bitmap.Config.ARGB_8888 && grown !== src) return grown
        val copy = grown.copy(Bitmap.Config.ARGB_8888, true)
        if (grown !== src) grown.recycle()
        return copy
    }
}
