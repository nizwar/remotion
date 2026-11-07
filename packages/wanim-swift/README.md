# Wanim for Swift

The official player for `.wanim` encrypted sprite animations, on iOS 15 and macOS 14. It draws with Metal and uses only system frameworks. The format is described in [`packages/wanim/SPEC.md`](../wanim/SPEC.md).

macOS needs version 14 because `NSView.displayLink` is the vsync source there.

## Install

Add the package by path, for a checkout of this repository:

```swift
dependencies: [
	.package(path: "../wanim-swift"),
],
targets: [
	.target(name: "MyApp", dependencies: [.product(name: "Wanim", package: "wanim-swift")]),
]
```

Or by URL, once it is published to a repository of its own:

```swift
.package(url: "https://github.com/your-org/wanim-swift", from: "1.0.0")
```

In Xcode: File > Add Package Dependencies, then Add Local, or enter the URL.

## Usage

UIKit or AppKit:

```swift
import Wanim

let animation = try await WanimAnimation(contentsOf: url)

let view = WanimView(animation: animation)
view.loop = true
view.fit = .contain // .contain, .cover, .fill, or .scale(2) for a fixed size
view.onReady = { view.play() }
view.onFinished = { print("done") }
view.onError = { print($0.localizedDescription) }
```

SwiftUI:

```swift
@State private var isPlaying = true

WanimPlayer(animation, loop: false, isPlaying: $isPlaying, onFinished: { print("done") })
```

`WanimPlayerController` seeks a `WanimPlayer` and publishes its `currentFrame`. Only pass it to views that need the frame: Every view that observes it updates once per frame.

`WanimView` also offers `pause()`, `seek(toFrame:)`, `speed`, `currentFrame`, `isPlaying`, `isReady`, `filtering` (`.linear` or `.nearest`), `contentOffset` and `onFrameChange`.

To get a frame without a view, use `WanimRenderer`. It returns premultiplied RGBA8 pixels:

```swift
let renderer = try WanimRenderer(animation: animation)
renderer.fit = .scale(1)
try await renderer.prepare(frame: 12)
let pixels = try renderer.renderPixels(frame: 12, width: animation.manifest.width, height: animation.manifest.height)
```

## Custom keys

Files packed with the official key open with no setup. A file with a key of its own needs that key, which is 32 bytes:

```swift
guard let key = WanimAnimation.key(hex: "000102…1e1f") else { return } // 64 hexadecimal characters
let animation = try await WanimAnimation(contentsOf: url, key: key)
```

A key passed for a file that uses the official key is ignored.

| `WanimError`                                | Meaning                                                |
| ------------------------------------------- | ------------------------------------------------------ |
| `.missingCustomKey`                         | The file has a key of its own, and none was passed     |
| `.wrongKeyOrTampered`                       | The key is wrong, or the file was modified             |
| `.invalidFile`                              | Not a `.wanim` file, truncated, or an invalid manifest |
| `.unsupportedVersion`, `.unsupportedFlags`  | Made for a newer format                                |
| `.metalUnavailable`                         | No Metal device                                        |
| `.atlasTooLarge`, `.atlasDecodingFailed`    | The GPU cannot hold an atlas, or it is no readable PNG |

Each atlas is authenticated when it is decrypted, so a file modified in an atlas opens, and then reports `.wrongKeyOrTampered` through `onError`.

## Memory

Texture memory is the limit, not file size: A 1 MB file can need 40 MB on the GPU. `manifest.gpuBytes` says how much.

- The file stays encrypted, in a memory map. Decrypted PNG bytes are released as soon as they are decoded.
- If `gpuBytes` fits `animation.gpuBudget` (192 MB by default), all atlases are decoded before `onReady`, and `animation.preloads` is true. Playback then only draws.
- Otherwise the first atlas is decoded before `onReady`, and the animation streams: While an atlas is on screen, the next one is prepared on a background queue. Older ones are evicted, but at least two stay. If an atlas is late, the last frame stays on screen and playback does not block. Keep this in mind if you change the budget: It only takes effect for atlases that load after the change.
- Views that play the same `WanimAnimation` share its textures. Share the object to avoid paying twice.
- On iOS, a memory warning shrinks the cache to the atlas on screen. `releaseCaches()` does the same on demand.

The display link stops while paused, finished, hidden, without a window, occluded (macOS) or in the background (iOS).

## Tests

`swift test` runs the conformance fixtures and draws every frame on the GPU, comparing it exactly with the atlas. For the iOS Simulator:

```sh
xcodebuild test -scheme Wanim -destination 'platform=iOS Simulator,name=<device>'
```
