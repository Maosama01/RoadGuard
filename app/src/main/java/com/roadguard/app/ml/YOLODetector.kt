package com.roadguard.app.ml

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.Log
import com.roadguard.app.core.HazardKind
import org.tensorflow.lite.Interpreter
import org.tensorflow.lite.support.common.FileUtil
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Runs the Ultralytics YOLO .tflite model.
 *
 * Input layout (NCHW or NHWC), input size, number of classes and class names are all read
 * from the model, so a re-exported model drops in without code changes.
 *
 * Buffers are allocated once and reused: the previous version built a 1024x1024x3 nested
 * Kotlin array and called getPixel() a million times per frame.
 *
 * Not thread-safe for concurrent detect() calls; use from one analysis thread.
 */
class YOLODetector(context: Context) {

    private val interpreter: Interpreter
    val labels: List<String>
    /** Thresholds calibrated for this model (assets/model_config.json). */
    val config: ModelConfig = ModelConfig.load(context)
    val inputSize: Int
    private val channelsFirst: Boolean
    private val numClasses: Int
    private val outputChannelsFirst: Boolean
    private val numPredictions: Int

    private val inputBuffer: ByteBuffer
    private val output: Array<Array<FloatArray>>
    private val pixels: IntArray
    private val letterboxBitmap: Bitmap
    private val letterboxCanvas: Canvas
    private val drawPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val dstRect = RectF()

    @Volatile
    private var closed = false

    init {
        val model = FileUtil.loadMappedFile(context, Constants.MODEL_NAME)
        interpreter = Interpreter(model, Interpreter.Options().apply { setNumThreads(Constants.NUM_THREADS) })

        val inShape = interpreter.getInputTensor(0).shape() // [1,3,S,S] or [1,S,S,3]
        channelsFirst = inShape.size == 4 && inShape[1] == 3
        inputSize = if (channelsFirst) inShape[2] else inShape[1]

        val outShape = interpreter.getOutputTensor(0).shape() // [1, 4+C, N] or [1, N, 4+C]
        require(outShape.size == 3) { "Unexpected YOLO output shape: ${outShape.contentToString()}" }
        outputChannelsFirst = outShape[1] < outShape[2]
        val channels = if (outputChannelsFirst) outShape[1] else outShape[2]
        numPredictions = if (outputChannelsFirst) outShape[2] else outShape[1]
        numClasses = channels - 4

        val names = Labels.readFromModel(context, Constants.MODEL_NAME)
        labels = List(numClasses) { names.getOrElse(it) { "Class $it" } }

        inputBuffer = ByteBuffer.allocateDirect(4 * 3 * inputSize * inputSize).order(ByteOrder.nativeOrder())
        output = Array(1) { Array(outShape[1]) { FloatArray(outShape[2]) } }
        pixels = IntArray(inputSize * inputSize)
        letterboxBitmap = Bitmap.createBitmap(inputSize, inputSize, Bitmap.Config.ARGB_8888)
        letterboxCanvas = Canvas(letterboxBitmap)

        Log.i(
            "RoadGuardYOLO",
            "Model ready: input ${inShape.contentToString()}, output ${outShape.contentToString()}, classes $labels"
        )
    }

    fun detect(bitmap: Bitmap, threshold: Float = config.detectThreshold): List<Detection> {
        if (closed || bitmap.width <= 0 || bitmap.height <= 0) return emptyList()

        // 1. Letterbox into the reusable square bitmap.
        val scale = min(inputSize.toFloat() / bitmap.width, inputSize.toFloat() / bitmap.height)
        val newW = bitmap.width * scale
        val newH = bitmap.height * scale
        val padX = (inputSize - newW) / 2f
        val padY = (inputSize - newH) / 2f
        letterboxCanvas.drawColor(Color.rgb(114, 114, 114))
        dstRect.set(padX, padY, padX + newW, padY + newH)
        letterboxCanvas.drawBitmap(bitmap, null, dstRect, drawPaint)

        // 2. Pixels -> float tensor in the model's layout.
        letterboxBitmap.getPixels(pixels, 0, inputSize, 0, 0, inputSize, inputSize)
        inputBuffer.rewind()
        if (channelsFirst) {
            val fb = inputBuffer.asFloatBuffer()
            val plane = inputSize * inputSize
            for (i in 0 until plane) {
                val p = pixels[i]
                fb.put(i, ((p shr 16) and 0xFF) / 255f)
                fb.put(plane + i, ((p shr 8) and 0xFF) / 255f)
                fb.put(2 * plane + i, (p and 0xFF) / 255f)
            }
        } else {
            for (p in pixels) {
                inputBuffer.putFloat(((p shr 16) and 0xFF) / 255f)
                inputBuffer.putFloat(((p shr 8) and 0xFF) / 255f)
                inputBuffer.putFloat((p and 0xFF) / 255f)
            }
        }
        inputBuffer.rewind()

        // 3. Inference.
        if (closed) return emptyList()
        interpreter.run(inputBuffer, output)

        // 4. Decode + NMS.
        val raw = parseOutput(bitmap.width, bitmap.height, scale, padX, padY, threshold)
        return nonMaximumSuppression(raw, Constants.NMS_THRESHOLD)
    }

