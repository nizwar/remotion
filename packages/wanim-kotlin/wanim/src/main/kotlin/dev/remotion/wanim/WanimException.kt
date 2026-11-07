package dev.remotion.wanim

/** Every failure reported by this library. */
public sealed class WanimException(message: String, cause: Throwable? = null) :
    Exception(message, cause) {

    /** The data is not a well-formed `.wanim` file, for example because it is truncated. */
    public class InvalidFile(message: String, cause: Throwable? = null) :
        WanimException(message, cause)

    /** A block failed its authentication tag: The key is wrong or the file was modified. */
    public class WrongKeyOrTampered(message: String, cause: Throwable? = null) :
        WanimException(message, cause)

    /** The file was encrypted with a key of its own and none was passed to `open`. */
    public class MissingCustomKey :
        WanimException("This .wanim file was encrypted with a key of its own.")

    /** The file uses a format version that this library cannot read. */
    public class UnsupportedVersion(public val version: Int) :
        WanimException("Unsupported .wanim version: $version")

    /** An atlas is larger than the textures this GPU supports. */
    public class TextureTooLarge(public val atlasSize: Int, public val maxTextureSize: Int) :
        WanimException("An atlas of size $atlasSize exceeds GL_MAX_TEXTURE_SIZE ($maxTextureSize).")

    /** EGL or OpenGL ES 3.0 is not available or failed. */
    public class Rendering(message: String, cause: Throwable? = null) :
        WanimException(message, cause)
}
