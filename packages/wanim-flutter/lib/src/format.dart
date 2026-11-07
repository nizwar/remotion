import 'dart:typed_data';

import 'exception.dart';

/// Length of the plain header. The first encrypted block follows it.
const int headerLength = 40;

/// Length of the authentication tag at the end of each block.
const int tagLength = 16;

const int _version = 1;
const int _flagCustomKey = 1;
const int _flagsOffset = 10;
const int _manifestLengthOffset = 12;
const int _saltOffset = 16;
const int _noncePrefixOffset = 32;
const List<int> _magic = [0x89, 0x57, 0x41, 0x4e, 0x49, 0x4d, 0x0d, 0x0a];

/// The plain fields at the start of a `.wanim` file.
class WanimHeader {
  WanimHeader._({
    required this.customKey,
    required this.manifestLength,
    required this.salt,
    required this.noncePrefix,
    required this.bytes,
  });

  /// Reads the header of [file], and rejects what no reader may accept.
  factory WanimHeader.parse(Uint8List file) {
    if (file.length < headerLength) {
      throw const WanimException(
        WanimErrorType.invalidFile,
        'Not a .wanim file: It is shorter than the header.',
      );
    }

    for (var i = 0; i < _magic.length; i++) {
      if (file[i] != _magic[i]) {
        throw const WanimException(
          WanimErrorType.invalidFile,
          'Not a .wanim file: The magic bytes do not match.',
        );
      }
    }

    final view = ByteData.sublistView(file, 0, headerLength);
    final version = view.getUint16(_magic.length, Endian.little);
    if (version != _version) {
      throw WanimException(
        WanimErrorType.unsupportedVersion,
        'Unsupported .wanim version: $version',
      );
    }

    final flags = view.getUint16(_flagsOffset, Endian.little);
    if (flags & ~_flagCustomKey != 0) {
      throw WanimException(
        WanimErrorType.unsupportedVersion,
        'Unsupported .wanim flags: $flags',
      );
    }

    return WanimHeader._(
      customKey: flags & _flagCustomKey != 0,
      manifestLength: view.getUint32(_manifestLengthOffset, Endian.little),
      salt: Uint8List.sublistView(file, _saltOffset, _noncePrefixOffset),
      noncePrefix: Uint8List.sublistView(
        file,
        _noncePrefixOffset,
        headerLength,
      ),
      bytes: Uint8List.sublistView(file, 0, headerLength),
    );
  }

  /// Whether the file was encrypted with a key of its own.
  final bool customKey;

  /// Size of block 0, including its tag.
  final int manifestLength;

  /// Input of the key derivation.
  final Uint8List salt;

  /// First 8 bytes of each nonce.
  final Uint8List noncePrefix;

  /// The header as stored, which each block authenticates.
  final Uint8List bytes;

  /// Offset of the data section, which holds the atlas blocks.
  int get dataStart => headerLength + manifestLength;
}
