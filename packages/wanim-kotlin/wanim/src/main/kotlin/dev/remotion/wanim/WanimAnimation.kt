package dev.remotion.wanim

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.os.Build
import dev.remotion.wanim.internal.WanimFile
import dev.remotion.wanim.internal.WanimManifest
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * An opened `.wanim` file. Only the encrypted file is kept, atlases are decrypted when a
 * [WanimView] needs them. One instance can be shared by any number of views.
 */
public class WanimAnimation internal constructor(internal val file: WanimFile) {
    internal val manifest: WanimManifest = file.manifest

    /** Size of the canvas in pixels. */
    public val width: Int get() = manifest.width
    public val height: Int get() = manifest.height
    public val fps: Double get() = manifest.fps
    public val frameCount: Int get() = manifest.frameCount
    public val durationSeconds: Double get() = manifest.frameCount / manifest.fps

    /** True if every frame covers the whole canvas with fully opaque pixels. */
    public val opaque: Boolean get() = manifest.opaque

    /** Memory of all atlases as textures. */
    public val gpuBytes: Long get() = manifest.gpuBytes
    public val compositionId: String? get() = manifest.compositionId

    private class DecodedAtlas {
        var users = 0
        var bitmap: Bitmap? = null
    }

    private val decodedAtlases = arrayOfNulls<DecodedAtlas>(manifest.atlases.size)

    /**
     * Decrypts and decodes an atlas. Views which load the same atlas at the same time share one
     * bitmap, which gets recycled by the last [releaseAtlas]. Blocks, so never call this on the
     * main or render thread.
     */
    internal fun acquireAtlas(index: Int): Bitmap {
        val entry = synchronized(decodedAtlases) {
            val entry = decodedAtlases[index] ?: DecodedAtlas().also { decodedAtlases[index] = it }
            entry.users++
            entry
        }
        try {
            synchronized(entry) {
                return entry.bitmap ?: decodeAtlas(index).also { entry.bitmap = it }
            }
        } catch (e: Throwable) {
            releaseAtlas(index)
            throw e
        }
    }

    internal fun releaseAtlas(index: Int) {
        val entry = synchronized(decodedAtlases) {
            val entry = decodedAtlases[index] ?: return
            entry.users--
            if (entry.users > 0) {
                return
            }
            decodedAtlases[index] = null
            entry
        }
        synchronized(entry) {
            entry.bitmap?.recycle()
            entry.bitmap = null
        }
    }

    private fun decodeAtlas(index: Int): Bitmap {
        val png = file.readAtlas(index)
        val options = BitmapFactory.Options().apply {
            inPremultiplied = true
            inScaled = false
            inMutable = false
            inPreferredConfig = Bitmap.Config.ARGB_8888
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
            }
        }
        val bitmap = BitmapFactory.decodeByteArray(png, 0, png.size, options)
            ?: throw WanimException.InvalidFile("Atlas $index is not a valid PNG")
        val atlas = manifest.atlases[index]
        if (bitmap.width != atlas.width || bitmap.height != atlas.height) {
            bitmap.recycle()
            throw WanimException.InvalidFile("Atlas $index does not have the size stated in the manifest")
        }
        return bitmap
    }

    public companion object {
        /**
         * Opens a `.wanim` file. Files that use the official key need no [key]. If the file was
         * encrypted with a key of its own, pass that key as 64 hexadecimal characters.
         *
         * @throws WanimException if the file cannot be opened
         * @throws IOException if the source cannot be read
         * @throws IllegalArgumentException if [key] is not 64 hexadecimal characters
         */
        public suspend fun open(context: Context, source: WanimSource, key: String? = null): WanimAnimation {
            val appContext = context.applicationContext ?: context
            val buffer = withContext(Dispatchers.IO) { read(appContext, source) }
            return withContext(Dispatchers.Default) {
                WanimAnimation(WanimFile.open(buffer, key))
            }
        }

        public suspend fun open(context: Context, file: File, key: String? = null): WanimAnimation =
            open(context, WanimSource.File(file), key)

        public suspend fun open(context: Context, bytes: ByteArray, key: String? = null): WanimAnimation =
            open(context, WanimSource.Bytes(bytes), key)

        private fun read(context: Context, source: WanimSource): ByteBuffer = when (source) {
            is WanimSource.Bytes -> ByteBuffer.wrap(source.bytes)
            is WanimSource.File -> RandomAccessFile(source.file, "r").use { file ->
                if (file.length() > Int.MAX_VALUE) {
                    throw WanimException.InvalidFile("A .wanim file cannot be larger than 2 GB")
                }
                file.channel.map(FileChannel.MapMode.READ_ONLY, 0, file.length())
            }
            is WanimSource.Asset -> try {
                context.assets.openFd(source.path).use { descriptor ->
                    FileInputStream(descriptor.fileDescriptor).use { stream ->
                        stream.channel.map(
                            FileChannel.MapMode.READ_ONLY,
                            descriptor.startOffset,
                            descriptor.length,
                        )
                    }
                }
            } catch (_: FileNotFoundException) {
                // Thrown by openFd for assets stored compressed, and for missing ones
                ByteBuffer.wrap(context.assets.open(source.path).use { it.readBytes() })
            }
        }
    }
}
