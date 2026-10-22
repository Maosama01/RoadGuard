import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
}

/** The public RoadGuard server (gradle.properties, written by ops/go_live_mac.sh), if there is one. */
val publicServerUrl: String? = (findProperty("roadguard.serverUrl") as String?)?.trim()?.takeIf { it.startsWith("http") }

/** Set roadguard.useLanServer=true in gradle.properties to point debug builds at this computer's Wi-Fi address instead. */
val useLanServer: Boolean = (findProperty("roadguard.useLanServer") as String?)?.trim() == "true"

/** Release signing key, kept out of git in signing/ (see ops/build_release.sh). */
val signingProps = Properties().apply {
    val f = rootProject.file("signing/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

/**
 * This computer's Wi-Fi address and the port from backend/.env, for debug builds that talk to a
 * backend on the same network (roadguard.useLanServer=true, or when there's no public server).
 */
fun devServerUrl(): String {
    val port = rootProject.file("backend/.env").takeIf { it.exists() }?.readLines()
        ?.firstNotNullOfOrNull { Regex("""^\s*PORT\s*=\s*(\d+)""").find(it)?.groupValues?.get(1) } ?: "5000"
    val ip = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback && !it.isVirtual }
            // Wi-Fi/Ethernet (en0, en1, wlan0, eth0) before VM bridges and VPN tunnels.
            .sortedBy { if (it.name.startsWith("en") || it.name.startsWith("wlan") || it.name.startsWith("eth")) 0 else 1 }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { it.isSiteLocalAddress }?.hostAddress
    } catch (e: Exception) {
        null
    }
    return "http://${ip ?: "10.0.2.2"}:$port/"
}

android {
    namespace = "com.roadguard.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.roadguard.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "2.1"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Where the app looks for the backend on first launch (it can be changed in Settings):
        // the public server from gradle.properties, else the emulator's view of this computer.
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"${publicServerUrl ?: "http://10.0.2.2:5000/"}\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    // The detector model is memory-mapped; it must not be compressed in the APK.
    androidResources {
        noCompress.add("tflite")
    }

    signingConfigs {
        create("release") {
            if (!signingProps.isEmpty()) {
                storeFile = rootProject.file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // Field testing needs the public server; LAN only when asked for.
            val url = if (publicServerUrl != null && !useLanServer) publicServerUrl else devServerUrl()
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"$url\"")
        }
        release {
            if (!signingProps.isEmpty()) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.material)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.fragment)
    implementation(libs.androidx.constraintlayout)
    implementation(libs.androidx.recyclerview)
    implementation(libs.androidx.swiperefresh)

    implementation(libs.lifecycle.runtime)
    implementation(libs.lifecycle.viewmodel)
    implementation(libs.lifecycle.livedata)
    implementation(libs.coroutines.android)

    // Offline queue: reports are saved first, uploaded when there is network.
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime)

    implementation(libs.camerax.core)
    implementation(libs.camerax.camera2)
    implementation(libs.camerax.lifecycle)
    implementation(libs.camerax.view)
    implementation(libs.play.location)

    implementation(libs.tflite)
    implementation(libs.tflite.support)

    implementation(libs.retrofit)
    implementation(libs.retrofit.gson)
    implementation(libs.okhttp.logging)
    implementation(libs.glide)

    // OpenStreetMap maps: no API key needed.
    implementation(libs.osmdroid)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
