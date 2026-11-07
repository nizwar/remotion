package dev.remotion.wanim.sample

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.widget.GridLayout
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import dev.remotion.wanim.WanimAnimation
import dev.remotion.wanim.WanimListener
import dev.remotion.wanim.WanimSource
import dev.remotion.wanim.WanimView
import kotlinx.coroutines.launch

/**
 * Plays several players at once and logs the result under the tag `WanimBenchmark`:
 *
 *     adb shell am start -n dev.remotion.wanim.sample/.BenchmarkActivity \
 *         --ei players 4 --ei seconds 60
 */
class BenchmarkActivity : ComponentActivity() {
    private val views = ArrayList<WanimView>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val players = intent.getIntExtra("players", 4)
        val seconds = intent.getIntExtra("seconds", 60)
        val columns = if (players > 2) 2 else 1
        val grid = GridLayout(this).apply { columnCount = columns }
        setContentView(grid)
        val size = resources.displayMetrics.widthPixels / columns

        lifecycleScope.launch {
            val animation = WanimAnimation.open(this@BenchmarkActivity, WanimSource.Asset("demo.wanim"))
            var ready = 0
            repeat(players) {
                val view = WanimView(this@BenchmarkActivity)
                view.setAnimation(animation)
                view.listener = object : WanimListener {
                    override fun onReady() {
                        ready++
                        if (ready == players) {
                            start(animation, seconds)
                        }
                    }
                }
                views.add(view)
                grid.addView(view, GridLayout.LayoutParams().apply {
                    width = size
                    height = size
                })
            }
        }
    }

    private fun start(animation: WanimAnimation, seconds: Int) {
        views.forEach { it.play() }
        val startedAt = SystemClock.elapsedRealtime()
        val before = views.map { it.stats }
        Log.i(TAG, "started players=${views.size} seconds=$seconds fps=${animation.fps} gpuBytes=${animation.gpuBytes}")

        Handler(Looper.getMainLooper()).postDelayed({
            val elapsed = (SystemClock.elapsedRealtime() - startedAt) / 1000.0
            val expected = (elapsed * animation.fps).toLong()
            views.forEachIndexed { index, view ->
                val stats = view.stats
                val drawn = stats.drawnFrames - before[index].drawnFrames
                val dropped = stats.droppedFrames - before[index].droppedFrames
                val held = stats.heldFrames - before[index].heldFrames
                Log.i(
                    TAG,
                    "player=$index seconds=$elapsed expectedFrames=$expected drawn=$drawn " +
                        "dropped=$dropped held=$held droppedPercent=${"%.3f".format(dropped * 100.0 / expected)}",
                )
            }
            views.forEach { it.pause() }
            Log.i(TAG, "finished")
        }, seconds * 1000L)
    }

    private companion object {
        const val TAG = "WanimBenchmark"
    }
}
