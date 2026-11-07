import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:cryptography_flutter/cryptography_flutter.dart';
import 'package:flutter/foundation.dart';

import 'exception.dart';
import 'format.dart';

const int _keyLength = 32;
final List<int> _hkdfInfo = utf8.encode('wanim/v1/aes-256-gcm');

/// Parses a key of 64 hexadecimal characters.
Uint8List parseKey(String key) {
  final trimmed = key.trim();
  if (!RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(trimmed)) {
    throw ArgumentError.value(
      '<redacted>',
      'key',
      'A .wanim key must be 64 hexadecimal characters (32 bytes)',
    );
  }

  final bytes = Uint8List(_keyLength);
  for (var i = 0; i < _keyLength; i++) {
    bytes[i] = int.parse(trimmed.substring(i * 2, i * 2 + 2), radix: 16);
  }

  return bytes;
}

/// The inputs of one AES-256-GCM block operation.
class WanimBlock {
  /// Splits [block], which is `ciphertext || tag`.
  WanimBlock({
    required this.fileKey,
    required this.nonce,
    required this.aad,
    required Uint8List block,
  }) : cipherText = Uint8List.sublistView(block, 0, block.length - tagLength),
       mac = Uint8List.sublistView(block, block.length - tagLength);

  /// Key derived for this file.
  final Uint8List fileKey;

  /// `noncePrefix || u32(blockIndex)`.
  final Uint8List nonce;

  /// `header || u32(blockIndex)`.
  final Uint8List aad;

  /// Encrypted bytes.
  final Uint8List cipherText;

  /// Authentication tag.
  final Uint8List mac;

  SecretBox get _secretBox =>
      SecretBox(cipherText, nonce: nonce, mac: Mac(mac));
}

/// Decrypts the blocks of one file.
class WanimCipher {
  WanimCipher._(this._fileKey, this._header);

  /// Derives the key of the file that [header] belongs to.
  static Future<WanimCipher> create({
    required Uint8List masterKey,
    required WanimHeader header,
  }) async {
    final derived = await Hkdf(hmac: Hmac.sha256(), outputLength: _keyLength)
        .deriveKey(
          secretKey: SecretKey(masterKey),
          nonce: header.salt,
          info: _hkdfInfo,
        );
    return WanimCipher._(
      Uint8List.fromList(await derived.extractBytes()),
      header,
    );
  }

  final Uint8List _fileKey;
  final WanimHeader _header;

  /// Prepares block [index] from its encrypted bytes.
  WanimBlock block(int index, Uint8List bytes) {
    final indexBytes = ByteData(4)..setUint32(0, index, Endian.little);
    final indexList = indexBytes.buffer.asUint8List();
    return WanimBlock(
      fileKey: _fileKey,
      nonce: Uint8List.fromList([..._header.noncePrefix, ...indexList]),
      aad: Uint8List.fromList([..._header.bytes, ...indexList]),
      block: bytes,
    );
  }

  /// Decrypts block [index], without blocking the UI isolate.
  ///
  /// Throws a [WanimException] if the block fails its authentication check.
  Future<Uint8List> decrypt(int index, Uint8List bytes) async {
    final block = this.block(index, bytes);
    final clearText = await _decryptOffUiIsolate(block);
    if (clearText == null) {
      throw const WanimException(
        WanimErrorType.wrongKeyOrTampered,
        'Could not decrypt .wanim file: The key is wrong or the file was modified.',
      );
    }

    return clearText;
  }
}

Future<Uint8List?> _decryptOffUiIsolate(WanimBlock block) async {
  if (kIsWeb) {
    return decryptWithPlatform(block);
  }

  // Larger messages can crash the method channel on Android
  final maxLength = CryptographyChannelQueue.defaultInstance.maxConcurrentSize;
  if (FlutterCryptography.isPluginPresent &&
      block.cipherText.length < maxLength) {
    try {
      return await decryptWithPlatform(block);
    } catch (_) {
      // An authentication failure is not an exception here: The native
      // implementation itself is unavailable or misbehaved
    }
  }

  return decryptInBackground(block);
}

/// Decrypts through the platform: Web Crypto in a browser, or the native
/// implementation of `cryptography_flutter` in an app. Returns `null` if the
/// authentication check fails.
Future<Uint8List?> decryptWithPlatform(WanimBlock block) async {
  final AesGcm cipher = kIsWeb
      ? AesGcm.with256bits()
      : FlutterAesGcm.with256bits(
          channelPolicy: const CryptographyChannelPolicy(
            minLength: 0,
            maxLength: null,
          ),
        );
  try {
    final clearText = await cipher.decrypt(
      block._secretBox,
      secretKey: SecretKey(block.fileKey),
      aad: block.aad,
    );
    return clearText is Uint8List ? clearText : Uint8List.fromList(clearText);
  } on SecretBoxAuthenticationError {
    return null;
  }
}

/// Decrypts with the pure Dart implementation in a background isolate. Returns
/// `null` if the authentication check fails.
Future<Uint8List?> decryptInBackground(WanimBlock block) {
  // A view would drag the whole file into the isolate message
  return compute(_decryptWithDart, [
    block.fileKey,
    block.nonce,
    block.aad,
    Uint8List.fromList(block.cipherText),
    Uint8List.fromList(block.mac),
  ]);
}

Future<Uint8List?> _decryptWithDart(List<Uint8List> input) async {
  try {
    final clearText = await DartAesGcm.with256bits().decrypt(
      SecretBox(input[3], nonce: input[1], mac: Mac(input[4])),
      secretKey: SecretKey(input[0]),
      aad: input[2],
    );
    return clearText is Uint8List ? clearText : Uint8List.fromList(clearText);
  } on SecretBoxAuthenticationError {
    return null;
  }
}
