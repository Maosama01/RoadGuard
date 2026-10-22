package com.roadguard.app.ml

import android.graphics.RectF
import com.roadguard.app.core.HazardKind

data class Detection(
    val classId: Int,
    val className: String,
    val kind: HazardKind,
    val confidence: Float,
    /** In pixels of the (rotated, upright) analysed frame. */
    val boundingBox: RectF,
    val imageWidth: Int,
    val imageHeight: Int,
    val timestamp: Long = System.currentTimeMillis(),
)
