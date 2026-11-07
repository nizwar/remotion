package dev.remotion.wanim.internal

import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import dev.remotion.wanim.WanimException

/**
 * An OpenGL ES 3.0 context, optionally in the share group of [shareWith]. The default display
 * is shared with the rest of the process, so it is never terminated.
 */
internal class EglCore(shareWith: EglCore? = null) {
    val display: EGLDisplay
    private val config: EGLConfig
    private val context: EGLContext

    init {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        if (display == EGL14.EGL_NO_DISPLAY || !EGL14.eglInitialize(display, version, 0, version, 1)) {
            throw failure("eglInitialize")
        }
        config = chooseConfig(display)
        context = EGL14.eglCreateContext(
            display,
            config,
            shareWith?.context ?: EGL14.EGL_NO_CONTEXT,
            intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE),
            0,
        )
        if (context == EGL14.EGL_NO_CONTEXT) {
            throw failure("eglCreateContext for OpenGL ES 3.0")
        }
    }

    fun createWindowSurface(surfaceTexture: SurfaceTexture): EGLSurface {
        val surface = EGL14.eglCreateWindowSurface(
            display,
            config,
            surfaceTexture,
            intArrayOf(EGL14.EGL_NONE),
            0,
        )
        if (surface == null || surface == EGL14.EGL_NO_SURFACE) {
            throw failure("eglCreateWindowSurface")
        }
        return surface
    }

    fun createPbufferSurface(width: Int, height: Int): EGLSurface {
        val surface = EGL14.eglCreatePbufferSurface(
            display,
            config,
            intArrayOf(EGL14.EGL_WIDTH, width, EGL14.EGL_HEIGHT, height, EGL14.EGL_NONE),
            0,
        )
        if (surface == null || surface == EGL14.EGL_NO_SURFACE) {
            throw failure("eglCreatePbufferSurface")
        }
        return surface
    }

    fun makeCurrent(surface: EGLSurface) {
        if (!EGL14.eglMakeCurrent(display, surface, surface, context)) {
            throw failure("eglMakeCurrent")
        }
    }

    fun makeNothingCurrent() {
        EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
    }

    /** Returns `EGL_SUCCESS` or the error of the swap. */
    fun swapBuffers(surface: EGLSurface): Int =
        if (EGL14.eglSwapBuffers(display, surface)) EGL14.EGL_SUCCESS else EGL14.eglGetError()

    fun destroySurface(surface: EGLSurface) {
        EGL14.eglDestroySurface(display, surface)
    }

    /** Detaches the context from the calling thread and destroys it. */
    fun release() {
        makeNothingCurrent()
        EGL14.eglDestroyContext(display, context)
        EGL14.eglReleaseThread()
    }

    private companion object {
        const val EGL_OPENGL_ES3_BIT = 0x40

        fun chooseConfig(display: EGLDisplay): EGLConfig {
            val configs = arrayOfNulls<EGLConfig>(32)
            val count = IntArray(1)
            val attributes = intArrayOf(
                EGL14.EGL_RED_SIZE, 8,
                EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_NONE,
            )
            if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, configs.size, count, 0)) {
                throw failure("eglChooseConfig")
            }

            val value = IntArray(1)
            // eglChooseConfig sorts deeper formats first, which would not be RGBA8
            for (index in 0 until count[0]) {
                val config = configs[index] ?: continue
                val isRgba8 = intArrayOf(
                    EGL14.EGL_RED_SIZE,
                    EGL14.EGL_GREEN_SIZE,
                    EGL14.EGL_BLUE_SIZE,
                    EGL14.EGL_ALPHA_SIZE,
                ).all { attribute ->
                    EGL14.eglGetConfigAttrib(display, config, attribute, value, 0) && value[0] == 8
                }
                if (isRgba8) {
                    return config
                }
            }
            throw WanimException.Rendering("This device has no RGBA8 OpenGL ES 3.0 EGL config")
        }

        fun failure(call: String) =
            WanimException.Rendering("$call failed: 0x${Integer.toHexString(EGL14.eglGetError())}")
    }
}
