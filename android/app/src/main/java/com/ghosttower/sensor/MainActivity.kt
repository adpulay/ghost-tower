package com.ghosttower.sensor

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View

/** Hosts [AppUi]: the first-run permission screen, then the Scam Shield-style app. Detections pop up as an in-app alert. */
class MainActivity : Activity() {
    companion object {
        const val EXTRA_ALERT_ID = "alert_id"
    }

    private var ui: AppUi? = null
    private val changed: () -> Unit = { ui?.onExternalChange() }

    private val perms: Array<String>
        get() = buildList {
            add(Manifest.permission.READ_PHONE_STATE)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private fun hasAll() = perms.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Pipeline.init(this)
        Ui.init(this)
        build()
    }

    private fun build() {
        val u = AppUi(this)
        ui = u
        if (hasAll()) {
            systemBars(Ui.p.bg, Ui.p.card, lightIcons = !Ui.p.dark)
            setContentView(u.root)
            startForegroundService(Intent(this, SensorService::class.java))
        } else {
            systemBars(Ui.p.magenta, Ui.p.magenta, lightIcons = false)
            setContentView(u.optInView { requestPermissions(perms, 1) })
        }
    }

    @Suppress("DEPRECATION")
    private fun systemBars(status: Int, nav: Int, lightIcons: Boolean) {
        window.statusBarColor = status
        window.navigationBarColor = nav
        var flags = window.decorView.systemUiVisibility
        val light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        flags = if (lightIcons) flags or light else flags and light.inv()
        window.decorView.systemUiVisibility = flags
    }

    override fun onResume() {
        super.onResume()
        // While the app is open, a detection pops up as an alert inside it instead of a notification.
        Alerts.foreground = { ev -> ui?.showAlert(ev) }
        EventLog.listeners.add(changed)
        Pipeline.statusListener = { changed() }
        ui?.start()
        ui?.onExternalChange()
        showAlertFromIntent()
    }

    override fun onPause() {
        Alerts.foreground = null
        EventLog.listeners.remove(changed)
        Pipeline.statusListener = null
        ui?.stop()
        super.onPause()
    }

    /** Tapping the notification (app was closed) opens the same alert. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        showAlertFromIntent()
    }

    private fun showAlertFromIntent() {
        val id = intent?.getLongExtra(EXTRA_ALERT_ID, -1L) ?: -1L
        if (id < 0 || !hasAll()) return
        intent?.removeExtra(EXTRA_ALERT_ID)
        EventLog.find(id)?.let { ui?.showAlert(it) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (hasAll()) build()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (ui?.onBack() == true) return
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }
}
