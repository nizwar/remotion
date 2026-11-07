package dev.remotion.wanim.internal

import dev.remotion.wanim.WanimAnimation
import dev.remotion.wanim.WanimFit
import dev.remotion.wanim.WanimStats
import java.util.concurrent.atomic.AtomicInteger

/**
 * What a view wants and where playback is. It outlives render threads, so that a view which
 * loses its surface continues from the same frame. Counters have a single writer.
 */
internal class PlaybackState {
    @Volatile var animation: WanimAnimation? = null
    @Volatile var loop = true
    @Volatile var speed = 1f
    @Volatile var fit = WanimFit.Contain
    @Volatile var playing = false
    @Volatile var shown = true
    @Volatile var memoryBudgetBytes = DEFAULT_MEMORY_BUDGET_BYTES

    @Volatile var currentFrame = 0
    @Volatile var finished = false
    @Volatile var readyAnimation: WanimAnimation? = null
    val seekTarget = AtomicInteger(NO_SEEK)

    @Volatile var drawnFrames = 0L
    @Volatile var skippedDraws = 0L
    @Volatile var droppedFrames = 0L
    @Volatile var heldFrames = 0L

    fun resetPosition() {
        currentFrame = 0
        finished = false
        seekTarget.set(NO_SEEK)
        drawnFrames = 0
        skippedDraws = 0
        droppedFrames = 0
        heldFrames = 0
    }

    fun stats() = WanimStats(drawnFrames, skippedDraws, droppedFrames, heldFrames)

    companion object {
        const val NO_SEEK = -1
        const val DEFAULT_MEMORY_BUDGET_BYTES = 192L * 1024 * 1024
    }
}
