plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.ghosttower.sensor"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.ghosttower.sensor"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1"

        // Defaults: the shared Maincloud database, so emulators and real phones report to the same
        // world as the simulator. Local fallback (venue Wi-Fi dies; emulator reaches the host at 10.0.2.2):
        //   ./gradlew assembleDebug -PspacetimeUri=http://<laptop-ip>:3000 -PspacetimeDb=ghost-tower
        // The classifier must be reachable from the phone: -PscoreUrl=http://<brev-host>:8001/score
        val spacetimeUri = (project.findProperty("spacetimeUri") as String?) ?: "https://maincloud.spacetimedb.com"
        val spacetimeDb = (project.findProperty("spacetimeDb") as String?) ?: "ghost-tower-94144"
        val scoreUrl = (project.findProperty("scoreUrl") as String?) ?: "http://10.0.2.2:8001/score"
        buildConfigField("String", "SPACETIME_URI", "\"$spacetimeUri\"")
        buildConfigField("String", "SPACETIME_DB", "\"$spacetimeDb\"")
        buildConfigField("String", "SCORE_URL", "\"$scoreUrl\"")
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Intentionally no third-party libraries: HttpURLConnection + org.json are in the platform.
}
