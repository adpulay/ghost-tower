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

        // Emulator reaches the host machine at 10.0.2.2. Override for a real phone:
        //   ./gradlew assembleDebug -PspacetimeUri=http://<laptop-ip>:3000 -PscoreUrl=http://<brev-host>:8001/score
        val spacetimeUri = (project.findProperty("spacetimeUri") as String?) ?: "http://10.0.2.2:3000"
        val spacetimeDb = (project.findProperty("spacetimeDb") as String?) ?: "ghost-tower"
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
