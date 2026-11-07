package dev.remotion.wanim.internal

import kotlin.math.floor

/**
 * Turns vsync timestamps into frame numbers. The frame always comes from the elapsed time, so
 * timing does not depend on the display rate and late frames are skipped instead of delayed.
 */
internal class PlaybackClock(private val fps: Double, private val frameCount: Int) {
    private var basePosition = 0.0
    private var anchorNanos = NOT_ANCHORED
    private var position = 0.0
    private var ratePerNano = fps * 1e-9

    /** Animation frames that were passed over by the last [advance]. */
    var skipped = 0L
        private set

    /** True if the last [advance] reached the end of a non-looping playback. */
    var finished = false
        private set

    var frame = 0
        private set

    fun seek(frame: Int) {
        position = frame.toDouble()
        this.frame = frame
        finished = false
        rebase()
    }

    fun setSpeed(speed: Double) {
        rebase()
        ratePerNano = fps * speed * 1e-9
    }

    /** Stops the time from counting until the next [advance], which continues where this was. */
    fun rebase() {
        basePosition = position
        anchorNanos = NOT_ANCHORED
    }

    /** Returns the frame to show at the vsync time [frameTimeNanos]. */
    fun advance(frameTimeNanos: Long, loop: Boolean): Int {
        if (anchorNanos == NOT_ANCHORED) {
            anchorNanos = frameTimeNanos
        }
        position = basePosition + (frameTimeNanos - anchorNanos) * ratePerNano
        var absolute = floor(position).toLong()
        if (!loop && absolute >= frameCount) {
            absolute = frameCount - 1L
            position = absolute.toDouble()
            finished = true
        }
        skipped = (absolute - frame - 1).coerceAtLeast(0)
        if (absolute >= frameCount) {
            val wrapped = absolute / frameCount * frameCount
            basePosition -= wrapped
            position -= wrapped
            absolute -= wrapped
        }
        frame = absolute.toInt()
        return frame
    }

    private companion object {
        const val NOT_ANCHORED = Long.MIN_VALUE
    }
}
