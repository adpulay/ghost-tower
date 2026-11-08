package com.ghosttower.sensor

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToLong

/**
 * Pinned demo location: on Coit Rd just past the turn, 2,500 m along the demo-01 route
 * (sim/routes/demo.json; the blaster turns north onto Coit Rd at ~2,260 m). Demo mode fires when an
 * active simulated track comes within TRIGGER_RADIUS_M, and debug/demo reports use this point so they
 * land in the simulated blaster's cluster (recluster joins events within 800 m).
 *
 * Why here: the warning zone is a corridor AHEAD of the tower, so the phone has to sit ahead of the
 * tower when the first warning goes out. The old pin (1,000 m along, on Campbell Rd) was within
 * reach of the tower before the track was even active, so the phone got its scam text before any
 * warning and was never inside a zone. In a 3x run of demo-01 the first warning with recipients is
 * sent when the car is ~1,780 m along; its zone covers this pin ~720 m (~22 s at 3x) before the car
 * gets here. The track estimate trails the car by ~224 m, so a 300 m trigger fires as the car
 * approaches the pin, after the warning.
 * If you move it, redo the check (compare the alerts' zone_json with the pin), and keep the pitch
 * script's timeline and the web map's DEMO_PHONE in step.
 */
object Demo {
    const val LAT = 32.98036
    const val LON = -96.76805
    const val TRIGGER_RADIUS_M = 300.0
}

private fun post(url: String, body: String, timeoutMs: Int = 5000): Pair<Int, String> {
    val c = URL(url).openConnection() as HttpURLConnection
    try {
        c.requestMethod = "POST"
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(body.toByteArray()) }
        val code = c.responseCode
        val stream = if (code in 200..299) c.inputStream else c.errorStream
        return code to (stream?.bufferedReader()?.readText() ?: "")
    } finally {
        c.disconnect()
    }
}

/** POST /score { "text": ... } -> { "score": 0.97, "brand": "TxTag" } (INTERFACES.md section 8). */
object ScoreClient {
    fun url(): String = Prefs.scoreUrl ?: BuildConfig.SCORE_URL

    fun score(text: String): Pair<Float, String>? = try {
        val (code, body) = post(url(), JSONObject().put("text", text).toString())
        if (code in 200..299) {
            val j = JSONObject(body)
            j.getDouble("score").toFloat() to j.optString("brand", "")
        } else null
    } catch (e: Exception) {
        null
    }
}

/** Calls the report_anomaly reducer over Spacetime's HTTP API (args in reducer order). */
object Reporter {
    private fun coarsen(v: Double) = (v * 1000).roundToLong() / 1000.0

    /** The demo pin, coarsened like any report. Used for simulated (debug/demo) hits. */
    fun pinnedLocation(): Pair<Double, Double> = coarsen(Demo.LAT) to coarsen(Demo.LON)

    fun send(
        tsMs: Long, lat: Double, lon: Double, ratDrop: Boolean, ratDropSecs: Float,
        smsScore: Float, urlHash: String, brand: String, smsc: String,
    ): Boolean = try {
        // Order matches INTERFACES.md section 6; no message text, number or exact GPS.
        val args = JSONArray()
            .put(tsMs).put(lat).put(lon).put(ratDrop).put(ratDropSecs.toDouble())
            .put(smsScore.toDouble()).put(urlHash).put(brand).put(smsc).put("phone")
        val url = "${BuildConfig.SPACETIME_URI}/v1/database/${BuildConfig.SPACETIME_DB}/call/report_anomaly"
        post(url, args.toString()).first in 200..299
    } catch (e: Exception) {
        false
    }

    /**
     * The sim's clock (dev_config.sim_now_ms), or null if unreachable. A sim run at --speed 4x
     * stamps its events ahead of the wall clock; demo reports use this so they land inside
     * recluster's 120 s window and join the simulated track.
     */
    fun simNowMs(): Long? = try {
        val url = "${BuildConfig.SPACETIME_URI}/v1/database/${BuildConfig.SPACETIME_DB}/sql"
        val (code, body) = post(url, "SELECT sim_now_ms FROM dev_config")
        if (code !in 200..299) null
        else JSONArray(body).getJSONObject(0).getJSONArray("rows").optJSONArray(0)?.optLong(0)
    } catch (e: Exception) {
        null
    }

