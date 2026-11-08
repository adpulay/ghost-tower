package com.ghosttower.sensor

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import android.util.Log
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Core detection path. The demo trigger (the simulated car passing, the button, a long-press on
 * the title) plays a 2G drop and a sample text through onNetworkType() / onSms(): the window
 * logic, the classifier call, the report and the notification are all real. The inputs are
 * simulated. This build has no real 2G listener and no SMS receiver, so it never reads a text.
 *
 * Privacy: only the sample text is sent to the classifier (/score). The Spacetime report carries
 * the score, brand, a hash of the link domain and the fixed demo location, never any text.
 */
object Pipeline {
    private const val SMS_AFTER_DROP_MS = 10_000L

    private lateinit var app: Context
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    @Volatile private var twoGSinceMs: Long? = null
    @Volatile private var lastDropEndMs = 0L
    @Volatile private var lastDropSecs = 0f
    @Volatile private var smsHandledForDrop = false
    private var noSmsReport: Runnable? = null

    @Volatile var lastStatus: String = "Watching. Nothing suspicious."
        private set
    var statusListener: ((String) -> Unit)? = null

    private val urlRegex = Regex("""(?i)\b(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:/\S*)?""")

    fun init(context: Context) {
        app = context.applicationContext
    }

    fun is2G(type: Int) = type == TelephonyManager.NETWORK_TYPE_GPRS ||
        type == TelephonyManager.NETWORK_TYPE_EDGE ||
        type == TelephonyManager.NETWORK_TYPE_GSM

    fun networkName(type: Int): String = when (type) {
        TelephonyManager.NETWORK_TYPE_GPRS -> "GPRS (2G)"
        TelephonyManager.NETWORK_TYPE_EDGE -> "EDGE (2G)"
        TelephonyManager.NETWORK_TYPE_GSM -> "GSM (2G)"
        TelephonyManager.NETWORK_TYPE_UMTS, TelephonyManager.NETWORK_TYPE_HSPA,
        TelephonyManager.NETWORK_TYPE_HSDPA, TelephonyManager.NETWORK_TYPE_HSUPA,
        TelephonyManager.NETWORK_TYPE_HSPAP -> "3G"
        TelephonyManager.NETWORK_TYPE_LTE -> "LTE (4G)"
        TelephonyManager.NETWORK_TYPE_NR -> "5G"
        TelephonyManager.NETWORK_TYPE_UNKNOWN -> "unknown"
        else -> "other ($type)"
    }

    private fun setStatus(s: String) {
        lastStatus = s
        main.post { statusListener?.invoke(s) }
    }

    /** Called for every (simulated) data network type change. */
    @Synchronized
    fun onNetworkType(type: Int, now: Long = System.currentTimeMillis()) {
        val since = twoGSinceMs
        if (is2G(type) && since == null) {
            twoGSinceMs = now
            smsHandledForDrop = false
            setStatus("Dropped to 2G. Watching for a text.")
        } else if (!is2G(type) && since != null) {
            twoGSinceMs = null
            lastDropEndMs = now
            lastDropSecs = (now - since) / 1000f
            setStatus("Back on ${networkName(type)} after %.1f s on 2G.".format(lastDropSecs))
            // 2G drop with no SMS: report with sms_score=0 once the 10 s grace passes.
            val secs = lastDropSecs
            val r = Runnable {
                if (!smsHandledForDrop) {
                    io.execute { report(secs, 0f, "", "", fallbackNotify = false) }
                }
            }
            noSmsReport = r
            main.postDelayed(r, SMS_AFTER_DROP_MS)
        }
    }

    /** Called with the (sample) SMS body. Silently ignored outside a 2G window. */
    @Synchronized
    fun onSms(text: String, now: Long = System.currentTimeMillis(), fallbackScore: Float? = null) {
        val since = twoGSinceMs
        val inWindow = since != null
        val justAfter = since == null && now - lastDropEndMs <= SMS_AFTER_DROP_MS && lastDropEndMs > 0
        if (!inWindow && !justAfter) return

        smsHandledForDrop = true
        noSmsReport?.let { main.removeCallbacks(it) }
        val secs = if (since != null) (now - since) / 1000f else lastDropSecs
        val urlHash = hashDomain(text)

        io.execute {
            val scored = ScoreClient.score(text)
            val score = scored?.first ?: fallbackScore ?: 0f
            val brand = scored?.second ?: if (fallbackScore != null) "TxTag" else ""
            if (scored == null && fallbackScore == null) {
                setStatus("Classifier unreachable. Text not scored.")
                return@execute
            }
            report(secs, score, brand, urlHash, fallbackNotify = true)
        }
    }

    private fun report(secs: Float, score: Float, brand: String, urlHash: String, fallbackNotify: Boolean) {
        val (lat, lon) = Reporter.pinnedLocation()
        // Follow the sim clock when it runs ahead (sim --speed 3x), so the report lands in the tracker's window.
        val wall = System.currentTimeMillis()
        val ts = maxOf(wall, Reporter.simNowMs() ?: 0L)
        Log.i("GhostTower", "report lat=$lat lon=$lon score=$score secs=$secs ts=$ts simAhead=${ts - wall}ms")
        val ok = Reporter.send(
            tsMs = ts, lat = lat, lon = lon,
            ratDrop = true, ratDropSecs = secs, smsScore = score,
            urlHash = urlHash, brand = brand, smsc = "unknown",
        )
        setStatus(
            (if (ok) "Report sent" else "Report FAILED to send") +
                " (2G %.1f s, scam score %.2f).".format(secs, score),
        )
        if (fallbackNotify && score >= 0.5f) Notifier.fakeTower(app)
    }

    /** The demo trigger: the simulated car passing, the button and the title long-press all call this. */
    fun fireDebug(reason: String = "button") {
        Log.i("GhostTower", "fireDebug reason=$reason")
        val now = System.currentTimeMillis()
        onNetworkType(TelephonyManager.NETWORK_TYPE_EDGE, now)
        main.postDelayed({
            onSms(
                "TxTag: Your toll balance is overdue. Pay now to avoid a fine: https://txtag-pay-demo.example/pay",
                fallbackScore = 0.97f, // only used if /score is unreachable
            )
            main.postDelayed({ onNetworkType(TelephonyManager.NETWORK_TYPE_LTE) }, 1500)
        }, 6_000)
    }

    fun hashDomain(text: String): String {
        val domain = urlRegex.find(text)?.groupValues?.get(1)?.lowercase()?.removePrefix("www.") ?: return ""
        return MessageDigest.getInstance("SHA-256").digest(domain.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }
}
