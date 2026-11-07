package dev.remotion.wanim

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Plays [animation] with a [WanimView].
 *
 * @param playing Changing it starts or pauses playback. A finished non-looping animation stays
 * on its last frame while this remains `true`.
 */
@Composable
public fun WanimPlayer(
    animation: WanimAnimation,
    modifier: Modifier = Modifier,
    loop: Boolean = true,
    playing: Boolean = true,
    fit: WanimFit = WanimFit.Contain,
    speed: Float = 1f,
    onReady: () -> Unit = {},
    onFinished: () -> Unit = {},
    onError: (WanimException) -> Unit = {},
) {
    val currentOnReady by rememberUpdatedState(onReady)
    val currentOnFinished by rememberUpdatedState(onFinished)
    val currentOnError by rememberUpdatedState(onError)

    AndroidView(
        modifier = modifier,
        factory = { context ->
            WanimView(context).apply {
                listener = object : WanimListener {
                    override fun onReady() = currentOnReady()
                    override fun onFinished() = currentOnFinished()
                    override fun onError(error: WanimException) = currentOnError(error)
                }
            }
        },
        update = { view ->
            view.loop = loop
            view.fit = fit
            view.speed = speed
            if (view.wanimAnimation !== animation) {
                view.setAnimation(animation)
                view.composePlaying = null
            }
            if (view.composePlaying != playing) {
                view.composePlaying = playing
                if (playing) view.play() else view.pause()
            }
        },
    )
}
