package com.ghosttower.sensor

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

enum class Glyph { SHIELD, CHECK, ALERT, ACTIVITY, MANAGE, SETTINGS, TOWER, LOCK, CHEVRON, SIGNAL }

/** Heavy-stroke line icons drawn in code, so the app needs no image assets. Coordinates are 0..1 of the box. */
object Glyphs {
    fun shieldPath(x: Float, y: Float, s: Float): Path = Path().apply {
        moveTo(x + .5f * s, y + .04f * s)
        lineTo(x + .88f * s, y + .19f * s)
        lineTo(x + .88f * s, y + .52f * s)
        quadTo(x + .88f * s, y + .82f * s, x + .5f * s, y + .97f * s)
        quadTo(x + .12f * s, y + .82f * s, x + .12f * s, y + .52f * s)
        lineTo(x + .12f * s, y + .19f * s)
        close()
    }

    fun draw(c: Canvas, g: Glyph, x: Float, y: Float, s: Float, p: Paint) {
        p.style = Paint.Style.STROKE
        fun px(v: Float) = x + v * s
        fun py(v: Float) = y + v * s
        when (g) {
            Glyph.SHIELD -> c.drawPath(shieldPath(x, y, s), p)
            Glyph.CHECK -> {
                val path = Path().apply { moveTo(px(.28f), py(.52f)); lineTo(px(.44f), py(.68f)); lineTo(px(.74f), py(.34f)) }
                c.drawPath(path, p)
            }
            Glyph.ALERT -> {
                c.drawLine(px(.5f), py(.24f), px(.5f), py(.56f), p)
                val fill = Paint(p).apply { style = Paint.Style.FILL }
                c.drawCircle(px(.5f), py(.74f), s * .055f, fill)
            }
            Glyph.ACTIVITY -> {
                val fill = Paint(p).apply { style = Paint.Style.FILL }
                for (k in 0..2) {
                    val yy = py(.25f + .25f * k)
                    c.drawCircle(px(.16f), yy, s * .05f, fill)
                    c.drawLine(px(.32f), yy, px(.88f), yy, p)
                }
            }
            Glyph.MANAGE -> {
                c.drawLine(px(.12f), py(.32f), px(.88f), py(.32f), p)
                c.drawCircle(px(.66f), py(.32f), s * .1f, p)
                c.drawLine(px(.12f), py(.68f), px(.88f), py(.68f), p)
                c.drawCircle(px(.34f), py(.68f), s * .1f, p)
            }
            Glyph.SETTINGS -> {
                c.drawCircle(px(.5f), py(.5f), s * .17f, p)
                for (k in 0 until 8) {
                    val a = k * PI / 4
                    val r1 = s * .3f
                    val r2 = s * .42f
                    c.drawLine(
                        px(.5f) + (r1 * cos(a)).toFloat(), py(.5f) + (r1 * sin(a)).toFloat(),
                        px(.5f) + (r2 * cos(a)).toFloat(), py(.5f) + (r2 * sin(a)).toFloat(), p,
                    )
                }
            }
            Glyph.TOWER -> {
                val fill = Paint(p).apply { style = Paint.Style.FILL }
                c.drawLine(px(.5f), py(.36f), px(.3f), py(.94f), p)
                c.drawLine(px(.5f), py(.36f), px(.7f), py(.94f), p)
                c.drawLine(px(.37f), py(.7f), px(.63f), py(.7f), p)
                c.drawCircle(px(.5f), py(.3f), s * .06f, fill)
                c.drawArc(RectF(px(.28f), py(.08f), px(.72f), py(.52f)), 205f, 130f, false, p)
                c.drawArc(RectF(px(.14f), py(-.06f), px(.86f), py(.66f)), 215f, 110f, false, p)
            }
            Glyph.LOCK -> {
                c.drawRoundRect(RectF(px(.26f), py(.46f), px(.74f), py(.88f)), s * .08f, s * .08f, p)
                c.drawArc(RectF(px(.34f), py(.12f), px(.66f), py(.7f)), 180f, 180f, false, p)
            }
            Glyph.SIGNAL -> {
                // four ascending bars: a signal-strength meter
                for (k in 0..3) {
                    val xx = px(.2f + .2f * k)
                    c.drawLine(xx, py(.86f), xx, py(.86f - (.2f + .17f * k)), p)
                }
            }
            Glyph.CHEVRON -> {
                val path = Path().apply { moveTo(px(.38f), py(.24f)); lineTo(px(.64f), py(.5f)); lineTo(px(.38f), py(.76f)) }
                c.drawPath(path, p)
            }
        }
    }
}