    /** One warning the agent sent: the corridor it covers, the message, and when it went out (agent clock). */
    class ZoneAlert(
        val id: Long, val trackId: Long, val zone: List<Pair<Double, Double>>, val message: String,
        val sentMs: Long, val recipients: Int,
    )

    /** Every row of the alert table (a handful per run), or null if the database can't be reached. */
    fun alerts(): List<ZoneAlert>? = try {
        val url = "${BuildConfig.SPACETIME_URI}/v1/database/${BuildConfig.SPACETIME_DB}/sql"
        val (code, body) = post(url, "SELECT * FROM alert")
        if (code !in 200..299) null else {
            val out = mutableListOf<ZoneAlert>()
            val results = JSONArray(body)
            for (i in 0 until results.length()) {
                val r = results.getJSONObject(i)
                val cols = r.getJSONObject("schema").getJSONArray("elements")
                // Column name arrives as {"some": "id"} or a plain string, depending on server version.
                val names = List(cols.length()) { k ->
                    val n = cols.getJSONObject(k).opt("name")
                    if (n is JSONObject) n.optString("some") else (n as? String ?: "")
                }
                val rows = r.getJSONArray("rows")
                for (k in 0 until rows.length()) {
                    val row = rows.getJSONArray(k)
                    fun col(name: String): Any? = names.indexOf(name).let { if (it < 0) null else row.opt(it) }
                    val zone = JSONArray(col("zone_json") as? String ?: "[]")
                    out += ZoneAlert(
                        id = (col("id") as Number).toLong(),
                        trackId = (col("track_id") as Number).toLong(),
                        zone = List(zone.length()) { z -> zone.getJSONArray(z).let { it.getDouble(0) to it.getDouble(1) } },
                        message = col("message") as? String ?: "",
                        sentMs = (col("sent_ms") as Number).toLong(),
                        recipients = (col("recipients") as Number).toInt(),
                    )
                }
            }
            out
        }
    } catch (e: Exception) {
        null
    }

    /**
     * How many reports from phones (this app) the database holds, or null if it can't be reached. Zero after the
     * demo world is reset, which is how the app notices a reset and clears its own activity log.
     */
    fun phoneReportCount(): Int? = try {
        val url = "${BuildConfig.SPACETIME_URI}/v1/database/${BuildConfig.SPACETIME_DB}/sql"
        val (code, body) = post(url, "SELECT id FROM anomaly_event WHERE source = 'phone'")
        if (code !in 200..299) null else JSONArray(body).getJSONObject(0).getJSONArray("rows").length()
    } catch (e: Exception) {
        null
    }

    /** Active track positions for demo mode: list of (lat, lon) where status == "active". */
    fun activeTracks(): List<Pair<Double, Double>> = try {
        val url = "${BuildConfig.SPACETIME_URI}/v1/database/${BuildConfig.SPACETIME_DB}/sql"
        val (code, body) = post(url, "SELECT * FROM track")
        if (code !in 200..299) emptyList() else {
            val out = mutableListOf<Pair<Double, Double>>()
            val results = JSONArray(body)
            for (i in 0 until results.length()) {
                val r = results.getJSONObject(i)
                val cols = r.getJSONObject("schema").getJSONArray("elements")
                fun idx(name: String): Int {
                    for (k in 0 until cols.length()) {
                        // Column name arrives as {"some": "lat"} or a plain string, depending on server version.
                        val n = cols.getJSONObject(k).opt("name")
                        val colName = if (n is JSONObject) n.optString("some") else n as? String
                        if (colName == name) return k
                    }
                    return -1
                }
                val iLat = idx("lat"); val iLon = idx("lon"); val iSt = idx("status")
                if (iLat < 0 || iLon < 0 || iSt < 0) continue
                val rows = r.getJSONArray("rows")
                for (k in 0 until rows.length()) {
                    val row = rows.getJSONArray(k)
                    if (row.getString(iSt) == "active") out += row.getDouble(iLat) to row.getDouble(iLon)
                }
            }
            out
        }
    } catch (e: Exception) {
        emptyList()
    }
}
