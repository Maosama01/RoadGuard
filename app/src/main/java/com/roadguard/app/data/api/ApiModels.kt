package com.roadguard.app.data.api

// JSON shapes of the RoadGuard backend. Strings and lists are nullable on purpose: Gson
// bypasses Kotlin's null checks, so a missing field must not crash the app.

data class ApiUser(
    val id: Long = 0,
    val name: String? = null,
    val email: String? = null,
    val role: String? = null,
    val isGuest: Boolean = false,
    val points: Int = 0,
    val city: String? = null,
)

data class LoginRequest(val email: String, val password: String)
data class RegisterRequest(val name: String, val email: String, val password: String)
data class GuestRequest(val deviceId: String, val name: String? = null)
data class VoteRequest(val vote: String)

data class AuthResponse(val token: String? = null, val user: ApiUser? = null, val message: String? = null)
data class MeResponse(val user: ApiUser? = null)
data class ErrorBody(val message: String? = null)
data class HealthResponse(val success: Boolean = false, val service: String? = null)

data class Hazard(
    val id: Long = 0,
    val type: String? = null,
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    val roadName: String? = null,
    val status: String? = null,
    val severityScore: Float = 0f,
    val severityLevel: String? = null,
    val reportCount: Int = 0,
    val uniqueReporters: Int = 0,
    val likelyFixed: Boolean = false,
    val reopenCount: Int = 0,
    val imageUrl: String? = null,
    val assignedTeam: String? = null,
    val maxShock: Float = 0f,
    val avgSpeed: Float = 0f,
    val firstReportedAt: Long = 0,
    val lastReportedAt: Long = 0,
    val resolvedAt: Long? = null,
    val votes: Map<String, Int>? = null,
    val myVote: String? = null,
    val distanceMeters: Double? = null,
    // Accountability (v3): who must fix it, by when, and proof that they did.
    val contractor: Contractor? = null,
    val segment: RoadSegment? = null,
    val dueAt: Long? = null,
    val overdueDays: Int? = null,
    val escalationLevel: Int? = null,
    val underWarranty: Boolean? = null,
    val repairImageUrl: String? = null,
    val publicUrl: String? = null,
)

data class Contractor(
    val id: Long = 0,
    val name: String? = null,
    val phone: String? = null,
    val email: String? = null,
)

/** The stretch of road a contract covers: tender, ward and the officer responsible. */
data class RoadSegment(
    val id: Long = 0,
    val tenderId: String? = null,
    val officerName: String? = null,
    val officerContact: String? = null,
    val ward: String? = null,
    val slaDays: Int? = null,
    val warrantyUntil: Long? = null,
)

/** GET /api/hazards/:id/complaint: a ready-to-send formal complaint. */
data class ComplaintResponse(
    val subject: String? = null,
    val body: String? = null,
    val to: ComplaintRecipient? = null,
    val publicUrl: String? = null,
)

data class ComplaintRecipient(
    val officerName: String? = null,
    val officerContact: String? = null,
)

// ---- Pocket mode and coverage ----

data class SensorHit(
    val clientId: String,
    val latitude: Double,
    val longitude: Double,
    val accuracy: Float,
    val speed: Float,
    val heading: Float?,
    val shock: Float,
    val timestamp: Long,
)

data class SensorHitsRequest(val hits: List<SensorHit>)

data class SensorHitsResponse(
    val success: Boolean = false,
    val accepted: Int = 0,
    val ignored: Int = 0,
    val confirmed: Int = 0,
    val promoted: Int = 0,
    val pointsAwarded: Int = 0,
)

data class DriveResponse(
    val success: Boolean = false,
    val cells: Int = 0,
    val distanceMeters: Double = 0.0,
)

data class HazardList(val total: Int = 0, val items: List<Hazard>? = null)
data class NearbyResponse(val items: List<Hazard>? = null)

data class ReportItem(
    val id: Long = 0,
    val hazardId: Long = 0,
    val type: String? = null,
    val source: String? = null,
    val latitude: Double = 0.0,
    val longitude: Double = 0.0,
    val confidence: Float = 0f,
    val shock: Float = 0f,
    val speed: Float = 0f,
    val severityScore: Float = 0f,
    val severityLevel: String? = null,
    val roadName: String? = null,
    val imageUrl: String? = null,
    val timestamp: Long = 0,
    val hazardStatus: String? = null,
    val hazardReportCount: Int? = null,
)

data class ReportList(val total: Int = 0, val items: List<ReportItem>? = null)

data class UploadResponse(
    val message: String? = null,
    val reportId: String? = null,
    val hazardId: Long? = null,
    val isNewHazard: Boolean = false,
    val duplicate: Boolean = false,
    val pointsAwarded: Int = 0,
    val hazard: Hazard? = null,
)

data class TimelineEvent(
    val id: Long = 0,
    val type: String? = null,
    val fromStatus: String? = null,
    val toStatus: String? = null,
    val note: String? = null,
    val actor: String? = null,
    val createdAt: Long = 0,
)

data class HazardDetailResponse(
    val hazard: Hazard? = null,
    val reports: List<ReportItem>? = null,
    val timeline: List<TimelineEvent>? = null,
)

data class VoteResponse(val message: String? = null, val pointsAwarded: Int = 0, val hazard: Hazard? = null)

data class OverviewTotals(
    val open: Int = 0,
    val resolved: Int = 0,
    val critical: Int = 0,
    val high: Int = 0,
    val reportsToday: Int = 0,
    val resolutionRate: Int = 0,
    val activeReporters: Int = 0,
    val avgResolutionHours: Double? = null,
)

data class OverviewResponse(val totals: OverviewTotals? = null)

data class MyStats(
    val reports: Int = 0,
    val reportsThisWeek: Int = 0,
    val hazardsDiscovered: Int = 0,
    val hazardsContributed: Int = 0,
    val hazardsFixed: Int = 0,
    val hazardsOpen: Int = 0,
    val hazardsVerified: Int = 0,
    val points: Int = 0,
    val rank: Int = 0,
    val streakDays: Int = 0,
    val level: String? = null,
    val levelIndex: Int = 0,
    val nextLevel: String? = null,
    val nextLevelPoints: Int? = null,
    val levelFloorPoints: Int = 0,
    val kmScanned: Double = 0.0,
    val drives: Int = 0,
)

data class MyStatsResponse(val user: ApiUser? = null, val stats: MyStats? = null)

data class LeaderEntry(
    val rank: Int = 0,
    val id: Long = 0,
    val name: String? = null,
    val points: Int = 0,
    val reports: Int = 0,
    val isMe: Boolean = false,
    val level: String? = null,
)

data class LeaderboardResponse(val items: List<LeaderEntry>? = null)
