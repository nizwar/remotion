package dev.remotion.wanim

/**
 * Counters of a [WanimView] since its animation was set.
 *
 * @property drawnFrames Frames that were drawn and presented.
 * @property skippedDraws Ticks where the sprite on screen was already correct.
 * @property droppedFrames Animation frames that passed without ever being shown.
 * @property heldFrames Ticks that kept the last frame since its atlas was not ready yet.
 */
public data class WanimStats(
    val drawnFrames: Long,
    val skippedDraws: Long,
    val droppedFrames: Long,
    val heldFrames: Long,
)
