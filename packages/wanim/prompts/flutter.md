# Build a `.wanim` player for Flutter

Attach `SPEC.md`, `src/official-key.ts` and the `fixtures/` folder of `@remotion/wanim` to this prompt. `SPEC.md` is the source of truth for the format and rendering rules. Read it first.

## Goal

Create a Flutter package in pure Dart that plays encrypted `.wanim` sprite animations on the GPU through the Flutter engine (Impeller or Skia). It has to work on Android, iOS, macOS and web without a platform channel.

## Public API

```dart
final animation = await WanimAnimation.load(bytes);
final custom = await WanimAnimation.load(bytes, key: customKey); // only for files with a custom key

WanimPlayer(
  animation: animation,
  controller: controller, // optional: play, pause, seek, speed
  loop: true,
  fit: BoxFit.contain,
  onFinished: () {},
);
```

`WanimAnimation.dispose()` releases all images. `WanimException` distinguishes an invalid file, a wrong key or tampered file, a missing custom key, and an unsupported version.

## Implementation requirements

Decryption:

- Use `package:cryptography` with `AesGcm.with256bits()` and `Hkdf(hmac: Hmac.sha256(), outputLength: 32)`. Add `package:cryptography_flutter`, so that AES-GCM runs natively: The pure Dart implementation is too slow for atlases of several MB.
- Pass `aad`, and split each block into `SecretBox(cipherText, nonce: nonce, mac: Mac(last16Bytes))`.
- Decryption must never block the UI isolate. Native AES-GCM is asynchronous, so call it from the main isolate. Where it is unavailable, fall back to the pure Dart implementation in `Isolate.run` (`dart:isolate` does not exist on web, where `package:cryptography` uses the browser's Web Crypto instead). Measure this on a device instead of assuming.

GPU rendering:

- Decode with `ui.ImmutableBuffer.fromUint8List`, `ui.ImageDescriptor.encoded` and `instantiateCodec`. The engine decodes off the UI thread, and the resulting `ui.Image` is a GPU texture with premultiplied alpha.
- Do not use `Image.memory`, `RawImage` or a widget per frame, and never call `setState` per frame.
- Implement a `LeafRenderObjectWidget` with a custom `RenderBox`. A `Ticker` provides the clock: Use the elapsed `Duration`, and call `markNeedsPaint()` only if the sprite of the new frame differs from the one on screen. Layout never changes during playback.
- In `paint`, make one `canvas.drawImageRect(image, src, dst, paint)` call. Reuse a single `Paint` with `filterQuality = FilterQuality.low` (bilinear). Allocate nothing besides the two `Rect`s.
- Use `BlendMode.src` if `opaque`, otherwise the default `srcOver`. Inset `src` by half a texel if the scale is not 1.
- Put a `RepaintBoundary` in `WanimPlayer` around the render object, so that playback does not repaint the parent, and the parent does not repaint the animation.
- Use `TickerMode` so that off screen routes stop, and stop the ticker when paused or finished.
- Do not use a `FragmentProgram`: `drawImageRect` is already a single textured quad, and it keeps web support.

Lifecycle:

- Listen to `AppLifecycleState`, and pause while not resumed.
- Call `ui.Image.dispose()` when an atlas leaves the LRU, or animations leak GPU memory.
- `WidgetsBindingObserver.didHaveMemoryPressure` shrinks the cache to the current atlas.

## Official key

This is the official player, so it opens official files with no setup: Build the official key from `src/official-key.ts` into the library, and keep it private to the library. Apps only pass a key for files whose custom key flag is set. Report a missing custom key as its own error.

## Verification

- Unit test: Open `fixtures/sample.wanim` without a key and `fixtures/sample-custom-key.wanim` with `expected.json.customKey`. For both, assert that the manifest equals `expected.json.manifest` and each atlas matches `expected.json.atlasSha256`. Test a wrong custom key, a missing custom key, an unknown flag, a flipped byte in each block and a truncated file.
- Golden test: Render each frame of the fixture and compare with the reference, including the empty frames.
- Run the example in profile mode on a device. Show in DevTools that the UI thread stays under 1 ms per frame, that no widget rebuilds happen during playback, and that the raster thread is not janky.
- Test both Impeller and Skia, and include a benchmark with several players at once.
