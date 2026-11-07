import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wanim/src/render_wanim.dart';
import 'package:wanim/wanim.dart';

import 'support.dart';

const Duration _frame = Duration(microseconds: 1000000 ~/ 12);

Duration _middleOf(int frame) =>
    Duration(microseconds: ((frame + 0.5) / 12 * 1e6).round());

Future<WanimAnimation> _load(
  WidgetTester tester, {
  Uint8List? file,
  int gpuBudgetBytes = 192 * 1024 * 1024,
}) async {
  late WanimAnimation animation;
  await tester.runAsync(() async {
    animation = await WanimAnimation.load(
      file ?? sample(),
      gpuBudgetBytes: gpuBudgetBytes,
    );
  });
  addTearDown(animation.dispose);
  return animation;
}

/// Lets background work that was started inside of the fake clock of a widget
/// test finish.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 10; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump();
  }
}

Widget _sized(Widget child) =>
    Center(child: SizedBox(width: 64, height: 48, child: child));

/// Returns the sprite rectangle drawn right now, as an atlas rectangle.
PaintPattern _drawsSprite(Rect source, Rect destination) =>
    paints..drawImageRect(source: source, destination: destination);

PaintPattern _drawsWith(BlendMode blendMode) =>
    paints..something((method, arguments) {
      if (method != #drawImageRect) {
        return false;
      }

      final paint = arguments[3] as Paint;
      return paint.blendMode == blendMode &&
          paint.filterQuality == FilterQuality.low;
    });

