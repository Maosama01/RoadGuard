package com.roadguard.app.database

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface PendingReportDao {

    @Insert
    suspend fun insert(report: PendingReport): Long

    @Update
    suspend fun update(report: PendingReport)

    @Delete
    suspend fun delete(report: PendingReport)

    @Query("SELECT * FROM pending_reports WHERE state = 'pending' ORDER BY timestamp ASC")
    suspend fun pending(): List<PendingReport>

    @Query("SELECT * FROM pending_reports ORDER BY timestamp DESC")
    fun observeAll(): Flow<List<PendingReport>>

    @Query("SELECT COUNT(*) FROM pending_reports WHERE state = 'pending'")
    fun observePendingCount(): Flow<Int>

    @Query("UPDATE pending_reports SET state = 'pending', attempts = 0, lastError = NULL WHERE state = 'rejected'")
    suspend fun retryRejected(): Int

    @Query("SELECT * FROM pending_reports WHERE state = 'rejected'")
    suspend fun rejected(): List<PendingReport>
}
