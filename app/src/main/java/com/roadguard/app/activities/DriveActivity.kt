package com.roadguard.app.activities

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RectF
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings as AndroidSettings
import android.util.Log
import android.util.Size
import android.view.Surface
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.roadguard.app.BuildConfig
import androidx.lifecycle.lifecycleScope
import com.roadguard.app.R
import com.roadguard.app.RoadGuardApp
import com.roadguard.app.camera.FrameAnalyzer
import com.roadguard.app.core.AlertEngine
import com.roadguard.app.core.DetectionFusion
import com.roadguard.app.core.HazardKind
import com.roadguard.app.data.ReportQueue
import com.roadguard.app.data.Settings
import com.roadguard.app.database.PendingReport
import com.roadguard.app.databinding.ActivityDriveBinding
import com.roadguard.app.location.LocationData
import com.roadguard.app.location.LocationHelper
import com.roadguard.app.ml.Detection
import com.roadguard.app.ml.ModelConfig
import com.roadguard.app.ml.YOLODetector
import com.roadguard.app.scan.DriveLog
import com.roadguard.app.scan.HazardAlerts
import com.roadguard.app.sensor.AccelerometerManager
import com.roadguard.app.service.PocketScanService
import com.roadguard.app.ui.Ui
import com.roadguard.app.ui.padForSystemBars
import com.roadguard.app.ui.visible
import com.roadguard.app.utils.ImageUtils
import com.roadguard.app.utils.SeverityCalculator
import com.roadguard.app.utils.SeverityLevel
import com.roadguard.app.utils.SeverityResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Drive mode: the phone on the dashboard becomes a road scanner.
 *
 * Camera + YOLO find hazards, the accelerometer feels jolts, GPS says where. [DetectionFusion]
 * decides what becomes a report; reports are saved locally and uploaded in the background.
 * Meanwhile [HazardAlerts] warns about hazards other drivers already reported, and [DriveLog]
 * records the route so the city knows this road was checked.
 */
class DriveActivity : AppCompatActivity(), FrameAnalyzer.Listener {

    private enum class Status { STARTING, SCANNING, NO_GPS, WEAK_GPS, NO_LOCATION, APPROXIMATE_ONLY, LOCATION_OFF, ERROR }

    private lateinit var binding: ActivityDriveBinding
    private val cameraExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private var detector: YOLODetector? = null
    private var analyzer: FrameAnalyzer? = null
    private var preview: Preview? = null
    private var imageAnalysis: ImageAnalysis? = null

    /** Uses the thresholds calibrated for the bundled model. */
    private val fusion by lazy {
        val model = ModelConfig.load(applicationContext)
        DetectionFusion(
            DetectionFusion.Config(
                mergeWindowMs = 2_500,
                requireShock = Settings.requireBump,
                singleHitConfidence = model.singleHitThreshold,
                visualOnlyMinConfidence = model.reportThreshold,
            )
        )
    }
    private lateinit var hazardAlerts: HazardAlerts
    private lateinit var driveLog: DriveLog

    private lateinit var locationHelper: LocationHelper
    private lateinit var accelerometer: AccelerometerManager

    @Volatile
    private var latestFix: DetectionFusion.Fix? = null
    private var lastLocation: LocationData? = null
    private var status = Status.STARTING

    private var reportedThisDrive = 0

    // Analysis rate shown under the status (proves the AI is alive).
    private var framesInWindow = 0
    private var windowStart = SystemClock.elapsedRealtime()
    private var lastInferenceMs = 0L
    private var lastErrorShownAt = 0L

    @Volatile
    private var destroyed = false

