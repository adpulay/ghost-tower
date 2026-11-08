# Ghost Tower Sensor (Android)

Role 3. Watches the data network type, catches an SMS during a 2G window, scores it with Role 2's `/score`, calls `report_anomaly`, and notifies the user.

**Status:** source written but **not yet compiled or run** (no Android SDK on the authoring machine). Open `android/` in Android Studio, let it sync, and fix whatever the first build reports.

## Run
1. Android Studio → Open `android/` → start an emulator (API 31+ recommended).
2. Defaults assume the emulator reaches the host at `10.0.2.2`. For a real phone:
   `./gradlew installDebug -PspacetimeUri=http://<laptop-ip>:3000 -PscoreUrl=http://<brev-host>:8001/score`
3. Open the app, accept the opt-in, grant permissions.

## Test 2G without breaking the law (emulator console)
```
adb emu                       # or: telnet localhost 5554 (auth token in ~/.emulator_console_auth_token)
network type edge             # data network becomes EDGE (2G)
sms send 5551234 "TxTag: toll overdue, pay at https://txtag-pay-now.example/pay"
network type lte              # back to LTE
```
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
