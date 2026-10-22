package com.roadguard.app.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

/** Pocket mode jolts and drive routes waiting to be sent. */
@Dao
interface SensorDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertHit(hit: PendingHit): Long

    @Query("SELECT * FROM pending_hits ORDER BY timestamp ASC LIMIT :limit")
    suspend fun oldestHits(limit: Int): List<PendingHit>

    @Query("DELETE FROM pending_hits WHERE id IN (:ids)")
    suspend fun deleteHits(ids: List<Long>): Int

    /** The server ignores hits older than 14 days, so there's no point keeping them. */
    @Query("DELETE FROM pending_hits WHERE timestamp < :before")
    suspend fun deleteHitsBefore(before: Long): Int

    /** Inserts, or replaces the earlier save of the same drive (same clientId). */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveDrive(drive: PendingDrive): Long

    @Query(
        "SELECT * FROM pending_drives WHERE state = 'pending' " +
            "OR (state = 'recording' AND endedAt < :staleBefore) ORDER BY startedAt ASC"
    )
    suspend fun drivesToSend(staleBefore: Long): List<PendingDrive>

    @Query("DELETE FROM pending_drives WHERE clientId = :clientId")
    suspend fun deleteDrive(clientId: String): Int
}
