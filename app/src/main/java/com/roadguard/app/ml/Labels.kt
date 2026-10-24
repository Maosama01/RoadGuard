package com.roadguard.app.ml

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream

/**
 * Class names for the detector.
 *
 * Ultralytics appends a small zip containing metadata.json (with the class names) to the end
 * of every exported .tflite. Reading the names from the model itself means a retrained model
 * can never be silently mislabelled again. (The old hardcoded list called class 0 "Pothole",
 * but in this model class 0 is "Drain Hole" and potholes are class 1.)
 */
object Labels {

    private const val TAG = "RoadGuardLabels"
    private const val TAIL_BYTES = 256 * 1024

    /**
     * Names baked into the bundled best.tflite (v3, trained on RDD: ml/prepare_rdd.py), used if
     * the metadata can't be read. The order is the class index order.
     */
    val fallback = listOf("Pothole", "Alligator Crack", "Longitudinal Crack", "Transverse Crack")

    fun readFromModel(context: Context, assetName: String): List<String> {
        return try {
            // The metadata zip is tiny and sits at the very end of the file.
            val bytes = context.assets.open(assetName).use { input ->
                var toSkip = (input.available() - TAIL_BYTES).toLong()
                while (toSkip > 0) {
                    val skipped = input.skip(toSkip)
                    if (skipped <= 0) break
                    toSkip -= skipped
                }
                input.readBytes()
            }
            val start = lastZipHeader(bytes)
            if (start < 0) return fallback
            ZipInputStream(ByteArrayInputStream(bytes, start, bytes.size - start)).use { zip ->
                var entry = zip.nextEntry
                while (entry != null) {
                    if (entry.name.endsWith("metadata.json")) {
                        val json = JSONObject(zip.readBytes().toString(Charsets.UTF_8))
                        val names = json.optJSONObject("names") ?: return fallback
                        val list = (0 until names.length()).map { i -> names.optString(i.toString(), "Class $i") }
                        Log.i(TAG, "Model classes: $list")
                        return list
                    }
                    entry = zip.nextEntry
                }
            }
            fallback
        } catch (e: Exception) {
            Log.w(TAG, "Could not read class names from the model, using defaults", e)
            fallback
        }
    }

    /** Index of the last zip local-file header ("PK\u0003\u0004"), or -1. */
    private fun lastZipHeader(b: ByteArray): Int {
        var i = b.size - 4
        while (i >= 0) {
            if (b[i] == 0x50.toByte() && b[i + 1] == 0x4B.toByte() && b[i + 2] == 0x03.toByte() && b[i + 3] == 0x04.toByte()) {
                return i
            }
            i--
        }
        return -1
    }
}
