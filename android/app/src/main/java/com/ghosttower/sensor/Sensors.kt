package com.ghosttower.sensor

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Telephony
import android.telephony.CellInfo
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
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

    fun fakeTower(ctx: Context) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        ensureChannel(ctx)
        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
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

/** Watches the data network type (real telephony callbacks). */
class NetworkWatcher(private val ctx: Context) {
    private val tm = ctx.getSystemService(TelephonyManager::class.java)
    private var callback: Any? = null

    @SuppressLint("MissingPermission")
    fun start() {
        if (ctx.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return
        Pipeline.onNetworkType(tm.dataNetworkType)
        if (Build.VERSION.SDK_INT >= 31) {
            val cb = object : TelephonyCallback(), TelephonyCallback.DataConnectionStateListener {
                override fun onDataConnectionStateChanged(state: Int, networkType: Int) {
                    Pipeline.onNetworkType(networkType)
                }
            }
            callback = cb
            tm.registerTelephonyCallback(ctx.mainExecutor, cb)
        } else {
            @Suppress("DEPRECATION")
            val l = object : PhoneStateListener() {
                @Deprecated("legacy listener for API < 31")
                override fun onDataConnectionStateChanged(state: Int, networkType: Int) {
                    Pipeline.onNetworkType(networkType)
                }
            }
            callback = l
            @Suppress("DEPRECATION")
            tm.listen(l, PhoneStateListener.LISTEN_DATA_CONNECTION_STATE)
        }
    }

    fun stop() {
        val cb = callback ?: return
        if (Build.VERSION.SDK_INT >= 31) tm.unregisterTelephonyCallback(cb as TelephonyCallback)
        else @Suppress("DEPRECATION") tm.listen(cb as PhoneStateListener, PhoneStateListener.LISTEN_NONE)
        callback = null
    }

    /** Best-effort cell id for the home screen. Needs location permission on most devices. */
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

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        Pipeline.init(context)
        val body = Telephony.Sms.Intents.getMessagesFromIntent(intent)
            .joinToString("") { it.messageBody ?: "" }
        if (body.isNotEmpty()) Pipeline.onSms(body)
    }
}

/** Demo mode: when a simulated blaster's active track comes near the pinned phone, fire the debug path once. */
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
                if (near && !fired) {
                    fired = true
                    Log.i("GhostTower", "demo fire: ${tracks.size} active, nearest ${nearest?.toInt()} m")
                    handler.post { Pipeline.fireDebug("demo") }
                }
                if (!near) fired = false // re-arm after the car leaves
            }
            handler.postDelayed(this, 2000)
        }
    }

    private fun metersFromPin(lat: Double, lon: Double): Double {
        val dLat = (lat - Demo.LAT) * 111_320.0
        val dLon = (lon - Demo.LON) * 111_320.0 * cos(Math.toRadians(Demo.LAT))
        return sqrt(dLat * dLat + dLon * dLon)
    }
}

class SensorService : Service() {
    private var watcher: NetworkWatcher? = null
    private var demo: DemoWatcher? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Pipeline.init(this)
        startForeground(1002, Notifier.foreground(this))
        if (watcher == null) watcher = NetworkWatcher(this).also { it.start() }
        val demoMode = intent?.getBooleanExtra(EXTRA_DEMO, false) == true
        if (demoMode) {
            if (demo == null) demo = DemoWatcher()
            demo?.start()
        } else {
            demo?.stop()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        watcher?.stop()
        demo?.stop()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_DEMO = "demo"
    }
}
