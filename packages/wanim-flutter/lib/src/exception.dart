/// Why a `.wanim` file could not be opened.
enum WanimErrorType {
  /// The bytes are not a well-formed `.wanim` file, or a file is truncated.
  invalidFile,

  /// A block failed its authentication check: The key is wrong, or the file
  /// was modified.
  wrongKeyOrTampered,

  /// The file was encrypted with a key of its own, and none was provided.
  missingCustomKey,

  /// The file uses a format version or flag that this player does not know.
  unsupportedVersion,
}

/// Thrown when a `.wanim` file cannot be opened or decoded.
class WanimException implements Exception {
  /// Creates an exception of the given [type].
  const WanimException(this.type, this.message);

  /// The kind of failure. Use this to decide how to react.
  final WanimErrorType type;

  /// A description for logs.
  final String message;

  @override
  String toString() => 'WanimException(${type.name}): $message';
}
