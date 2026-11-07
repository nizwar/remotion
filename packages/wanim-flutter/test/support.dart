import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:wanim/src/official_key.dart';

Uint8List fixture(String name) => File('test/fixtures/$name').readAsBytesSync();

Map<String, dynamic> expected() =>
    jsonDecode(File('test/fixtures/expected.json').readAsStringSync())
        as Map<String, dynamic>;

Uint8List sample() => fixture('sample.wanim');

Uint8List customSample() => fixture('sample-custom-key.wanim');

String customKey() => expected()['customKey'] as String;

/// Offset of the block of atlas [atlas] in the fixture.
int atlasStart(Uint8List file, int atlas) {
  final manifestLength = ByteData.sublistView(file)
      .getUint32(12, Endian.little);
  final atlases = (expected()['manifest'] as Map)['atlases'] as List;
  return 40 + manifestLength + (atlases[atlas]['offset'] as int);
}

int atlasLength(int atlas) =>
    ((expected()['manifest'] as Map)['atlases'] as List)[atlas]['length']
        as int;

Uint8List flipped(Uint8List file, int offset) {
  final copy = Uint8List.fromList(file);
  copy[offset] ^= 0x01;
  return copy;
}

/// The premultiplied RGBA pixels of [image].
Future<Uint8List> pixels(ui.Image image) async {
  final data = await image.toByteData();
  return data!.buffer.asUint8List();
}

Future<ui.Image> decodePng(Uint8List png) async {
  final codec = await ui.instantiateImageCodec(png);
  final frame = await codec.getNextFrame();
  codec.dispose();
  return frame.image;
}

/// Encrypts a file with the official key, to test manifests and atlases that
/// no packer would write.
Future<Uint8List> packFile(
  Map<String, dynamic> manifest,
  List<Uint8List> atlases,
) async {
  final salt = Uint8List(16);
  final noncePrefix = Uint8List(8);
  final fileKey =
      await DartHkdf(
        hmac: const DartHmac(DartSha256()),
        outputLength: 32,
      ).deriveKey(
        secretKey: SecretKey(officialKeyBytes()),
        nonce: salt,
        info: utf8.encode('wanim/v1/aes-256-gcm'),
      );

  Future<Uint8List> seal(Uint8List header, int index, List<int> clear) async {
    final indexBytes = (ByteData(
      4,
    )..setUint32(0, index, Endian.little)).buffer.asUint8List();
    final box = await DartAesGcm.with256bits().encrypt(
      clear,
      secretKey: fileKey,
      nonce: [...noncePrefix, ...indexBytes],
      aad: [...header, ...indexBytes],
    );
    return Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
  }

  final json = utf8.encode(jsonEncode(manifest));
  final header = Uint8List(40)
    ..setAll(0, [0x89, 0x57, 0x41, 0x4e, 0x49, 0x4d, 0x0d, 0x0a])
    ..[8] = 1;
  ByteData.sublistView(header).setUint32(12, json.length + 16, Endian.little);
  final output = [...header, ...await seal(header, 0, json)];
  for (var i = 0; i < atlases.length; i++) {
    output.addAll(await seal(header, i + 1, atlases[i]));
  }

  return Uint8List.fromList(output);
}
