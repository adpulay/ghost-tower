# Ghost Tower Sensor (Android)

Role 3. Watches the data network type, catches an SMS during a 2G window, scores it with Role 2's `/score`, calls `report_anomaly`, and notifies the user.

**Status:** compiles and builds a debug APK (`./gradlew assembleDebug`). Not yet run on an emulator or phone.

**Build notes**
- The wrapper is pinned to Gradle 9.6.0. Android Studio's bundled JDK is 25, which Gradle 8.x cannot run on, so do not downgrade it.
- From a terminal, point Gradle at Studio's JDK: `JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"`, then `./gradlew assembleDebug` (PowerShell: `.\gradlew.bat assembleDebug`). The APK is `app/build/outputs/apk/debug/app-debug.apk`.
- Expected noise: a "Daemon compilation failed" message (Kotlin 1.9.24 daemon on JDK 25; it falls back and still compiles) and one deprecation warning for `PhoneStateListener` (used only on API < 31).

## Run
1. Android Studio → Open `android/` → start an emulator (API 31+ recommended).
2. Defaults assume the emulator reaches the host at `10.0.2.2`. For a real phone:
   `./gradlew installDebug -PspacetimeUri=http://<laptop-ip>:3000 -PscoreUrl=http://<brev-host>:8001/score`
3. Open the app, accept the opt-in, grant permissions.

## Test 2G without breaking the law (emulator only, nothing is transmitted)
Use the emulator's **Extended controls** (the `...` button on the emulator toolbar):
1. **Cellular → Network type:** pick `EDGE` (or `GPRS`/`GSM`). The app's home screen should change to "EDGE (2G)".
2. **Phone → Send message:** enter any sender number and the scam text, e.g. `TxTag: toll overdue, pay at https://txtag-pay-now.example/pay`.
3. **Cellular → Network type:** back to `LTE`.

The console equivalent for step 2 is `adb emu sms send 5551234 "<text>"`. If the app never sees the network type change in step 1 on your emulator image, say so; the hidden debug trigger exercises the same code path.

Expect: a row in `anomaly_event` with `rat_drop=true`, high `sms_score`, and a "Fake cell tower detected" notification.
SMS with no 2G drop → ignored. 2G drop with no SMS → report with `sms_score=0` after 10 s.

## Code path
`NetworkWatcher` (real telephony callback) and `SmsReceiver` (real SMS) → `Pipeline.onNetworkType` / `Pipeline.onSms` → `ScoreClient` → `Reporter.send` → `Notifier`.
The **debug trigger** (long-press the title, or the button) and **demo mode** (polls `track`, fires when an active track is within 500 m of the pinned UTD location) call the same two `Pipeline` entry points.

## Privacy contract (INTERFACES.md §6)
The report carries only `ts_ms`, coarsened lat/lon (3 decimals), `rat_drop`, `rat_drop_secs`, `sms_score`, `url_hash`, `brand`, `smsc_match` (`unknown`, the phone cannot see carrier logs), `source=phone`. Message text goes only to `/score`.

## Known gaps
- The `report_anomaly` call uses Spacetime's HTTP API with positional args in the order of INTERFACES.md §6. Confirm against Role 1's actual reducer signature.
- `/score` unreachable: real texts are not reported (status shows "Classifier unreachable"). The debug path falls back to a fixed 0.97 score so the demo still fires.
- Cell ID needs location permission on many devices; the home screen shows "unavailable" if it is denied.
