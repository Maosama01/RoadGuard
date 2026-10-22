package com.roadguard.app.database

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * A jolt felt in pocket mode, waiting to be sent to POST /api/sensor-hits. One jolt alone
 * proves little (speed breaker, door slam); the server only creates a hazard once several
 * drivers feel the same spot, or adds it to a hazard that is already known there.
 */
@Entity(tableName = "pending_hits", indices = [Index(value = ["clientId"], unique = true)])
data class PendingHit(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    /** Lets the server ignore a retry of something it already received. */
    val clientId: String,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Float,
    /** km/h */
    val speed: Float,
    val heading: Float?,
    /** Vertical jolt, m/s². */
    val shock: Float,
    val timestamp: Long,
)
