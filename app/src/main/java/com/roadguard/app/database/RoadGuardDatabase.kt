package com.roadguard.app.database

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(entities = [PendingReport::class, PendingHit::class, PendingDrive::class], version = 3, exportSchema = true)
abstract class RoadGuardDatabase : RoomDatabase() {

    abstract fun dao(): PendingReportDao

    abstract fun sensorDao(): SensorDao

    companion object {
        @Volatile
        private var instance: RoadGuardDatabase? = null

        /**
         * Version 3 adds pocket mode jolts and drive routes. It only creates tables, so reports
         * still waiting to be sent survive the update. The SQL must match what Room generates
         * for [PendingHit] and [PendingDrive] exactly, or Room rejects the migrated database.
         */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_hits` (" +
                        "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`clientId` TEXT NOT NULL, " +
                        "`latitude` REAL NOT NULL, " +
                        "`longitude` REAL NOT NULL, " +
                        "`accuracy` REAL NOT NULL, " +
                        "`speed` REAL NOT NULL, " +
                        "`heading` REAL, " +
                        "`shock` REAL NOT NULL, " +
                        "`timestamp` INTEGER NOT NULL)"
                )
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_pending_hits_clientId` ON `pending_hits` (`clientId`)")
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `pending_drives` (" +
                        "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`clientId` TEXT NOT NULL, " +
                        "`mode` TEXT NOT NULL, " +
                        "`startedAt` INTEGER NOT NULL, " +
                        "`endedAt` INTEGER NOT NULL, " +
                        "`distanceMeters` REAL NOT NULL, " +
                        "`pathJson` TEXT NOT NULL, " +
                        "`state` TEXT NOT NULL)"
                )
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS `index_pending_drives_clientId` ON `pending_drives` (`clientId`)")
            }
        }

        fun get(context: Context): RoadGuardDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    RoadGuardDatabase::class.java,
                    "roadguard.db"
                )
                    .addMigrations(MIGRATION_2_3)
                    // Version 1 was never usable (Room's processor wasn't configured), so
                    // there is nothing to migrate from. Only versions without a migration
                    // above fall back to a fresh database.
                    .fallbackToDestructiveMigration(true)
                    .build()
                    .also { instance = it }
            }
    }
}
