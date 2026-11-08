# Ghost Tower Sensor (Android)

Demo build. When the simulated fake tower's track passes the phone's pinned spot, the app plays out a **simulated 2G drop and a sample scam text** through its detection pipeline: window logic, the classifier call (`/score`), `report_anomaly`, and the "Fake cell tower detected" notification. The pipeline is real; its inputs are simulated.

**This build has no real 2G listener and no SMS receiver.** It never reads your texts or calls, and it has no `RECEIVE_SMS` permission. The only permissions are phone state and coarse location (to show the phone's real network type and cell on the home screen, display only) and notifications.

**Status:** builds a debug APK (`./gradlew assembleDebug`). The demo trigger has fired on a real phone against the live database.

**Build notes**
- The wrapper is pinned to Gradle 9.6.0. Android Studio's bundled JDK is 25, which Gradle 8.x cannot run on, so do not downgrade it.
- From a terminal, point Gradle at Studio's JDK: `JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"`, then `./gradlew assembleDebug` (PowerShell: `.\gradlew.bat assembleDebug`). The APK is `app/build/outputs/apk/debug/app-debug.apk`.
- Expected noise: a "Daemon compilation failed" message (Kotlin 1.9.24 daemon on JDK 25; it falls back and still compiles).

## Run
1. Android Studio → Open `android/` → select the phone (or an emulator) → Run.
2. Reports go to the shared Maincloud database `ghost-tower-94144` by default (same world as the
   simulator). Point `/score` at a classifier the phone can reach (put `scoreUrl=...` in
   `~/.gradle/gradle.properties`, or pass `-PscoreUrl=...`):
   `./gradlew installDebug -PscoreUrl=http://<laptop-ip>:8001/score`
   Local fallback: add `-PspacetimeUri=http://<laptop-ip>:3000 -PspacetimeDb=ghost-tower`
   (the emulator reaches the host at `10.0.2.2`).
3. Open the app, tap **Turn on sensor**, and grant the permissions. There is no mode switch: the demo trigger is always on.

## The demo trigger
- **Automatic:** the app polls the `track` table every 2 s. When an *active* track's estimated position comes within 500 m of the pinned spot (`Demo` in `Net.kt`), it fires once. It re-arms after the car leaves.
- **Manual:** the **Trigger the demo now** button, or a long-press on the title. It buzzes about 8 s later.
- The phone always reports from the pinned spot (a fixed point on Campbell Rd, coarsened to 3 decimals), never from its GPS.

## Code path
Demo trigger → `Pipeline.fireDebug` → `Pipeline.onNetworkType` (simulated EDGE, then LTE) and `Pipeline.onSms` (sample text) → `ScoreClient` → `Reporter.send` → `Notifier`.

## Privacy contract (INTERFACES.md §6)
The report carries only `ts_ms`, coarsened lat/lon (3 decimals), `rat_drop`, `rat_drop_secs`, `sms_score`, `url_hash`, `brand`, `smsc_match` (`unknown`, the phone cannot see carrier logs), `source=phone`. Only the sample text goes to `/score`; the app never reads real messages.

## Known gaps
- The `report_anomaly` call uses Spacetime's HTTP API with positional args in the order of INTERFACES.md §6. Confirm against Role 1's actual reducer signature.
- `/score` unreachable: the demo path falls back to a fixed 0.97 score so the demo still fires.
- Cell ID needs location permission on many devices; the home screen shows "unavailable" if it is denied.
