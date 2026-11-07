# Build a `.wanim` player for iOS (Swift)

Attach `SPEC.md`, `src/official-key.ts` and the `fixtures/` folder of `@remotion/wanim` to this prompt. `SPEC.md` is the source of truth for the format and rendering rules. Read it first.

## Goal

Create a Swift Package that plays encrypted `.wanim` sprite animations on the GPU with Metal, and offers both a UIKit and a SwiftUI API. Target iOS 15, and macOS 12 if it costs little. Use only system frameworks: `CryptoKit`, `Metal`, `MetalKit`, `ImageIO`, `QuartzCore`.

## Public API

```swift
let animation = try await WanimAnimation(contentsOf: url) // or Data
let custom = try await WanimAnimation(contentsOf: url, key: customKey) // only for files with a custom key

let view = WanimView(animation: animation)
view.loop = true
view.fit = .contain // .contain, .cover, .fill
view.play()

WanimPlayer(animation, loop: true, isPlaying: $playing, onFinished: {}) // SwiftUI
```

Also: `pause()`, `seek(toFrame:)`, `speed`, `currentFrame`. `WanimError` distinguishes an invalid file, a wrong key or tampered file, a missing custom key, and an unsupported version.

## Implementation requirements

Decryption:

- `HKDF<SHA256>.deriveKey(inputKeyMaterial:salt:info:outputByteCount:)`.
- `AES.GCM.SealedBox(nonce:ciphertext:tag:)` and `AES.GCM.open(_:using:authenticating:)`, where the tag is the last 16 bytes of a block.
- Open the file with `Data(contentsOf:options: .alwaysMapped)`, so that blocks are paged in on demand.
- Decode the manifest with `Codable`. Convert `sprites` into a contiguous array of a struct, so that drawing does not touch dictionaries or allocate.

GPU rendering:

- Render into a `CAMetalLayer` hosted by a `UIView`, with `framebufferOnly = true`, `pixelFormat = .bgra8Unorm` (not `_srgb`), `isOpaque = manifest.opaque`, and `presentsWithTransaction = false`.
- Use a `CADisplayLink` with `preferredFrameRateRange` matching `fps`, so ProMotion devices do not wake up more than needed. Use `targetTimestamp` as the clock. Pause the link when not playing.
- Build one `MTLRenderPipelineState` per blend mode once. Pass the quad and UV rectangles with `setVertexBytes`, then draw a 4 vertex triangle strip. Set blending to `.one` and `.oneMinusSourceAlpha`, or disable it if `opaque`.
- Use a `DispatchSemaphore` of 3 for in-flight frames, and skip a draw if no drawable is available rather than blocking the main thread.
- Decode on a background queue with `CGImageSourceCreateImageAtIndex`, with `kCGImageSourceShouldCache` off. Draw into a `CGContext` with `premultipliedLast`, in the sRGB color space, with `.copy` blend mode.
- Create an `.rgba8Unorm` texture. Upload to a `.private` texture through a blit encoder on a separate `MTLCommandQueue`, and only hand over the texture after the command buffer has completed. Do not use `MTKTextureLoader`, as it does not guarantee premultiplied alpha.
- Check the device limit of 8192 or 16384 against the largest atlas.

Lifecycle:

- Stop on `didEnterBackground`: Issuing GPU work in the background gets the app killed. Pause when the view has no window.
- On a memory warning, shrink the texture cache to the current atlas.
- Several views playing the same `WanimAnimation` share decoded textures.

## Official key

This is the official player, so it opens official files with no setup: Build the official key from `src/official-key.ts` into the library, and keep it private to the library. Apps only pass a key for files whose custom key flag is set. Report a missing custom key as its own error.

## Verification

- XCTest: Open `fixtures/sample.wanim` without a key and `fixtures/sample-custom-key.wanim` with `expected.json.customKey`. For both, assert that the manifest equals `expected.json.manifest` and each atlas matches `expected.json.atlasSha256`. Test a wrong custom key, a missing custom key, an unknown flag, a flipped byte in each block and a truncated file.
- GPU test: Render each frame of the fixture offscreen at scale 1 into an `.rgba8Unorm` texture, read it back and compare the sprite rectangle with the premultiplied atlas pixels. It must match exactly.
- A sample app. Show in Instruments (Metal System Trace and Time Profiler) that the main thread does no per-frame work besides encoding one draw.
- Include a benchmark: Report hitches over 60 seconds with several players at once on an older device.
