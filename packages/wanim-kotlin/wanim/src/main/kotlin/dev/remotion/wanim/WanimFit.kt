package dev.remotion.wanim

/** How the canvas of an animation is mapped into the view. */
public enum class WanimFit {
    /** Scale uniformly so that the whole canvas is visible. */
    Contain,

    /** Scale uniformly so that the canvas fills the view, cropping what does not fit. */
    Cover,

    /** Stretch the canvas to the size of the view. */
    Fill,
}
