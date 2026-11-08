package com.ghosttower.sensor

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

/** Programmatic UI so the app has no layout XML or AndroidX dependencies. */
class MainActivity : Activity() {
    private lateinit var networkView: TextView
    private lateinit var cellView: TextView
    private lateinit var statusView: TextView
    private lateinit var optIn: LinearLayout
    private lateinit var home: LinearLayout
    private lateinit var debugButton: Button
    private lateinit var demoSwitch: Switch
    private val ui = Handler(Looper.getMainLooper())
    private var watcher: NetworkWatcher? = null

    private val perms: Array<String> get() = buildList {
        add(Manifest.permission.READ_PHONE_STATE)
        add(Manifest.permission.ACCESS_COARSE_LOCATION)
        add(Manifest.permission.RECEIVE_SMS)
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
    }.toTypedArray()

    private fun hasAll() = perms.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Pipeline.init(this)
        watcher = NetworkWatcher(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }
        val title = TextView(this).apply {
            text = "Ghost Tower Sensor"
            textSize = 26f
            // Hidden debug trigger: long-press the title.
            setOnLongClickListener { Pipeline.fireDebug("title long-press"); true }
        }
        root.addView(title)

        // One-screen opt-in.
        optIn = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        optIn.addView(TextView(this).apply {
            text = "Your phone is now a sensor. We only report fake-tower events, never your calls, contacts or exact location."
            textSize = 18f
            setPadding(0, 32, 0, 32)
        })
        optIn.addView(TextView(this).apply {
            text = "What leaves your phone: whether you dropped to 2G and for how long, a scam score for a text received during that drop, the brand it imitates, a hash of the link's domain, and your location rounded to about 150 m. The text itself is only scored and never stored or reported."
            textSize = 14f
            setPadding(0, 0, 0, 32)
        })
        optIn.addView(Button(this).apply {
            text = "Turn on sensor"
            setOnClickListener { requestPermissions(perms, 1) }
        })
        root.addView(optIn)

        // Home screen: real telemetry.
        home = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        networkView = TextView(this).apply { textSize = 22f; setPadding(0, 32, 0, 8) }
        cellView = TextView(this).apply { textSize = 16f; setPadding(0, 0, 0, 24) }
        statusView = TextView(this).apply { textSize = 16f; text = Pipeline.lastStatus }
        home.addView(TextView(this).apply { text = "Real network right now"; textSize = 14f })
        home.addView(networkView)
        home.addView(cellView)
        home.addView(statusView)
        demoSwitch = Switch(this).apply {
            text = "Demo mode (fire when the simulated car passes)"
            setPadding(0, 48, 0, 0)
            setOnCheckedChangeListener { _, _ -> startSensor() }
        }
        home.addView(demoSwitch)
        debugButton = Button(this).apply {
            text = "Debug trigger (fake 2G drop + scam text)"
            setOnClickListener { Pipeline.fireDebug() }
        }
        home.addView(debugButton)
        root.addView(home)

        setContentView(ScrollView(this).apply { addView(root) })
        Pipeline.statusListener = { statusView.text = it }
    }

    override fun onResume() {
        super.onResume()
        refresh()
        ui.post(ticker)
    }

    override fun onPause() {
        ui.removeCallbacks(ticker)
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    private fun refresh() {
        val ok = hasAll()
        optIn.visibility = if (ok) View.GONE else View.VISIBLE
        home.visibility = if (ok) View.VISIBLE else View.GONE
        if (ok) startSensor()
    }

    private fun startSensor() {
        val i = Intent(this, SensorService::class.java).putExtra(SensorService.EXTRA_DEMO, demoSwitch.isChecked)
        startForegroundService(i)
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (hasAll()) {
                val t = Pipeline.currentNetworkType
                networkView.text = Pipeline.networkName(t)
                cellView.text = "Cell: " + (watcher?.cellId() ?: "unavailable")
            }
            ui.postDelayed(this, 2000)
        }
    }
}
