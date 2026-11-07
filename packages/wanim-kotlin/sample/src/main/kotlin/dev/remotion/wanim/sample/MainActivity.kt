package dev.remotion.wanim.sample

import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.lifecycleScope
import dev.remotion.wanim.WanimAnimation
import dev.remotion.wanim.WanimException
import dev.remotion.wanim.WanimFit
import dev.remotion.wanim.WanimListener
import dev.remotion.wanim.WanimPlayer
import dev.remotion.wanim.WanimSource
import dev.remotion.wanim.WanimView
import kotlinx.coroutines.launch

/** A `WanimView` with a playback rate overlay on top, and a `WanimPlayer` below it. */
class MainActivity : ComponentActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var wanimView: WanimView
    private lateinit var rateText: TextView
    private var lastDrawn = 0L

    private val updateRate = object : Runnable {
        override fun run() {
            val stats = wanimView.stats
            rateText.text = "${stats.drawnFrames - lastDrawn} draws/s\n" +
                "frame ${wanimView.currentFrame}\n" +
                "dropped ${stats.droppedFrames}, held ${stats.heldFrames}"
            lastDrawn = stats.drawnFrames
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        wanimView = WanimView(this).apply {
            fit = WanimFit.Contain
            listener = object : WanimListener {
                override fun onError(error: WanimException) {
                    rateText.text = error.message
                }
            }
            setOnClickListener { if (isPlaying) pause() else play() }
        }
        rateText = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(0x88000000.toInt())
            setPadding(16, 16, 16, 16)
        }
        val composeView = ComposeView(this)
        val viewContainer = FrameLayout(this).apply {
            addView(wanimView)
            addView(
                rateText,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP or Gravity.START,
                ),
            )
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(0xFF20242C.toInt())
                addView(viewContainer, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
                addView(composeView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            },
        )

        lifecycleScope.launch {
            val animation = WanimAnimation.open(this@MainActivity, WanimSource.Asset("demo.wanim"))
            wanimView.apply {
                setAnimation(animation)
                loop = true
                play()
            }
            composeView.setContent {
                var playing by remember { mutableStateOf(true) }
                WanimPlayer(
                    animation,
                    Modifier.fillMaxSize().clickable { playing = !playing },
                    playing = playing,
                    speed = 0.5f,
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        handler.post(updateRate)
    }

    override fun onStop() {
        handler.removeCallbacks(updateRate)
        super.onStop()
    }
}
