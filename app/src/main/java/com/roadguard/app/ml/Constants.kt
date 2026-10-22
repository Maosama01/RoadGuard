package com.roadguard.app.ml

object Constants {

    const val MODEL_NAME = "best.tflite"

    /** Fallback only: each model's real thresholds come from assets/model_config.json (see ModelConfig). */
    const val CONFIDENCE_THRESHOLD = 0.55f

    const val NMS_THRESHOLD = 0.45f

    const val MAX_RESULTS = 20

    const val NUM_THREADS = 4
}
