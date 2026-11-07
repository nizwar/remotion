package dev.remotion.wanim

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WanimPlayerTest {
    @get:Rule
    val rule = createAndroidComposeRule<TestActivity>()

    @Test
    fun playsAndReportsTheEnd() {
        val ready = AtomicInteger()
        val finished = AtomicInteger()
        var playing by mutableStateOf(true)
        var size by mutableStateOf(100)
        val animation = Fixtures.official()
        rule.setContent {
            WanimPlayer(
                animation,
                Modifier.size(size.dp),
                loop = false,
                playing = playing,
                speed = 4f,
                onReady = { ready.incrementAndGet() },
                onFinished = { finished.incrementAndGet() },
            )
        }
        waitUntil("ready", 10_000) { ready.get() == 1 }
        waitUntil("finished") { finished.get() == 1 }

        // A recomposition with `playing` still true must not start over
        rule.runOnIdle { size = 120 }
        rule.waitForIdle()
        Thread.sleep(500)
        assertEquals(1, finished.get())

        rule.runOnIdle { playing = false }
        rule.waitForIdle()
        rule.runOnIdle { playing = true }
        rule.waitForIdle()
        waitUntil("finished again") { finished.get() == 2 }
    }

    @Test
    fun switchingTheAnimationStartsIt() {
        val first = Fixtures.official()
        val second = Fixtures.custom()
        val ready = AtomicInteger()
        var animation by mutableStateOf(first)
        rule.setContent {
            WanimPlayer(animation, Modifier.size(100.dp), onReady = { ready.incrementAndGet() })
        }
        waitUntil("first ready", 10_000) { ready.get() == 1 }
        rule.runOnIdle { animation = second }
        rule.waitForIdle()
        waitUntil("second ready", 10_000) { ready.get() == 2 }
    }

    @Test
    fun reportsErrors() {
        val pngs = listOf(ByteArray(32))
        val file = WanimWriter.write(WanimWriter.manifest(pngs), pngs)
        val animation = Fixtures.fromBytes(file)
        val errors = AtomicInteger()
        rule.setContent {
            WanimPlayer(animation, Modifier.size(100.dp), onError = { errors.incrementAndGet() })
        }
        waitUntil("error", 10_000) { errors.get() == 1 }
    }
}
