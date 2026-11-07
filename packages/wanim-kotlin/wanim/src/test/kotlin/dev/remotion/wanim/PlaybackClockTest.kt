package dev.remotion.wanim

import dev.remotion.wanim.internal.PlaybackClock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackClockTest {
    private val second = 1_000_000_000L

    @Test
    fun frameComesFromElapsedTime() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 100)
        assertEquals(0, clock.advance(5 * second, loop = true))
        assertEquals(1, clock.advance(5 * second + second / 10, loop = true))
        assertEquals(30, clock.advance(8 * second, loop = true))
    }

    @Test
    fun doesNotDependOnTickRate() {
        for (ticksPerSecond in listOf(30, 60, 90, 120, 144)) {
            val clock = PlaybackClock(fps = 24.0, frameCount = 1000)
            var frame = 0
            for (tick in 0..ticksPerSecond * 10) {
                frame = clock.advance(tick * second / ticksPerSecond, loop = true)
            }
            assertEquals(240, frame)
        }
    }

    @Test
    fun lateFramesAreSkippedAndCounted() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 100)
        clock.advance(0, loop = true)
        assertEquals(5, clock.advance(second / 2, loop = true))
        assertEquals(4, clock.skipped)
        assertEquals(6, clock.advance(second * 6 / 10, loop = true))
        assertEquals(0, clock.skipped)
    }

    @Test
    fun loopsAtFrameCount() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 12)
        clock.advance(0, loop = true)
        assertEquals(0, clock.advance(second * 12 / 10, loop = true))
        assertEquals(3, clock.advance(second * 15 / 10, loop = true))
        assertEquals(0, clock.advance(second * 24 / 10, loop = true))
        assertFalse(clock.finished)
    }

    @Test
    fun longLoopsStayExact() {
        val clock = PlaybackClock(fps = 60.0, frameCount = 7)
        clock.advance(0, loop = true)
        val hours = 100L
        val expected = ((hours * 3600 * 60) % 7).toInt()
        assertEquals(expected, clock.advance(hours * 3600 * second, loop = true))
    }

    @Test
    fun finishesOnLastFrameWithoutLoop() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 12)
        clock.advance(0, loop = false)
        assertEquals(11, clock.advance(second * 11 / 10, loop = false))
        assertFalse(clock.finished)
        assertEquals(11, clock.advance(second * 12 / 10, loop = false))
        assertTrue(clock.finished)
    }

    @Test
    fun turningLoopOffContinuesFromTheCurrentLap() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 12)
        clock.advance(0, loop = true)
        assertEquals(3, clock.advance(second * 15 / 10, loop = true))
        assertEquals(4, clock.advance(second * 16 / 10, loop = false))
        assertFalse(clock.finished)
    }

    @Test
    fun rebaseStopsTimeUntilNextTick() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 100)
        clock.advance(0, loop = true)
        assertEquals(5, clock.advance(second / 2, loop = true))
        clock.rebase()
        assertEquals(5, clock.advance(100 * second, loop = true))
        assertEquals(6, clock.advance(100 * second + second / 10, loop = true))
    }

    @Test
    fun seekContinuesFromExactFrame() {
        val clock = PlaybackClock(fps = 29.97, frameCount = 100)
        clock.advance(0, loop = true)
        for (frame in 0 until 100) {
            clock.seek(frame)
            assertEquals(frame, clock.advance(50 * second, loop = true))
        }
    }

    @Test
    fun seekClearsFinished() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 12)
        clock.advance(0, loop = false)
        clock.advance(5 * second, loop = false)
        assertTrue(clock.finished)
        clock.seek(0)
        assertFalse(clock.finished)
        assertEquals(0, clock.advance(6 * second, loop = false))
    }

    @Test
    fun speedChangesRateWithoutJumping() {
        val clock = PlaybackClock(fps = 10.0, frameCount = 1000)
        clock.advance(0, loop = true)
        assertEquals(10, clock.advance(second, loop = true))
        clock.setSpeed(2.0)
        assertEquals(10, clock.advance(second, loop = true))
        assertEquals(30, clock.advance(2 * second, loop = true))
        clock.setSpeed(0.5)
        assertEquals(30, clock.advance(2 * second, loop = true))
        assertEquals(35, clock.advance(3 * second, loop = true))
    }
}
