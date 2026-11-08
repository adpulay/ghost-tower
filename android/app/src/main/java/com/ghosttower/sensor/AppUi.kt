package com.ghosttower.sensor

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.RippleDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The Ghost Tower app. The look borrows from carrier security apps (magenta brand, rounded cards, risk pills, bottom
 * sheets, a hero status), but the content is Ghost Tower's own: fake cell towers and forced 2G downgrades. Home shows a
 * radar-ring tower and your real connection; Alerts lists what was spotted; Network explains the attack and offers the
 * fix (turn off 2G); a detection also appears as an alert pop-up inside the app.
 * Built from plain Views so the app has no UI library dependency.
 */
class AppUi(private val act: Activity) {
    enum class Tab(val label: String, val glyph: Glyph) {
        HOME("Home", Glyph.TOWER), ALERTS("Alerts", Glyph.ACTIVITY), NETWORK("Network", Glyph.SIGNAL), SETTINGS("Settings", Glyph.SETTINGS),
    }

    val root = FrameLayout(act)
    private val main = act.vbox()
    private val content = FrameLayout(act)
    private val tabBar = act.hbox()
    private val overlay = FrameLayout(act)
    private val radio = RadioInfo(act)
    private val handler = Handler(Looper.getMainLooper())
    private val clock = SimpleDateFormat("MMM d, h:mm a", Locale.getDefault())
    private var tab = Tab.HOME
    private val tabViews = mutableMapOf<Tab, Pair<IconView, TextView>>()

    private val tick = object : Runnable {
        override fun run() {
            onExternalChange()
            handler.postDelayed(this, 5_000)
        }
    }

    init {
        root.setBackgroundColor(Ui.p.bg)
        main.addView(content, LinearLayout.LayoutParams(MATCH, 0, 1f))
        main.addView(View(act).apply { setBackgroundColor(Ui.p.border) }, LinearLayout.LayoutParams(MATCH, 1))
        main.addView(buildTabBar(), LinearLayout.LayoutParams(MATCH, WRAP))
        root.addView(main, FrameLayout.LayoutParams(MATCH, MATCH))
        overlay.visibility = View.GONE
        root.addView(overlay, FrameLayout.LayoutParams(MATCH, MATCH))
        render()
    }

    // ---------------------------------------------------------------- lifecycle hooks from MainActivity

    fun start() { handler.removeCallbacks(tick); handler.postDelayed(tick, 5_000) }
    fun stop() { handler.removeCallbacks(tick) }

    /** Data changed elsewhere (a detection, a status change). Don't rebuild Network: the user may be typing there. */
    fun onExternalChange() { if (tab != Tab.NETWORK) render() }

    fun onBack(): Boolean {
        if (overlay.visibility != View.VISIBLE) return false
        dismissOverlay()
        return true
    }

    fun select(t: Tab) { tab = t; render() }

    // ---------------------------------------------------------------- scaffold

    private fun buildTabBar(): View {
        tabBar.setBackgroundColor(Ui.p.card)
        Tab.values().forEach { t ->
            val icon = IconView(act, t.glyph, Ui.p.muted)
            val label = act.text(t.label, 11f, Ui.p.muted, bold = true)
            val cell = act.vbox().apply {
                gravity = Gravity.CENTER
                setPadding(0, dp(10), 0, dp(10))
                setOnClickListener { select(t) }
                addView(icon, act.lp(w = dp(26), h = dp(26)))
                addView(label, act.lp(w = WRAP, t = 4))
            }
            tabViews[t] = icon to label
            tabBar.addView(cell, LinearLayout.LayoutParams(0, WRAP, 1f))
        }
        return tabBar
    }

    fun render() {
        content.removeAllViews()
        content.addView(
            when (tab) {
                Tab.HOME -> homeView()
                Tab.ALERTS -> alertsView()
                Tab.NETWORK -> networkView()
                Tab.SETTINGS -> settingsView()
            },
        )
        tabViews.forEach { (t, v) ->
            val c = if (t == tab) Ui.p.magenta else Ui.p.muted
            v.first.tint = c
            v.second.setTextColor(c)
        }
    }

    private fun dp(v: Number) = act.dp(v)

