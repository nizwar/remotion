package dev.remotion.wanim.internal

import dev.remotion.wanim.WanimException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.spec.SecretKeySpec

/**
 * Header parsing and block decryption. The encrypted file stays in [file], which is either
 * a memory map or a wrapped array. Decrypted data is only ever handed to the caller.
 */
internal class WanimFile private constructor(
    private val file: ByteBuffer,
    private val fileKey: SecretKeySpec,
    private val header: ByteArray,
    private val dataStart: Long,
    val manifest: WanimManifest,
) {
    fun readAtlas(index: Int): ByteArray {
        val atlas = manifest.atlases[index]
        return decrypt(file, fileKey, header, index + 1, dataStart + atlas.offset, atlas.length)
    }

    companion object {
        const val VERSION = 1
        const val HEADER_LENGTH = 40
        const val TAG_LENGTH = 16
        private const val FLAG_CUSTOM_KEY = 1
        private const val SALT_OFFSET = 16
        private const val SALT_LENGTH = 16
        private const val NONCE_PREFIX_OFFSET = 32
        private const val NONCE_PREFIX_LENGTH = 8
        private val MAGIC = byteArrayOf(0x89.toByte(), 0x57, 0x41, 0x4E, 0x49, 0x4D, 0x0D, 0x0A)
        private val HKDF_INFO = "wanim/v1/aes-256-gcm".toByteArray(Charsets.US_ASCII)

        fun open(source: ByteBuffer, key: String?): WanimFile {
            val file = source.slice().order(ByteOrder.LITTLE_ENDIAN)
            val size = file.remaining().toLong()
            if (size < HEADER_LENGTH || MAGIC.indices.any { file.get(it) != MAGIC[it] }) {
                throw WanimException.InvalidFile("Not a .wanim file")
            }

            val version = file.getShort(8).toInt() and 0xFFFF
            if (version != VERSION) {
                throw WanimException.UnsupportedVersion(version)
            }

            val flags = file.getShort(10).toInt() and 0xFFFF
            if (flags and FLAG_CUSTOM_KEY.inv() != 0) {
                throw WanimException.InvalidFile("Unsupported .wanim flags: $flags")
            }

            val customKey = flags and FLAG_CUSTOM_KEY != 0
            if (customKey && key == null) {
                throw WanimException.MissingCustomKey()
            }

            val manifestLength = file.getInt(12).toLong() and 0xFFFFFFFFL
            val dataStart = HEADER_LENGTH + manifestLength
            if (manifestLength < TAG_LENGTH || dataStart > size) {
                throw WanimException.InvalidFile("The manifest is outside of the file: The file is truncated")
            }

            val header = ByteArray(HEADER_LENGTH)
            file.duplicate().get(header)

            val masterKey = if (customKey) WanimCrypto.parseKey(key!!) else OfficialKey.bytes()
            val derived = WanimCrypto.hkdfSha256(
                ikm = masterKey,
                salt = header.copyOfRange(SALT_OFFSET, SALT_OFFSET + SALT_LENGTH),
                info = HKDF_INFO,
            )
            val fileKey = SecretKeySpec(derived, "AES")
            masterKey.fill(0)
            derived.fill(0)

            val manifestJson = decrypt(file, fileKey, header, 0, HEADER_LENGTH.toLong(), manifestLength)
            val manifest = WanimManifest.parse(String(manifestJson, Charsets.UTF_8), size - dataStart)
            return WanimFile(file, fileKey, header, dataStart, manifest)
        }

        private fun decrypt(
            file: ByteBuffer,
            fileKey: SecretKeySpec,
            header: ByteArray,
            blockIndex: Int,
            position: Long,
            length: Long,
        ): ByteArray {
            val nonce = ByteBuffer.allocate(NONCE_PREFIX_LENGTH + 4).order(ByteOrder.LITTLE_ENDIAN)
                .put(header, NONCE_PREFIX_OFFSET, NONCE_PREFIX_LENGTH)
                .putInt(blockIndex)
                .array()
            val aad = ByteBuffer.allocate(HEADER_LENGTH + 4).order(ByteOrder.LITTLE_ENDIAN)
                .put(header)
                .putInt(blockIndex)
                .array()

            val block = ByteArray(length.toInt())
            val view = file.duplicate()
            view.position(position.toInt())
            view.get(block)
            return WanimCrypto.decryptBlock(fileKey, nonce, aad, block)
        }
    }
}
