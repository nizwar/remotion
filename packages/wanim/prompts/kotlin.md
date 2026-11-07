# Build a `.wanim` player for Android (Kotlin)

Attach `SPEC.md` and the `fixtures/` folder of `@remotion/wanim` to this prompt. `SPEC.md` is the source of truth for the format and rendering rules. Read it first.

## Goal

Create a Kotlin Android library that plays encrypted `.wanim` sprite animations on the GPU with OpenGL ES 3.0, and offers both a `View` and a Jetpack Compose API. Target `minSdk 24`. Use no third party dependencies for crypto or decoding.

## Public API

```kotlin
val animation = WanimAnimation.open(context, source, key) // suspend, source = asset, file or ByteArray

WanimView(context).apply {
    setAnimation(animation)
    loop = true
    fit = WanimFit.Contain // Contain, Cover, Fill
    play()
}

WanimPlayer(animation, modifier, loop = true, playing = true, onFinished = {}) // Compose
```

Also: `pause()`, `seek(frame)`, `speed`, `currentFrame`, and listeners for ready, finished and errors. `WanimException` distinguishes an invalid file, a wrong key or tampered file, and an unsupported version.

## Implementation requirements

Decryption:

- `javax.crypto.Cipher` with `AES/GCM/NoPadding` and `GCMParameterSpec(128, nonce)`. The ciphertext passed to `doFinal` includes the trailing tag. Call `updateAAD` before it.
- Implement HKDF-SHA256 with `javax.crypto.Mac`. Since the output is 32 bytes, one expand round is enough.
- Run on `Dispatchers.Default`. Parse the manifest with `org.json` or a small reader, and keep `sprites` and `frames` in flat `IntArray`s, so that no allocation happens per frame.

GPU rendering:

- Use `TextureView` with a dedicated render thread that owns an EGL context, so that the player composes with other views, animates, clips and can be transparent. Expose a `SurfaceView` variant only if needed for opaque full screen content.
- Use `Choreographer.postFrameCallback` as the clock, with `frameTimeNanos`. Post the next callback only while playing.
- One static vertex buffer, one small shader program with a uniform for the quad and UV rectangles, one `glDrawArrays(GL_TRIANGLE_STRIP, 0, 4)` per frame. No allocations in the draw loop.
- `glDisable(GL_BLEND)` if `opaque`, otherwise `glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA)`. Also use an opaque `TextureView` in that case.
- Decode atlases on a background thread with `BitmapFactory` (`inPremultiplied = true`, `inScaled = false`, `ARGB_8888`, `inMutable = false`). Do not use `Bitmap.Config.HARDWARE`.
- Upload with `GLUtils.texImage2D`, then `recycle()` the bitmap. Use a second EGL context which shares with the render context to upload without stalling the draw loop, and a `glFenceSync` before the render thread uses the texture.
- Handle EGL context loss and `onSurfaceTextureDestroyed`: Textures are gone and have to be uploaded again from the retained encrypted file.
- Check `GL_MAX_TEXTURE_SIZE` against the largest atlas and report an error rather than rendering black.

Lifecycle:

- Pause when the view is detached, invisible, or the activity is stopped. `onTrimMemory` shrinks the texture cache to the current atlas.
- Several views playing the same `WanimAnimation` share decoded data, and each releases its GPU resources when detached.

## Key handling

Do not put the key in a string constant. Accept it as a `ByteArray` from the host app, and zero the array after deriving the file key. Document for the host app how to obtain it, for example from a server after a Play Integrity check, or split in native code.

## Verification

- Unit test: Open `fixtures/sample.wanim` with `expected.json.key`, assert that the manifest equals `expected.json.manifest` and each atlas matches `expected.json.atlasSha256`. Test a wrong key, a flipped byte in each block and a truncated file.
- Instrumented test: Render each frame of the fixture to an offscreen `EGLSurface` at scale 1, read it with `glReadPixels`, and compare the sprite rectangle with the premultiplied atlas pixels. It must match exactly.
- A sample app with a playback rate overlay. Show in Android GPU Inspector or `dumpsys gfxinfo` that the main thread does no per-frame work and that CPU use stays flat while playing.
- Include a benchmark: Report dropped frames over 60 seconds with several players at once on a low-end device.
