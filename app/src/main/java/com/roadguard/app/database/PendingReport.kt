package com.roadguard.app.database

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A sighting saved on the phone, waiting to be sent. Reports are always stored first so no
 * pothole is lost to a dead zone; the upload worker sends them when there is network.
 */
@Entity(tableName = "pending_reports", indices = [Index(value = ["clientId"], unique = true)])
data class PendingReport(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    /** Lets the server ignore a retry of something it already received. */
    val clientId: String,
    val type: String,
    val source: String,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Float,
    val heading: Float?,
    val speed: Float,
    val confidence: Float,
    val shock: Float,
    val severityScore: Float,
    val severityLevel: String,
    val roadName: String?,
    val imagePath: String?,
    val timestamp: Long,
    val attempts: Int = 0,
    val state: String = STATE_PENDING,
    val lastError: String? = null,
) {
    companion object {
        const val STATE_PENDING = "pending"
        /** The server refused it for good (e.g. too old); shown to the user, not retried. */
        const val STATE_REJECTED = "rejected"
    }
}
