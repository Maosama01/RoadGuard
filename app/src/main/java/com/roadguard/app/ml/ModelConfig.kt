package com.roadguard.app.ml

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Confidence thresholds that belong to a specific model.
 *
 * Every model is calibrated differently: a threshold that suits one can hide almost everything
 * another sees. So each model ships with assets/model_config.json, written by
 * ml/calibrate.py from the validation split (never the test split):
 *
 *  * [detectThreshold]: lowest confidence that counts as a sighting (the best-F1 point).
 *  * [reportThreshold]: a sighting the car didn't feel is still reported above this.
 *  * [singleHitThreshold]: one frame alone is trusted above this (otherwise two are needed).
 */
data class ModelConfig(
    val detectThreshold: Float,
    val reportThreshold: Float,
    val singleHitThreshold: Float,
) {
    companion object {
        const val ASSET = "model_config.json"

        /** The values the original 1024 px model was tuned with. */
        val DEFAULT = ModelConfig(detectThreshold = 0.55f, reportThreshold = 0.70f, singleHitThreshold = 0.75f)

        fun load(context: Context): ModelConfig = try {
            val json = context.assets.open(ASSET).bufferedReader().use { it.readText() }
            val o = JSONObject(json)
            ModelConfig(
                detectThreshold = o.optDouble("detectThreshold", DEFAULT.detectThreshold.toDouble()).toFloat(),
                reportThreshold = o.optDouble("reportThreshold", DEFAULT.reportThreshold.toDouble()).toFloat(),
                singleHitThreshold = o.optDouble("singleHitThreshold", DEFAULT.singleHitThreshold.toDouble()).toFloat(),
            ).also { Log.i("RoadGuardModel", "Model thresholds: $it") }
        } catch (e: Exception) {
            DEFAULT
        }
    }
}
