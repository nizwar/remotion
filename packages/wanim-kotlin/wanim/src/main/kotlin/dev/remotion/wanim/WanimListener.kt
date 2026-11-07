package dev.remotion.wanim

/** Playback events of a [WanimView]. All methods are called on the main thread. */
public interface WanimListener {
    /** The animation can be shown. Called once per [WanimView.setAnimation]. */
    public fun onReady() {}

    /** A non-looping playback reached its end. */
    public fun onFinished() {}

    /** Playback stopped because of [error]. */
    public fun onError(error: WanimException) {}
}
