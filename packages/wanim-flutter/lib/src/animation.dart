import 'dart:collection';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';

import 'crypto.dart';
import 'exception.dart';
import 'format.dart';
import 'manifest.dart';
import 'official_key.dart';

const int _defaultGpuBudgetBytes = 192 * 1024 * 1024;

// Signature and the start of the IHDR chunk, up to its width and height
const int _pngHeaderLength = 24;

// Current, next and previous atlas. At the largest atlas size, this equals the
// default budget.
const int _streamingCacheSize = 3;

/// An opened `.wanim` file.
///
/// If the textures fit the budget, all of them are on the GPU before [load]
/// completes. Otherwise atlases are streamed during playback. Call [dispose]
/// when the animation is no longer needed, or GPU memory leaks.
class WanimAnimation {
  WanimAnimation._(
    this._file,
    this._dataStart,
    this._cipher,
    this.manifest,
    this._resident,
  );

  /// Opens a `.wanim` file.
  ///
  /// Official files need no [key]. For a file with a custom key, pass its key
  /// as 64 hexadecimal characters. A [key] that is not well-formed is an
  /// [ArgumentError]. [bytes] are kept, not copied, and must not be modified.
  ///
  /// [gpuBudgetBytes] is the texture memory up to which all atlases are decoded
  /// up front. Larger animations are streamed through a small cache.
  ///
  /// Throws a [WanimException] if the file cannot be opened. With streaming,
  /// atlases after the first one are authenticated when they are reached.
  static Future<WanimAnimation> load(
    Uint8List bytes, {
    String? key,
    int gpuBudgetBytes = _defaultGpuBudgetBytes,
  }) async {
    final header = WanimHeader.parse(bytes);
    if (header.customKey && key == null) {
      throw const WanimException(
        WanimErrorType.missingCustomKey,
        'This .wanim file was encrypted with a key of its own.',
      );
    }

    if (header.dataStart > bytes.length || header.manifestLength < tagLength) {
      throw const WanimException(
        WanimErrorType.invalidFile,
        'Invalid .wanim file: The manifest block is truncated.',
      );
    }

    final cipher = await WanimCipher.create(
      masterKey: header.customKey ? parseKey(key!) : officialKeyBytes(),
      header: header,
    );
    final manifest = WanimManifest.parse(
      await cipher.decrypt(
        0,
        Uint8List.sublistView(bytes, headerLength, header.dataStart),
      ),
      dataLength: bytes.length - header.dataStart,
    );

    final gpuBytes = manifest.atlases.fold(
      0,
      (sum, atlas) => sum + atlas.gpuBytes,
    );
    final resident = gpuBytes <= gpuBudgetBytes;
    final animation = WanimAnimation._(
      bytes,
      header.dataStart,
      cipher,
      manifest,
      resident,
    );
    final initialAtlases = resident
        ? [for (var i = 0; i < manifest.atlases.length; i++) i]
        : [
            for (final sprite in manifest.frames.where((s) => s >= 0).take(1))
              manifest.sprites[sprite].atlas,
          ];
    for (final atlas in initialAtlases) {
      await animation.prepareAtlas(atlas);
      final error = animation.atlasError(atlas);
      if (error != null) {
        animation.dispose();
        throw error;
      }
    }

    return animation;
  }

  final Uint8List _file;
  final int _dataStart;
  final WanimCipher _cipher;
  bool _resident;
  bool _disposed = false;

  // Insertion order is the LRU order: The first entry was used the longest ago
  final LinkedHashMap<int, ui.Image> _images = LinkedHashMap();
  final Map<int, Future<void>> _pending = {};
  final Map<int, WanimException> _errors = {};

  /// The decrypted description of this animation.
  final WanimManifest manifest;

  /// Width of the canvas in pixels.
  int get width => manifest.width;

  /// Height of the canvas in pixels.
  int get height => manifest.height;

  /// Playback speed in frames per second.
  double get fps => manifest.fps;

  /// Number of frames.
  int get frameCount => manifest.frameCount;

  /// Whether every frame covers the whole canvas with opaque pixels.
  bool get opaque => manifest.opaque;

