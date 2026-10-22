import java.net.Inet4Address
import java.net.NetworkInterface

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.ksp)
}

/**
 * Debug builds talk to the backend running on this computer. A real phone can't use the
 * emulator address (10.0.2.2), so use this computer's Wi-Fi address and the port from
 * backend/.env. Release builds keep DEFAULT_SERVER_URL from defaultConfig.
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
        versionCode = 2
        versionName = "2.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Where a release build looks for the backend on first launch (change it in Settings).
        // Debug builds override this with this computer's Wi-Fi address; see devServerUrl().
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:5000/\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    // The detector model is memory-mapped; it must not be compressed in the APK.
    androidResources {
        noCompress.add("tflite")
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"${devServerUrl()}\"")
        }
        release {
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