    private fun screen(title: String?, build: LinearLayout.() -> Unit): View {
        val col = act.vbox().apply {
            setPadding(dp(20), dp(20), dp(20), dp(28))
            if (title != null) addView(act.text(title, 30f, Ui.p.ink, bold = true), act.lp(b = 18))
            build()
        }
        return ScrollView(act).apply {
            isVerticalScrollBarEnabled = false
            addView(col, FrameLayout.LayoutParams(MATCH, WRAP))
        }
    }

    private fun addDivider(box: LinearLayout, inset: Number = 18) =
        box.addView(View(act).apply { setBackgroundColor(Ui.p.border) }, act.lp(h = 1, l = inset))

    // ---------------------------------------------------------------- Home

    private data class Hero(val state: SignalState, val title: String, val sub: String)

    private fun hero(): Hero {
        val now = System.currentTimeMillis()
        if (!Prefs.shieldOn) return Hero(SignalState.ATTENTION, "Tower watch is paused", "Turn it back on to be warned about fake cell towers.")
        if (EventLog.all().any { it.kind == "text" && now - it.ts < 90_000 }) {
            return Hero(SignalState.ALERT, "Fake tower nearby", "Your phone was pulled onto a fake tower. Don't tap links in new texts.")
        }
        if (EventLog.all().any { it.kind == "warning" && now - it.ts < 90_000 }) {
            return Hero(SignalState.ATTENTION, "Fake tower heading your way", "Ghost Tower warned you before it reached you. Don't tap links in new texts.")
        }
        Pipeline.problem?.let { return Hero(SignalState.ATTENTION, "Needs attention", it) }
        return Hero(SignalState.CLEAR, "Your signal looks clear", "Ghost Tower is watching for fake cell towers around you.")
    }

    private fun homeView(): View = screen(null) {
        addView(
            act.hbox().apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(IconView(act, Glyph.TOWER, Ui.p.magenta), act.lp(w = dp(26), h = dp(26), r = 8))
                addView(act.text("Ghost Tower", 20f, Ui.p.magenta, bold = true), act.lp(w = 0, weight = 1f))
                addView(act.pill("Demo build", Ui.p.amberInk, Ui.p.amberWash))
            },
            act.lp(b = 16),
        )

