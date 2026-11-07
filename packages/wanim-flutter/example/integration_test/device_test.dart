import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart' as hash;
import 'package:cryptography_flutter/cryptography_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:wanim/src/crypto.dart';
import 'package:wanim/src/format.dart';
import 'package:wanim/src/official_key.dart';
import 'package:wanim/wanim.dart';

Future<Uint8List> _asset(String name) async {
  final data = await rootBundle.load('assets/fixtures/$name');
  return Uint8List.fromList(data.buffer.asUint8List());
}

Matcher _throws(WanimErrorType type) =>
    throwsA(isA<WanimException>().having((error) => error.type, 'type', type));

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, dynamic> expected;
  late Uint8List official;
  late Uint8List custom;

  setUpAll(() async {
    expected = jsonDecode(
      await rootBundle.loadString('assets/fixtures/expected.json'),
    ) as Map<String, dynamic>;
    official = await _asset('sample.wanim');
    custom = await _asset('sample-custom-key.wanim');
  });

  Future<void> checkPath(
    Uint8List file,
    String? key,
    Future<Uint8List?> Function(WanimBlock) decrypt,
  ) async {
    final header = WanimHeader.parse(file);
    final cipher = await WanimCipher.create(
      masterKey: key == null ? officialKeyBytes() : parseKey(key),
      header: header,
    );
    final manifestBytes = await decrypt(
      cipher.block(
        0,
        Uint8List.sublistView(file, headerLength, header.dataStart),
      ),
    );
    expect(jsonDecode(utf8.decode(manifestBytes!)), expected['manifest']);

    final atlases = (expected['manifest'] as Map)['atlases'] as List;
    for (var i = 0; i < atlases.length; i++) {
      final start = header.dataStart + (atlases[i]['offset'] as int);
      final bytes = Uint8List.sublistView(
        file,
        start,
        start + (atlases[i]['length'] as int),
      );
      final png = await decrypt(cipher.block(i + 1, bytes));
      expect(
        hash.sha256.convert(png!).toString(),
        (expected['atlasSha256'] as List)[i],
      );

      final tampered = Uint8List.fromList(bytes)..[3] ^= 1;
      expect(await decrypt(cipher.block(i + 1, tampered)), isNull);
    }
  }

  testWidgets('the native plugin is registered', (tester) async {
    expect(FlutterCryptography.isPluginPresent, isTrue);
  });

  testWidgets('both decryption paths conform', (tester) async {
    await tester.runAsync(() async {
      final key = expected['customKey'] as String;
      await checkPath(official, null, decryptWithPlatform);
      await checkPath(custom, key, decryptWithPlatform);
      await checkPath(official, null, decryptInBackground);
      await checkPath(custom, key, decryptInBackground);
    });
  });

  testWidgets('load reports its errors', (tester) async {
    await tester.runAsync(() async {
      await expectLater(
        WanimAnimation.load(custom),
        _throws(WanimErrorType.missingCustomKey),
      );
      await expectLater(
        WanimAnimation.load(custom, key: 'ff' * 32),
        _throws(WanimErrorType.wrongKeyOrTampered),
      );
      await expectLater(
        WanimAnimation.load(Uint8List.fromList(official)..[100] ^= 1),
        _throws(WanimErrorType.wrongKeyOrTampered),
      );
      await expectLater(
        WanimAnimation.load(
          Uint8List.sublistView(official, 0, official.length - 1),
        ),
        _throws(WanimErrorType.invalidFile),
      );
    });
  });

  // What the fixture generator draws in each frame, on the canvas
  (Rect, List<int>)? reference(int frame) {
    if (frame < 4) {
      return (
        Rect.fromLTWH(4 + frame * 8.0, 8, 16, 16),
        const [128, 20, 20, 128],
      );
    }

    if (frame < 10) {
      final width = frame < 8 ? 10 + (frame - 4) * 12.0 : 46.0;
      return (Rect.fromLTWH(8, 30, width, 10), const [40, 120, 255, 255]);
    }

    return null;
  }

  // The macOS Impeller backend draws some pixels near the edges of a quad up to
  // 8 levels too strong at some scales, whatever the inset and antialiasing.
  // Android and iOS have no such pixels.
  const macOSScaled = 8;

  // Draws every frame at [scale] physical pixels per canvas pixel, and compares
  // it with the flat colors. All tested scales put the quads on whole pixels,
  // so every pixel has one correct value, including the outermost ones.
  Future<void> checkFrames(
    WidgetTester tester,
    Uint8List file,
    double scale,
    int tolerance,
  ) async {
    late WanimAnimation animation;
    await tester.runAsync(() async {
      animation = await WanimAnimation.load(file);
    });
    final controller = WanimController(autoplay: false);
    final ratio = tester.view.devicePixelRatio;
    final width = (64 * scale).round();
    final height = (48 * scale).round();
    await tester.pumpWidget(
      Center(
        child: SizedBox(
          width: width / ratio,
          height: height / ratio,
          child: WanimPlayer(animation: animation, controller: controller),
        ),
      ),
    );

    var maxDifference = 0;
    for (var frame = 0; frame < 12; frame++) {
      controller.seek(
        Duration(microseconds: ((frame + 0.5) / 12 * 1e6).round()),
      );
      await tester.pump();
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.descendant(
          of: find.byType(WanimPlayer),
          matching: find.byType(RepaintBoundary),
        ),
      );
      late Uint8List pixels;
      await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: ratio);
        expect(image.width, width);
        expect(image.height, height);
        pixels = (await image.toByteData())!.buffer.asUint8List();
        image.dispose();
      });

      final expectedFrame = reference(frame);
      final rect = expectedFrame?.$1;
      final color = expectedFrame?.$2;
      final wrong = <String>[];
      for (var y = 0; y < height; y++) {
        for (var x = 0; x < width; x++) {
          final center = Offset(x + 0.5, y + 0.5) / scale;
          final inside = rect?.contains(center) ?? false;
          final index = (y * width + x) * 4;
          for (var channel = 0; channel < 4; channel++) {
            final want = inside ? color![channel] : 0;
            final difference = (pixels[index + channel] - want).abs();
            maxDifference = max(maxDifference, difference);
            final allowed = inside && scale != 1 && Platform.isMacOS
                ? macOSScaled
                : tolerance;
            if (difference > allowed) {
              wrong.add('$x,$y channel $channel: ${pixels[index + channel]}');
            }
          }
        }
      }
      expect(wrong.take(5), isEmpty, reason: 'frame $frame: ${wrong.length}');
    }

    debugPrint('WANIM_PIXELS $scale: max difference $maxDifference');
    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    animation.dispose();
  }

  for (final name in ['sample.wanim', 'sample-compressed.wanim']) {
    for (final scale in [1.0, 2.0, 3.5, 0.5]) {
      testWidgets('$name matches the source frames at ${scale}x', (
        tester,
      ) async {
        await checkFrames(
          tester,
          await _asset(name),
          scale,
          scale == 1 ? 0 : 2,
        );
      });
    }
  }
}
