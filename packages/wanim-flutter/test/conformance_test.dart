import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as hash;
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:wanim/src/crypto.dart';
import 'package:wanim/src/format.dart';
import 'package:wanim/src/official_key.dart';
import 'package:wanim/wanim.dart';

import 'support.dart';

Matcher throwsWanim(WanimErrorType type) =>
    throwsA(isA<WanimException>().having((error) => error.type, 'type', type));

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final expectedData = expected();

  Future<void> expectConforms(Uint8List file, String? key) async {
    final animation = await WanimAnimation.load(file, key: key);
    addTearDown(animation.dispose);
    expect(animation.manifest.toJson(), expectedData['manifest']);
    expect(animation.width, 64);
    expect(animation.height, 48);
    expect(animation.fps, 12);
    expect(animation.frameCount, 12);
    expect(animation.opaque, isFalse);
    expect(animation.duration, const Duration(seconds: 1));
    expect(animation.isResident, isTrue);

    final header = WanimHeader.parse(file);
    final cipher = await WanimCipher.create(
      masterKey: key == null ? officialKeyBytes() : parseKey(key),
      header: header,
    );
    final digests = <String>[];
    for (var i = 0; i < animation.manifest.atlases.length; i++) {
      final atlas = animation.manifest.atlases[i];
      final start = header.dataStart + atlas.offset;
      final png = await cipher.decrypt(
        i + 1,
        Uint8List.sublistView(file, start, start + atlas.length),
      );
      digests.add(hash.sha256.convert(png).toString());
    }
    expect(digests, expectedData['atlasSha256']);
  }

  group('conformance', () {
    test('opens the official fixture without a key', () async {
      await expectConforms(sample(), null);
    });

    test('opens the custom key fixture with its key', () async {
      await expectConforms(customSample(), customKey());
    });

    test('accepts upper case keys with surrounding whitespace', () async {
      final animation = await WanimAnimation.load(
        customSample(),
        key: '  ${customKey().toUpperCase()}\n',
      );
      animation.dispose();
    });

    test('ignores a key for an official file', () async {
      final animation = await WanimAnimation.load(sample(), key: customKey());
      animation.dispose();
    });

    test('streams if the textures exceed the budget', () async {
      final animation = await WanimAnimation.load(sample(), gpuBudgetBytes: 0);
      addTearDown(animation.dispose);
      expect(animation.isResident, isFalse);
      expect(animation.atlasImage(0)?..dispose(), isNotNull);
      expect(animation.atlasImage(1), isNull);
    });
  });

  group('keys', () {
    test('rejects a wrong custom key', () async {
      await expectLater(
        WanimAnimation.load(customSample(), key: 'ff' * 32),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
    });

    test('reports a missing custom key', () async {
      await expectLater(
        WanimAnimation.load(customSample()),
        throwsWanim(WanimErrorType.missingCustomKey),
      );
    });

    test('rejects a malformed key without echoing it', () async {
      await expectLater(
        WanimAnimation.load(customSample(), key: 'abc'),
        throwsA(
          isA<ArgumentError>().having(
            (error) => error.toString(),
            'message',
            isNot(contains('abc')),
          ),
        ),
      );
    });
  });

  group('header', () {
    test('rejects other files', () async {
      await expectLater(
        WanimAnimation.load(Uint8List(0)),
        throwsWanim(WanimErrorType.invalidFile),
      );
      await expectLater(
        WanimAnimation.load(Uint8List(100)),
        throwsWanim(WanimErrorType.invalidFile),
      );
      await expectLater(
        WanimAnimation.load(flipped(sample(), 3)),
        throwsWanim(WanimErrorType.invalidFile),
      );
    });

    test('rejects an unknown version', () async {
      final file = sample()..[8] = 2;
      await expectLater(
        WanimAnimation.load(file),
        throwsWanim(WanimErrorType.unsupportedVersion),
      );
    });

    test('rejects an unknown flag', () async {
      for (final flag in [2, 0x80]) {
        final file = sample()..[10] = flag;
        await expectLater(
          WanimAnimation.load(file),
          throwsWanim(WanimErrorType.unsupportedVersion),
        );
      }

      final highByte = sample()..[11] = 1;
      await expectLater(
        WanimAnimation.load(highByte),
        throwsWanim(WanimErrorType.unsupportedVersion),
      );
    });

    test('authenticates the custom key flag', () async {
      final file = sample()..[10] = 1;
      await expectLater(
        WanimAnimation.load(file, key: 'ff' * 32),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
      final cleared = customSample()..[10] = 0;
      await expectLater(
        WanimAnimation.load(cleared),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
    });

    test('authenticates salt, nonce prefix and manifest length', () async {
      for (final offset in [16, 31, 32, 39]) {
        await expectLater(
          WanimAnimation.load(flipped(sample(), offset)),
          throwsWanim(WanimErrorType.wrongKeyOrTampered),
        );
      }

      await expectLater(
        WanimAnimation.load(flipped(sample(), 12)),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
    });
  });

  group('tampering', () {
    test('rejects a flipped byte in the manifest block', () async {
      final file = sample();
      await expectLater(
        WanimAnimation.load(flipped(file, 40)),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
      await expectLater(
        WanimAnimation.load(flipped(file, atlasStart(file, 0) - 1)),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
    });

    test('rejects a flipped byte in each atlas block', () async {
      final file = sample();
      for (final atlas in [0, 1]) {
        final start = atlasStart(file, atlas);
        for (final offset in [start, start + atlasLength(atlas) - 1]) {
          await expectLater(
            WanimAnimation.load(flipped(file, offset)),
            throwsWanim(WanimErrorType.wrongKeyOrTampered),
          );
        }
      }
    });

    test('rejects swapped atlas blocks', () async {
      final file = sample();
      final first = atlasStart(file, 0);
      final second = atlasStart(file, 1);
      final swapped = Uint8List.fromList(file)
        ..setRange(first, first + atlasLength(1), file, second);
      await expectLater(
        WanimAnimation.load(swapped),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
    });

    test('rejects a block moved from another file', () async {
      final file = sample();
      final other = customSample();
      final start = atlasStart(file, 0);
      final mixed = Uint8List.fromList(file)
        ..setRange(start, start + atlasLength(0), other, start);
      await expectLater(
        WanimAnimation.load(mixed),
        throwsWanim(WanimErrorType.wrongKeyOrTampered),
      );
    });
  });

  group('truncation', () {
    test('rejects a file cut at any length', () async {
      final file = sample();
      final cuts = {
        10,
        39,
        40,
        41,
        atlasStart(file, 0) - 1,
        atlasStart(file, 0),
        atlasStart(file, 1),
        file.length - 1,
      };
      for (final length in cuts) {
        await expectLater(
          WanimAnimation.load(Uint8List.sublistView(file, 0, length)),
          throwsWanim(WanimErrorType.invalidFile),
          reason: 'cut at $length',
        );
      }
    });
  });

  group('atlas contents', () {
    Future<Uint8List> clearAtlas() async {
      final file = sample();
      final header = WanimHeader.parse(file);
      final cipher = await WanimCipher.create(
        masterKey: officialKeyBytes(),
        header: header,
      );
      final start = atlasStart(file, 0);
      return cipher.decrypt(
        1,
        Uint8List.sublistView(file, start, start + atlasLength(0)),
      );
    }

    Map<String, dynamic> oneAtlas(int length, {int width = 38}) => {
      'version': 1,
      'width': 64,
      'height': 48,
      'fps': 12,
      'frameCount': 1,
      'opaque': false,
      'gpuBytes': 0,
      'atlases': [
        {
          'offset': 0,
          'length': length + 16,
          'width': width,
          'height': 44,
          'format': 'png',
        },
      ],
      'sprites': [
        [0, 2, 2, 16, 16, 4, 8],
      ],
      'frames': [0],
    };

    test('the test packer produces a valid file', () async {
      final png = await clearAtlas();
      final file = await packFile(oneAtlas(png.length), [png]);
      final animation = await WanimAnimation.load(file);
      animation.dispose();
    });

    test('rejects an atlas that differs from its stated size', () async {
      final png = await clearAtlas();
      final file = await packFile(oneAtlas(png.length, width: 37), [png]);
      await expectLater(
        WanimAnimation.load(file),
        throwsWanim(WanimErrorType.invalidFile),
      );
    });

    test('rejects an atlas that is not a PNG', () async {
      for (final length in [4, 200]) {
        final file = await packFile(oneAtlas(length), [Uint8List(length)]);
        await expectLater(
          WanimAnimation.load(file),
          throwsWanim(WanimErrorType.invalidFile),
        );
      }
    });

    test('rejects a PNG with a valid header but broken data', () async {
      final png = await clearAtlas();
      final broken = Uint8List.sublistView(png, 0, 40);
      final file = await packFile(oneAtlas(broken.length), [broken]);
      await expectLater(
        WanimAnimation.load(file),
        throwsWanim(WanimErrorType.invalidFile),
      );
    });
  });

  group('manifest validation', () {
    Map<String, dynamic> valid() =>
        jsonDecode(jsonEncode(expectedData['manifest']))
            as Map<String, dynamic>;

    WanimManifest parse(Map<String, dynamic> json) => WanimManifest.parse(
      Uint8List.fromList(utf8.encode(jsonEncode(json))),
      dataLength: 343,
    );

    test('accepts the fixture and ignores unknown fields', () {
      final manifest = parse(valid()..['futureField'] = {'a': 1});
      expect(manifest.frameCount, 12);
    });

    test('accepts fractional fps and a missing composition', () {
      final manifest = parse(
        valid()
          ..['fps'] = 29.97
          ..remove('compositionId'),
      );
      expect(manifest.fps, 29.97);
      expect(manifest.compositionId, isNull);
    });

    test('accepts an animation of empty frames', () {
      final manifest = parse(
        valid()
          ..['atlases'] = <Object>[]
          ..['sprites'] = <Object>[]
          ..['frames'] = [-1, -1]
          ..['frameCount'] = 2,
      );
      expect(manifest.atlases, isEmpty);
    });

    final invalid = <String, void Function(Map<String, dynamic>)>{
      'no frames': (json) => json
        ..['frames'] = <int>[]
        ..['frameCount'] = 0,
      'wrong frameCount': (json) => json['frameCount'] = 11,
      'frame out of range': (json) => (json['frames'] as List)[0] = 8,
      'frame below -1': (json) => (json['frames'] as List)[0] = -2,
      'frame of wrong type': (json) => (json['frames'] as List)[0] = 'x',
      'fps of zero': (json) => json['fps'] = 0,
      'negative fps': (json) => json['fps'] = -12,
      'empty canvas': (json) => json['width'] = 0,
      'sprite outside of atlas': (json) =>
          ((json['sprites'] as List)[0] as List)[3] = 1000,
      'sprite of missing atlas': (json) =>
          ((json['sprites'] as List)[0] as List)[0] = 2,
      'short sprite': (json) => (json['sprites'] as List)[0] = [0, 1],
      'atlas outside of file': (json) =>
          ((json['atlases'] as List)[1] as Map)['offset'] = 343,
      'huge atlas': (json) =>
          ((json['atlases'] as List)[0] as Map)['width'] = 4097,
      'atlas of wrong type': (json) => (json['atlases'] as List)[0] = 1,
      'missing fields': (json) => json.remove('sprites'),
    };
    for (final MapEntry(key: name, value: change) in invalid.entries) {
      test('rejects $name', () {
        final json = valid();
        change(json);
        expect(() => parse(json), throwsWanim(WanimErrorType.invalidFile));
      });
    }

    test('rejects what is not JSON', () {
      expect(
        () => WanimManifest.parse(
          Uint8List.fromList([0xff, 0xfe]),
          dataLength: 0,
        ),
        throwsWanim(WanimErrorType.invalidFile),
      );
      expect(
        () => WanimManifest.parse(
          Uint8List.fromList(utf8.encode('[1]')),
          dataLength: 0,
        ),
        throwsWanim(WanimErrorType.invalidFile),
      );
    });

    test('reports unknown versions and atlas formats as unsupported', () {
      expect(
        () => parse(valid()..['version'] = 2),
        throwsWanim(WanimErrorType.unsupportedVersion),
      );
      final json = valid();
      ((json['atlases'] as List)[0] as Map)['format'] = 'webp';
      expect(() => parse(json), throwsWanim(WanimErrorType.unsupportedVersion));
    });
  });
}
