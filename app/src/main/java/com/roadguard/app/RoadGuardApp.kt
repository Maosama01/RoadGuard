package com.roadguard.app

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import com.roadguard.app.data.ReportQueue
import com.roadguard.app.data.Session
import com.roadguard.app.data.Settings
import org.osmdroid.config.Configuration
import java.io.File

class RoadGuardApp : Application() {

    companion object {
        /** Outlives any screen: a report confirmed as a drive ends must still be saved. */
        val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        /** For text built where no screen is at hand (network errors). Set before any component runs. */
        lateinit var instance: RoadGuardApp
            private set
    }

    init {
        instance = this
    }

    override fun onCreate() {
        super.onCreate()
        Session.init(this)
        Settings.init(this)

        // OpenStreetMap tiles: identify ourselves and cache tiles in app storage (no permission needed).
        Configuration.getInstance().apply {
            userAgentValue = packageName
            osmdroidBasePath = File(cacheDir, "osmdroid")
            osmdroidTileCache = File(cacheDir, "osmdroid/tiles")
        }

        // Anything saved while offline last time goes out as soon as there is network.
        if (Session.canUseApp) ReportQueue.scheduleUpload(this)
    }
}
