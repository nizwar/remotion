package dev.remotion.wanim

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.TextureView
import dev.remotion.wanim.internal.PlaybackState
import dev.remotion.wanim.internal.RenderEvents
import dev.remotion.wanim.internal.RenderTarget
import dev.remotion.wanim.internal.WanimLayout
import dev.remotion.wanim.internal.WanimRenderThread

/**
 * Plays a [WanimAnimation] on the GPU. Being a [TextureView], it composes with other views, can
 * be transparent, animated and clipped. Requires OpenGL ES 3.0 and a hardware accelerated window.
 *
 * Call its methods on the main thread. It stops by itself while it is detached, invisible or
 * while the activity is stopped, and continues afterwards.
 */
public class WanimView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : TextureView(context, attrs, defStyleAttr) {
    private val state = PlaybackState()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var renderThread: WanimRenderThread? = null

    /** Receives ready, finished and error events on the main thread. */
    public var listener: WanimListener? = null

    /** The animation set with [setAnimation]. */
    public val wanimAnimation: WanimAnimation? get() = state.animation

    /** Whether playback starts over at the end. Defaults to `true`. */
    public var loop: Boolean
        get() = state.loop
        set(value) {
            state.loop = value
        }

    /** Defaults to [WanimFit.Contain]. */
    public var fit: WanimFit
        get() = state.fit
        set(value) {
            state.fit = value
            updateOpaque()
            renderThread?.requestSync()
        }

    /** Playback rate, where 1 is the speed of the file. Must be positive. */
    public var speed: Float
        get() = state.speed
        set(value) {
            require(value > 0f && !value.isInfinite()) { "speed must be positive, got $value" }
            state.speed = value
            renderThread?.requestSync()
        }

    /**
     * The GPU memory this view may use. Animations that fit are fully loaded before ready is
     * reported. Others are streamed. Applies from the next [setAnimation]. Defaults to 192 MB.
     */
    public var memoryBudgetBytes: Long
        get() = state.memoryBudgetBytes
        set(value) {
            require(value > 0) { "memoryBudgetBytes must be positive, got $value" }
            state.memoryBudgetBytes = value
        }

    /** The frame on screen. */
    public val currentFrame: Int get() = state.currentFrame

    /** True from [play] until [pause] or the end, also while stopped by the view being hidden. */
    public val isPlaying: Boolean get() = state.playing

    /** Counters since the animation was set, for example for a playback rate overlay. */
    public val stats: WanimStats get() = state.stats()

    internal var composePlaying: Boolean? = null
    internal val renderThreadForTest: WanimRenderThread? get() = renderThread

    private val events = object : RenderEvents {
        override fun onReady(animation: WanimAnimation) = onMain(animation) { listener?.onReady() }

        override fun onFinished(animation: WanimAnimation) = onMain(animation) { listener?.onFinished() }

        override fun onError(animation: WanimAnimation?, error: WanimException) =
            onMain(animation) { listener?.onError(error) }

        private inline fun onMain(animation: WanimAnimation?, crossinline block: () -> Unit) {
            mainHandler.post {
                if (animation === state.animation) {
                    block()
                }
            }
        }
    }

    private val surfaceListener = object : SurfaceTextureListener {
        override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
            state.shown = isShown && windowVisibility == VISIBLE
            renderThread = WanimRenderThread(RenderTarget.Window(surface), state, events, width, height).also {
                it.startThread()
                it.requestSync()
            }
        }

        override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) {
            renderThread?.resize(width, height)
        }

        // The render thread releases the surface once it stopped using it, so that the main
        // thread does not have to wait for that.
        override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
            renderThread?.shutdown()
            renderThread = null
            return false
        }

        override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
    }

    private val memoryCallbacks = object : ComponentCallbacks2 {
        override fun onTrimMemory(level: Int) {
            // UI_HIDDEN only says that the app went to the background. Android 14 and later
            // send nothing but that level and BACKGROUND.
            if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND ||
                (level >= TRIM_RUNNING_LOW && level < ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN)
            ) {
                renderThread?.trimMemory()
            }
        }

        override fun onConfigurationChanged(newConfig: Configuration) = Unit

        @Deprecated("Deprecated in Java")
        override fun onLowMemory() = Unit
    }

    init {
        isOpaque = false
        surfaceTextureListener = surfaceListener
    }

    /** Shows [animation] from its first frame. An animation can be set on many views. */
    public fun setAnimation(animation: WanimAnimation) {
        if (animation === state.animation) {
            return
        }
        state.resetPosition()
        state.animation = animation
        updateOpaque()
        renderThread?.requestSync()
    }

    /** Starts or continues playback. Starts over if a non-looping playback had finished. */
    public fun play() {
        if (state.finished) {
            seek(0)
        }
        state.playing = true
        renderThread?.requestSync()
    }

    public fun pause() {
        state.playing = false
        renderThread?.requestSync()
    }

    /** Shows [frame] and continues from there. Values outside of the animation are clamped. */
    public fun seek(frame: Int) {
        val last = (state.animation?.frameCount ?: 1) - 1
        val target = frame.coerceIn(0, last)
        state.finished = false
        state.currentFrame = target
        state.seekTarget.set(target)
        renderThread?.requestSync()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        context.applicationContext.registerComponentCallbacks(memoryCallbacks)
        if (!isHardwareAccelerated) {
            events.onError(
                state.animation,
                WanimException.Rendering("WanimView needs a hardware accelerated window"),
            )
        }
    }

    override fun onDetachedFromWindow() {
        context.applicationContext.unregisterComponentCallbacks(memoryCallbacks)
        state.shown = false
        renderThread?.requestSync()
        super.onDetachedFromWindow()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        state.shown = isVisible
        renderThread?.requestSync()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        updateOpaque()
    }

    // An opaque TextureView would show black in the bars that Contain leaves around the canvas
    private fun updateOpaque() {
        val animation = state.animation ?: return
        if (width == 0 || height == 0) {
            return
        }
        val covered = WanimLayout.compute(state.fit, animation.width, animation.height, width, height)
            .coversView(animation.width, animation.height, width, height)
        isOpaque = animation.opaque && covered
    }

    private companion object {
        const val TRIM_RUNNING_LOW = 10
    }
}
