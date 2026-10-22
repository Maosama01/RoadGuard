package com.roadguard.app.location

data class LocationData(
    val latitude: Double,
    val longitude: Double,
    val speedKmh: Float,
    val accuracyMeters: Float,
    val timestamp: Long,
    /** Direction of travel in degrees, when the phone is moving. */
    val bearing: Float? = null,
)
