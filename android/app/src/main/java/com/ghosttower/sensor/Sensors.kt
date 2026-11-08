package com.ghosttower.sensor

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.TelephonyManager
import android.telephony.CellInfoWcdma
import android.util.Log
import java.util.concurrent.Executors
import kotlin.math.cos
import kotlin.math.sqrt

object Notifier {
    private const val CH = "fake_tower"

    private fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH, "Fake tower alerts", NotificationManager.IMPORTANCE_HIGH))
    }

    fun cancelAlert(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java).cancel(1001)
    }

    fun fakeTower(ctx: Context, eventId: Long) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        ensureChannel(ctx)
        // Tapping it opens the app and shows the same alert pop-up.
        val open = PendingIntent.getActivity(
            ctx, eventId.toInt(),
            Intent(ctx, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_ALERT_ID, eventId)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("Fake cell tower detected")
            .setContentText("Your phone was just pulled onto a fake cell tower. The text you received is fake. Don't tap the link.")
            .setStyle(
                Notification.BigTextStyle().bigText(
                    "Your phone was just pulled onto a fake cell tower. The text you received is fake. Don't tap the link.",
                ),
            )
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(1001, n)
    }

    fun foreground(ctx: Context): Notification {
        ensureChannel(ctx)
        return Notification.Builder(ctx, CH)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("Ghost Tower sensor is on")
            .setContentText("Watching for fake-tower events only.")
            .build()
    }
}

/**
 * Read-only view of the phone's real radio, for the home screen only. It drives nothing: the 2G
 * drop and the text that the detection pipeline reacts to are simulated by the demo trigger.
 */
class RadioInfo(ctx: Context) {
    private val tm = ctx.getSystemService(TelephonyManager::class.java)

    /** The phone's real data network type (a TelephonyManager.NETWORK_TYPE_* value), or UNKNOWN. */
    @SuppressLint("MissingPermission")
    fun networkType(): Int = try {
        tm.dataNetworkType
    } catch (e: Exception) {
        TelephonyManager.NETWORK_TYPE_UNKNOWN
    }

    @SuppressLint("MissingPermission")
    fun networkName(): String = try {
        Pipeline.networkName(tm.dataNetworkType)
    } catch (e: Exception) {
        "unavailable"
    }

    /** Best-effort cell id. Needs location permission on most devices. */
    @SuppressLint("MissingPermission")
    fun cellId(): String = try {
        val cells: List<CellInfo> = tm.allCellInfo ?: emptyList()
        val c = cells.firstOrNull { it.isRegistered } ?: cells.firstOrNull()
        when (c) {
            is CellInfoLte -> "LTE ci=${c.cellIdentity.ci}"
            is CellInfoGsm -> "GSM cid=${c.cellIdentity.cid}"
            is CellInfoWcdma -> "WCDMA cid=${c.cellIdentity.cid}"
            is CellInfoNr -> "NR ${c.cellIdentity}"
            null -> "unavailable"
            else -> "other"
        }
    } catch (e: Exception) {
        "unavailable"
    }
}

/** The demo trigger: when a simulated blaster's active track comes near the pinned phone, fire the demo path once. */
class DemoWatcher {
    private val handler = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var running = false
    private var fired = false

    fun start() {
        if (running) return
        running = true
        fired = false
        handler.post(poll)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(poll)
    }

    private val poll = object : Runnable {
        override fun run() {
            if (!running) return
            io.execute {
                val tracks = Reporter.activeTracks()
                val nearest = tracks.minOfOrNull { (lat, lon) -> metersFromPin(lat, lon) }
                val near = nearest != null && nearest <= Demo.TRIGGER_RADIUS_M
                if (near && !fired && Prefs.shieldOn) {
                    fired = true
                    Log.i("GhostTower", "demo fire: ${tracks.size} active, nearest ${nearest?.toInt()} m")
                    handler.post { Pipeline.fireDebug("demo") }
                }
                if (!near) fired = false // re-arm after the car leaves
                clearIfWorldReset()
            }
            handler.postDelayed(this, 2000)
        }
    }

    /**
     * Restarting the sim resets the demo world, which deletes every report from the database. If this app has
     * entries it reported (a while ago) but the database now holds none, the world was reset, so start the counters
     * over too. A failed request reads as "unknown" and changes nothing.
     */
    private fun clearIfWorldReset() {
        if (!EventLog.hasReportedOlderThan(15_000)) return
        if (Reporter.phoneReportCount() == 0) {
            Log.i("GhostTower", "demo world was reset; clearing the app's alerts")
            EventLog.clear()
        }
    }

    private fun metersFromPin(lat: Double, lon: Double): Double {
        val dLat = (lat - Demo.LAT) * 111_320.0
        val dLon = (lon - Demo.LON) * 111_320.0 * cos(Math.toRadians(Demo.LAT))
        return sqrt(dLat * dLat + dLon * dLon)
    }
}

class SensorService : Service() {
    private var demo: DemoWatcher? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Pipeline.init(this)
        startForeground(1002, Notifier.foreground(this))
        // The demo trigger is the only mode: there is no real 2G or SMS listener in this build.
        if (demo == null) demo = DemoWatcher()
        demo?.start()
        return START_STICKY
    }

    override fun onDestroy() {
        demo?.stop()
        super.onDestroy()
    }
}
