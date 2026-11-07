package dev.remotion.wanim

import dev.remotion.wanim.internal.OfficialKey
import dev.remotion.wanim.internal.WanimCrypto
import java.nio.ByteBuffer
import java.nio.ByteOrder
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

/** Writes `.wanim` files with arbitrary content, to test what the packer never creates. */
object WanimWriter {
    fun sprite(vararg values: Int): JSONArray = JSONArray().apply { values.forEach { put(it) } }

    /** A manifest with one atlas entry per PNG of the given size. */
    fun manifest(
        atlases: List<ByteArray>,
        atlasWidth: Int = 8,
        atlasHeight: Int = 8,
        sprites: List<JSONArray> = listOf(sprite(0, 0, 0, 4, 4, 0, 0)),
        frames: List<Int> = listOf(0, -1),
    ): JSONObject {
        var offset = 0
        val atlasEntries = JSONArray()
        for (png in atlases) {
            val length = png.size + 16
            atlasEntries.put(
                JSONObject()
                    .put("offset", offset)
                    .put("length", length)
                    .put("width", atlasWidth)
                    .put("height", atlasHeight)
                    .put("format", "png"),
            )
            offset += length
        }
        return JSONObject()
            .put("version", 1)
            .put("compositionId", "written")
            .put("width", 16)
            .put("height", 16)
            .put("fps", 30)
            .put("frameCount", frames.size)
            .put("opaque", false)
            .put("gpuBytes", atlases.size * atlasWidth * atlasHeight * 4)
            .put("atlases", atlasEntries)
            .put("sprites", JSONArray().apply { sprites.forEach { put(it) } })
            .put("frames", JSONArray().apply { frames.forEach { put(it) } })
    }

    fun write(
        manifest: JSONObject,
        atlases: List<ByteArray>,
        key: ByteArray? = null,
        extraFlags: Int = 0,
    ): ByteArray = writeRaw(manifest.toString().toByteArray(Charsets.UTF_8), key, atlases, extraFlags)

    fun writeRaw(
        json: ByteArray,
        key: ByteArray? = null,
        atlases: List<ByteArray> = emptyList(),
        extraFlags: Int = 0,
    ): ByteArray {
        val flags = (if (key == null) 0 else 1) or extraFlags
        val salt = ByteArray(16) { (it * 7 + 1).toByte() }
        val noncePrefix = ByteArray(8) { (it * 13 + 3).toByte() }
        val header = ByteBuffer.allocate(40).order(ByteOrder.LITTLE_ENDIAN)
            .put(byteArrayOf(0x89.toByte(), 0x57, 0x41, 0x4E, 0x49, 0x4D, 0x0D, 0x0A))
            .putShort(1)
            .putShort(flags.toShort())
            .putInt(json.size + 16)
            .put(salt)
            .put(noncePrefix)
            .array()
        val fileKey = SecretKeySpec(
            WanimCrypto.hkdfSha256(
                key ?: OfficialKey.bytes(),
                salt,
                "wanim/v1/aes-256-gcm".toByteArray(Charsets.US_ASCII),
            ),
            "AES",
        )

        val blocks = (listOf(json) + atlases).mapIndexed { index, plaintext ->
            val nonce = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN)
                .put(noncePrefix).putInt(index).array()
            val aad = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
                .put(header).putInt(index).array()
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.ENCRYPT_MODE, fileKey, GCMParameterSpec(128, nonce))
                updateAAD(aad)
                doFinal(plaintext)
            }
        }
        return blocks.fold(header) { file, block -> file + block }
    }
}
