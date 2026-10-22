package com.roadguard.app.data.api

import com.google.gson.JsonObject
import okhttp3.MultipartBody
import okhttp3.RequestBody
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.PartMap
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.QueryMap

interface ApiService {

    @GET("api/health")
    suspend fun health(): HealthResponse

    // ---- Account ----
    @POST("api/auth/login")
    suspend fun login(@Body body: LoginRequest): AuthResponse

    @POST("api/auth/register")
    suspend fun register(@Body body: RegisterRequest): AuthResponse

    @POST("api/auth/guest")
    suspend fun guest(@Body body: GuestRequest): AuthResponse

    @GET("api/auth/me")
    suspend fun me(): MeResponse

    // ---- Reports ----
    @Multipart
    @POST("api/reports")
    suspend fun uploadReport(
        @PartMap fields: Map<String, @JvmSuppressWildcards RequestBody>,
        @Part image: MultipartBody.Part?,
    ): UploadResponse

    @GET("api/reports/mine")
    suspend fun myReports(@Query("limit") limit: Int = 50, @Query("offset") offset: Int = 0): ReportList

    // ---- Hazards ----
    @GET("api/hazards")
    suspend fun hazards(@QueryMap query: Map<String, String>): HazardList

    @GET("api/hazards/nearby")
    suspend fun nearby(
        @Query("lat") lat: Double,
        @Query("lng") lng: Double,
        @Query("radius") radius: Int,
    ): NearbyResponse

    @GET("api/hazards/{id}")
    suspend fun hazard(@Path("id") id: Long): HazardDetailResponse

    @POST("api/hazards/{id}/vote")
    suspend fun vote(@Path("id") id: Long, @Body body: VoteRequest): VoteResponse

    @GET("api/hazards/{id}/complaint")
    suspend fun complaint(@Path("id") id: Long, @Query("lang") lang: String): ComplaintResponse

    // ---- Pocket mode and coverage ----
    @POST("api/sensor-hits")
    suspend fun sensorHits(@Body body: SensorHitsRequest): SensorHitsResponse

    /** Body: { clientId, mode, startedAt, endedAt, distanceMeters, path: [[lat, lng, ts], ...] } */
    @POST("api/drives")
    suspend fun drive(@Body body: JsonObject): DriveResponse

    // ---- Stats ----
    @GET("api/stats/overview")
    suspend fun overview(): OverviewResponse

    @GET("api/stats/me")
    suspend fun myStats(): MyStatsResponse

    @GET("api/stats/leaderboard")
    suspend fun leaderboard(@Query("limit") limit: Int = 10): LeaderboardResponse
}
