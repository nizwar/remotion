import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wanim/wanim.dart';

import 'support.dart';

const int _width = 64;
const int _height = 48;

/// What the fixture generator draws in each frame: Rectangle and premultiplied
/// color, or `null` for an empty frame.
({Rect rect, List<int> color})? _reference(int frame) {
  if (frame < 4) {
    return (
      rect: Rect.fromLTWH(4 + frame * 8.0, 8, 16, 16),
      color: const [128, 20, 20, 128],
    );
  }

  if (frame < 8) {
    return (
      rect: Rect.fromLTWH(8, 30, 10 + (frame - 4) * 12.0, 10),
      color: const [40, 120, 255, 255],
    );
  }

  if (frame < 10) {
    return (
      rect: const Rect.fromLTWH(8, 30, 46, 10),
      color: const [40, 120, 255, 255],
    );
  }

  return null;
}

void main() {
  late WanimAnimation animation;
  late WanimController controller;

  Duration middleOf(int frame) =>
      Duration(microseconds: ((frame + 0.5) / animation.fps * 1e6).round());

  Future<void> pumpPlayer(
    WidgetTester tester,
    double width,
    double height, {
    BoxFit fit = BoxFit.contain,
    double pixelRatio = 1,
  }) async {
    tester.view
      ..physicalSize = const Size(800, 600)
      ..devicePixelRatio = pixelRatio;
    addTearDown(tester.view.reset);
    await tester.runAsync(() async {
      animation = await WanimAnimation.load(sample());
    });
    addTearDown(animation.dispose);
    controller = WanimController(autoplay: false);
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      Center(
        child: SizedBox(
          width: width,
          height: height,
          child: WanimPlayer(
            animation: animation,
            controller: controller,
            fit: fit,
          ),
        ),
      ),
    );
  }

  Future<Uint8List> capture(
    WidgetTester tester, {
    double pixelRatio = 1,
  }) async {
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.descendant(
        of: find.byType(WanimPlayer),
        matching: find.byType(RepaintBoundary),
      ),
    );
    late Uint8List result;
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: pixelRatio);
      result = await pixels(image);
      image.dispose();
    });
    return result;
  }

  testWidgets('each frame equals the source frame of the fixture', (
    tester,
  ) async {
    await pumpPlayer(tester, _width.toDouble(), _height.toDouble());
    for (var frame = 0; frame < 12; frame++) {
      controller.seek(middleOf(frame));
      await tester.pump();
      final actual = await capture(tester);

      final name = frame.toString().padLeft(2, '0');
      final png = File('test/goldens/frame_$name.png').readAsBytesSync();
      late Uint8List reference;
      await tester.runAsync(() async {
        final image = await decodePng(png);
        reference = await pixels(image);
        image.dispose();
      });
      expect(actual.length, reference.length);
      expect(actual, reference, reason: 'frame $frame');

      final expectedColored = _reference(frame);
      expect(
        actual.any((byte) => byte != 0),
        expectedColored != null,
        reason: 'frame $frame',
      );
    }
  });

  // Each sprite is one flat color. Any bleeding of the transparent gutter into
  // the quad, or fringes from filtering, shows up as another value.
  for (final (name, scale) in [('2x', 2.0), ('3.5x', 3.5), ('0.5x', 0.5)]) {
    testWidgets('scaling by $name stays inside of the sprite', (tester) async {
      final width = _width * scale;
      final height = _height * scale;
      await pumpPlayer(tester, width, height);
      for (var frame = 0; frame < 12; frame++) {
        controller.seek(middleOf(frame));
        await tester.pump();
        final actual = await capture(tester);
        final reference = _reference(frame);
        final stride = width.round();
        final wrong = <String>[];
        for (var y = 0; y < height.round(); y++) {
          for (var x = 0; x < stride; x++) {
            final index = (y * stride + x) * 4;
            final pixel = actual.sublist(index, index + 4);
            final center = Offset(x + 0.5, y + 0.5) / scale;
            final rect = reference?.rect;
            if (rect != null && rect.deflate(1 / scale).contains(center)) {
              for (var channel = 0; channel < 4; channel++) {
                if ((pixel[channel] - reference!.color[channel]).abs() > 1) {
                  wrong.add('inside at $x,$y: $pixel');
                }
              }
            } else if ((rect == null ||
                    !rect.inflate(1 / scale).contains(center)) &&
                pixel.any((channel) => channel != 0)) {
              wrong.add('outside at $x,$y: $pixel');
            }
          }
        }

        expect(wrong, isEmpty, reason: 'frame $frame');
      }
    });
  }

  testWidgets('a device pixel ratio magnifies without leaving the sprite', (
    tester,
  ) async {
    await pumpPlayer(
      tester,
      _width.toDouble(),
      _height.toDouble(),
      pixelRatio: 3,
    );
    controller.seek(middleOf(7));
    await tester.pump();
    final actual = await capture(tester, pixelRatio: 3);
    const stride = _width * 3;
    const sprite = Rect.fromLTWH(8 * 3, 30 * 3, 46 * 3, 10 * 3);
    final wrong = <String>[];
    for (var y = 0; y < _height * 3; y++) {
      for (var x = 0; x < stride; x++) {
        final index = (y * stride + x) * 4;
        final pixel = actual.sublist(index, index + 4);
        final inside = sprite.contains(Offset(x + 0.5, y + 0.5));
        if (!listEquals(pixel, inside ? [40, 120, 255, 255] : [0, 0, 0, 0])) {
          wrong.add('at $x,$y: $pixel');
        }
      }
    }

    expect(wrong, isEmpty);
  });

  testWidgets('cover clips the canvas to the box', (tester) async {
    await pumpPlayer(tester, 64, 24, fit: BoxFit.cover);
    controller.seek(middleOf(0));
    await tester.pump();
    final actual = await capture(tester);
    expect(actual.length, 64 * 24 * 4);
    // The canvas keeps its scale, and its central 24 rows are visible:
    // Rows 12 to 36 of the canvas. The sprite covers rows 8 to 24.
    int alphaAt(int x, int y) => actual[(y * 64 + x) * 4 + 3];
    expect(alphaAt(10, 0), 128);
    expect(alphaAt(10, 11), 128);
    expect(alphaAt(10, 12), 0);
    expect(alphaAt(2, 5), 0);
  });

  testWidgets('ui.Image handles do not leak', (tester) async {
    await pumpPlayer(tester, 64, 48);
    final probe = animation.atlasImage(0)!;
    addTearDown(probe.dispose);
    expect(probe.debugGetOpenHandleStackTraces()!.length, greaterThan(1));
    await tester.pumpWidget(const SizedBox());
    animation.dispose();
    expect(probe.debugGetOpenHandleStackTraces(), hasLength(1));
  });
}
