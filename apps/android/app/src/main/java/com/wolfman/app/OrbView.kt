package com.wolfman.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.random.Random

enum class OrbState { IDLE, LISTENING, THINKING, SPEAKING }

/**
 * A glowing particle-cloud orb (Jarvis-style) that visibly reacts to Wolfman's state: gentle
 * drift when idle, pulses with your real mic input level while listening, a faster swirl while
 * thinking, and a rhythmic pulse while speaking a reply. Throttled to ~30fps with a cached glow
 * shader — recreating the shader and redrawing at full vsync rate every frame previously made
 * the whole UI thread janky enough to feel unresponsive.
 */
class OrbView(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    private class Particle(val angleRad: Double, val radius: Float, val speed: Float, val size: Float)

    private val particles = List(320) {
        val depthBias = Random.nextFloat()
        Particle(
            angleRad = Math.toRadians((Random.nextFloat() * 360f).toDouble()),
            radius = depthBias * depthBias, // biased toward the center, like the reference glow
            speed = 0.4f + Random.nextFloat() * 1.2f,
            size = 1.2f + Random.nextFloat() * 2.6f,
        )
    }

    @Volatile private var state = OrbState.IDLE
    private var audioLevel = 0f
    @Volatile private var targetAudioLevel = 0f
    private var phase = 0f

    private val particlePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var cachedGlowRadius = -1f
    private var cachedGlowColor = 0

    private val frame = object : Runnable {
        override fun run() {
            phase += 0.05f
            audioLevel += (targetAudioLevel - audioLevel) * 0.2f
            invalidate()
            postDelayed(this, 33) // ~30fps — plenty smooth for a background decoration, far cheaper than vsync-rate redraws
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        postDelayed(frame, 33)
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(frame)
        super.onDetachedFromWindow()
    }

    fun setState(newState: OrbState) {
        state = newState
        if (newState != OrbState.LISTENING) targetAudioLevel = 0f
    }

    /** rmsdB from SpeechRecognizer is roughly -2..10; normalized here into a gentle 0..1 pulse. */
    fun pushAudioLevel(rmsdB: Float) {
        targetAudioLevel = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val baseRadius = min(width, height) * 0.38f
        if (baseRadius <= 0f) return

        canvas.drawColor(BACKGROUND_COLOR)

        val (pulse, spin, glowColor) = when (state) {
            OrbState.IDLE -> Triple(1f + 0.03f * sin(phase * 1.2f), 3f, IDLE_COLOR)
            OrbState.LISTENING -> Triple(1f + 0.18f * audioLevel + 0.03f * sin(phase * 3f), 8f + audioLevel * 18f, LISTENING_COLOR)
            OrbState.THINKING -> Triple(1f + 0.07f * sin(phase * 4f), 34f, THINKING_COLOR)
            OrbState.SPEAKING -> Triple(1f + 0.09f * (0.5f + 0.5f * sin(phase * 6f)), 22f, SPEAKING_COLOR)
        }

        val glowRadius = baseRadius * 2.3f * pulse
        // RadialGradient allocation is expensive (GPU shader upload) — only rebuild it when the
        // radius or color actually changed meaningfully instead of on every single frame.
        if (glowColor != cachedGlowColor || kotlin.math.abs(glowRadius - cachedGlowRadius) > 2f) {
            glowPaint.shader = RadialGradient(cx, cy, glowRadius.coerceAtLeast(1f), glowColor, Color.TRANSPARENT, Shader.TileMode.CLAMP)
            cachedGlowRadius = glowRadius
            cachedGlowColor = glowColor
        }
        canvas.drawCircle(cx, cy, glowRadius, glowPaint)

        for (p in particles) {
            val angle = p.angleRad + phase * spin * p.speed
            val r = baseRadius * pulse * (0.12f + p.radius * 0.92f)
            val x = cx + (cos(angle) * r).toFloat()
            val y = cy + (sin(angle) * r * 0.82f).toFloat()
            val closeness = 1f - p.radius
            particlePaint.color = glowColor
            particlePaint.alpha = (50 + closeness * 200).toInt().coerceIn(0, 255)
            canvas.drawCircle(x, y, p.size * (0.55f + closeness * 0.6f), particlePaint)
        }
    }

    private companion object {
        val BACKGROUND_COLOR = Color.parseColor("#0A1628")
        val IDLE_COLOR = Color.parseColor("#33C9FF")
        val LISTENING_COLOR = Color.parseColor("#4EE2FF")
        val THINKING_COLOR = Color.parseColor("#8F7DFF")
        val SPEAKING_COLOR = Color.parseColor("#5CF2C0")
    }
}
