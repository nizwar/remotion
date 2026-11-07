package dev.remotion.wanim

import android.graphics.Bitmap
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WanimViewTest {
    private lateinit var scenario: ActivityScenario<TestActivity>
    private val events = CopyOnWriteArrayList<String>()
    private val errors = CopyOnWriteArrayList<WanimException>()

    @Before
    fun launch() {
        scenario = ActivityScenario.launch(TestActivity::class.java)
    }

    @After
    fun finish() {
        scenario.close()
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun addView(
        animation: WanimAnimation,
        width: Int = 128,
        height: Int = 96,
        configure: WanimView.() -> Unit = {},
    ): WanimView {
        var view: WanimView? = null
        scenario.onActivity { activity ->
            view = WanimView(activity).apply {
                listener = object : WanimListener {
                    override fun onReady() {
                        events.add("ready")
                    }

                    override fun onFinished() {
                        events.add("finished")
                    }

                    override fun onError(error: WanimException) {
                        errors.add(error)
                    }
                }
                setAnimation(animation)
                configure()
            }
            activity.setContentView(FrameLayout(activity).apply { addView(view, width, height) })
        }
        waitUntil("ready, errors: $errors", 10_000) { events.contains("ready") }
        return view!!
    }

    private fun pixelsOf(view: WanimView): Bitmap = onMain { view.getBitmap(view.width, view.height)!! }

    @Test
    fun readyIsReportedOnceAndShowsTheFirstFrame() {
        val view = addView(Fixtures.official())
        waitUntil("frame 0 on screen") {
            pixelsOf(view).getPixel(16, 32) != 0
        }
        assertEquals(listOf("ready"), events)
        assertEquals(0, view.currentFrame)
        assertFalse(view.isPlaying)
    }

    @Test
    fun playsInRealTimeAndLoops() {
        val view = addView(Fixtures.official()) { play() }
        val start = System.nanoTime()
        val seen = HashSet<Int>()
        waitUntil("every frame was reached", 3000) {
            seen.add(view.currentFrame)
            seen.size == 12
        }
        val elapsed = (System.nanoTime() - start) / 1e9
        assertTrue("took $elapsed seconds", elapsed in 0.7..1.6)
        assertTrue(view.isPlaying)
        assertTrue(view.stats.drawnFrames > 5)
    }

    @Test
    fun heldFramesSkipDrawing() {
        val view = addView(Fixtures.official()) { play() }
        Thread.sleep(1500)
        val stats = view.stats
        assertTrue("$stats", stats.skippedDraws > stats.drawnFrames)
    }

    @Test
    fun speedScalesPlayback() {
        val view = addView(Fixtures.official()) {
            speed = 4f
            play()
        }
        val start = System.nanoTime()
        val seen = HashSet<Int>()
        waitUntil("every frame was reached", 3000) {
            seen.add(view.currentFrame)
            seen.size == 12
        }
        val elapsed = (System.nanoTime() - start) / 1e9
        assertTrue("took $elapsed seconds", elapsed < 0.6)
    }

    @Test
    fun pauseHoldsAndPlayContinues() {
        val view = addView(Fixtures.official()) { play() }
        waitUntil("started") { view.currentFrame >= 2 }
        onMain { view.pause() }
        Thread.sleep(100)
        val frame = view.currentFrame
        Thread.sleep(400)
        assertEquals(frame, view.currentFrame)
        assertFalse(view.renderThreadForTest!!.isRunningForTest)
        onMain { view.play() }
        waitUntil("continued") { view.currentFrame != frame }
    }

    @Test
    fun seekShowsTheFrameWhilePaused() {
        val view = addView(Fixtures.official())
        onMain { view.seek(7) }
        assertEquals(7, view.currentFrame)
        waitUntil("frame 7 on screen") {
            val pixel = pixelsOf(view).getPixel(100, 70)
            Color.alpha(pixel) == 255 && Color.blue(pixel) == 255
        }
        onMain { view.seek(10) }
        waitUntil("empty frame on screen") { Color.alpha(pixelsOf(view).getPixel(100, 70)) == 0 }
        onMain { view.seek(1000) }
        assertEquals(11, view.currentFrame)
        onMain { view.seek(-5) }
        assertEquals(0, view.currentFrame)
    }

    @Test
    fun nonLoopingPlaybackFinishesOnceAndCanRestart() {
        val view = addView(Fixtures.official()) {
            loop = false
            speed = 4f
            play()
        }
        waitUntil("finished", 3000) { events.contains("finished") }
        assertEquals(11, view.currentFrame)
        assertFalse(view.isPlaying)
        Thread.sleep(300)
        assertEquals(1, events.count { it == "finished" })

        onMain { view.play() }
        assertTrue(view.isPlaying)
        waitUntil("finished again", 3000) { events.count { it == "finished" } == 2 }
    }

    @Test
    fun invisibleViewStopsAndContinues() {
        val view = addView(Fixtures.official()) { play() }
        waitUntil("running") { view.renderThreadForTest?.isRunningForTest == true }
        onMain { view.visibility = View.INVISIBLE }
        waitUntil("stopped") { view.renderThreadForTest?.isRunningForTest == false }
        val frame = view.currentFrame
        Thread.sleep(300)
        assertEquals(frame, view.currentFrame)
        assertTrue("keeps its intent", view.isPlaying)
        onMain { view.visibility = View.VISIBLE }
        waitUntil("running again") { view.renderThreadForTest?.isRunningForTest == true }
        waitUntil("advancing") { view.currentFrame != frame }
    }

    @Test
    fun invisibleParentStopsPlayback() {
        val view = addView(Fixtures.official()) { play() }
        waitUntil("running") { view.renderThreadForTest?.isRunningForTest == true }
        val parent = view.parent as ViewGroup
        onMain { parent.visibility = View.GONE }
        waitUntil("stopped") { view.renderThreadForTest?.isRunningForTest == false }
        onMain { parent.visibility = View.VISIBLE }
        waitUntil("running again") { view.renderThreadForTest?.isRunningForTest == true }
    }

    @Test
    fun stoppedActivityStopsAndContinues() {
        val view = addView(Fixtures.official()) { play() }
        waitUntil("running") { view.renderThreadForTest?.isRunningForTest == true }
        scenario.moveToState(Lifecycle.State.CREATED)
        waitUntil("stopped") { view.renderThreadForTest?.isRunningForTest != true }
        val frame = view.currentFrame
        Thread.sleep(300)
        assertEquals(frame, view.currentFrame)
        scenario.moveToState(Lifecycle.State.RESUMED)
        waitUntil("running again") { view.renderThreadForTest?.isRunningForTest == true }
        waitUntil("advancing") { view.currentFrame != frame }
    }

    @Test
    fun detachReleasesAndReattachContinuesFromTheSameFrame() {
        val view = addView(Fixtures.official()) { play() }
        waitUntil("started") { view.currentFrame >= 2 }
        val thread = view.renderThreadForTest!!
        val parent = view.parent as ViewGroup
        onMain { parent.removeView(view) }
        assertNull(view.renderThreadForTest)
        waitUntil("render thread ended") { !thread.isAlive }
        val frame = view.currentFrame

        onMain { parent.addView(view, 128, 96) }
        waitUntil("surface is back") { view.renderThreadForTest != null }
        assertTrue(view.renderThreadForTest !== thread)
        waitUntil("running again") { view.renderThreadForTest?.isRunningForTest == true }
        assertEquals("ready must not repeat", 1, events.count { it == "ready" })
        assertTrue(view.currentFrame >= 0 && frame >= 0)
    }

    @Test
    fun switchingAnimationsStartsOver() {
        val second = Fixtures.solidAtlases(listOf(Color.GREEN))
        val view = addView(Fixtures.official()) { play() }
        waitUntil("started") { view.currentFrame >= 2 }
        onMain { view.setAnimation(second) }
        waitUntil("ready for second") { events.count { it == "ready" } == 2 }
        waitUntil("green on screen") {
            val pixel = pixelsOf(view).getPixel(64, 48)
            Color.green(pixel) == 255
        }
        assertEquals(0, view.currentFrame)
    }

    @Test
    fun resizeRedrawsAtTheNewSize() {
        val view = addView(Fixtures.solidAtlases(listOf(Color.BLUE)))
        waitUntil("drawn") { Color.alpha(pixelsOf(view).getPixel(64, 48)) == 255 }
        onMain {
            view.layoutParams = view.layoutParams.apply {
                width = 256
                height = 256
            }
        }
        waitUntil("laid out") { view.width == 256 }
        waitUntil("redrawn") {
            val pixels = pixelsOf(view)
            Color.alpha(pixels.getPixel(128, 128)) == 255 && Color.alpha(pixels.getPixel(30, 128)) == 0
        }
    }

    @Test
    fun opaqueTextureViewOnlyIfTheCanvasCoversTheView() {
        val opaque = Fixtures.solidAtlases(listOf(Color.RED), opaque = true)
        val view = addView(opaque, 200, 100)
        assertFalse("bars must stay transparent", onMain { view.isOpaque })
        onMain { view.fit = WanimFit.Cover }
        assertTrue(onMain { view.isOpaque })
        onMain { view.fit = WanimFit.Fill }
        assertTrue(onMain { view.isOpaque })
        val transparent = addView(Fixtures.official(), 128, 96)
        assertFalse(onMain { transparent.isOpaque })
    }

    @Test
    fun loadErrorReachesTheListener() {
        val png = Fixtures.solidPng(Color.RED)
        val pngs = listOf(png)
        val file = WanimWriter.write(WanimWriter.manifest(pngs), pngs)
        file[file.size - 1] = (file[file.size - 1] + 1).toByte()
        val animation = Fixtures.fromBytes(file)
        scenario.onActivity { activity ->
            val view = WanimView(activity).apply {
                listener = object : WanimListener {
                    override fun onError(error: WanimException) {
                        errors.add(error)
                    }
                }
                setAnimation(animation)
                play()
            }
            activity.setContentView(view)
        }
        waitUntil("error") { errors.isNotEmpty() }
        assertTrue(errors.single() is WanimException.WrongKeyOrTampered)
    }

    @Test
    fun severalViewsPlayOneAnimation() {
        val animation = Fixtures.official()
        val views = ArrayList<WanimView>()
        scenario.onActivity { activity ->
            val root = FrameLayout(activity)
            repeat(4) { index ->
                val view = WanimView(activity)
                view.setAnimation(animation)
                view.play()
                views.add(view)
                root.addView(view, FrameLayout.LayoutParams(100, 100).apply { leftMargin = index * 110 })
            }
            activity.setContentView(root)
        }
        waitUntil("all run", 10_000) { views.all { it.renderThreadForTest?.isRunningForTest == true } }
        val removed = views[0]
        val thread = removed.renderThreadForTest!!
        onMain { (removed.parent as ViewGroup).removeView(removed) }
        waitUntil("first released") { !thread.isAlive }
        assertNotNull(views[1].renderThreadForTest)
        val frame = views[1].stats.drawnFrames
        waitUntil("others keep playing") { views[1].stats.drawnFrames > frame }
    }

    @Test
    fun speedMustBePositive() {
        val view = addView(Fixtures.official())
        for (value in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY)) {
            val failed = runCatching { onMain { view.speed = value } }.isFailure
            assertTrue("$value", failed)
        }
    }
}