        val h = hero()
        addView(
            act.card(20).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                addView(RadarView(act).apply { state = h.state }, act.lp(w = dp(250), h = dp(220)))
                addView(
                    act.text(h.title, 26f, if (h.state == SignalState.ALERT) Ui.p.red else Ui.p.ink, bold = true).apply { gravity = Gravity.CENTER },
                    act.lp(t = 2),
                )
                addView(act.text(h.sub, 15f, Ui.p.ink2).apply { gravity = Gravity.CENTER }, act.lp(t = 8))
            },
            act.lp(b = 14),
        )

        addView(connectionCard(), act.lp(b = 14))

        val since = System.currentTimeMillis() - 30L * 24 * 3600 * 1000
        val towers = EventLog.countSince(since, "tower")
        val texts = EventLog.countSince(since, "text")
        addView(
            act.card(20).apply {
                addView(
                    act.hbox().apply {
                        gravity = Gravity.CENTER_VERTICAL
                        addView(
                            act.vbox().apply {
                                addView(act.text("Fake towers spotted", 14f, Ui.p.muted, bold = true))
                                addView(act.text(towers.toString(), 58f, Ui.p.magenta, bold = true, condensed = true), act.lp(t = 6))
                                addView(act.text("in the last 30 days", 13f, Ui.p.muted), act.lp(t = 2))
                            },
                            act.lp(w = 0, weight = 1f),
                        )
                        addView(View(act).apply { setBackgroundColor(Ui.p.border) }, act.lp(w = 1, h = dp(70), r = 18))
                        addView(
                            act.vbox().apply {
                                gravity = Gravity.CENTER_HORIZONTAL
                                addView(act.text(texts.toString(), 36f, Ui.p.ink, bold = true, condensed = true))
                                addView(act.text("scam texts\nflagged", 12f, Ui.p.muted).apply { gravity = Gravity.CENTER }, act.lp(t = 4))
                            },
                            act.lp(w = WRAP),
                        )
                    },
                )
            },
            act.lp(b = 14),
        )

        addView(
            act.hbox().apply {
                addView(toggleCard(Glyph.TOWER, "Tower watch", Prefs.shieldOn) { Prefs.shieldOn = it; render() }, act.lp(w = 0, weight = 1f, r = 7))
                addView(toggleCard(Glyph.ALERT, "Pop-up alerts", Prefs.popupsOn) { Prefs.popupsOn = it; render() }, act.lp(w = 0, weight = 1f, l = 7))
            },
            act.lp(b = 22),
        )

        addView(
            act.hbox().apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(act.text("Latest alerts", 18f, Ui.p.ink, bold = true), act.lp(w = 0, weight = 1f))
                addView(act.text("See all", 15f, Ui.p.magenta, bold = true).apply { setOnClickListener { select(Tab.ALERTS) } })
            },
            act.lp(b = 10),
        )
        addView(alertsCard(EventLog.all().take(3)), act.lp(b = 16))
        addView(
            act.text("Demo build: the 2G drop and the scam text are simulated. This app never reads your texts or calls.", 12f, Ui.p.muted)
                .apply { gravity = Gravity.CENTER },
        )
    }

    /** Your phone's real network, with the attack's tell-tale sign: being pushed down to 2G. */
    private fun connectionCard(): View {
        val risky = Pipeline.is2G(radio.networkType())
        return act.card(18).apply {
            addView(
                act.hbox().apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(
                        act.vbox().apply {
                            addView(act.text("Your connection", 14f, Ui.p.muted, bold = true))
                            addView(act.text(radio.networkName(), 32f, Ui.p.ink, bold = true, condensed = true), act.lp(t = 4))
                        },
                        act.lp(w = 0, weight = 1f),
                    )
                    addView(if (risky) act.pill("On 2G: risky", Ui.p.red, Ui.p.redWash) else act.pill("No fake-tower signs", Ui.p.green, Ui.p.greenWash))
                },
            )
            addView(
                act.text("A fake tower tries to push your phone down to 2G so it can text you directly. This is your phone's real network right now.", 13f, Ui.p.muted),
                act.lp(t = 10),
            )
        }
    }

    private fun toggleCard(glyph: Glyph, label: String, on: Boolean, onChange: (Boolean) -> Unit): View {
        val sw = switchView(on)
        return act.card(16).apply {
            minimumHeight = dp(104)
            setOnClickListener {
                val next = !sw.isChecked
                sw.isChecked = next
                onChange(next)
            }
            addView(
                act.hbox().apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(iconDisc(glyph, if (on) Ui.p.magenta else Ui.p.muted, if (on) Ui.p.magentaWash else Ui.p.bg), act.lp(w = dp(38), h = dp(38)))
                    addView(View(act), act.lp(w = 0, weight = 1f))
                    addView(sw)
                },
            )
            addView(act.text(label, 16f, Ui.p.ink, bold = true), act.lp(t = 14))
            addView(act.text(if (on) "On" else "Off", 13f, if (on) Ui.p.green else Ui.p.muted, bold = true), act.lp(t = 3))
        }
    }

    private fun switchView(on: Boolean) = Switch(act).apply {
        isChecked = on
        isClickable = false
        thumbTintList = tint(Color.WHITE, Color.WHITE)
        trackTintList = tint(Ui.p.magenta, if (Ui.p.dark) 0xFF55555E.toInt() else 0xFFC8C8CF.toInt())
    }

    private fun tint(checked: Int, unchecked: Int) = ColorStateList(
        arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()), intArrayOf(checked, unchecked),
    )

    private fun iconDisc(glyph: Glyph, fg: Int, bg: Int): View = FrameLayout(act).apply {
        background = act.shape(bg, 999)
        addView(IconView(act, glyph, fg), FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER))
    }

    // ---------------------------------------------------------------- Alerts

    private fun alertsView(): View = screen("Alerts") {
        addView(alertsCard(EventLog.all()), act.lp())
    }

    private fun emptyState(): View = act.card(28).apply {
        gravity = Gravity.CENTER_HORIZONTAL
        addView(iconDisc(Glyph.TOWER, Ui.p.magenta, Ui.p.magentaWash), act.lp(w = dp(64), h = dp(64)))
        addView(act.text("All clear", 20f, Ui.p.ink, bold = true).apply { gravity = Gravity.CENTER }, act.lp(t = 14))
        addView(
            act.text("No fake towers spotted. When Ghost Tower detects one, it shows up here. Tap an alert for details.", 15f, Ui.p.ink2).apply { gravity = Gravity.CENTER },
            act.lp(t = 6),
        )
    }

    private fun alertsCard(events: List<ThreatEvent>): View {
        if (events.isEmpty()) return emptyState()
        return act.card(0).apply {
            events.forEachIndexed { i, ev ->
                addView(alertRow(ev))
                if (i < events.lastIndex) addDivider(this)
            }
        }
    }

    private fun badge(ev: ThreatEvent): View = when {
        ev.kind == "warning" -> act.pill("Warning", Ui.p.amberInk, Ui.p.amberWash)
        ev.kind == "tower" -> act.pill("Fake tower", Ui.p.red, Ui.p.redWash)
        ev.score >= 0.9f -> act.pill("Scam text", Ui.p.red, Ui.p.redWash)
        else -> act.pill("Suspicious", Ui.p.amberInk, Ui.p.amberWash)
    }

    private fun alertRow(ev: ThreatEvent): View = act.hbox().apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(18), dp(16), dp(18), dp(16))
        setOnClickListener { showAlertSheet(ev) }
        val warn = ev.kind == "warning"
        val glyph = if (ev.kind == "tower" || warn) Glyph.TOWER else Glyph.ALERT
        addView(
            iconDisc(glyph, if (warn) Ui.p.amberInk else Ui.p.red, if (warn) Ui.p.amberWash else Ui.p.redWash),
            act.lp(w = dp(42), h = dp(42), r = 14),
        )
        addView(
            act.vbox().apply {
                addView(act.text(ev.title, 16f, Ui.p.ink, bold = true))
                addView(act.text(ev.detail, 14f, Ui.p.ink2), act.lp(t = 3))
                addView(act.text(ago(ev.ts), 12f, Ui.p.muted), act.lp(t = 5))
            },
            act.lp(w = 0, weight = 1f, r = 10),
        )
        addView(badge(ev))
    }

    private fun ago(ts: Long): String {
        val s = (System.currentTimeMillis() - ts) / 1000
        return when {
            s < 60 -> "Just now"
            s < 3600 -> "${s / 60} min ago"
            else -> clock.format(Date(ts))
        }
    }

    // ---------------------------------------------------------------- Network

    private fun networkView(): View = screen("Network") {
        addView(
            act.card(18).apply {
                addView(act.text("Your connection", 18f, Ui.p.ink, bold = true), act.lp(b = 8))
                addView(infoRow("Network now", radio.networkName()))
                addView(infoRow("Cell", radio.cellId()))
                addView(act.text("Read-only. This is your phone's real radio.", 12f, Ui.p.muted), act.lp(t = 6))
            },
            act.lp(b = 16),
        )
        addView(
            act.card(18).apply {
                addView(act.text("How a fake tower works", 18f, Ui.p.ink, bold = true), act.lp(b = 14))
                addView(step(1, "It pretends to be a cell tower", "A box in a car broadcasts a strong signal on the old 2G network."), act.lp(b = 14))
                addView(step(2, "Your phone drops to 2G", "Phones prefer the strongest signal, even an old and weak one."), act.lp(b = 14))
                addView(step(3, "It texts you directly", "The scam message never goes through your carrier, so carrier filters never see it."))
            },
            act.lp(b = 16),
        )
        addView(
            act.card(18).apply {
                addView(act.text("Protect yourself", 18f, Ui.p.ink, bold = true))
                addView(
                    act.text("Turning off 2G on your phone stops a fake tower from pulling you down to it. On most Android phones it's under Network & internet, then SIMs.", 14f, Ui.p.ink2),
                    act.lp(t = 6, b = 14),
                )
                addView(primaryButton("Open network settings") { openNetworkSettings() })
            },
            act.lp(),
        )
    }

    private fun step(n: Int, title: String, body: String): View = act.hbox().apply {
        addView(
            FrameLayout(act).apply {
                background = act.shape(Ui.p.magentaWash, 999)
                addView(act.text(n.toString(), 16f, Ui.p.magenta, bold = true), FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER))
            },
            act.lp(w = dp(34), h = dp(34), r = 14),
        )
        addView(
            act.vbox().apply {
                addView(act.text(title, 15f, Ui.p.ink, bold = true))
                addView(act.text(body, 14f, Ui.p.ink2), act.lp(t = 3))
            },
            act.lp(w = 0, weight = 1f),
        )
    }

    private fun openNetworkSettings() {
        try {
            act.startActivity(Intent(Settings.ACTION_WIRELESS_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(act, "Open Settings, then Network & internet", Toast.LENGTH_LONG).show()
        }
    }

    // ---------------------------------------------------------------- Settings

    private fun settingsView(): View = screen("Settings") {
        addView(
            act.card(0).apply {
                addView(switchRow("Tower watch", "Watch for fake cell towers and the scam texts they send.", Prefs.shieldOn) { Prefs.shieldOn = it })
                addDivider(this)
                addView(switchRow("Pop-up alerts", "Show a full alert in the app when a fake tower is detected.", Prefs.popupsOn) { Prefs.popupsOn = it })
                addDivider(this)
                addView(switchRow("Notifications", "Send a notification when the app is closed.", Prefs.notifyOn) { Prefs.notifyOn = it })
            },
            act.lp(b = 16),
        )
        addView(
            act.card(18).apply {
                addView(act.text("This demo build", 18f, Ui.p.ink, bold = true), act.lp(b = 8))
                addView(infoRow("Demo spot", "Coit Rd (fixed point)"))
                addView(infoRow("Scam checker", BuildConfig.SCORE_URL.removePrefix("http://")))
                addView(infoRow("Reports go to", BuildConfig.SPACETIME_DB))
                addView(
                    act.text(
                        "The 2G drop and the scam text are simulated when the demo's fake tower passes. The app never reads your texts or calls, and sends no personal data.",
                        13f, Ui.p.muted,
                    ),
                    act.lp(t = 10),
                )
            },
            act.lp(b = 16),
        )
        addView(
            primaryButton("Run the demo now") {
                Pipeline.fireDebug("settings")
                Toast.makeText(act, "Demo started. The alert appears in about 8 seconds.", Toast.LENGTH_LONG).show()
                select(Tab.HOME)
            },
            act.lp(b = 12),
        )
        addView(outlineButton("Clear alerts", Ui.p.red) { EventLog.clear(); Toast.makeText(act, "Alerts cleared", Toast.LENGTH_SHORT).show() }, act.lp())
    }

    private fun switchRow(title: String, desc: String, on: Boolean, onChange: (Boolean) -> Unit): View {
        val sw = switchView(on)
        return act.hbox().apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(16))
            setOnClickListener { sw.isChecked = !sw.isChecked; onChange(sw.isChecked) }
            addView(
                act.vbox().apply {
                    addView(act.text(title, 16f, Ui.p.ink, bold = true))
                    addView(act.text(desc, 13f, Ui.p.muted), act.lp(t = 3))
                },
                act.lp(w = 0, weight = 1f, r = 12),
            )
            addView(sw)
        }
    }

    private fun infoRow(label: String, value: String): View = act.hbox().apply {
        setPadding(0, dp(7), 0, dp(7))
        addView(act.text(label, 15f, Ui.p.ink2), act.lp(w = 0, weight = 1f, r = 12))
        addView(act.text(value, 15f, Ui.p.ink, bold = true).apply { gravity = Gravity.END }, act.lp(w = 0, weight = 1.4f))
    }

    // ---------------------------------------------------------------- buttons

    private fun ripple(fill: Int, r: Number, stroke: Int? = null, rippleColor: Int = 0x33000000): RippleDrawable =
        RippleDrawable(ColorStateList.valueOf(rippleColor), act.shape(fill, r, stroke, 1.5f), null)

    private fun primaryButton(label: String, onClick: () -> Unit): View =
        act.text(label, 16f, Color.WHITE, bold = true).apply {
            gravity = Gravity.CENTER
            background = ripple(Ui.p.magenta, 14, rippleColor = 0x44FFFFFF)
            minHeight = dp(52)
            setPadding(dp(16), dp(15), dp(16), dp(15))
            setOnClickListener { onClick() }
        }

    private fun outlineButton(label: String, color: Int, onClick: () -> Unit): View =
        act.text(label, 16f, color, bold = true).apply {
            gravity = Gravity.CENTER
            background = ripple(Ui.p.card, 14, stroke = color, rippleColor = 0x22000000)
            minHeight = dp(52)
            setPadding(dp(16), dp(15), dp(16), dp(15))
            setOnClickListener { onClick() }
        }

    private fun textButton(label: String, onClick: () -> Unit): View =
        act.text(label, 15f, Ui.p.muted, bold = true).apply {
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(14), dp(16), dp(6))
            setOnClickListener { onClick() }
        }

    // ---------------------------------------------------------------- bottom sheet and alert pop-up

    private fun dismissOverlay() {
        overlay.removeAllViews()
        overlay.visibility = View.GONE
    }

    private fun showOverlay(build: FrameLayout.() -> Unit) {
        overlay.removeAllViews()
        overlay.visibility = View.VISIBLE
        overlay.build()
    }

    private fun scrim(onTap: () -> Unit): View = View(act).apply {
        setBackgroundColor(0x99000000.toInt())
        setOnClickListener { onTap() }
    }

    private fun showAlertSheet(ev: ThreatEvent) = showOverlay {
        addView(scrim { dismissOverlay() }, FrameLayout.LayoutParams(MATCH, MATCH))
        val sheet = act.vbox().apply {
            background = act.topRounded(Ui.p.card, 24)
            setPadding(dp(22), dp(10), dp(22), dp(24))
            isClickable = true
            addView(View(act).apply { background = act.shape(Ui.p.border, 3) }, act.lp(w = dp(40), h = dp(5), b = 16).apply { gravity = Gravity.CENTER_HORIZONTAL })
            threatBody(this, ev, alert = false)
        }
        addView(sheet, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))
        sheet.translationY = 900f
        sheet.animate().translationY(0f).setDuration(240).start()
    }

    /** The full alert shown inside the app the moment a fake tower and a scam text are detected. */
    fun showAlert(ev: ThreatEvent) {
        select(Tab.HOME)
        showOverlay {
            addView(scrim { }, FrameLayout.LayoutParams(MATCH, MATCH))
            val card = act.vbox().apply {
                background = act.shape(Ui.p.card, 24)
                setPadding(dp(22), dp(10), dp(22), dp(18))
                isClickable = true
                gravity = Gravity.CENTER_HORIZONTAL
                addView(
                    RadarView(act).apply { state = if (ev.kind == "warning") SignalState.ATTENTION else SignalState.ALERT },
                    act.lp(w = dp(210), h = dp(170)),
                )
                threatBody(this, ev, alert = true)
            }
            addView(card, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.CENTER).apply { setMargins(dp(20), dp(20), dp(20), dp(20)) })
            card.scaleX = .9f; card.scaleY = .9f; card.alpha = 0f
            card.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(220).start()
        }
    }

    /** Shared by the bottom sheet and the alert: what happened, how sure we are, and what to do about it. */
    private fun threatBody(box: LinearLayout, ev: ThreatEvent, alert: Boolean) {
        val close = { dismissOverlay() }
        if (!alert) {
            box.addView(
                act.hbox().apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(badge(ev))
                    addView(act.text(clock.format(Date(ev.ts)), 13f, Ui.p.muted), act.lp(l = 10))
                },
                act.lp(b = 12),
            )
        }
        val warn = ev.kind == "warning"
        val titleColor = if (warn) Ui.p.amberInk else if (alert) Ui.p.red else Ui.p.ink
        box.addView(
            act.text(if (alert && !warn) "Fake tower detected" else ev.title, if (alert) 24f else 22f, titleColor, bold = true)
                .apply { if (alert) gravity = Gravity.CENTER },
            act.lp(t = if (alert) 2 else 0),
        )
        box.addView(
            act.text(
                if (alert && !warn) "Your phone was just pulled onto a fake cell tower. The text you received is fake. Don't tap the link."
                else ev.detail,
                15f, Ui.p.ink2,
            ).apply { if (alert) gravity = Gravity.CENTER },
            act.lp(t = 8),
        )
        if (ev.preview.isNotBlank()) {
            box.addView(
                act.vbox().apply {
                    background = act.shape(Ui.p.bg, 12, Ui.p.border)
                    setPadding(dp(14), dp(12), dp(14), dp(12))
                    addView(
                        act.hbox().apply {
                            gravity = Gravity.CENTER_VERTICAL
                            // The sheet already shows the badge in its header; only the alert needs it here.
                            if (alert) addView(badge(ev.copy(kind = "text")))
                            addView(act.text("${(ev.score * 100).toInt()}% sure", 13f, Ui.p.ink2, bold = true), act.lp(l = if (alert) 10 else 0))
                        },
                    )
                    addView(act.text(ev.preview, 14f, Ui.p.ink), act.lp(t = 8))
                },
                act.lp(t = 14),
            )
        }
        if (!alert) {
            box.addView(infoRow("Where", "Coit Rd (demo spot)"), act.lp(t = 10))
            if (ev.brand.isNotBlank()) box.addView(infoRow("Pretending to be", ev.brand))
            if (ev.domain.isNotBlank()) box.addView(infoRow("Link", ev.domain))
        }
        // Detections are reported to the Ghost Tower map automatically; say whether that worked.
        box.addView(
            act.hbox().apply {
                gravity = Gravity.CENTER_VERTICAL
                val ok = warn || ev.reported
                addView(
                    iconDisc(if (ok) Glyph.CHECK else Glyph.ALERT, if (ok) Ui.p.green else Ui.p.amberInk, if (ok) Ui.p.greenWash else Ui.p.amberWash),
                    act.lp(w = dp(30), h = dp(30), r = 10),
                )
                addView(
                    act.text(
                        when {
                            warn -> "Your spot is inside the warning zone, so Ghost Tower warned you before the tower arrived"
                            ev.reported -> "Sent to the Ghost Tower map, so people nearby can be warned"
                            else -> "Couldn't reach the Ghost Tower map. Check your connection."
                        },
                        13f, Ui.p.ink2,
                    ),
                    act.lp(w = 0, weight = 1f),
                )
            },
            act.lp(t = 14),
        )
        box.addView(
            if (alert) primaryButton("Got it") { close() } else outlineButton("Close", Ui.p.muted) { close() },
            act.lp(t = 16),
        )
        box.addView(outlineButton("Turn off 2G on this phone", Ui.p.magenta) { close(); openNetworkSettings() }, act.lp(t = 10))
        if (alert) box.addView(textButton("Dismiss") { close() }, act.lp(t = 2))
    }

    // ---------------------------------------------------------------- first-run screen

    fun optInView(onTurnOn: () -> Unit): View = ScrollView(act).apply {
        setBackgroundColor(Ui.p.magenta)
        isVerticalScrollBarEnabled = false
        addView(
            act.vbox().apply {
                gravity = Gravity.CENTER_HORIZONTAL
                setPadding(dp(28), dp(64), dp(28), dp(32))
                addView(FrameLayout(act).apply {
                    background = act.shape(0x33FFFFFF, 999)
                    addView(IconView(act, Glyph.TOWER, Color.WHITE), FrameLayout.LayoutParams(dp(64), dp(64), Gravity.CENTER))
                }, act.lp(w = dp(120), h = dp(120)))
                addView(act.text("Turn on Tower watch", 32f, Color.WHITE, bold = true).apply { gravity = Gravity.CENTER }, act.lp(t = 28))
                addView(act.text("Demo build. This app does not read your texts or calls.", 18f, Color.WHITE, bold = true).apply { gravity = Gravity.CENTER }, act.lp(t = 14))
                addView(
                    act.text(
                        "When the simulated fake tower drives past the demo spot, the app plays out a simulated 2G drop and a sample scam text, scores that sample text, and sends a report to the demo database: the score, the brand, a hash of the link's domain, and a fixed demo location.\n\nNothing about you is sent. Phone and location permission are only used to show your phone's real network type and cell on the next screens.",
                        15f, 0xFFFFE6F2.toInt(),
                    ).apply { gravity = Gravity.CENTER },
                    act.lp(t = 14),
                )
                addView(
                    act.text("Turn on", 18f, Ui.p.magenta, bold = true).apply {
                        gravity = Gravity.CENTER
                        background = RippleDrawable(ColorStateList.valueOf(0x33E20074), act.shape(Color.WHITE, 999), null)
                        setPadding(dp(16), dp(17), dp(16), dp(17))
                        setOnClickListener { onTurnOn() }
                    },
                    act.lp(t = 30),
                )
            },
            FrameLayout.LayoutParams(MATCH, WRAP),
        )
    }
}
