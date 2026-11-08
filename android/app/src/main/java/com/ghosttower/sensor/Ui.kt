package com.ghosttower.sensor

import android.content.Context
import android.content.res.Configuration
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView

const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT

private fun rgb(v: Int): Int = (0xFF shl 24) or v

/** Colours for one theme. Magenta is the brand colour; red/green/amber are the semantic states. */
class Palette(
    val dark: Boolean,
    val bg: Int, val card: Int, val border: Int,
    val ink: Int, val ink2: Int, val muted: Int,
    val magenta: Int, val magentaWash: Int,
    val red: Int, val redWash: Int,
    val green: Int, val greenWash: Int,
    val amber: Int, val amberWash: Int, val amberInk: Int,
)

/** Scam Shield-style design system: magenta brand, white or charcoal surfaces, 16 dp cards, bold sans type. */
object Ui {
    val LIGHT = Palette(
        dark = false, bg = rgb(0xF6F6F8), card = rgb(0xFFFFFF), border = rgb(0xE4E4E8),
        ink = rgb(0x131316), ink2 = rgb(0x3E3E46), muted = rgb(0x6B6B75),
        magenta = rgb(0xE20074), magentaWash = rgb(0xFCE6F1),
        red = rgb(0xD42A3A), redWash = rgb(0xFDECEE),
        green = rgb(0x17824A), greenWash = rgb(0xE3F4EA),
        amber = rgb(0xF2B705), amberWash = rgb(0xFFF3CC), amberInk = rgb(0x6E4A00),
    )
    val DARK = Palette(
        dark = true, bg = rgb(0x121212), card = rgb(0x1E1E22), border = rgb(0x2E2E35),
        ink = rgb(0xF2F2F5), ink2 = rgb(0xC9C9D1), muted = rgb(0x9A9AA5),
        magenta = rgb(0xE20074), magentaWash = rgb(0x3A0A26),
        red = rgb(0xFF5A67), redWash = rgb(0x3A1519),
        green = rgb(0x3CC47C), greenWash = rgb(0x12301F),
        amber = rgb(0xF2B705), amberWash = rgb(0x3A2E05), amberInk = rgb(0xFFD966),
    )

    @Volatile var p: Palette = LIGHT
        private set

    fun init(ctx: Context) {
        val night = ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        p = if (night == Configuration.UI_MODE_NIGHT_YES) DARK else LIGHT
    }
}

fun Context.dp(v: Number): Int = (v.toFloat() * resources.displayMetrics.density + 0.5f).toInt()
fun View.dp(v: Number): Int = context.dp(v)

fun Context.shape(fill: Int, radiusDp: Number, stroke: Int? = null, strokeDp: Number = 1): GradientDrawable =
    GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radiusDp).toFloat()
        if (stroke != null) setStroke(dp(strokeDp), stroke)
    }

fun Context.topRounded(fill: Int, radiusDp: Number): GradientDrawable =
    GradientDrawable().apply {
        setColor(fill)
        val r = dp(radiusDp).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
    }

fun Context.text(
    s: CharSequence, sp: Float, color: Int, bold: Boolean = false, condensed: Boolean = false,
): TextView = TextView(this).apply {
    text = s
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    setTextColor(color)
    typeface = Typeface.create(if (condensed) "sans-serif-condensed" else "sans-serif", if (bold) Typeface.BOLD else Typeface.NORMAL)
    includeFontPadding = false
}

fun Context.vbox(): LinearLayout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
fun Context.hbox(): LinearLayout = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }

fun Context.lp(
    w: Int = MATCH, h: Int = WRAP, weight: Float = 0f,
    l: Number = 0, t: Number = 0, r: Number = 0, b: Number = 0,
): LinearLayout.LayoutParams =
    LinearLayout.LayoutParams(w, h).apply {
        this.weight = weight
        setMargins(dp(l), dp(t), dp(r), dp(b))
    }

/** A bordered 16 dp card on the surface colour. */
fun Context.card(padding: Number = 18): LinearLayout = vbox().apply {
    background = shape(Ui.p.card, 16, Ui.p.border)
    setPadding(dp(padding), dp(padding), dp(padding), dp(padding))
}

/** A small rounded risk badge, e.g. "Scam likely". */
fun Context.pill(label: String, fg: Int, bg: Int): TextView = text(label, 12f, fg, bold = true).apply {
    background = shape(bg, 999)
    setPadding(dp(10), dp(5), dp(10), dp(5))
}
