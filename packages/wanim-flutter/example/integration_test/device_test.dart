import 'dart:convert';

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

  testWidgets('the GPU draws each frame as the source frame', (tester) async {
    late WanimAnimation animation;
    await tester.runAsync(() async {
      animation = await WanimAnimation.load(official);
    });
    final controller = WanimController(autoplay: false);
    final ratio = tester.view.devicePixelRatio;
    await tester.pumpWidget(
      Center(
        child: SizedBox(
          width: 64 / ratio,
          height: 48 / ratio,
          child: WanimPlayer(animation: animation, controller: controller),
        ),
      ),
    );

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
        expect(image.width, 64);
        expect(image.height, 48);
        pixels = (await image.toByteData())!.buffer.asUint8List();
        image.dispose();
      });

      final Rect? rect;
      final List<int>? color;
      if (frame < 4) {
        rect = Rect.fromLTWH(4 + frame * 8.0, 8, 16, 16);
        color = const [128, 20, 20, 128];
      } else if (frame < 10) {
        rect = Rect.fromLTWH(
          8,
          30,
          frame < 8 ? 10 + (frame - 4) * 12.0 : 46,
          10,
        );
        color = const [40, 120, 255, 255];
      } else {
        rect = null;
        color = null;
      }

      final wrong = <String>[];
      for (var y = 0; y < 48; y++) {
        for (var x = 0; x < 64; x++) {
          final inside = rect?.contains(Offset(x + 0.5, y + 0.5)) ?? false;
          final index = (y * 64 + x) * 4;
          for (var channel = 0; channel < 4; channel++) {
            final want = inside ? color![channel] : 0;
            if ((pixels[index + channel] - want).abs() > 2) {
              wrong.add('$x,$y channel $channel: ${pixels[index + channel]}');
            }
          }
        }
      }
      expect(wrong.take(5), isEmpty, reason: 'frame $frame');
    }

    await tester.pumpWidget(const SizedBox());
    controller.dispose();
    animation.dispose();
  });
}
