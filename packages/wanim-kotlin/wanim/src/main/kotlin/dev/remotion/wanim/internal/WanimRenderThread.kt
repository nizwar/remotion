package dev.remotion.wanim.internal

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLSurface
import android.opengl.GLES30
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.view.Choreographer
import dev.remotion.wanim.WanimAnimation
import dev.remotion.wanim.WanimException
import dev.remotion.wanim.WanimFit

internal sealed interface RenderTarget {
    class Window(val surfaceTexture: SurfaceTexture) : RenderTarget
    class Offscreen : RenderTarget
}

internal interface RenderEvents {
    fun onReady(animation: WanimAnimation)
    fun onFinished(animation: WanimAnimation)
    fun onError(animation: WanimAnimation?, error: WanimException)
}

/**
 * Owns the EGL context and the vsync loop of one surface. All fields except for the [state] and
 * the handler belong to this thread. Its Choreographer runs on this thread as well, so a playing
 * animation does not schedule any work on the main thread.
 */
internal class WanimRenderThread(
    private val target: RenderTarget,
    private val state: PlaybackState,
    private val events: RenderEvents,
    private var viewWidth: Int,
    private var viewHeight: Int,
    private val maxTextureSizeOverride: Int? = null,
) : HandlerThread("wanim-render", Process.THREAD_PRIORITY_DISPLAY), Choreographer.FrameCallback {
    private lateinit var handler: Handler
    private lateinit var choreographer: Choreographer
    private val syncRunnable = Runnable { sync() }

    private var egl: EglCore? = null
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var quad: QuadProgram? = null
    private var loader: AtlasLoader? = null
    private var maxTextureSize = 0

    private var animation: WanimAnimation? = null
    private var clock = PlaybackClock(1.0, 1)
    private var cache: AtlasTextureCache? = null
    private var generation = 0
    private var layout: WanimLayout? = null
    private var appliedFit: WanimFit? = null
    private var appliedSpeed = 1f

    private var ready = false
    private var running = false
    private var failed = false
    private var surfaceLost = false
    private var trimmed = false
    private var drawnSprite = NOT_DRAWN

    fun startThread() {
        start()
        handler = Handler(looper)
    }

    override fun onLooperPrepared() {
        choreographer = Choreographer.getInstance()
        initGl()
    }

    /** Applies the [state]. Callable from any thread. */
    fun requestSync() {
        handler.removeCallbacks(syncRunnable)
        handler.post(syncRunnable)
    }

    fun resize(width: Int, height: Int) {
        handler.post {
            viewWidth = width
            viewHeight = height
            GLES30.glViewport(0, 0, width, height)
            layout = null
            sync()
        }
    }

    fun trimMemory() {
        handler.post {
            val manifest = animation?.manifest ?: return@post
            cache?.trim(keep = atlasOfFrame(manifest, state.currentFrame))
            trimmed = true
        }
    }

    /** Releases everything asynchronously, including the surface of the view. */
    fun shutdown() {
        handler.removeCallbacks(syncRunnable)
        handler.post {
            stopFrames()
            releaseGl(contextLost = false)
            (target as? RenderTarget.Window)?.surfaceTexture?.release()
            quitSafely()
        }
    }

    internal fun simulateContextLossForTest() {
        handler.post { recoverFromContextLoss() }
    }

    internal fun <T> runOnRenderThreadForTest(block: () -> T): T {
        var result: Result<T>? = null
        val done = java.util.concurrent.CountDownLatch(1)
        handler.post {
            result = runCatching(block)
            done.countDown()
        }
        done.await()
        return result!!.getOrThrow()
    }

    internal fun presentForTest(frame: Int) = present(frame)

    internal val isRunningForTest: Boolean get() = running
    internal val isReadyForTest: Boolean get() = ready
    internal val loadedAtlasCountForTest: Int get() = cache?.loadedCount ?: 0
    internal val cacheCapacityForTest: Int get() = cache?.capacity ?: 0

    override fun doFrame(frameTimeNanos: Long) {
        if (!running) {
            return
        }
        val frame = clock.advance(frameTimeNanos, state.loop)
        state.droppedFrames += clock.skipped
        present(frame)
        if (!running) {
            return
        }
        if (clock.finished) {
            running = false
            state.playing = false
            state.finished = true
            events.onFinished(animation!!)
        } else {
            choreographer.postFrameCallback(this)
        }
    }

    private fun sync() {
        val nextAnimation = state.animation
        if (nextAnimation !== animation) {
            switchAnimation(nextAnimation)
        }
        val manifest = animation?.manifest ?: return

        if (appliedSpeed != state.speed) {
            appliedSpeed = state.speed
            clock.setSpeed(appliedSpeed.toDouble())
        }

        if (layout == null || appliedFit != state.fit) {
            appliedFit = state.fit
            layout = WanimLayout.compute(state.fit, manifest.width, manifest.height, viewWidth, viewHeight)
            drawnSprite = NOT_DRAWN
            if (ready && !running) {
                present(state.currentFrame)
            }
        }

        val seek = state.seekTarget.getAndSet(PlaybackState.NO_SEEK)
        if (seek != PlaybackState.NO_SEEK) {
            clock.seek(seek)
            if (ready) {
                present(seek)
            }
        }

        if (trimmed && state.shown) {
            trimmed = false
            cache?.let { cache ->
                cache.restore()
                if (cache.resident) {
                    manifest.atlases.indices.forEach(cache::request)
                }
            }
        }

        val shouldRun = ready && state.playing && state.shown && !failed && !surfaceLost
        if (shouldRun && !running) {
            clock.rebase()
            running = true
            choreographer.postFrameCallback(this)
        } else if (!shouldRun) {
            stopFrames()
        }
    }

    private fun stopFrames() {
        if (running) {
            running = false
            choreographer.removeFrameCallback(this)
            clock.rebase()
        }
    }

    private fun switchAnimation(next: WanimAnimation?) {
        stopFrames()
        cache?.deleteAll()
        cache = null
        generation++
        // A new thread continues where the last one was. Otherwise, the frame in the state could
        // still have been written by the previous animation, after the view reset it.
        val switched = animation != null
        animation = next
        ready = false
        failed = false
        drawnSprite = NOT_DRAWN
        layout = null
        if (next != null) {
            clock = PlaybackClock(next.manifest.fps, next.manifest.frameCount)
            clock.setSpeed(state.speed.toDouble())
            appliedSpeed = state.speed
            state.currentFrame = if (switched) 0 else state.currentFrame.coerceIn(0, next.manifest.frameCount - 1)
            clock.seek(state.currentFrame)
            quad?.setOpaque(next.manifest.opaque)
            startLoading()
        } else if (egl != null) {
            drawNothing()
        }
    }

    private fun startLoading() {
        val animation = animation ?: return
        val loader = loader ?: return
        val manifest = animation.manifest
        val largest = manifest.atlases.maxOfOrNull { maxOf(it.width, it.height) } ?: 0
        if (largest > maxTextureSize) {
            fail(WanimException.TextureTooLarge(largest, maxTextureSize))
            return
        }

        val cache = AtlasTextureCache(animation, loader, generation, state.memoryBudgetBytes)
        this.cache = cache
        if (manifest.atlases.isEmpty()) {
            onContentReady()
            return
        }

        val current = atlasOfFrame(manifest, state.currentFrame)
        cache.request(current)
        if (cache.resident) {
            manifest.atlases.indices.forEach(cache::request)
        } else {
            requestNext(cache, manifest, current)
        }
    }

    private fun onAtlasLoaded(from: AtlasLoader, loadGeneration: Int, atlas: Int, texture: Int, fence: Long) {
        if (from !== loader) {
            return
        }
        val cache = cache
        if (cache == null || loadGeneration != cache.generation) {
            GLES30.glDeleteSync(fence)
            GLES30.glDeleteTextures(1, intArrayOf(texture), 0)
            return
        }

        val manifest = animation!!.manifest
        cache.accept(atlas, texture, fence, keep = atlasOfFrame(manifest, state.currentFrame))
        if (!ready && (!cache.resident || cache.loadedCount == manifest.atlases.size)) {
            onContentReady()
        } else if (ready && !running) {
            present(state.currentFrame)
        }
    }

    private fun onAtlasFailed(from: AtlasLoader, loadGeneration: Int, error: WanimException) {
        if (from === loader && loadGeneration == cache?.generation) {
            fail(error)
        }
    }

    private fun onContentReady() {
        ready = true
        val animation = animation!!
        if (layout == null) {
            sync()
        }
        present(state.currentFrame)
        if (state.readyAnimation !== animation) {
            state.readyAnimation = animation
            events.onReady(animation)
        }
        sync()
    }

    private fun present(frame: Int) {
        state.currentFrame = frame
        val cache = cache ?: return
        val manifest = animation!!.manifest
        val sprite = manifest.frames[frame]
        if (sprite == drawnSprite) {
            state.skippedDraws++
            return
        }
        if (surfaceLost) {
            return
        }

        var atlas = NO_ATLAS
        if (sprite != WanimManifest.EMPTY_FRAME) {
            atlas = manifest.sprites[sprite * WanimManifest.SPRITE_FIELDS + WanimManifest.SPRITE_ATLAS]
            if (cache.texture(atlas) == 0) {
                cache.request(atlas)
                state.heldFrames++
                return
            }
        }

        val quad = quad ?: return
        val layout = layout ?: return
        quad.clear()
        if (atlas != NO_ATLAS) {
            quad.drawSprite(
                cache.texture(atlas),
                manifest.atlases[atlas],
                manifest.sprites,
                sprite * WanimManifest.SPRITE_FIELDS,
                layout,
                viewWidth,
                viewHeight,
            )
            cache.touch(atlas)
            if (!cache.resident) {
                requestNext(cache, manifest, atlas)
            }
        }
        if (swap()) {
            drawnSprite = sprite
            state.drawnFrames++
        }
    }

    private fun drawNothing() {
        quad?.clear()
        swap()
    }

    private fun requestNext(cache: AtlasTextureCache, manifest: WanimManifest, atlas: Int) {
        val count = manifest.atlases.size
        if (atlas + 1 < count) {
            cache.request(atlas + 1)
        } else if (state.loop) {
            cache.request(0)
        }
    }

    private fun atlasOfFrame(manifest: WanimManifest, frame: Int): Int {
        // Empty frames have no atlas of their own, so they count as the next frame that has one
        for (offset in 0 until manifest.frameCount) {
            val sprite = manifest.frames[(frame + offset) % manifest.frameCount]
            if (sprite != WanimManifest.EMPTY_FRAME) {
                return manifest.sprites[sprite * WanimManifest.SPRITE_FIELDS + WanimManifest.SPRITE_ATLAS]
            }
        }
        return 0
    }

    private fun swap(): Boolean {
        val egl = egl ?: return false
        when (val result = egl.swapBuffers(eglSurface)) {
            EGL14.EGL_SUCCESS -> return true
            EGL14.EGL_CONTEXT_LOST -> recoverFromContextLoss()
            EGL14.EGL_BAD_SURFACE, EGL14.EGL_BAD_NATIVE_WINDOW -> {
                // The view is about to report that its surface is destroyed
                surfaceLost = true
                stopFrames()
            }
            else -> fail(WanimException.Rendering("eglSwapBuffers failed: 0x${Integer.toHexString(result)}"))
        }
        return false
    }

    private fun recoverFromContextLoss() {
        stopFrames()
        releaseGl(contextLost = true)
        ready = false
        drawnSprite = NOT_DRAWN
        generation++
        initGl()
    }

    private fun initGl() {
        try {
            val egl = EglCore()
            val surface = when (target) {
                is RenderTarget.Window -> egl.createWindowSurface(target.surfaceTexture)
                is RenderTarget.Offscreen -> egl.createPbufferSurface(viewWidth, viewHeight)
            }
            egl.makeCurrent(surface)
            EGL14.eglSwapInterval(egl.display, 1)
            this.egl = egl
            eglSurface = surface

            val limit = IntArray(1)
            GLES30.glGetIntegerv(GLES30.GL_MAX_TEXTURE_SIZE, limit, 0)
            maxTextureSize = maxTextureSizeOverride ?: limit[0]
            GLES30.glViewport(0, 0, viewWidth, viewHeight)
            quad = QuadProgram()
            loader = AtlasLoader(
                renderContext = egl,
                renderHandler = Handler(looper),
                onLoaded = ::onAtlasLoaded,
                onFailed = ::onAtlasFailed,
            )
            animation?.let { quad?.setOpaque(it.manifest.opaque) }
            startLoading()
        } catch (e: WanimException) {
            fail(e)
        }
    }

    private fun releaseGl(contextLost: Boolean) {
        loader?.shutdown()
        loader = null
        if (!contextLost) {
            cache?.deleteAll()
        }
        cache = null
        quad = null
        egl?.let { egl ->
            egl.makeNothingCurrent()
            if (eglSurface != EGL14.EGL_NO_SURFACE) {
                egl.destroySurface(eglSurface)
            }
            egl.release()
        }
        eglSurface = EGL14.EGL_NO_SURFACE
        egl = null
    }

    private fun fail(error: WanimException) {
        if (failed) {
            return
        }
        failed = true
        stopFrames()
        events.onError(animation ?: state.animation, error)
    }

    private companion object {
        const val NOT_DRAWN = -2
        const val NO_ATLAS = -1
    }
}
