package dev.remotion.wanim

import dev.remotion.wanim.internal.WanimLayout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WanimLayoutTest {
    private fun assertLayout(layout: WanimLayout, scaleX: Float, scaleY: Float, originX: Float, originY: Float) {
        assertEquals(scaleX, layout.scaleX, 0f)
        assertEquals(scaleY, layout.scaleY, 0f)
        assertEquals(originX, layout.originX, 0f)
        assertEquals(originY, layout.originY, 0f)
    }

    @Test
    fun containLetterboxes() {
        val layout = WanimLayout.compute(WanimFit.Contain, 100, 50, 200, 200)
        assertLayout(layout, 2f, 2f, 0f, 50f)
        assertFalse(layout.coversView(100, 50, 200, 200))
    }

    @Test
    fun coverCrops() {
        val layout = WanimLayout.compute(WanimFit.Cover, 100, 50, 200, 200)
        assertLayout(layout, 4f, 4f, -100f, 0f)
        assertTrue(layout.coversView(100, 50, 200, 200))
    }

    @Test
    fun fillStretches() {
        val layout = WanimLayout.compute(WanimFit.Fill, 100, 50, 200, 200)
        assertLayout(layout, 2f, 4f, 0f, 0f)
        assertTrue(layout.coversView(100, 50, 200, 200))
    }

    @Test
    fun sameAspectContainCoversTheView() {
        val layout = WanimLayout.compute(WanimFit.Contain, 64, 48, 128, 96)
        assertLayout(layout, 2f, 2f, 0f, 0f)
        assertTrue(layout.coversView(64, 48, 128, 96))
    }

    @Test
    fun originStaysOnWholePixelsAtScaleOne() {
        val layout = WanimLayout.compute(WanimFit.Contain, 64, 48, 64, 149)
        assertLayout(layout, 1f, 1f, 0f, 50f)
    }
}