  /// Length of one playthrough at normal speed.
  Duration get duration => Duration(
    microseconds: (frameCount / fps * Duration.microsecondsPerSecond).round(),
  );

  /// Whether [dispose] was called.
  bool get isDisposed => _disposed;

  /// Whether all atlases stay on the GPU, instead of being streamed.
  bool get isResident => _resident;

  /// Releases all images. A [WanimPlayer] that is still mounted keeps showing
  /// its current atlas until it is disposed, but shows no other one.
  void dispose() {
    _disposed = true;
    for (final image in _images.values) {
      image.dispose();
    }
    _images.clear();
  }

  /// A new handle to the texture of [atlas] that the caller has to dispose, or
  /// `null` if it is not decoded. Marks the atlas as recently used.
  @internal
  ui.Image? atlasImage(int atlas) {
    final image = _images.remove(atlas);
    if (image == null) {
      return null;
    }

    _images[atlas] = image;
    return image.clone();
  }

  /// The failure of [atlas], if it could not be prepared.
  @internal
  WanimException? atlasError(int atlas) => _errors[atlas];

  /// Decrypts and decodes [atlas] unless that already happened. Never throws:
  /// A failure is available from [atlasError] afterwards.
  @internal
  Future<void> prepareAtlas(int atlas) {
    if (_disposed || _images.containsKey(atlas) || _errors.containsKey(atlas)) {
      return Future.value();
    }

    return _pending[atlas] ??= _decodeAtlas(atlas).whenComplete(() {
      _pending.remove(atlas);
    });
  }

  /// Starts preparing the atlas that follows [atlas] in playback order.
  @internal
  void prefetchAfter(int atlas, {required bool loop}) {
    final next = atlas + 1;
    if (_resident || (next == manifest.atlases.length && !loop)) {
      return;
    }

    prepareAtlas(next % manifest.atlases.length);
  }

  /// Drops every texture but [keep] from the cache, and streams from now on.
  @internal
  void shrinkCache(int? keep) {
    _resident = false;
    _images.removeWhere((atlas, image) {
      if (atlas == keep) {
        return false;
      }

      image.dispose();
      return true;
    });
  }

  Future<void> _decodeAtlas(int index) async {
    final atlas = manifest.atlases[index];
    final start = _dataStart + atlas.offset;
    try {
      final png = await _cipher.decrypt(
        index + 1,
        Uint8List.sublistView(_file, start, start + atlas.length),
      );
      final image = await _decodePng(png, atlas);
      if (_disposed) {
        image.dispose();
        return;
      }

      _images[index] = image;
      if (!_resident) {
        while (_images.length > _streamingCacheSize) {
          _images.remove(_images.keys.first)!.dispose();
        }
      }
    } on WanimException catch (error) {
      _errors[index] = error;
    }
  }

  // The engine decodes on a background thread and uploads to the GPU, with
  // premultiplied alpha
  static Future<ui.Image> _decodePng(Uint8List png, WanimAtlas atlas) async {
    // Read from the PNG header, because ImageDescriptor.width does not exist on
    // web. Keeps a file from allocating more texture memory than it declares.
    if (png.length < _pngHeaderLength ||
        ByteData.sublistView(png).getUint32(16) != atlas.width ||
        ByteData.sublistView(png).getUint32(20) != atlas.height) {
      throw const WanimException(
        WanimErrorType.invalidFile,
        'Invalid .wanim file: An atlas differs from its stated size.',
      );
    }

    ui.ImmutableBuffer? buffer;
    ui.ImageDescriptor? descriptor;
    ui.Codec? codec;
    try {
      buffer = await ui.ImmutableBuffer.fromUint8List(png);
      descriptor = await ui.ImageDescriptor.encoded(buffer);
      codec = await descriptor.instantiateCodec();
      return (await codec.getNextFrame()).image;
    } catch (error) {
      throw WanimException(
        WanimErrorType.invalidFile,
        'Invalid .wanim file: Could not decode an atlas: $error',
      );
    } finally {
      codec?.dispose();
      descriptor?.dispose();
      buffer?.dispose();
    }
  }
}
