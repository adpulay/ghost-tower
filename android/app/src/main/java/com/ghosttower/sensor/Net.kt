package com.ghosttower.sensor

import android.annotation.SuppressLint
import android.content.Context
import android.location.LocationManager
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.roundToLong

/** Pinned demo location (UTD) used when no real fix is available, and by demo mode. */
object Demo {
    const val LAT = 32.9858
    const val LON = -96.7501
    const val TRIGGER_RADIUS_M = 500.0
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
    fun score(text: String): Pair<Float, String>? = try {
        val (code, body) = post(BuildConfig.SCORE_URL, JSONObject().put("text", text).toString())
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

    @SuppressLint("MissingPermission")
    fun coarseLocation(ctx: Context): Pair<Double, Double> {
        try {
            val lm = ctx.getSystemService(LocationManager::class.java)
            val loc = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            if (loc != null) return coarsen(loc.latitude) to coarsen(loc.longitude)
        } catch (_: Exception) {
        }
        return coarsen(Demo.LAT) to coarsen(Demo.LON) // pinned demo location
    }

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
