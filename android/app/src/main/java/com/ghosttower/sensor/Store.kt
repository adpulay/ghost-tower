package com.ghosttower.sensor

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/** Small on-device settings. Everything defaults to ON so a fresh install is protected. */
object Prefs {
    private var sp: SharedPreferences? = null

    @Synchronized
    fun init(ctx: Context) {
        if (sp == null) sp = ctx.applicationContext.getSharedPreferences("ghosttower", Context.MODE_PRIVATE)
    }

    private fun prefs(): SharedPreferences = checkNotNull(sp) { "Prefs.init was not called" }

    var shieldOn: Boolean
        get() = prefs().getBoolean("shield", true)
        set(v) = prefs().edit().putBoolean("shield", v).apply()

    var popupsOn: Boolean
        get() = prefs().getBoolean("popups", true)
        set(v) = prefs().edit().putBoolean("popups", v).apply()

    var notifyOn: Boolean
        get() = prefs().getBoolean("notify", true)
        set(v) = prefs().edit().putBoolean("notify", v).apply()

    fun blockedLinks(): List<String> = (prefs().getStringSet("blocked", emptySet()) ?: emptySet()).sorted()

    fun setBlocked(domain: String, blocked: Boolean) {
        if (domain.isBlank()) return
        val next = HashSet(prefs().getStringSet("blocked", emptySet()) ?: emptySet())
        if (blocked) next.add(domain) else next.remove(domain)
        prefs().edit().putStringSet("blocked", next).apply()
    }

    internal fun raw(): SharedPreferences = prefs()
}

/**
 * One thing the app flagged. `kind` is "warning" (the agent's zone covers this phone, ahead of the tower), "tower" (the phone was pulled onto a fake 2G cell) or "text" (a scam text
 * arrived during it). In this demo build both come from the simulated trigger; `preview` is the sample text.
 */
data class ThreatEvent(
    val id: Long,
    val ts: Long,
    val kind: String,
    val title: String,
    val detail: String,
    val score: Float,
    val brand: String,
    val domain: String,
    val preview: String,
    val blocked: Boolean = false,
    val reported: Boolean = false,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id).put("ts", ts).put("kind", kind).put("title", title).put("detail", detail)
        .put("score", score.toDouble()).put("brand", brand).put("domain", domain).put("preview", preview)
        .put("blocked", blocked).put("reported", reported)

    companion object {
        fun fromJson(o: JSONObject) = ThreatEvent(
            id = o.getLong("id"), ts = o.getLong("ts"), kind = o.getString("kind"), title = o.getString("title"),
            detail = o.getString("detail"), score = o.optDouble("score", 0.0).toFloat(), brand = o.optString("brand"),
            domain = o.optString("domain"), preview = o.optString("preview"),
            blocked = o.optBoolean("blocked"), reported = o.optBoolean("reported"),
        )
    }
}

/** The activity log: newest first, kept on the device, capped at 100 entries. */
object EventLog {
    private const val KEY = "events"
    private const val MAX = 100
    private val items = mutableListOf<ThreatEvent>()
    private val seq = AtomicLong(System.currentTimeMillis())
    private val main = Handler(Looper.getMainLooper())
    val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var loaded = false

    fun newId(): Long = seq.incrementAndGet()

    @Synchronized
    fun init(ctx: Context) {
        Prefs.init(ctx)
        if (loaded) return
        loaded = true
        val json = Prefs.raw().getString(KEY, null) ?: return
        try {
            val arr = JSONArray(json)
            for (i in 0 until arr.length()) items.add(ThreatEvent.fromJson(arr.getJSONObject(i)))
        } catch (_: Exception) {
            items.clear()
        }
    }

    @Synchronized
    fun all(): List<ThreatEvent> = items.sortedByDescending { it.ts }

    @Synchronized
    fun find(id: Long): ThreatEvent? = items.firstOrNull { it.id == id }

    @Synchronized
    fun countSince(sinceMs: Long, kind: String): Int = items.count { it.kind == kind && it.ts >= sinceMs }

    /** True if some entry was successfully reported to the map more than [ms] ago (so it should be in the database). */
    @Synchronized
    fun hasReportedOlderThan(ms: Long): Boolean = items.any { it.reported && System.currentTimeMillis() - it.ts > ms }

    fun add(e: ThreatEvent) {
        synchronized(this) {
            items.add(e)
            while (items.size > MAX) items.remove(items.minByOrNull { it.ts }!!)
            save()
        }
        changed()
    }

    fun update(id: Long, f: (ThreatEvent) -> ThreatEvent) {
        synchronized(this) {
            val i = items.indexOfFirst { it.id == id }
            if (i < 0) return
            items[i] = f(items[i])
            save()
        }
        changed()
    }

    fun clear() {
        synchronized(this) {
            items.clear()
            save()
        }
        changed()
    }

    private fun save() {
        val arr = JSONArray()
        items.forEach { arr.put(it.toJson()) }
        Prefs.raw().edit().putString(KEY, arr.toString()).apply()
    }

    private fun changed() = main.post { listeners.forEach { it() } }
}

/**
 * Delivers a detection to the user. If the app is open and pop-ups are on, it appears as an alert inside the app.
 * Otherwise it is a notification, and tapping that notification opens the same alert.
 */
object Alerts {
    @Volatile var foreground: ((ThreatEvent) -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())

    fun raise(ctx: Context, ev: ThreatEvent) {
        val show = foreground
        when {
            show != null && Prefs.popupsOn -> {
                main.post { show(ev) }
                Notifier.cancelAlert(ctx)
            }
            Prefs.notifyOn -> Notifier.alert(ctx, ev)
        }
    }
}
