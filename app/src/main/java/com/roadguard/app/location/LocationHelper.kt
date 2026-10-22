package com.roadguard.app.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

class LocationHelper(
    private val context: Context,
    private val onLocationChanged: (LocationData) -> Unit
) {

    private val fusedLocationClient = LocationServices.getFusedLocationProviderClient(context)
    private var locationCallback: LocationCallback? = null

    companion object {
        private const val UPDATE_INTERVAL_MS = 1000L
        private const val FASTEST_INTERVAL_MS = 500L

        fun hasPermission(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED

        /** Android 12+ ignores a request for precise location unless approximate is asked for too. */
        val PERMISSIONS = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

        /** Reporting needs precise location; approximate (~2 km) can't place a pothole. */
        fun hasPrecise(context: Context): Boolean =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED

        /** Last known position for screens that just need "roughly where am I". */
        @SuppressLint("MissingPermission")
        fun lastKnown(context: Context, callback: (Location?) -> Unit) {
            if (!hasPermission(context)) {
                callback(null)
                return
            }
            val client = LocationServices.getFusedLocationProviderClient(context)
            client.lastLocation
                .addOnSuccessListener { last ->
                    if (last != null) {
                        callback(last)
                        return@addOnSuccessListener
                    }
                    // No cached position (fresh boot, or location was just switched on): ask for one.
                    client.getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, null)
                        .addOnSuccessListener { callback(it) }
                        .addOnFailureListener { callback(null) }
                }
                .addOnFailureListener { callback(null) }
        }

        fun toData(location: Location) = LocationData(
            latitude = location.latitude,
            longitude = location.longitude,
            speedKmh = if (location.hasSpeed()) location.speed * 3.6f else 0f,
            accuracyMeters = location.accuracy,
            timestamp = location.time,
            bearing = if (location.hasBearing() && location.hasSpeed() && location.speed > 1.5f) location.bearing else null,
        )
    }

    val isTracking: Boolean get() = locationCallback != null

    @SuppressLint("MissingPermission")
    fun startLocationUpdates() {
        if (!hasPermission(context) || locationCallback != null) return

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, UPDATE_INTERVAL_MS)
            .setMinUpdateIntervalMillis(FASTEST_INTERVAL_MS)
            .setWaitForAccurateLocation(false)
            .build()

        val callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val location = result.lastLocation ?: return
                onLocationChanged(toData(location))
            }
        }
        locationCallback = callback
        fusedLocationClient.requestLocationUpdates(request, callback, Looper.getMainLooper())
    }

    fun stopLocationUpdates() {
        locationCallback?.let { fusedLocationClient.removeLocationUpdates(it) }
        locationCallback = null
    }
}