void main() {
  void useRatioOne(WidgetTester tester) {
    tester.view
      ..physicalSize = const Size(800, 600)
      ..devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  Finder view() => find.byType(WanimView);

  testWidgets('sizes like an image', (tester) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    await tester.pumpWidget(
      Align(
        alignment: Alignment.topLeft,
        child: WanimPlayer(animation: animation),
      ),
    );
    expect(tester.getSize(view()), const Size(64, 48));

    await tester.pumpWidget(
      Align(
        alignment: Alignment.topLeft,
        child: SizedBox(width: 32, child: WanimPlayer(animation: animation)),
      ),
    );
    expect(tester.getSize(view()), const Size(32, 24));

    final render = tester.renderObject<RenderWanim>(view());
    expect(render.getMaxIntrinsicWidth(24), 32);
    expect(render.getMinIntrinsicWidth(double.infinity), 64);
    expect(render.getMinIntrinsicHeight(32), 24);
    expect(render.getMaxIntrinsicHeight(double.infinity), 48);
  });

  testWidgets('draws one quad with the mapped rectangles', (tester) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    final controller = WanimController(autoplay: false);
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _sized(WanimPlayer(animation: animation, controller: controller)),
    );
    expect(
      tester.renderObject(view()),
      _drawsSprite(
        const Rect.fromLTWH(2, 2, 16, 16),
        const Rect.fromLTWH(4, 8, 16, 16),
      ),
    );
    final recording = tester.renderObject<RenderWanim>(view());
    expect(
      recording,
      isNot(
        paints
          ..drawImageRect()
          ..drawImageRect(),
      ),
    );
  });

  testWidgets('insets the source by half a texel when scaling', (tester) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    final controller = WanimController(autoplay: false);
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      Center(
        child: SizedBox(
          width: 128,
          height: 96,
          child: WanimPlayer(animation: animation, controller: controller),
        ),
      ),
    );
    expect(
      tester.renderObject(view()),
      _drawsSprite(
        const Rect.fromLTRB(2.5, 2.5, 17.5, 17.5),
        const Rect.fromLTWH(8, 16, 32, 32),
      ),
    );
  });

  testWidgets('counts a device pixel ratio as scaling', (tester) async {
    tester.view
      ..physicalSize = const Size(800, 600)
      ..devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    final animation = await _load(tester);
    await tester.pumpWidget(_sized(WanimPlayer(animation: animation)));
    expect(
      tester.renderObject(view()),
      _drawsSprite(
        const Rect.fromLTRB(2.5, 2.5, 17.5, 17.5),
        const Rect.fromLTWH(4, 8, 16, 16),
      ),
    );

    tester.view.devicePixelRatio = 1;
    await tester.pump();
    expect(
      tester.renderObject(view()),
      _drawsSprite(
        const Rect.fromLTWH(2, 2, 16, 16),
        const Rect.fromLTWH(4, 8, 16, 16),
      ),
    );
  });

  testWidgets('maps every fit', (tester) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    final controller = WanimController(autoplay: false);
    addTearDown(controller.dispose);

    Future<void> pumpFit(BoxFit fit) => tester.pumpWidget(
      Center(
        child: SizedBox(
          width: 128,
          height: 48,
          child: WanimPlayer(
            animation: animation,
            controller: controller,
            fit: fit,
          ),
        ),
      ),
    );
    Rect place(double originX, double originY, double sx, double sy) =>
        Rect.fromLTWH(originX + 4 * sx, originY + 8 * sy, 16 * sx, 16 * sy);

    await pumpFit(BoxFit.contain);
    expect(
      tester.renderObject(view()),
      paints..drawImageRect(destination: place(32, 0, 1, 1)),
    );
    await pumpFit(BoxFit.fill);
    expect(
      tester.renderObject(view()),
      paints..drawImageRect(destination: place(0, 0, 2, 1)),
    );
    await pumpFit(BoxFit.none);
    expect(
      tester.renderObject(view()),
      paints..drawImageRect(destination: place(32, 0, 1, 1)),
    );
    await pumpFit(BoxFit.cover);
    expect(
      tester.renderObject(view()),
      paints
        ..clipRect(rect: const Rect.fromLTWH(0, 0, 128, 48))
        ..drawImageRect(destination: place(0, -24, 2, 2)),
    );
    await pumpFit(BoxFit.fitHeight);
    expect(
      tester.renderObject(view()),
      paints..drawImageRect(destination: place(32, 0, 1, 1)),
    );
    await pumpFit(BoxFit.fitWidth);
    expect(
      tester.renderObject(view()),
      paints..drawImageRect(destination: place(0, -24, 2, 2)),
    );
  });

  testWidgets('an empty box paints nothing and does not fail', (tester) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    await tester.pumpWidget(
      Center(
        child: SizedBox.shrink(child: WanimPlayer(animation: animation)),
      ),
    );
    expect(tester.renderObject(view()), isNot(paints..drawImageRect()));
    expect(tester.takeException(), isNull);
  });

  testWidgets('derives the frame from the clock', (tester) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    final controller = WanimController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _sized(WanimPlayer(animation: animation, controller: controller)),
    );
    await tester.pump(); // First tick starts the clock
    final render = tester.renderObject<RenderWanim>(view());

    // A late tick skips frames instead of falling behind
    await tester.pump(_frame * 2.5);
    expect(
      render,
      paints..drawImageRect(destination: const Rect.fromLTWH(20, 8, 16, 16)),
    );
    expect(
      controller.position,
      Duration(microseconds: (_frame * 2.5).inMicroseconds),
    );

    // Empty frames draw nothing
    controller.seek(_middleOf(10));
    await tester.pump();
    expect(render, isNot(paints..drawImageRect()));
  });

  testWidgets('wraps around when looping', (tester) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    final controller = WanimController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _sized(WanimPlayer(animation: animation, controller: controller)),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 3) + _middleOf(1));
    expect(
      tester.renderObject(view()),
      paints..drawImageRect(destination: const Rect.fromLTWH(12, 8, 16, 16)),
    );
    expect(controller.position, _middleOf(1));
    expect(controller.isFinished, isFalse);
  });

  testWidgets('does no rebuilds, and paints only when the sprite changes', (
    tester,
  ) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    await tester.pumpWidget(_sized(WanimPlayer(animation: animation)));
    await tester.pump();

    var builds = 0;
    var paintCount = 0;
    debugProfilePaintsEnabled = true;
    debugOnRebuildDirtyWidget = (_, _) => builds++;
    debugOnProfilePaint = (object) {
      if (object is RenderWanim) {
        paintCount++;
      }
    };

    // 60 Hz for one loop: 12 frames, of which sprites 7, 7, 7 and -1, -1 hold.
    // The loop leads from -1 back to sprite 0.
    for (var i = 0; i < 60; i++) {
      await tester.pump(const Duration(microseconds: 16667));
    }

    debugProfilePaintsEnabled = false;
    debugOnRebuildDirtyWidget = null;
    debugOnProfilePaint = null;
    expect(builds, 0);
    expect(paintCount, 9);
  });

  testWidgets('a parent rebuild does not repaint the animation', (
    tester,
  ) async {
    useRatioOne(tester);
    final animation = await _load(tester);
    final controller = WanimController(autoplay: false);
    addTearDown(controller.dispose);
    late StateSetter rebuild;
    var color = const Color(0xff000000);
    await tester.pumpWidget(
      StatefulBuilder(
        builder: (context, setState) {
          rebuild = setState;
          return ColoredBox(
            color: color,
            child: _sized(
              WanimPlayer(animation: animation, controller: controller),
            ),
          );
        },
      ),
    );

    var paintCount = 0;
    debugProfilePaintsEnabled = true;
    debugOnProfilePaint = (object) {
      if (object is RenderWanim) {
        paintCount++;
      }
    };

    rebuild(() => color = const Color(0xffffffff));
    await tester.pump();
    debugProfilePaintsEnabled = false;
    debugOnProfilePaint = null;
    expect(paintCount, 0);
  });

  testWidgets('keeps the drawing opaque when the file says so', (tester) async {
    useRatioOne(tester);
    final frame = WanimFrameState();
    addTearDown(frame.dispose);
    await tester.pumpWidget(
      WanimView(
        frame: frame,
        canvasSize: const Size(64, 48),
        opaque: true,
        fit: BoxFit.contain,
        devicePixelRatio: 1,
      ),
    );
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final image = await tester.runAsync(() async {
      canvas.drawColor(const Color(0xffffffff), BlendMode.src);
      return recorder.endRecording().toImage(4, 4);
    });
    frame
      ..holdAtlas(0, image!)
      ..show(
        0,
        const WanimSprite(
          atlas: 0,
          x: 0,
          y: 0,
          width: 4,
          height: 4,
          dx: 0,
          dy: 0,
        ),
      );
    await tester.pump();
    expect(tester.renderObject(view()), _drawsWith(BlendMode.src));

    await tester.pumpWidget(
      WanimView(
        frame: frame,
        canvasSize: const Size(64, 48),
        opaque: false,
        fit: BoxFit.contain,
        devicePixelRatio: 1,
      ),
    );
    expect(tester.renderObject(view()), _drawsWith(BlendMode.srcOver));
  });

  group('controller', () {
    testWidgets('pause stops the ticker and holds the frame', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      await tester.pump();
      await tester.pump(_frame * 1.5);
      expect(tester.binding.transientCallbackCount, 1);

      controller.pause();
      expect(controller.isPlaying, isFalse);
      expect(tester.binding.transientCallbackCount, 0);
      final position = controller.position;
      await tester.pump(const Duration(seconds: 1));
      expect(controller.position, position);

      controller.play();
      await tester.pump();
      await tester.pump(_frame);
      expect(controller.position, position + _frame);
    });

    testWidgets('autoplay: false shows the first frame and waits', (
      tester,
    ) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController(autoplay: false);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      expect(tester.binding.transientCallbackCount, 0);
      expect(tester.renderObject(view()), paints..drawImageRect());
    });

    testWidgets('speed scales the clock without a jump', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      controller.speed = 2;
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(controller.position, const Duration(milliseconds: 300));
      expect(() => controller.speed = 0, throwsArgumentError);
      expect(() => controller.speed = double.nan, throwsArgumentError);
      expect(() => WanimController(speed: -1), throwsArgumentError);
    });

    testWidgets('seek works while paused and while playing', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController(autoplay: false);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      controller.seek(_middleOf(4));
      await tester.pump();
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(destination: const Rect.fromLTWH(8, 30, 10, 10)),
      );

      // Second atlas
      controller.seek(_middleOf(8));
      await tester.pump();
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(
          source: const Rect.fromLTWH(2, 2, 46, 10),
          destination: const Rect.fromLTWH(8, 30, 46, 10),
        ),
      );

      // Out of range positions stay valid
      controller.seek(const Duration(seconds: -5));
      expect(controller.position, Duration.zero);
      controller.seek(const Duration(seconds: 1) + _middleOf(1));
      await tester.pump();
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(destination: const Rect.fromLTWH(12, 8, 16, 16)),
      );

      controller.play();
      await tester.pump();
      controller.seek(_middleOf(3));
      await tester.pump(_frame * 5);
      await tester.pump(_frame);
      expect(controller.position, _middleOf(3) + _frame);
    });

    testWidgets('replacing the controller keeps playback working', (
      tester,
    ) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final first = WanimController();
      final second = WanimController(autoplay: false);
      addTearDown(first.dispose);
      addTearDown(second.dispose);

      Widget build(WanimController? controller) =>
          _sized(WanimPlayer(animation: animation, controller: controller));

      await tester.pumpWidget(build(first));
      await tester.pumpWidget(build(second));
      expect(tester.binding.transientCallbackCount, 0);
      first.seek(_middleOf(5)); // No longer attached
      await tester.pumpWidget(build(null));
      expect(tester.binding.transientCallbackCount, 1);
      await tester.pumpWidget(build(first));
      await tester.pump();
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(source: const Rect.fromLTWH(2, 20, 22, 10)),
      );
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('finishing', () {
    testWidgets('plays once, holds the last frame and stops', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController();
      addTearDown(controller.dispose);
      var finished = 0;
      await tester.pumpWidget(
        _sized(
          WanimPlayer(
            animation: animation,
            controller: controller,
            loop: false,
            onFinished: () => finished++,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 999));
      expect(finished, 0);
      await tester.pump(const Duration(milliseconds: 1));
      expect(finished, 1);
      expect(controller.isFinished, isTrue);
      expect(controller.isPlaying, isFalse);
      expect(tester.binding.transientCallbackCount, 0);
      expect(controller.position, const Duration(seconds: 1));
      expect(tester.renderObject(view()), isNot(paints..drawImageRect()));

      await tester.pump(const Duration(seconds: 5));
      expect(finished, 1);

      controller.play();
      expect(controller.position, Duration.zero);
      expect(tester.binding.transientCallbackCount, 1);
      await tester.pump();
      expect(tester.renderObject(view()), paints..drawImageRect());
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      expect(finished, 2);
    });

    testWidgets('finishes on a late tick and on the default controller', (
      tester,
    ) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      var finished = 0;
      await tester.pumpWidget(
        _sized(
          WanimPlayer(
            animation: animation,
            loop: false,
            onFinished: () => finished++,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(minutes: 1));
      expect(finished, 1);
      expect(tester.binding.transientCallbackCount, 0);
    });

    testWidgets('onFinished may restart playback', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(
          WanimPlayer(
            animation: animation,
            controller: controller,
            loop: false,
            onFinished: controller.play,
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      expect(controller.isPlaying, isTrue);
      expect(tester.binding.transientCallbackCount, 1);
      expect(tester.takeException(), isNull);
    });
  });

  group('lifecycle', () {
    testWidgets('TickerMode stops the clock, and resumes at the same frame', (
      tester,
    ) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController();
      addTearDown(controller.dispose);

      Widget build(bool enabled) => TickerMode(
        enabled: enabled,
        child: _sized(
          WanimPlayer(animation: animation, controller: controller),
        ),
      );

      await tester.pumpWidget(build(true));
      await tester.pump();
      await tester.pump(_frame);
      final position = controller.position;
      await tester.pumpWidget(build(false));
      expect(tester.binding.transientCallbackCount, 0);
      await tester.pump(const Duration(seconds: 10));
      expect(controller.position, position);
      expect(controller.isPlaying, isTrue);

      await tester.pumpWidget(build(true));
      await tester.pump();
      await tester.pump(_frame);
      expect(controller.position, position + _frame);
    });

    testWidgets('a covered route stops ticking', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final navigator = GlobalKey<NavigatorState>();
      await tester.pumpWidget(
        MaterialApp(
          navigatorKey: navigator,
          home: _sized(WanimPlayer(animation: animation)),
        ),
      );
      await tester.pump();
      expect(tester.binding.transientCallbackCount, 1);
      navigator.currentState!.push(
        MaterialPageRoute<void>(builder: (_) => const SizedBox()),
      );
      await tester.pumpAndSettle();
      expect(tester.binding.transientCallbackCount, 0);
      navigator.currentState!.pop();
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(tester.binding.transientCallbackCount, 1);
    });

    testWidgets('pauses while the app is not resumed', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      await tester.pump();
      await tester.pump(_frame);
      final position = controller.position;
      for (final state in [
        AppLifecycleState.inactive,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
      ]) {
        tester.binding.handleAppLifecycleStateChanged(state);
        await tester.pump(const Duration(seconds: 1));
        expect(tester.binding.transientCallbackCount, 0);
      }

      tester.binding
        ..handleAppLifecycleStateChanged(AppLifecycleState.hidden)
        ..handleAppLifecycleStateChanged(AppLifecycleState.inactive)
        ..handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      expect(tester.binding.transientCallbackCount, 1);
      await tester.pump();
      await tester.pump(_frame);
      expect(controller.position, position + _frame);
    });

    testWidgets('a pause by the user survives the background', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController(autoplay: false);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      tester.binding
        ..handleAppLifecycleStateChanged(AppLifecycleState.inactive)
        ..handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      expect(tester.binding.transientCallbackCount, 0);
    });

    testWidgets('releases everything when unmounted', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final probe = animation.atlasImage(0)!;
      addTearDown(probe.dispose);
      await tester.pumpWidget(_sized(WanimPlayer(animation: animation)));
      await tester.pump();
      await tester.pumpWidget(const SizedBox());
      expect(tester.binding.transientCallbackCount, 0);
      animation.dispose();
      expect(animation.isDisposed, isTrue);
      expect(probe.debugGetOpenHandleStackTraces(), hasLength(1));
    });

    testWidgets('survives the animation being disposed under it', (
      tester,
    ) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final probe = animation.atlasImage(0)!;
      addTearDown(probe.dispose);
      await tester.pumpWidget(_sized(WanimPlayer(animation: animation)));
      await tester.pump();
      animation.dispose();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(seconds: 3));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      expect(probe.debugGetOpenHandleStackTraces(), hasLength(1));
    });

    testWidgets('a new animation starts over', (tester) async {
      useRatioOne(tester);
      final first = await _load(tester);
      final second = await _load(tester);
      final controller = WanimController();
      addTearDown(controller.dispose);

      Widget build(WanimAnimation animation) => _sized(
        WanimPlayer(animation: animation, controller: controller, loop: false),
      );

      await tester.pumpWidget(build(first));
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      expect(controller.isFinished, isTrue);

      await tester.pumpWidget(build(second));
      expect(controller.isFinished, isFalse);
      expect(controller.isPlaying, isTrue);
      expect(controller.position, Duration.zero);
      expect(tester.renderObject(view()), paints..drawImageRect());
      await tester.pump();
    });
  });

  group('streaming', () {
    testWidgets('holds the last frame until the atlas is ready', (
      tester,
    ) async {
      useRatioOne(tester);
      final animation = await _load(tester, gpuBudgetBytes: 0);
      final controller = WanimController(autoplay: false);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      // The prefetch of atlas 1 is running
      await _settle(tester);
      animation.shrinkCache(0);
      expect(animation.atlasImage(1), isNull);

      controller.seek(_middleOf(7));
      await tester.pump();
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(source: const Rect.fromLTWH(2, 2, 16, 16)),
      );

      await _settle(tester);
      await tester.pump();
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(source: const Rect.fromLTWH(2, 2, 46, 10)),
      );
    });

    testWidgets('prefetches the next atlas', (tester) async {
      useRatioOne(tester);
      final animation = await _load(tester, gpuBudgetBytes: 0);
      expect(animation.atlasImage(1), isNull);
      await tester.pumpWidget(_sized(WanimPlayer(animation: animation)));
      await _settle(tester);
      final next = animation.atlasImage(1);
      expect(next, isNotNull);
      next!.dispose();
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('reports a tampered atlas once and keeps playing', (
      tester,
    ) async {
      useRatioOne(tester);
      final file = sample();
      final animation = await _load(
        tester,
        file: flipped(file, atlasStart(file, 1)),
        gpuBudgetBytes: 0,
      );
      final errors = <WanimException>[];
      final controller = WanimController(autoplay: false);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(
          WanimPlayer(
            animation: animation,
            controller: controller,
            onError: errors.add,
          ),
        ),
      );
      controller.seek(_middleOf(7));
      await tester.pump();
      await _settle(tester);
      controller.seek(_middleOf(8));
      await tester.pump();
      expect(errors, hasLength(1));
      expect(errors.single.type, WanimErrorType.wrongKeyOrTampered);
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(source: const Rect.fromLTWH(2, 2, 16, 16)),
      );
    });

    testWidgets('memory pressure shrinks the cache to the current atlas', (
      tester,
    ) async {
      useRatioOne(tester);
      final animation = await _load(tester);
      final controller = WanimController(autoplay: false);
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        _sized(WanimPlayer(animation: animation, controller: controller)),
      );
      expect(animation.isResident, isTrue);
      tester.binding.handleMemoryPressure();
      expect(animation.isResident, isFalse);
      expect(animation.atlasImage(0)?..dispose(), isNotNull);
      expect(animation.atlasImage(1), isNull);

      // Comes back through streaming
      controller.seek(_middleOf(7));
      await tester.pump();
      await _settle(tester);
      await tester.pump();
      expect(
        tester.renderObject(view()),
        paints..drawImageRect(source: const Rect.fromLTWH(2, 2, 46, 10)),
      );
    });
  });

  testWidgets('compressed atlases are indexed PNGs that decode and play', (
    tester,
  ) async {
    Object? failure;
    final animation = (await tester.runAsync(
      () => WanimAnimation.load(fixture('sample-compressed.wanim')),
    ))!;
    addTearDown(animation.dispose);
    expect(animation.manifest.frames, hasLength(12));
    await tester.pumpWidget(
      Directionality(
        textDirection: TextDirection.ltr,
        child: WanimPlayer(
          animation: animation,
          onError: (error) => failure = error,
        ),
      ),
    );
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 300)),
    );
    await tester.pump(const Duration(milliseconds: 100));
    expect(failure, isNull);
    expect(animation.isResident, isTrue);
  });
}