/** One heavy-stroke glyph in a single colour (tab bar, list rows, buttons). */
class IconView(ctx: Context, var glyph: Glyph, tint: Int) : View(ctx) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    var tint: Int = tint
        set(v) { field = v; invalidate() }

    override fun onDraw(canvas: Canvas) {
        val s = min(width, height).toFloat()
        paint.color = tint
        paint.strokeWidth = s * .085f
        Glyphs.draw(canvas, glyph, (width - s) / 2f, (height - s) / 2f, s, paint)
    }
}

enum class SignalState { CLEAR, ALERT, ATTENTION }

/**
 * The home screen's hero: a cell tower at the centre of pulsing radar rings. Magenta = signal clear,
 * red = a fake tower was just detected, amber = needs attention. A small badge says which.
 */
class RadarView(ctx: Context) : View(ctx) {
    var state: SignalState = SignalState.CLEAR
        set(v) {
            field = v
            anim.duration = if (v == SignalState.ALERT) 1500 else 3200
            invalidate()
        }

    private var phase = 0f
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val glyph = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val anim: ValueAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
        repeatCount = ValueAnimator.INFINITE
        duration = 3200
        interpolator = LinearInterpolator()
        addUpdateListener { phase = it.animatedValue as Float; invalidate() }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        anim.start()
    }

    override fun onDetachedFromWindow() {
        anim.cancel()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        val s = min(width, height).toFloat()
        val cx = width / 2f
        val cy = height / 2f
        val color = when (state) {
            SignalState.CLEAR -> Ui.p.magenta
            SignalState.ALERT -> Ui.p.red
            SignalState.ATTENTION -> Ui.p.amber
        }
        // Radar rings expanding outward from the tower.
        ring.strokeWidth = s * .014f
        ring.color = color
        for (k in 0..2) {
            val ph = (phase + k / 3f) % 1f
            ring.alpha = ((1f - ph) * 150).toInt()
            canvas.drawCircle(cx, cy, s * .22f + s * .26f * ph, ring)
        }
        // Soft halo and the solid disc the tower sits on.
        fill.color = color
        fill.alpha = if (Ui.p.dark) 55 else 34
        canvas.drawCircle(cx, cy, s * .3f, fill)
        fill.color = color
        fill.alpha = 255
        canvas.drawCircle(cx, cy, s * .21f, fill)

        glyph.color = if (state == SignalState.ATTENTION) 0xFF3A2A00.toInt() else 0xFFFFFFFF.toInt()
        glyph.strokeWidth = s * .03f
        val ts = s * .3f
        Glyphs.draw(canvas, Glyph.TOWER, cx - ts / 2, cy - ts / 2, ts, glyph)

        // Status badge on the disc's lower right.
        val bx = cx + s * .15f
        val by = cy + s * .15f
        fill.color = if (Ui.p.dark) 0xFF1E1E22.toInt() else 0xFFFFFFFF.toInt()
        canvas.drawCircle(bx, by, s * .075f, fill)
        fill.color = when (state) {
            SignalState.CLEAR -> Ui.p.green
            SignalState.ALERT -> Ui.p.red
            SignalState.ATTENTION -> Ui.p.amberInk
        }
        canvas.drawCircle(bx, by, s * .06f, fill)
        glyph.color = 0xFFFFFFFF.toInt()
        glyph.strokeWidth = s * .014f
        val bs = s * .09f
        Glyphs.draw(canvas, if (state == SignalState.CLEAR) Glyph.CHECK else Glyph.ALERT, bx - bs / 2, by - bs / 2, bs, glyph)
    }
}
