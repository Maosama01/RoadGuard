package com.roadguard.app.database

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * The route of one drive (camera or pocket mode), for road coverage. Saved every minute while
 * recording so a crash or a killed app loses at most a minute, and sent to POST /api/drives
 * once the drive ends.
 */
@Entity(tableName = "pending_drives", indices = [Index(value = ["clientId"], unique = true)])
data class PendingDrive(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    val clientId: String,
    /** "camera" or "pocket". */
    val mode: String,
    val startedAt: Long,
    /** While recording: the time of the last save. */
    val endedAt: Long,
    val distanceMeters: Double,
    /** `[[lat, lng, timestamp], ...]`, already in the shape the server expects. */
    val pathJson: String,
    val state: String = STATE_RECORDING,
) {
    companion object {
        /** Still being driven. Sent anyway if it hasn't been saved for a long time (the app died). */
        const val STATE_RECORDING = "recording"
        const val STATE_PENDING = "pending"
    }
}
