package dev.remotion.wanim

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.opengl.GLES30
import androidx.activity.ComponentActivity
import androidx.test.platform.app.InstrumentationRegistry
import dev.remotion.wanim.internal.PlaybackState
import dev.remotion.wanim.internal.RenderEvents
import dev.remotion.wanim.internal.RenderTarget
import dev.remotion.wanim.internal.WanimFile
import dev.remotion.wanim.internal.WanimRenderThread
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertTrue

class TestActivity : ComponentActivity()

object Fixtures {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets

    fun bytes(name: String): ByteArray = assets.open("wanim/$name").use { it.readBytes() }

    val expected: JSONObject by lazy { JSONObject(String(bytes("expected.json"))) }
    val customKey: String get() = expected.getString("customKey")

    fun official() = WanimAnimation(WanimFile.open(ByteBuffer.wrap(bytes("sample.wanim")), null))

    fun custom() = WanimAnimation(WanimFile.open(ByteBuffer.wrap(bytes("sample-custom-key.wanim")), customKey))

    fun fromBytes(file: ByteArray) = WanimAnimation(WanimFile.open(ByteBuffer.wrap(file), null))

    fun solidPng(color: Int, width: Int = 8, height: Int = 8): ByteArray {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    /** One 8x8 atlas of a solid color per entry, and one frame covering the 16x16 canvas each. */
    fun solidAtlases(colors: List<Int>, opaque: Boolean = false): WanimAnimation {
        val pngs = colors.map { solidPng(it) }
        val manifest = WanimWriter.manifest(
            pngs,
            sprites = colors.indices.map { WanimWriter.sprite(it, 0, 0, 8, 8, 4, 4) },
            frames = colors.indices.toList(),
        ).put("opaque", opaque)
        return fromBytes(WanimWriter.write(manifest, pngs))
    }

    /** RGBA bytes of an atlas as they are stored in a premultiplied bitmap. */
    fun premultipliedAtlas(animation: WanimAnimation, index: Int): ByteArray {
        val png = animation.file.readAtlas(index)
        val bitmap = BitmapFactory.decodeByteArray(
            png,
            0,
            png.size,
            BitmapFactory.Options().apply {
                inPremultiplied = true
                inScaled = false
                inPreferredConfig = Bitmap.Config.ARGB_8888
            },
        )
        val pixels = ByteBuffer.allocate(bitmap.width * bitmap.height * 4)
        bitmap.copyPixelsToBuffer(pixels)
        bitmap.recycle()
        return pixels.array()
    }

    fun rgba(color: Int) = intArrayOf(Color.red(color), Color.green(color), Color.blue(color), Color.alpha(color))
}

/** The real render and loader threads, drawing into a pbuffer instead of a window. */
internal class OffscreenPlayer(
    animation: WanimAnimation,
    val width: Int,
    val height: Int,
    fit: WanimFit = WanimFit.Contain,
    memoryBudgetBytes: Long = PlaybackState.DEFAULT_MEMORY_BUDGET_BYTES,
    maxTextureSizeOverride: Int? = null,
) {
    val state = PlaybackState().also {
        it.animation = animation
        it.fit = fit
        it.memoryBudgetBytes = memoryBudgetBytes
    }
    private val ready = CountDownLatch(1)
    val errors = LinkedBlockingQueue<WanimException>()

    val thread = WanimRenderThread(
        RenderTarget.Offscreen(),
        state,
        object : RenderEvents {
            override fun onReady(animation: WanimAnimation) = ready.countDown()
            override fun onFinished(animation: WanimAnimation) = Unit
            override fun onError(animation: WanimAnimation?, error: WanimException) {
                errors.add(error)
            }
        },
        width,
        height,
        maxTextureSizeOverride,
    ).also {
        it.startThread()
        it.requestSync()
    }

    fun awaitReady() {
        val error = errors.peek()
        if (error != null) {
            throw error
        }
        assertTrue("not ready in time", ready.await(10, TimeUnit.SECONDS))
    }

    fun seek(frame: Int) {
        state.currentFrame = frame
        state.seekTarget.set(frame)
        thread.requestSync()
    }

    /** The current framebuffer as RGBA, with the first row at the top. */
    fun readPixels(): ByteArray = thread.runOnRenderThreadForTest {
        val buffer = ByteBuffer.allocateDirect(width * height * 4)
        GLES30.glPixelStorei(GLES30.GL_PACK_ALIGNMENT, 1)
        GLES30.glReadPixels(0, 0, width, height, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, buffer)
        check(GLES30.glGetError() == GLES30.GL_NO_ERROR)
        val rows = ByteArray(width * height * 4)
        for (y in 0 until height) {
            buffer.position((height - 1 - y) * width * 4)
            buffer.get(rows, y * width * 4, width * 4)
        }
        rows
    }

    fun render(frame: Int): ByteArray {
        seek(frame)
        return readPixels()
    }

    fun pixel(pixels: ByteArray, x: Int, y: Int): IntArray {
        val start = (y * width + x) * 4
        return IntArray(4) { pixels[start + it].toInt() and 0xFF }
    }

    fun shutdown() {
        thread.shutdown()
        thread.join(5000)
    }
}

fun waitUntil(message: String, timeoutMillis: Long = 5000, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMillis
    while (!condition()) {
        assertTrue(message, System.currentTimeMillis() < deadline)
        Thread.sleep(5)
    }
}
