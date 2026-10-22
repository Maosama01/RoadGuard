package com.roadguard.app.utils

/**
 * Severity 0..100 from what the camera saw, what the car felt, and how fast it was going.
 * Thresholds match the backend (hazards.js severityLevel) so both sides agree.
 */
object SeverityCalculator {

    private const val CONFIDENCE_WEIGHT = 30f
    private const val AREA_WEIGHT = 30f
    private const val SHOCK_WEIGHT = 25f
    private const val SPEED_WEIGHT = 15f

    /**
     * A pothole filling ~6% of the frame is already big; scaling by this keeps the area term
     * from staying near zero for real-world box sizes.
     */
    private const val AREA_FOR_MAX = 0.06f

    /** Normalized bounding-box area, 0.0 to 1.0 of the frame. */
    fun calculateNormalizedBoundingBoxArea(
        boxWidth: Float,
        boxHeight: Float,
        imageWidth: Int,
        imageHeight: Int
    ): Float {
        if (imageWidth <= 0 || imageHeight <= 0 || boxWidth <= 0f || boxHeight <= 0f) return 0f
        val imageArea = imageWidth.toFloat() * imageHeight.toFloat()
        return ((boxWidth * boxHeight) / imageArea).coerceIn(0f, 1f)
    }

    fun calculateSeverity(
        confidence: Float,
        boundingBoxArea: Float,
        shockMagnitude: Float,
        speedKmh: Float
    ): SeverityResult {
        val normalizedConfidence = confidence.coerceIn(0f, 1f)
        val normalizedArea = (boundingBoxArea / AREA_FOR_MAX).coerceIn(0f, 1f)
        // 15 m/s² or more gives the full shock contribution.
        val normalizedShock = (shockMagnitude / 15f).coerceIn(0f, 1f)
        // 80 km/h or more gives the full speed contribution.
        val normalizedSpeed = (speedKmh / 80f).coerceIn(0f, 1f)

        val score = (normalizedConfidence * CONFIDENCE_WEIGHT) +
            (normalizedArea * AREA_WEIGHT) +
            (normalizedShock * SHOCK_WEIGHT) +
            (normalizedSpeed * SPEED_WEIGHT)

        val finalScore = score.coerceIn(0f, 100f)
        return SeverityResult(score = finalScore, level = levelFor(finalScore))
    }

    fun levelFor(score: Float): SeverityLevel = when {
        score >= 80f -> SeverityLevel.CRITICAL
        score >= 60f -> SeverityLevel.HIGH
        score >= 40f -> SeverityLevel.MEDIUM
        else -> SeverityLevel.LOW
    }
}

enum class SeverityLevel(val label: String) {
    LOW("Low"),
    MEDIUM("Medium"),
    HIGH("High"),
    CRITICAL("Critical");

    companion object {
        fun from(value: String?): SeverityLevel =
            entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: LOW
    }
}

data class SeverityResult(
    val score: Float,
    val level: SeverityLevel
)
