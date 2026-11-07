import 'dart:convert';
import 'dart:typed_data';

import 'exception.dart';
import 'format.dart';

const int _maxAtlasSize = 4096;

/// One texture atlas of an animation.
class WanimAtlas {
  /// Creates the description of an atlas.
  const WanimAtlas({
    required this.offset,
    required this.length,
    required this.width,
    required this.height,
    required this.format,
  });

  /// Position of the block in the data section.
  final int offset;

  /// Size of the block, including its authentication tag.
  final int length;

  /// Width in pixels.
  final int width;

  /// Height in pixels.
  final int height;

  /// Encoding of the decrypted bytes. `png` in version 1.
  final String format;

  /// Memory of this atlas as an RGBA8 texture.
  int get gpuBytes => width * height * 4;
}

/// A rectangle of an atlas, and where it goes on the canvas.
class WanimSprite {
  /// Creates a sprite.
  const WanimSprite({
    required this.atlas,
    required this.x,
    required this.y,
    required this.width,
    required this.height,
    required this.dx,
    required this.dy,
  });

  /// Index of the atlas.
  final int atlas;

  /// Left edge in the atlas.
  final int x;

  /// Top edge in the atlas.
  final int y;

  /// Width in pixels.
  final int width;

  /// Height in pixels.
  final int height;

  /// Left edge on the canvas.
  final int dx;

  /// Top edge on the canvas.
  final int dy;
}

/// The decrypted description of an animation.
class WanimManifest {
  /// Creates a manifest. Use [WanimManifest.parse] to read one from a file.
  const WanimManifest({
    required this.version,
    required this.compositionId,
    required this.width,
    required this.height,
    required this.fps,
    required this.opaque,
    required this.gpuBytes,
    required this.atlases,
    required this.sprites,
    required this.frames,
  });

  /// Reads and validates decrypted manifest bytes. [dataLength] is the size of
  /// the data section that the atlases have to fit into.
  factory WanimManifest.parse(Uint8List bytes, {required int dataLength}) {
    final WanimManifest manifest;
    try {
      final json = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
      final version = json['version'] as int;
      if (version != 1) {
        throw WanimException(
          WanimErrorType.unsupportedVersion,
          'Unsupported .wanim manifest version: $version',
        );
      }

      final frames = (json['frames'] as List<dynamic>).cast<int>();
      if (json['frameCount'] != frames.length) {
        throw const FormatException('frameCount does not match frames');
      }

      manifest = WanimManifest(
        version: version,
        compositionId: json['compositionId'] as String?,
        width: json['width'] as int,
        height: json['height'] as int,
        fps: (json['fps'] as num).toDouble(),
        opaque: json['opaque'] as bool,
        gpuBytes: json['gpuBytes'] as int,
        atlases: [
          for (final atlas in json['atlases'] as List<dynamic>)
            WanimAtlas(
              offset: atlas['offset'] as int,
              length: atlas['length'] as int,
              width: atlas['width'] as int,
              height: atlas['height'] as int,
              format: atlas['format'] as String,
            ),
        ],
        sprites: [
          for (final sprite in json['sprites'] as List<dynamic>)
            WanimSprite(
              atlas: sprite[0] as int,
              x: sprite[1] as int,
              y: sprite[2] as int,
              width: sprite[3] as int,
              height: sprite[4] as int,
              dx: sprite[5] as int,
              dy: sprite[6] as int,
            ),
        ],
        frames: Int32List.fromList(frames),
      );
      manifest._validate(dataLength);
    } on FormatException catch (error) {
      throw WanimException(
        WanimErrorType.invalidFile,
        'Invalid .wanim manifest: ${error.message}',
      );
    } on Error catch (error) {
      // JSON of the wrong shape surfaces as a TypeError, RangeError or
      // NoSuchMethodError while reading it
      throw WanimException(
        WanimErrorType.invalidFile,
        'Invalid .wanim manifest: $error',
      );
    }

    return manifest;
  }

  /// Format version of the manifest.
  final int version;

  /// The composition that the file was rendered from, if known.
  final String? compositionId;

  /// Width of the canvas in pixels.
  final int width;

  /// Height of the canvas in pixels.
  final int height;

  /// Playback speed in frames per second. May be fractional.
  final double fps;

  /// Whether every frame covers the whole canvas with opaque pixels.
  final bool opaque;

  /// Memory of all atlases as RGBA8 textures, as stated by the file.
  final int gpuBytes;

  /// The texture atlases, in playback order.
  final List<WanimAtlas> atlases;

  /// All placements of atlas rectangles.
  final List<WanimSprite> sprites;

  /// One entry per frame: An index into [sprites], or `-1` for an empty frame.
  final List<int> frames;

  /// Number of frames.
  int get frameCount => frames.length;

  /// The JSON representation of this manifest.
  Map<String, Object?> toJson() => {
    'version': version,
    'compositionId': compositionId,
    'width': width,
    'height': height,
    'fps': fps,
    'frameCount': frameCount,
    'opaque': opaque,
    'gpuBytes': gpuBytes,
    'atlases': [
      for (final atlas in atlases)
        {
          'offset': atlas.offset,
          'length': atlas.length,
          'width': atlas.width,
          'height': atlas.height,
          'format': atlas.format,
        },
    ],
    'sprites': [
      for (final sprite in sprites)
        [
          sprite.atlas,
          sprite.x,
          sprite.y,
          sprite.width,
          sprite.height,
          sprite.dx,
          sprite.dy,
        ],
    ],
    'frames': frames.toList(),
  };

  // A valid tag only proves that the file was made with the key, and the
  // official key ships in every player. Nothing below may be trusted blindly.
  void _validate(int dataLength) {
    if (width <= 0 || height <= 0) {
      throw const FormatException('The canvas is empty');
    }

    if (!(fps > 0) || fps.isInfinite) {
      throw const FormatException('fps must be positive');
    }

    if (frames.isEmpty) {
      throw const FormatException('There are no frames');
    }

    for (final atlas in atlases) {
      if (atlas.format != 'png') {
        throw WanimException(
          WanimErrorType.unsupportedVersion,
          'Unsupported atlas format: ${atlas.format}',
        );
      }

      if (atlas.width <= 0 ||
          atlas.height <= 0 ||
          atlas.width > _maxAtlasSize ||
          atlas.height > _maxAtlasSize) {
        throw const FormatException('An atlas has an invalid size');
      }

      if (atlas.offset < 0 ||
          atlas.length < tagLength ||
          atlas.offset + atlas.length > dataLength) {
        throw const FormatException(
          'An atlas lies outside of the file, which may be truncated',
        );
      }
    }

    for (final sprite in sprites) {
      if (sprite.atlas < 0 || sprite.atlas >= atlases.length) {
        throw const FormatException('A sprite points to a missing atlas');
      }

      final atlas = atlases[sprite.atlas];
      if (sprite.x < 0 ||
          sprite.y < 0 ||
          sprite.width <= 0 ||
          sprite.height <= 0 ||
          sprite.x + sprite.width > atlas.width ||
          sprite.y + sprite.height > atlas.height) {
        throw const FormatException('A sprite lies outside of its atlas');
      }
    }

    for (final frame in frames) {
      if (frame < -1 || frame >= sprites.length) {
        throw const FormatException('A frame points to a missing sprite');
      }
    }
  }
}