    /** Catches 180° flips (landscape to reverse landscape), which don't count as a configuration change. */
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit
        override fun onDisplayRemoved(displayId: Int) = Unit
        override fun onDisplayChanged(displayId: Int) = updateRotation()
    }

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            val camera = result[Manifest.permission.CAMERA] ?: hasPermission(Manifest.permission.CAMERA)
            if (camera) startEverything() else showPermissionPanel()
        }

    /** Asked again from the status pill when location was refused or only approximate. */
    private val locationLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            if (LocationHelper.hasPermission(this)) locationHelper.startLocationUpdates()
            refreshStatus()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        binding = ActivityDriveBinding.inflate(layoutInflater)
        setContentView(binding.root)
        hazardAlerts = HazardAlerts(this, lifecycleScope, onAlert = { showAlert(it) }, onHazardsChanged = { updateHud() })
        driveLog = DriveLog(this, DriveLog.MODE_CAMERA)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        binding.topBar.padForSystemBars(top = true)
        binding.bottomArea.padForSystemBars(top = false, bottom = true)

        binding.btnClose.setOnClickListener { confirmEnd() }
        // Back (button or gesture) ends the drive the same way, with a summary, never silently.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = confirmEnd()
        })
        binding.statusPill.setOnClickListener { onStatusTapped() }
        binding.txtStatusDetail.setOnClickListener { onStatusTapped() }
        binding.btnPermissionClose.setOnClickListener { finish() }
        binding.btnGrant.setOnClickListener { onGrantClicked() }
        binding.btnMark.setOnClickListener { markHazardManually() }
        binding.btnVoice.setOnClickListener {
            Settings.voiceAlerts = !Settings.voiceAlerts
            updateVoiceIcon()
            Toast.makeText(this, if (Settings.voiceAlerts) R.string.drive_voice_on else R.string.drive_voice_off, Toast.LENGTH_SHORT).show()
        }
        binding.btnTipOk.setOnClickListener {
            Settings.showMountTip = false
            binding.mountTip.visible(false)
        }
        binding.mountTip.visible(Settings.showMountTip)
        updateVoiceIcon()
        updateHud()
        setStatus(Status.STARTING)

        accelerometer = AccelerometerManager(this) { shock ->
            fusion.onShock(shock.magnitude, shock.timestamp)
            hazardAlerts.onShock(shock.timestamp)
        }
        accelerometer.setShockThreshold(Settings.shockThreshold)
        locationHelper = LocationHelper(this) { onLocation(it) }

        requestPermissionsIfNeeded()
    }

    // ------------------------------------------------------------------ permissions

    private fun hasPermission(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun requestPermissionsIfNeeded() {
        // Precise location must be requested together with approximate on Android 12+.
        val needed = listOf(
            Manifest.permission.CAMERA,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ).filterNot { hasPermission(it) }
        if (needed.isEmpty()) startEverything() else permissionLauncher.launch(needed.toTypedArray())
    }

    private fun showPermissionPanel() {
        binding.permissionPanel.visible(true)
    }

    private fun onGrantClicked() {
        when {
            hasPermission(Manifest.permission.CAMERA) -> startEverything()
            shouldShowRequestPermissionRationale(Manifest.permission.CAMERA) -> requestPermissionsIfNeeded()
            // "Don't ask again" was chosen: only the app's system settings can grant it now.
            else -> startActivity(
                Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
            )
        }
    }

    override fun onRestart() {
        super.onRestart()
        // Back from system settings with permissions granted.
        if (binding.permissionPanel.visibility == android.view.View.VISIBLE && hasPermission(Manifest.permission.CAMERA)) {
            startEverything()
        }
    }

    private var started = false

    private fun startEverything() {
        binding.permissionPanel.visible(false)
        // The camera drive does everything pocket mode does; two would warn twice.
        if (PocketScanService.isRunning) {
            PocketScanService.stop(this)
            Toast.makeText(this, R.string.pocket_paused_for_camera, Toast.LENGTH_SHORT).show()
        }
        if (LocationHelper.hasPermission(this)) locationHelper.startLocationUpdates()
        // Keep "Getting ready" until the detector is loaded; location problems show right after.
        if (detector != null) setStatus(statusFromGps())
        if (started) return
        started = true
        lifecycleScope.launch {
            val loaded = withContext(Dispatchers.Default) { runCatching { YOLODetector(applicationContext) } }
            loaded.onSuccess {
                detector = it
                startCamera(it)
            }.onFailure {
                Log.e(TAG, "Model failed to load", it)
                setStatus(Status.ERROR, getString(R.string.drive_error_model) + debugSuffix(it))
            }
        }
    }

    // ------------------------------------------------------------------ camera

    private fun startCamera(detector: YOLODetector) {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                val selector = ResolutionSelector.Builder()
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                    .build()
                val rotation = binding.previewView.display?.rotation ?: Surface.ROTATION_0

                val previewUseCase = Preview.Builder()
                    .setResolutionSelector(selector)
                    .setTargetRotation(rotation)
                    .build()
                previewUseCase.setSurfaceProvider(binding.previewView.surfaceProvider)

                // The model looks at 1024 px; without this CameraX hands it 640x480 frames.
                val analysisSelector = ResolutionSelector.Builder()
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                    .setResolutionStrategy(
                        ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
                    )
                    .build()
                val analysisUseCase = ImageAnalysis.Builder()
                    .setResolutionSelector(analysisSelector)
                    .setTargetRotation(rotation)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                // Only hand out a fresh position: an old one would put the pothole in the wrong place.
                val frameAnalyzer = FrameAnalyzer(detector, fusion, {
                    latestFix?.takeIf { System.currentTimeMillis() - it.timestamp < MAX_FIX_AGE_MS }
                }, this)
                analysisUseCase.setAnalyzer(cameraExecutor, frameAnalyzer)

                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysisUseCase)

                preview = previewUseCase
                imageAnalysis = analysisUseCase
                analyzer = frameAnalyzer
                setStatus(statusFromGps())
            } catch (e: Exception) {
                Log.e(TAG, "Camera failed", e)
                setStatus(Status.ERROR, getString(R.string.drive_error_camera_friendly) + debugSuffix(e))
            }
        }, ContextCompat.getMainExecutor(this))
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // The activity isn't recreated on rotation (the model is expensive to reload),
        // so tell the camera which way is up.
        updateRotation()
    }

    private fun updateRotation() {
        val rotation = binding.previewView.display?.rotation ?: return
        preview?.setTargetRotation(rotation)
        imageAnalysis?.setTargetRotation(rotation)
    }

    // ------------------------------------------------------------------ analyzer callbacks (analysis thread)

    override fun onFrameResult(detections: List<Detection>, imageWidth: Int, imageHeight: Int, inferenceMs: Long) {
        lastInferenceMs = inferenceMs
        binding.overlay.post {
            framesInWindow++
            binding.overlay.setResults(detections, imageWidth, imageHeight)
            val now = SystemClock.elapsedRealtime()
            val elapsed = now - windowStart
            if (elapsed >= 2_000) {
                val fps = framesInWindow * 1000f / elapsed
                framesInWindow = 0
                windowStart = now
                // Frame rate is for developers; drivers just need to know it's watching.
                if (status == Status.SCANNING && BuildConfig.DEBUG) {
                    binding.txtStatusDetail.text = getString(R.string.drive_detail_fps, fps)
                }
            }
        }
    }

    override fun onHazardConfirmed(confirmed: DetectionFusion.Confirmed, photo: Bitmap?, box: RectF?) {
        val computed = SeverityCalculator.calculateSeverity(
            confirmed.confidence, confirmed.boxArea, confirmed.shock, confirmed.fix.speedKmh
        )
        // Cracks are a warning sign, not an emergency: never above medium.
        val severity = if (confirmed.kind == HazardKind.CRACK && computed.score > CRACK_MAX_SEVERITY) {
            SeverityResult(CRACK_MAX_SEVERITY, SeverityCalculator.levelFor(CRACK_MAX_SEVERITY))
        } else computed
        val imagePath = photo?.let {
            try {
                ImageUtils.saveReportPhoto(applicationContext, it, box)
            } catch (e: Exception) {
                Log.w(TAG, "Photo not saved", e)
                null
            } finally {
                it.recycle()
            }
        }
        val report = PendingReport(
            clientId = UUID.randomUUID().toString(),
            type = confirmed.kind.apiType,
            source = "auto",
            latitude = confirmed.fix.latitude,
            longitude = confirmed.fix.longitude,
            accuracy = confirmed.fix.accuracyMeters,
            heading = confirmed.fix.bearing,
            speed = confirmed.fix.speedKmh,
            confidence = confirmed.confidence,
            shock = confirmed.shock,
            severityScore = severity.score,
            severityLevel = severity.level.name,
            roadName = null,
            imagePath = imagePath,
            timestamp = confirmed.detectedAt,
        )
        RoadGuardApp.appScope.launch { ReportQueue.add(applicationContext, report) }

        if (destroyed) return
        main.post {
            reportedThisDrive++
            updateHud()
            val word = Ui.severityWord(this, severity.level.name)
            showConfirmation(
                getString(R.string.drive_reported_title, Ui.kindName(this, confirmed.kind)),
                getString(if (confirmed.shock > 0f) R.string.drive_reported_felt else R.string.drive_reported_seen, word),
            )
            vibrate(longArrayOf(0, 60))
        }
    }

    override fun onAnalysisError(error: Throwable) {
        Log.e(TAG, "Analysis failed", error)
        val now = SystemClock.elapsedRealtime()
        if (now - lastErrorShownAt > 10_000) {
            lastErrorShownAt = now
            if (BuildConfig.DEBUG) {
                main.post { binding.txtStatusDetail.text = getString(R.string.drive_skipped_frame, error.javaClass.simpleName) }
            }
        }
    }

    // ------------------------------------------------------------------ location

    private fun onLocation(d: LocationData) {
        driveLog.onLocation(d)
        lastLocation = d
        // Stamped with arrival time: GPS time can drift from the phone clock used for freshness checks.
        latestFix = DetectionFusion.Fix(d.latitude, d.longitude, d.accuracyMeters, d.speedKmh, d.bearing, System.currentTimeMillis())

        binding.txtSpeed.text = d.speedKmh.toInt().toString()
        if (detector != null && status != Status.ERROR) setStatus(statusFromGps())
        updateHud()
        hazardAlerts.onLocation(d)
    }

    private fun statusFromGps(): Status {
        if (!LocationHelper.hasPermission(this)) return Status.NO_LOCATION
        if (!LocationHelper.hasPrecise(this)) return Status.APPROXIMATE_ONLY
        if (!isLocationSwitchOn()) return Status.LOCATION_OFF
        val d = lastLocation ?: return Status.NO_GPS
        return if (d.accuracyMeters > 25f) Status.WEAK_GPS else Status.SCANNING
    }

    private fun isLocationSwitchOn(): Boolean {
        val lm = getSystemService(LOCATION_SERVICE) as? android.location.LocationManager ?: return true
        return LocationManagerCompat.isLocationEnabled(lm)
    }

    private fun refreshStatus() {
        if (detector != null && status != Status.ERROR) setStatus(statusFromGps())
    }

    /** Every location problem on the status pill is one tap from being fixed. */
    private fun onStatusTapped() {
        val fine = Manifest.permission.ACCESS_FINE_LOCATION
        val coarse = Manifest.permission.ACCESS_COARSE_LOCATION
        when (status) {
            Status.NO_LOCATION, Status.APPROXIMATE_ONLY -> {
                val askedBefore = Settings.askedLocationOnce
                Settings.askedLocationOnce = true
                // Android only shows its dialog again if the user hasn't chosen "Don't allow" twice.
                if (!askedBefore || shouldShowRequestPermissionRationale(fine) || shouldShowRequestPermissionRationale(coarse)) {
                    locationLauncher.launch(arrayOf(fine, coarse))
                } else {
                    Toast.makeText(this, R.string.location_blocked_hint, Toast.LENGTH_LONG).show()
                    openAppSettings()
                }
            }
            Status.LOCATION_OFF -> try {
                startActivity(Intent(AndroidSettings.ACTION_LOCATION_SOURCE_SETTINGS))
            } catch (_: Exception) {
                openAppSettings()
            }
            Status.ERROR -> recreate()
            else -> Unit
        }
    }

    private fun openAppSettings() {
        startActivity(Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    private fun debugSuffix(t: Throwable): String = if (BuildConfig.DEBUG) " (${t.message})" else ""

    /** Ends the drive with a short summary, unless nothing happened yet. */
    private fun confirmEnd() {
        val km = driveLog.distanceMeters / 1000
        if (reportedThisDrive == 0 && km < 0.2) {
            finish()
            return
        }
        val reports = if (reportedThisDrive == 0) getString(R.string.drive_summary_none)
        else resources.getQuantityString(R.plurals.drive_summary_reports, reportedThisDrive, reportedThisDrive)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.drive_end_title)
            .setMessage(getString(R.string.drive_summary_km, Ui.oneDecimal(km)) + "\n\n" + reports)
            .setPositiveButton(R.string.drive_end) { _, _ -> finish() }
            .setNegativeButton(R.string.drive_keep_driving, null)
            .show()
    }

    // ------------------------------------------------------------------ manual report

    private fun markHazardManually() {
        val d = lastLocation
        if (d == null || d.accuracyMeters > 50f) {
            Toast.makeText(this, R.string.drive_wait_gps_to_mark, Toast.LENGTH_SHORT).show()
            return
        }
        val frame: Bitmap? = binding.previewView.bitmap
        RoadGuardApp.appScope.launch {
            val path = frame?.let {
                try {
                    ImageUtils.saveReportPhoto(applicationContext, it, null)
                } catch (_: Exception) {
                    null
                } finally {
                    it.recycle()
                }
            }
            ReportQueue.add(
                applicationContext,
                PendingReport(
                    clientId = UUID.randomUUID().toString(),
                    type = HazardKind.POTHOLE.apiType,
                    source = "manual",
                    latitude = d.latitude,
                    longitude = d.longitude,
                    accuracy = d.accuracyMeters,
                    heading = d.bearing,
                    speed = d.speedKmh,
                    confidence = 0.5f,
                    shock = 0f,
                    severityScore = 50f,
                    severityLevel = SeverityLevel.MEDIUM.name,
                    roadName = null,
                    imagePath = path,
                    timestamp = System.currentTimeMillis(),
                )
            )
        }
        reportedThisDrive++
        updateHud()
        showConfirmation(getString(R.string.drive_marked_title), getString(R.string.drive_marked_body))
        vibrate(longArrayOf(0, 40))
    }

    // ------------------------------------------------------------------ UI

    private fun setStatus(s: Status, detail: String? = null) {
        status = s
        val (text, colorRes) = when (s) {
            Status.STARTING -> R.string.drive_status_starting to R.color.on_asphalt_muted
            Status.SCANNING -> R.string.drive_status_scanning to R.color.sev_low
            Status.NO_GPS -> R.string.drive_status_no_gps to R.color.sev_medium
            Status.WEAK_GPS -> R.string.drive_status_weak_gps to R.color.sev_medium
            Status.NO_LOCATION -> R.string.drive_status_no_location to R.color.sev_high
            Status.APPROXIMATE_ONLY -> R.string.drive_status_approximate to R.color.sev_high
            Status.LOCATION_OFF -> R.string.drive_status_location_off to R.color.sev_high
            Status.ERROR -> R.string.drive_status_error to R.color.sev_critical
        }
        binding.txtStatus.setText(text)
        binding.dotStatus.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, colorRes))
        binding.txtStatusDetail.text = detail ?: when (s) {
            Status.NO_GPS, Status.WEAK_GPS -> getString(R.string.drive_detail_waiting_accuracy)
            Status.NO_LOCATION -> getString(R.string.drive_detail_no_location)
            Status.APPROXIMATE_ONLY -> getString(R.string.drive_detail_approximate)
            Status.LOCATION_OFF -> getString(R.string.drive_detail_location_off)
            Status.STARTING -> getString(R.string.drive_detail_loading_model)
            Status.SCANNING -> getString(R.string.drive_detail_watching)
            Status.ERROR -> binding.txtStatusDetail.text
        }
    }

    private fun updateHud() {
        binding.txtFound.text = reportedThisDrive.toString()
        binding.txtKm.text = Ui.oneDecimal(driveLog.distanceMeters / 1000)
        binding.txtKnown.text = if (!hazardAlerts.hasLoaded) getString(R.string.no_value) else hazardAlerts.hazardCount.toString()
    }

    private fun updateVoiceIcon() {
        binding.btnVoice.setImageResource(if (Settings.voiceAlerts) R.drawable.ic_volume_up else R.drawable.ic_volume_off)
    }

    private val hideAlert = Runnable { binding.alertCard.visible(false) }
    private val hideConfirmation = Runnable { binding.toastCard.visible(false) }

    private fun showAlert(alert: AlertEngine.Alert) {
        val h = alert.hazard
        binding.txtAlertTitle.text = getString(R.string.drive_alert_ahead, Ui.kindName(this, h.kind))
        binding.txtAlertSub.text = getString(R.string.drive_alert_sub, Ui.severityWord(this, h.severityLevel), Ui.drivers(this, h.reportCount))
        binding.txtAlertDistance.text = Ui.distance(this, alert.distanceMeters)
        binding.alertCard.visible(true)
        main.removeCallbacks(hideAlert)
        main.postDelayed(hideAlert, 7_000)
        // Voice and vibration come from HazardAlerts.
    }

    private fun showConfirmation(title: String, body: String) {
        binding.txtToastTitle.text = title
        binding.txtToastBody.text = body
        binding.toastCard.visible(true)
        main.removeCallbacks(hideConfirmation)
        main.postDelayed(hideConfirmation, 2_500)
    }

    @Suppress("DEPRECATION")
    private fun vibrate(pattern: LongArray) {
        if (!Settings.vibrateAlerts) return
        val v = getSystemService(VIBRATOR_SERVICE) as? Vibrator ?: return
        if (!v.hasVibrator()) return
        v.vibrate(VibrationEffect.createWaveform(pattern, -1))
    }

    // ------------------------------------------------------------------ lifecycle

    override fun onResume() {
        super.onResume()
        (getSystemService(DISPLAY_SERVICE) as DisplayManager).registerDisplayListener(displayListener, main)
        updateRotation()
        accelerometer.setShockThreshold(Settings.shockThreshold)
        accelerometer.start()
        if (started && LocationHelper.hasPermission(this)) locationHelper.startLocationUpdates()
        analyzer?.paused = false
        refreshStatus() // back from system settings: location may have been switched on
    }

    override fun onPause() {
        (getSystemService(DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(displayListener)
        accelerometer.stop()
        locationHelper.stopLocationUpdates()
        latestFix = null
        analyzer?.paused = true
        super.onPause()
    }

    override fun onDestroy() {
        destroyed = true
        main.removeCallbacksAndMessages(null)
        imageAnalysis?.clearAnalyzer()
        val a = analyzer
        val d = detector
        cameraExecutor.execute {
            a?.flush() // a pothole seen in the last seconds of the drive is still reported
            a?.release()
            d?.close()
        }
        cameraExecutor.shutdown()
        hazardAlerts.release()
        driveLog.finish() // the route is saved and sent even after the app closes
        super.onDestroy()
    }

    companion object {
        private const val TAG = "RoadGuardDrive"
        private const val MAX_FIX_AGE_MS = 4_000L
        private const val CRACK_MAX_SEVERITY = 55f
    }
}
