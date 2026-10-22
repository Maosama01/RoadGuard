package com.roadguard.app.camera

import android.graphics.Bitmap
import android.graphics.RectF
import android.os.SystemClock
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.roadguard.app.core.DetectionFusion
import com.roadguard.app.ml.Detection
import com.roadguard.app.ml.YOLODetector
import com.roadguard.app.utils.ImageUtils
import com.roadguard.app.utils.SeverityCalculator

/**
 * Camera frame -> detector -> fusion. Runs on a single background executor.
 *
 * Keeps the sharpest frame of each candidate so the report photo is the best view of the
 * hazard, not whichever frame happened to be last.
 */
class FrameAnalyzer(
    private val detector: YOLODetector,
    private val fusion: DetectionFusion,
    private val currentFix: () -> DetectionFusion.Fix?,
    private val listener: Listener,
) : ImageAnalysis.Analyzer {

    interface Listener {
        /** Every analysed frame (for the on-screen boxes). Called on the analysis thread. */
        fun onFrameResult(detections: List<Detection>, imageWidth: Int, imageHeight: Int, inferenceMs: Long)

        /** A hazard passed all checks. [photo] is owned by the listener and must be recycled. */
        fun onHazardConfirmed(confirmed: DetectionFusion.Confirmed, photo: Bitmap?, box: RectF?)

        fun onAnalysisError(error: Throwable)
    }

    companion object {
        /** Upper bound on analysis rate; slower phones are naturally limited by inference time. */
        private const val MIN_INTERVAL_MS = 150L
    }

    private var lastAnalysis = 0L
    private val keptFrames = HashMap<Long, Pair<Bitmap, RectF>>()

    @Volatile
    var paused = false

    override fun analyze(image: ImageProxy) {
        val now = System.currentTimeMillis()
        if (paused || now - lastAnalysis < MIN_INTERVAL_MS) {
            image.close()
            drain(now)
            return
        }
        lastAnalysis = now

        var frame: Bitmap? = null
        try {
            frame = ImageUtils.imageProxyToBitmap(image)
            val t0 = SystemClock.elapsedRealtime()
            val detections = detector.detect(frame)
            listener.onFrameResult(detections, frame.width, frame.height, SystemClock.elapsedRealtime() - t0)

            val best = detections.filter { it.kind.reportable }.maxByOrNull { it.confidence }
            if (best != null) {
                val area = SeverityCalculator.calculateNormalizedBoundingBoxArea(
                    best.boundingBox.width(), best.boundingBox.height(), frame.width, frame.height
                )
                val isBestView = fusion.onDetection(best.kind, best.confidence, area, now, currentFix())
                val id = fusion.currentCandidateId
                if (isBestView && id != null) {
                    keptFrames.remove(id)?.first?.recycle()
                    keptFrames[id] = frame to RectF(best.boundingBox)
                    frame = null // ownership moved to keptFrames
                }
            }
            drain(now)
        } catch (t: Throwable) {
            listener.onAnalysisError(t)
        } finally {
            frame?.recycle()
            image.close()
        }
    }

    private fun drain(now: Long) {
        while (true) {
            val confirmed = fusion.poll(now) ?: break
            val kept = keptFrames.remove(confirmed.candidateId)
            listener.onHazardConfirmed(confirmed, kept?.first, kept?.second)
        }
        // Drop frames of candidates that were discarded.
        val current = fusion.currentCandidateId
        val stale = keptFrames.keys.filter { it != current }
        for (id in stale) keptFrames.remove(id)?.first?.recycle()
    }

    /** Hands out a candidate that was still waiting for its jolt. Call on the analysis thread at shutdown. */
    fun flush() {
        drain(System.currentTimeMillis() + 60_000)
    }

    /** Call on the analysis thread when shutting down. */
    fun release() {
        keptFrames.values.forEach { it.first.recycle() }
        keptFrames.clear()
    }
}
