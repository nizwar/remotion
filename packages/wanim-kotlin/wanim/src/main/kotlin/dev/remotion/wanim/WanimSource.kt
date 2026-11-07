package dev.remotion.wanim

/** Where the bytes of a `.wanim` file come from. */
public sealed interface WanimSource {
    /**
     * A file in the assets of the app. Add `androidResources { noCompress += "wanim" }` to the
     * build file of the app so that it can be memory mapped instead of being read into memory.
     */
    public data class Asset(val path: String) : WanimSource

    /** A file on disk, which gets memory mapped. It must not be modified while in use. */
    public data class File(val file: java.io.File) : WanimSource

    /** A file already in memory. The array is not copied, so it must not be modified. */
    public class Bytes(public val bytes: ByteArray) : WanimSource
}
