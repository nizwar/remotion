package dev.remotion.wanim.internal

import dev.remotion.wanim.WanimFit
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Maps canvas coordinates to view coordinates: `view = origin + canvas * scale`. */
internal class WanimLayout(
    val scaleX: Float,
    val scaleY: Float,
    val originX: Float,
    val originY: Float,
) {
    fun coversView(canvasWidth: Int, canvasHeight: Int, viewWidth: Int, viewHeight: Int): Boolean =
        originX <= 0f && originY <= 0f &&
            originX + canvasWidth * scaleX >= viewWidth &&
            originY + canvasHeight * scaleY >= viewHeight

    companion object {
        fun compute(fit: WanimFit, canvasWidth: Int, canvasHeight: Int, viewWidth: Int, viewHeight: Int): WanimLayout {
            val fitX = viewWidth.toFloat() / canvasWidth
            val fitY = viewHeight.toFloat() / canvasHeight
            val scaleX: Float
            val scaleY: Float
            when (fit) {
                WanimFit.Fill -> {
                    scaleX = fitX
                    scaleY = fitY
                }
                WanimFit.Contain -> {
                    scaleX = min(fitX, fitY)
                    scaleY = scaleX
                }
                WanimFit.Cover -> {
                    scaleX = max(fitX, fitY)
                    scaleY = scaleX
                }
            }
            return WanimLayout(
                scaleX = scaleX,
                scaleY = scaleY,
                originX = centered(viewWidth, canvasWidth, scaleX),
                originY = centered(viewHeight, canvasHeight, scaleY),
            )
        }

        // At scale 1, a half pixel offset would blur every texel of the sprite
        private fun centered(view: Int, canvas: Int, scale: Float): Float {
            val origin = (view - canvas * scale) / 2f
            return if (scale == 1f) floor(origin) else origin
        }
    }
}
