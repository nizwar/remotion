# wanim

Plays encrypted `.wanim` sprite animations on the GPU through the Flutter engine. Pure Dart, on Android, iOS, macOS and web, with no platform channel of its own.

Each frame is one textured quad: A `Ticker` picks the frame, and a render object draws it with one `drawImageRect` call. Playback rebuilds no widget, and repaints only when the sprite changes.

The format is specified in [`packages/wanim/SPEC.md`](../wanim/SPEC.md).

## Usage

```dart
import 'package:flutter/services.dart';
import 'package:wanim/wanim.dart';

final data = await rootBundle.load('assets/ball.wanim');
final animation = await WanimAnimation.load(data.buffer.asUint8List());

WanimPlayer(animation: animation);
```

Official files open without any setup. Only a file with a custom key needs its key, as 64 hexadecimal characters:

```dart
final animation = await WanimAnimation.load(bytes, key: customKey);
```

Dispose the animation when you are done with it, after the players that show it are gone:

```dart
animation.dispose();
```

One animation can be shown by any number of players.

## Player

```dart
WanimPlayer(
  animation: animation,
  controller: controller,
  loop: true,
  fit: BoxFit.contain,
  onFinished: () {},
  onError: (error) {},
);
```

The widget sizes itself like an image: To the canvas of the animation within its constraints, keeping the aspect ratio. `fit` maps the canvas into that size.

Playback pauses by itself while the route is covered (`TickerMode`) and while the app is not in the `resumed` state, and continues at the same frame.

## Controller

```dart
final controller = WanimController(autoplay: false, speed: 1);

controller.play();
controller.pause();
controller.seek(const Duration(seconds: 1));
controller.speed = 2;

controller.isPlaying;
controller.isFinished;
controller.position;
```

A controller belongs to one player at a time. Its listeners are told about commands and the end of playback, not about each frame.

## Errors

`WanimAnimation.load` throws a `WanimException`, whose `type` is one of:

| `WanimErrorType`     | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `invalidFile`        | Not a `.wanim` file, truncated, or its contents are not well-formed    |
| `wrongKeyOrTampered` | A block failed its authentication check                                |
| `missingCustomKey`   | The file has a key of its own, and none was passed                     |
| `unsupportedVersion` | The file uses a version, flag or atlas format this player does not know |

A `key` that is not 64 hexadecimal characters is an `ArgumentError`, as it is a programming error, not a property of the file.

## Memory

Texture memory is the limit, not file size. If all atlases fit `gpuBudgetBytes` (192 MB by default), they are decoded before `load` completes, and playback does nothing but draw. Otherwise they are streamed through a cache of three atlases: The next atlas is prepared in the background, and if it is late, the last frame stays on screen.

With streaming, an atlas after the first one is only authenticated when it is reached. A failure then goes to `onError`, or to `FlutterError.reportError` if there is none, and the last frame stays on screen.

On a memory warning, the cache shrinks to the current atlas, and the animation streams from then on.

## Decryption

Blocks are decrypted by the native AES-GCM of the platform (`cryptography_flutter`), or by Web Crypto in a browser. Where the native implementation is missing or fails, the pure Dart implementation runs in a background isolate. In a browser without a secure context, Web Crypto is not available, and decryption runs on the main thread.

On Android, the native implementation runs synchronously on the thread of the UI isolate, so it stalls the UI for as long as it takes. It is only used for blocks up to 512 KB there, and larger blocks go to the isolate. That takes about 130 ms per MB on a mid-range phone, without costing frames. Files that are streamed on Android should keep their atlases small enough for that, using the `atlasSize` and compression options of the packer.

## Example

[`example/`](./example) has a demo with all controls, a benchmark with several players at once, and an on-device test.