    private fun value(channel: Int, index: Int): Float =
        if (outputChannelsFirst) output[0][channel][index] else output[0][index][channel]

    private fun parseOutput(
        originalWidth: Int,
        originalHeight: Int,
        scale: Float,
        padX: Float,
        padY: Float,
        threshold: Float,
    ): List<Detection> {
        if (numClasses <= 0) return emptyList()
        val detections = ArrayList<Detection>()

        for (i in 0 until numPredictions) {
            var bestClass = -1
            var bestConfidence = 0f
            for (c in 0 until numClasses) {
                val conf = value(4 + c, i)
                if (conf > bestConfidence) {
                    bestConfidence = conf
                    bestClass = c
                }
            }
            if (bestClass < 0 || bestConfidence < threshold) continue

            val x = value(0, i)
            val y = value(1, i)
            val w = value(2, i)
            val h = value(3, i)
            var left = x - w / 2f
            var top = y - h / 2f
            var right = x + w / 2f
            var bottom = y + h / 2f

            // Exports may give normalized (0..1) coordinates; convert to input pixels.
            if (max(max(abs(left), abs(top)), max(abs(right), abs(bottom))) <= 2f) {
                left *= inputSize; top *= inputSize; right *= inputSize; bottom *= inputSize
            }

            // Undo the letterbox and clamp to the frame.
            left = ((left - padX) / scale).coerceIn(0f, originalWidth.toFloat())
            top = ((top - padY) / scale).coerceIn(0f, originalHeight.toFloat())
            right = ((right - padX) / scale).coerceIn(0f, originalWidth.toFloat())
            bottom = ((bottom - padY) / scale).coerceIn(0f, originalHeight.toFloat())
            if (right <= left || bottom <= top) continue

            val name = labels[bestClass]
            detections.add(
                Detection(
                    classId = bestClass,
                    className = name,
                    kind = HazardKind.fromModelLabel(name),
                    confidence = bestConfidence,
                    boundingBox = RectF(left, top, right, bottom),
                    imageWidth = originalWidth,
                    imageHeight = originalHeight,
                )
            )
        }
        detections.sortByDescending { it.confidence }
        return if (detections.size > 200) detections.subList(0, 200) else detections
    }

    private fun nonMaximumSuppression(detections: List<Detection>, iouThreshold: Float): List<Detection> {
        val remaining = detections.toMutableList() // already sorted by confidence
        val selected = ArrayList<Detection>()
        while (remaining.isNotEmpty() && selected.size < Constants.MAX_RESULTS) {
            val best = remaining.removeAt(0)
            selected.add(best)
            val it = remaining.iterator()
            while (it.hasNext()) {
                val other = it.next()
                // Per class, like the training benchmark: a pothole sits inside cracked road, and a
                // stronger crack box over the same spot must not erase the pothole.
                if (other.classId == best.classId && iou(best.boundingBox, other.boundingBox) > iouThreshold) it.remove()
            }
        }
        return selected
    }

    private fun iou(a: RectF, b: RectF): Float {
        val iw = max(0f, min(a.right, b.right) - max(a.left, b.left))
        val ih = max(0f, min(a.bottom, b.bottom) - max(a.top, b.top))
        val inter = iw * ih
        val union = a.width() * a.height() + b.width() * b.height() - inter
        return if (union <= 0f) 0f else inter / union
    }

    fun close() {
        if (closed) return
        closed = true
        interpreter.close()
        letterboxBitmap.recycle()
    }
}
