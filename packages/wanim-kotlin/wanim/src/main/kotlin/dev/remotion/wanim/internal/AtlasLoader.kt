package dev.remotion.wanim.internal

import android.opengl.EGL14
import android.opengl.EGLSurface
import android.opengl.GLES30
import android.opengl.GLUtils
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import dev.remotion.wanim.WanimAnimation
import dev.remotion.wanim.WanimException

/**
 * Decrypts, decodes and uploads atlases on its own thread, in a context that shares textures
 * with the render context, so that the draw loop never waits for any of it.
 */
internal class AtlasLoader(
    private val renderContext: EglCore,
    private val renderHandler: Handler,
    private val onLoaded: (loader: AtlasLoader, generation: Int, atlas: Int, texture: Int, fence: Long) -> Unit,
    private val onFailed: (loader: AtlasLoader, generation: Int, error: WanimException) -> Unit,
) {
    private val thread = HandlerThread("wanim-loader", Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
    private val handler = Handler(thread.looper)
    private var context: EglCore? = null
    private var surface: EGLSurface = EGL14.EGL_NO_SURFACE

    fun load(animation: WanimAnimation, generation: Int, atlas: Int) {
        handler.post {
            try {
                val (texture, fence) = upload(animation, atlas)
                renderHandler.post { onLoaded(this, generation, atlas, texture, fence) }
            } catch (e: WanimException) {
                renderHandler.post { onFailed(this, generation, e) }
            } catch (e: OutOfMemoryError) {
                renderHandler.post {
                    onFailed(this, generation, WanimException.Rendering("Out of memory while decoding an atlas", e))
                }
            }
        }
    }

    /** Drops pending work, and returns after the thread and its context are gone. */
    fun shutdown() {
        handler.removeCallbacksAndMessages(null)
        handler.post {
            context?.let { context ->
                context.makeNothingCurrent()
                context.destroySurface(surface)
                context.release()
            }
            context = null
        }
        thread.quitSafely()
        thread.join()
    }

    private fun upload(animation: WanimAnimation, atlas: Int): Pair<Int, Long> {
        val bitmap = animation.acquireAtlas(atlas)
        try {
            ensureContext()
            val textures = IntArray(1)
            GLES30.glGenTextures(1, textures, 0)
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, textures[0])
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
            GLUtils.texImage2D(GLES30.GL_TEXTURE_2D, 0, bitmap, 0)
            val error = GLES30.glGetError()
            if (error != GLES30.GL_NO_ERROR) {
                GLES30.glDeleteTextures(1, textures, 0)
                throw WanimException.Rendering("Could not upload atlas $atlas: 0x${Integer.toHexString(error)}")
            }
            val fence = GLES30.glFenceSync(GLES30.GL_SYNC_GPU_COMMANDS_COMPLETE, 0)
            // The other context can only wait for a fence that has reached the GPU
            GLES30.glFlush()
            return textures[0] to fence
        } finally {
            animation.releaseAtlas(atlas)
        }
    }

    private fun ensureContext() {
        if (context != null) {
            return
        }
        val created = EglCore(shareWith = renderContext)
        surface = created.createPbufferSurface(1, 1)
        created.makeCurrent(surface)
        context = created
    }
}
