package com.roadguard.app.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.roadguard.app.R
import com.roadguard.app.RoadGuardApp
import com.roadguard.app.activities.HomeActivity
import com.roadguard.app.core.AlertEngine
import com.roadguard.app.core.BumpDetector
import com.roadguard.app.core.GeoUtils
import com.roadguard.app.data.SensorQueue
import com.roadguard.app.data.Settings
import com.roadguard.app.database.PendingHit
import com.roadguard.app.location.LocationData
import com.roadguard.app.location.LocationHelper
import com.roadguard.app.scan.DriveLog
import com.roadguard.app.scan.HazardAlerts
import com.roadguard.app.ui.Ui
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * Pocket mode: no camera, no mount. GPS plus the accelerometer feel potholes while the phone
 * sits in a pocket or a holder, and known hazards are announced out loud like in a camera
 * drive. Jolts are saved on the phone and sent in batches; the route is sent when it stops.
 *
 * A foreground service of type "location" with a persistent notification (Stop action). It is
 * only started from the app while it is on screen, after location permission was granted:
 * Android 14 refuses a location service otherwise. Not restarted by the system if killed
 * (a restart from the background isn't allowed to use location); the route saved so far is
 * still sent.
 */
class PocketScanService : Service(), SensorEventListener {

    data class State(
        val running: Boolean = false,
        val startedAt: Long = 0,
        val meters: Double = 0.0,
        val jolts: Int = 0,
        /** Null until hazards around the car have loaded. */
        val knownHazards: Int? = null,
    )

    companion object {
        const val ACTION_START = "com.roadguard.app.action.START_POCKET"
        const val ACTION_STOP = "com.roadguard.app.action.STOP_POCKET"

        private const val TAG = "RoadGuardPocket"
        private const val CHANNEL_ID = "scanning"
        private const val NOTIFICATION_ID = 4101
        private const val MAX_FIX_AGE_MS = 3_000L
        private const val MAX_HIT_ACCURACY_M = 30f
        private const val WAKE_LOCK_MS = 6 * 60 * 60 * 1000L
        private const val MAX_SPEED_AGE_MS = 3_000L
        private const val ALERT_CHANNEL_ID = "roadguard-hazard-alerts"
        private const val ALERT_NOTIFICATION_ID = 4102
        private const val ALERT_VISIBLE_MS = 45_000L
        private const val TICK_MS = 30_000L
        private const val NOTIFY_EVERY_MS = 10_000L
        private const val UPLOAD_EVERY_HITS = 25
        private const val UPLOAD_EVERY_MS = 5 * 60_000L

        private val _state = MutableStateFlow(State())
        val state: StateFlow<State> = _state.asStateFlow()
        val isRunning: Boolean get() = _state.value.running

        /**
         * Starts pocket mode. Call from a visible screen, after location permission was
         * granted. Returns false if it couldn't start.
         */
        fun start(context: Context): Boolean {
            if (!LocationHelper.hasPermission(context)) return false
            return try {
                ContextCompat.startForegroundService(
                    context, Intent(context, PocketScanService::class.java).setAction(ACTION_START)
                )
                true
            } catch (e: Exception) {
                // e.g. ForegroundServiceStartNotAllowedException when the app isn't in front.
                Log.w(TAG, "Pocket mode not started", e)
                false
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PocketScanService::class.java))
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val main = Handler(Looper.getMainLooper())
    private val detector = BumpDetector()

    private var scanning = false
    private var sensorManager: SensorManager? = null
    private var locationHelper: LocationHelper? = null
    private var alerts: HazardAlerts? = null
    private var driveLog: DriveLog? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private var lastFix: LocationData? = null
    /** Wall-clock arrival time of [lastFix]. */
    private var lastFixAt = 0L
    private var speedKmh = 0f
    private var jolts = 0
    private var hitsSinceUpload = 0
    private var lastUploadAt = 0L
    private var lastNotifyAt = 0L
    private var lastHitSave: Job? = null
    private var wakeLockAt = 0L

    private fun renewWakeLock(lock: PowerManager.WakeLock) {
        lock.acquire(WAKE_LOCK_MS)
        wakeLockAt = System.currentTimeMillis()
    }

    private val tick = object : Runnable {
        override fun run() {
            driveLog?.maybeCheckpoint()
            // The wake lock has a time limit as a safety net; renew it for drives longer than that.
            wakeLock?.let { if (!it.isHeld || System.currentTimeMillis() - wakeLockAt > WAKE_LOCK_MS / 2) renewWakeLock(it) }
            if (hitsSinceUpload > 0 && System.currentTimeMillis() - lastUploadAt >= UPLOAD_EVERY_MS) scheduleUpload()
            publish()
            main.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopScanning()
            return START_NOT_STICKY
        }
        // Started with startForegroundService(): must go foreground within seconds, every time.
        if (!goForeground()) {
            // Still honour the startForegroundService() contract before stopping, where the OS
            // allows it, so the system doesn't kill the app for skipping startForeground().
            try {
                createChannel()
                ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), 0)
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            } catch (e: Exception) {
                Log.w(TAG, "Stopping without a foreground notification", e)
            }
            stopSelf()
            return START_NOT_STICKY
        }
        if (!scanning) startScanning()
        return START_NOT_STICKY
    }

    private fun goForeground(): Boolean {
        if (!LocationHelper.hasPermission(this)) return false
        return try {
            createChannel()
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "Could not go foreground", e)
            false
        }
    }

    private fun startScanning() {
        scanning = true
        val now = System.currentTimeMillis()
        jolts = 0
        hitsSinceUpload = 0
        lastUploadAt = now
        detector.reset()
        detector.threshold = Settings.shockThreshold

        driveLog = DriveLog(this, DriveLog.MODE_POCKET)
        alerts = HazardAlerts(this, scope, onAlert = { showHazardAlert(it) }, onHazardsChanged = { publish() })
        locationHelper = LocationHelper(this) { onLocation(it) }.also { it.startLocationUpdates() }

        val sm = getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        sensorManager = sm
        val accelerometer = sm?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        if (sm != null && accelerometer != null) {
            sm.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME)
        } else {
            Log.w(TAG, "No accelerometer: pocket mode only records the route and gives warnings")
            alerts?.canFeelJolts = false
        }

        // The phone is in a pocket with the screen off; keep the CPU awake for the sensors.
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RoadGuard:pocket")?.apply {
            setReferenceCounted(false)
        }?.also { renewWakeLock(it) }

        _state.value = State(running = true, startedAt = now)
        main.postDelayed(tick, TICK_MS)
        updateNotification(force = true)
    }

    private fun stopScanning() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        if (scanning) {
            scanning = false
            sensorManager?.unregisterListener(this)
            locationHelper?.stopLocationUpdates()
            alerts?.release()
            driveLog?.finish()
            val pendingHits = lastHitSave
            val app = applicationContext
            RoadGuardApp.appScope.launch {
                pendingHits?.join()
                SensorQueue.scheduleUpload(app)
            }
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
        }
        scope.cancel()
        _state.value = State()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ sensors

    private fun onLocation(d: LocationData) {
        lastFix = d
        lastFixAt = System.currentTimeMillis()
        speedKmh = d.speedKmh
        driveLog?.onLocation(d)
        alerts?.onLocation(d)
        publish()
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER || event.values.size < 3) return
        val sensorMs = event.timestamp / 1_000_000L
        // A speed from before GPS dropped out (tunnel, flyover) is not the speed now.
        val speed = if (System.currentTimeMillis() - lastFixAt > MAX_SPEED_AGE_MS) 0f else speedKmh
        val hit = detector.onSample(event.values[0], event.values[1], event.values[2], sensorMs, speed) ?: return
        // Sensor clock (time since boot) to wall clock.
        val ageMs = ((SystemClock.elapsedRealtimeNanos() - event.timestamp) / 1_000_000L).coerceIn(0L, 2_000L)
        val at = System.currentTimeMillis() - ageMs - (sensorMs - hit.timestamp)
        onJolt(hit.magnitude, at)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun onJolt(magnitude: Float, at: Long) {
        alerts?.onShock(at)
        val fix = lastFix
        val age = at - lastFixAt
        if (fix == null || age !in -MAX_FIX_AGE_MS..MAX_FIX_AGE_MS || fix.accuracyMeters > MAX_HIT_ACCURACY_M) {
            // Without a good position the city can't use it, so it isn't counted on screen either
            // (the count used to include these, and then the dashboard showed fewer).
            Log.i(TAG, "Jolt felt but not recorded: GPS ${fix?.accuracyMeters ?: "none"} m, ${age / 1000} s old")
        }
        if (fix != null && age in -MAX_FIX_AGE_MS..MAX_FIX_AGE_MS && fix.accuracyMeters <= MAX_HIT_ACCURACY_M) {
            jolts++
            // GPS updates once a second; move the fix forward to where the car was at the jolt.
            var lat = fix.latitude
            var lng = fix.longitude
            val bearing = fix.bearing
            val seconds = (age / 1000.0).coerceIn(0.0, 2.0)
            if (bearing != null && seconds > 0) {
                val moved = GeoUtils.offset(lat, lng, bearing.toDouble(), fix.speedKmh / 3.6 * seconds)
                lat = moved.first
                lng = moved.second
            }
            val row = PendingHit(
                clientId = UUID.randomUUID().toString(),
                latitude = lat,
                longitude = lng,
                accuracy = fix.accuracyMeters,
                speed = fix.speedKmh,
                heading = bearing,
                shock = magnitude,
                timestamp = at,
            )
            hitsSinceUpload++
            val uploadNow = hitsSinceUpload >= UPLOAD_EVERY_HITS
            if (uploadNow) {
                hitsSinceUpload = 0
                lastUploadAt = System.currentTimeMillis()
            }
            val app = applicationContext
            val previous = lastHitSave
            lastHitSave = RoadGuardApp.appScope.launch {
                previous?.join()
                try {
                    SensorQueue.addHit(app, row)
                    if (uploadNow) SensorQueue.scheduleUpload(app)
                } catch (e: Exception) {
                    Log.w(TAG, "Jolt not saved", e)
                }
            }
        }
        publish()
    }

    private fun scheduleUpload() {
        hitsSinceUpload = 0
        lastUploadAt = System.currentTimeMillis()
        SensorQueue.scheduleUpload(applicationContext)
    }

    // ------------------------------------------------------------------ state and notification

    private fun publish() {
        if (!scanning) return
        val a = alerts
        _state.value = _state.value.copy(
            meters = driveLog?.distanceMeters ?: 0.0,
            jolts = jolts,
            knownHazards = if (a != null && a.hasLoaded) a.hazardCount else null,
        )
        updateNotification(force = false)
    }

    /**
     * The phone is in a pocket, so the spoken warning is the main one. This pop-up carries the
     * same details for a glance at the lock screen or a watch, and clears itself once passed.
     */
    private fun showHazardAlert(alert: AlertEngine.Alert) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val res = Ui.localized(this)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(ALERT_CHANNEL_ID, res.getString(R.string.hazard_alert_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
                description = res.getString(R.string.hazard_alert_channel_description)
                // The voice and the vibration pattern already alert; the pop-up stays quiet.
                setSound(null, null)
                enableVibration(false)
            }
        )
        val h = alert.hazard
        val details = listOfNotNull(
            h.roadName?.let { res.getString(R.string.alert_speech_road, it) },
            if (h.reportCount > 1) res.resources.getQuantityString(R.plurals.alert_speech_drivers, h.reportCount, h.reportCount) else null,
        ).joinToString(" ")
        val open = packageManager.getLaunchIntentForPackage(packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            ?: Intent(this, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val n = NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_pocket)
            .setContentTitle(res.getString(R.string.hazard_alert_title, HazardAlerts.whatAhead(res, h), HazardAlerts.roundedMeters(alert)))
            .setContentText(details.ifBlank { null })
            .setColor(Ui.severityColor(this, h.severityLevel))
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setTimeoutAfter(ALERT_VISIBLE_MS)
            .setContentIntent(
                PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            )
            .build()
        nm.notify(ALERT_NOTIFICATION_ID, n)
    }

    private fun createChannel() {
        // A service doesn't follow the language picked in Settings on Android 12 and below.
        val res = Ui.localized(this)
        val channel = NotificationChannel(
            CHANNEL_ID, res.getString(R.string.pocket_channel_name), NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = res.getString(R.string.pocket_channel_description)
            setShowBadge(false)
        }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val s = _state.value
        val open = packageManager.getLaunchIntentForPackage(packageName)
            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            ?: Intent(this, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val openIntent = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stopIntent = PendingIntent.getService(
            this, 1, Intent(this, PocketScanService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val res = Ui.localized(this)
        val text = if (!s.running || lastFix == null) {
            res.getString(R.string.pocket_notif_starting)
        } else {
            res.getString(
                R.string.pocket_notif_text,
                Ui.oneDecimal(s.meters / 1000),
                res.resources.getQuantityString(R.plurals.pocket_jolts, s.jolts, s.jolts),
            )
        }
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_pocket)
            .setContentTitle(res.getString(R.string.pocket_notif_title))
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setColor(ContextCompat.getColor(this, R.color.lane))
            .setContentIntent(openIntent)
            .addAction(R.drawable.ic_stop, res.getString(R.string.pocket_stop), stopIntent)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun updateNotification(force: Boolean) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastNotifyAt < NOTIFY_EVERY_MS) return
        lastNotifyAt = now
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION_ID, buildNotification())
    }
}
