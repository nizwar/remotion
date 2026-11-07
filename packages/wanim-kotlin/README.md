# Wanim for Android

The official Android player for `.wanim` encrypted sprite animations. It decrypts atlases with `javax.crypto`, draws each frame as one textured quad with OpenGL ES 3.0, and offers a `View` and a Jetpack Compose API.

The format is described in [`packages/wanim/SPEC.md`](../wanim/SPEC.md).

## Requirements

- `minSdk` 24, and a device with OpenGL ES 3.0. Otherwise the player reports `WanimException.Rendering`.
- A hardware accelerated window, which is the default.

## Install

Add the `wanim` module to your Gradle build:

```kotlin
// settings.gradle.kts
include(":wanim")
project(":wanim").projectDir = file("path/to/wanim-kotlin/wanim")

// app/build.gradle.kts
dependencies {
    implementation(project(":wanim"))
}
```

`./gradlew :wanim:assembleRelease` builds an AAR, in `wanim/build/outputs/aar`.

If you ship files as assets, keep them uncompressed, so that they can be memory mapped rather than read into memory:

```kotlin
android {
    androidResources {
        noCompress += "wanim"
    }
}
```

## Usage

Files that use the official key open without any setup. Only pass a `key`, as 64 hexadecimal characters, for files that were encrypted with a key of their own.

```kotlin
val animation = WanimAnimation.open(context, WanimSource.Asset("intro.wanim"))
val fromFile = WanimAnimation.open(context, File(path))
val fromBytes = WanimAnimation.open(context, bytes)
val custom = WanimAnimation.open(context, WanimSource.Asset("paid.wanim"), key = customKey)
```

`open` is a suspending function, and does its work off the main thread. It throws a `WanimException`:

| Type                 | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `InvalidFile`        | Not a `.wanim` file, truncated, or its manifest is wrong |
| `WrongKeyOrTampered` | The key is wrong or the file was modified                |
| `MissingCustomKey`   | The file needs a key of its own, and none was passed     |
| `UnsupportedVersion` | The file has a format version this library cannot read   |

Atlases are decrypted later, so a modified atlas is reported through `onError`. There, you can also get `TextureTooLarge` if an atlas exceeds the limit of the GPU, or `Rendering` if EGL or OpenGL ES failed.

### View

```kotlin
val view = WanimView(context).apply {
    setAnimation(animation)
    loop = true
    fit = WanimFit.Contain // Contain, Cover, Fill
    listener = object : WanimListener {
        override fun onReady() {}
        override fun onFinished() {}
        override fun onError(error: WanimException) {}
    }
    play()
}

view.pause()
view.seek(30)
view.speed = 0.5f
val frame = view.currentFrame
```

Call these methods on the main thread. Listeners are called on the main thread as well.

The view can be used in XML. `WanimView` stops while it is detached, invisible or its activity is stopped, and continues from the same frame afterwards. When detached, it releases its GPU memory.

### Compose

```kotlin
WanimPlayer(
    animation,
    Modifier.fillMaxSize(),
    loop = true,
    playing = true,
    fit = WanimFit.Cover,
    speed = 1f,
    onReady = {},
    onFinished = {},
    onError = {},
)
```

## Memory

If the `gpuBytes` of a file fit `WanimView.memoryBudgetBytes` (192 MB by default), all atlases are uploaded before `onReady`, and playback does nothing but drawing. Otherwise, atlases are streamed: While one is on screen, the next one is prepared in the background, and the last frame is held if it is late. `WanimView.stats` shows how often that happened.

Several views can share one `WanimAnimation`. They share the decrypted manifest and the decoding of atlases that they load at the same time, while each view has its own textures.

If the system reports memory pressure, a view keeps only the atlas on screen, and streams until it is shown again.

## Sample

`sample` plays `assets/demo.wanim` in a `WanimView` with a playback rate overlay, and in a `WanimPlayer`. Tap a player to pause it. `BenchmarkActivity` plays several players at once, and logs dropped frames under the tag `WanimBenchmark`:

```bash
./gradlew :sample:installDebug
adb shell am start -n dev.remotion.wanim.sample/.BenchmarkActivity --ei players 4 --ei seconds 60
adb logcat -s WanimBenchmark
```

## Tests

```bash
./gradlew :wanim:testDebugUnitTest         # Format conformance, clock and layout, on the JVM
./gradlew :wanim:connectedDebugAndroidTest # Pixel exact GPU tests, views and Compose, on a device
```

The fixtures in `wanim/src/test/resources/wanim` are copies of `packages/wanim/fixtures`. The tests on a device that use `WanimView` need a screen that is on. `GpuPixelTest` and `WanimOpenTest` draw offscreen, and do not.
