package dev.remotion.wanim

import dev.remotion.wanim.WanimWriter.sprite
import dev.remotion.wanim.internal.WanimCrypto
import dev.remotion.wanim.internal.WanimFile
import dev.remotion.wanim.internal.WanimManifest
import java.nio.ByteBuffer
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class WanimFileTest {
    private fun resource(name: String): ByteArray =
        checkNotNull(javaClass.getResourceAsStream("/wanim/$name")) { name }.use { it.readBytes() }

    private val sample = resource("sample.wanim")
    private val customSample = resource("sample-custom-key.wanim")
    private val expected = JSONObject(String(resource("expected.json")))
    private val customKey = expected.getString("customKey")
    private val png = ByteArray(40) { it.toByte() }

    private fun open(bytes: ByteArray, key: String? = null) = WanimFile.open(ByteBuffer.wrap(bytes), key)

    private fun sha256(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun assertConforms(file: WanimFile) {
        val want = expected.getJSONObject("manifest")
        val manifest = file.manifest
        assertEquals(want.getInt("version"), manifest.version)
        assertEquals(want.getString("compositionId"), manifest.compositionId)
        assertEquals(want.getInt("width"), manifest.width)
        assertEquals(want.getInt("height"), manifest.height)
        assertEquals(want.getDouble("fps"), manifest.fps, 0.0)
        assertEquals(want.getInt("frameCount"), manifest.frameCount)
        assertEquals(want.getBoolean("opaque"), manifest.opaque)
        assertEquals(want.getLong("gpuBytes"), manifest.gpuBytes)

        val atlases = want.getJSONArray("atlases")
        assertEquals(atlases.length(), manifest.atlases.size)
        for (index in 0 until atlases.length()) {
            val atlas = atlases.getJSONObject(index)
            val actual = manifest.atlases[index]
            assertEquals(atlas.getLong("offset"), actual.offset)
            assertEquals(atlas.getLong("length"), actual.length)
            assertEquals(atlas.getInt("width"), actual.width)
            assertEquals(atlas.getInt("height"), actual.height)
            assertEquals(atlas.getString("format"), actual.format)
        }

        val sprites = want.getJSONArray("sprites")
        val flatSprites = (0 until sprites.length()).flatMap { index ->
            val sprite = sprites.getJSONArray(index)
            (0 until sprite.length()).map(sprite::getInt)
        }
        assertArrayEquals(flatSprites.toIntArray(), manifest.sprites)
        assertEquals(sprites.length(), manifest.spriteCount)

        val frames = want.getJSONArray("frames")
        assertArrayEquals(IntArray(frames.length(), frames::getInt), manifest.frames)

        val hashes = expected.getJSONArray("atlasSha256")
        assertEquals(hashes.length(), manifest.atlases.size)
        for (index in 0 until hashes.length()) {
            assertEquals(hashes.getString(index), sha256(file.readAtlas(index)))
        }
    }

    private fun flip(bytes: ByteArray, position: Int) =
        bytes.copyOf().also { it[position] = (it[position].toInt() xor 0x40).toByte() }

    private fun assertInvalidManifest(edit: (JSONObject) -> Unit) {
        val atlases = listOf(png)
        val manifest = WanimWriter.manifest(atlases).also(edit)
        assertThrows(WanimException.InvalidFile::class.java) {
            open(WanimWriter.write(manifest, atlases))
        }
    }

    @Test
    fun opensOfficialFileWithoutKey() = assertConforms(open(sample))

    @Test
    fun opensCustomKeyFile() = assertConforms(open(customSample, customKey))

    @Test
    fun acceptsUppercaseKeyWithSurroundingSpace() =
        assertConforms(open(customSample, "  ${customKey.uppercase()}\n"))

    @Test
    fun ignoresKeyForOfficialFile() = assertConforms(open(sample, customKey))

    @Test
    fun readsFromSubrangeOfBuffer() {
        val padded = ByteArray(5) + sample
        val buffer = ByteBuffer.wrap(padded).also { it.position(5) }
        assertConforms(WanimFile.open(buffer, null))
    }

    @Test
    fun compressedFixtureHoldsIndexedAtlasesOfTheSameAnimation() {
        val compressed = open(resource("sample-compressed.wanim"))
        val original = open(sample).manifest
        assertArrayEquals(original.frames, compressed.manifest.frames)
        assertArrayEquals(original.sprites, compressed.manifest.sprites)
        assertEquals(original.width, compressed.manifest.width)
        assertEquals(original.height, compressed.manifest.height)
        assertEquals(original.fps, compressed.manifest.fps, 0.0)
        assertEquals(original.gpuBytes, compressed.manifest.gpuBytes)

        val pngSignature = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        for (index in compressed.manifest.atlases.indices) {
            val png = compressed.readAtlas(index)
            assertArrayEquals(pngSignature, png.copyOf(8))
            val colorTypeOfIhdr = png[25].toInt()
            assertEquals("indexed color", 3, colorTypeOfIhdr)
            assertEquals("bit depth", true, png[24].toInt() in listOf(1, 2, 4, 8))
            assertTrue("tRNS chunk", String(png, Charsets.ISO_8859_1).contains("tRNS"))
        }
    }

    @Test
    fun wrongCustomKeyIsReported() {
        val wrongKey = "ff" + customKey.drop(2)
        assertThrows(WanimException.WrongKeyOrTampered::class.java) { open(customSample, wrongKey) }
    }

    @Test
    fun missingCustomKeyIsReported() {
        assertThrows(WanimException.MissingCustomKey::class.java) { open(customSample) }
    }

    @Test
    fun malformedKeyIsAProgrammingError() {
        for (key in listOf("", "abcd", "g".repeat(64), customKey + "00")) {
            assertThrows(IllegalArgumentException::class.java) { open(customSample, key) }
        }
    }

    @Test
    fun everyUnknownFlagIsRejected() {
        for (bit in 1 until 16) {
            for (file in listOf(sample, customSample)) {
                val changed = file.copyOf()
                val flags = (changed[10].toInt() and 0xFF) or ((changed[11].toInt() and 0xFF) shl 8) or (1 shl bit)
                changed[10] = flags.toByte()
                changed[11] = (flags shr 8).toByte()
                assertThrows("bit $bit", WanimException.InvalidFile::class.java) { open(changed, customKey) }
            }
        }
    }

    @Test
    fun unsupportedVersionsAreRejected() {
        for (version in listOf(0, 2, 0xFFFF)) {
            val changed = sample.copyOf()
            changed[8] = version.toByte()
            changed[9] = (version shr 8).toByte()
            val error = assertThrows(WanimException.UnsupportedVersion::class.java) { open(changed) }
            assertEquals(version, error.version)
        }
    }

    @Test
    fun manifestVersionMustMatch() {
        val atlases = listOf(png)
        val manifest = WanimWriter.manifest(atlases).put("version", 2)
        assertThrows(WanimException.UnsupportedVersion::class.java) {
            open(WanimWriter.write(manifest, atlases))
        }
    }

    @Test
    fun everyMagicByteIsChecked() {
        for (position in 0 until 8) {
            assertThrows(WanimException.InvalidFile::class.java) { open(flip(sample, position)) }
        }
    }

    @Test
    fun everyAuthenticatedHeaderByteIsChecked() {
        for (position in 16 until 40) {
            assertThrows("byte $position", WanimException.WrongKeyOrTampered::class.java) {
                open(flip(sample, position))
            }
        }
    }

    @Test
    fun changedManifestLengthIsRejected() {
        for (position in 12 until 16) {
            try {
                open(flip(sample, position))
                fail("byte $position")
            } catch (e: WanimException) {
                assertFalse(e is WanimException.UnsupportedVersion)
            }
        }
    }

    @Test
    fun flippedByteInManifestBlockIsRejected() {
        val file = open(sample)
        val dataStart = sample.size - file.manifest.atlases.sumOf { it.length }.toInt()
        for (position in 40 until dataStart) {
            assertThrows("byte $position", WanimException.WrongKeyOrTampered::class.java) {
                open(flip(sample, position))
            }
        }
    }

    @Test
    fun flippedByteInEachAtlasBlockIsRejected() {
        val manifest = open(sample).manifest
        val dataStart = sample.size - manifest.atlases.sumOf { it.length }.toInt()
        for ((index, atlas) in manifest.atlases.withIndex()) {
            val start = dataStart + atlas.offset.toInt()
            for (position in start until start + atlas.length.toInt()) {
                val changed = open(flip(sample, position))
                assertThrows("byte $position", WanimException.WrongKeyOrTampered::class.java) {
                    changed.readAtlas(index)
                }
                val other = 1 - index
                assertEquals(
                    expected.getJSONArray("atlasSha256").getString(other),
                    sha256(changed.readAtlas(other)),
                )
            }
        }
    }

    @Test
    fun everyTruncationIsRejected() {
        for (length in 0 until sample.size) {
            assertThrows("length $length", WanimException.InvalidFile::class.java) {
                open(sample.copyOf(length))
            }
        }
    }

    @Test
    fun atlasBlocksCannotBeSwapped() {
        val first = ByteArray(32) { 1 }
        val second = ByteArray(32) { 2 }
        val atlases = listOf(first, second)
        val file = WanimWriter.write(WanimWriter.manifest(atlases), atlases)
        val blockLength = first.size + 16
        val secondStart = file.size - blockLength
        val firstStart = secondStart - blockLength
        val swapped = file.copyOf()
        file.copyInto(swapped, firstStart, secondStart, secondStart + blockLength)
        file.copyInto(swapped, secondStart, firstStart, firstStart + blockLength)

        assertArrayEquals(first, open(file).readAtlas(0))
        assertThrows(WanimException.WrongKeyOrTampered::class.java) { open(swapped).readAtlas(0) }
        assertThrows(WanimException.WrongKeyOrTampered::class.java) { open(swapped).readAtlas(1) }
    }

    @Test
    fun manifestBlockCannotMoveIntoAnotherFile() {
        val atlases = listOf(png)
        val manifest = WanimWriter.manifest(atlases)
        val official = WanimWriter.write(manifest, atlases)
        val other = official.copyOf()
        other[16] = (other[16] + 1).toByte()
        assertThrows(WanimException.WrongKeyOrTampered::class.java) { open(other) }
    }

    @Test
    fun unknownManifestFieldsAreIgnored() {
        val atlases = listOf(png)
        val manifest = WanimWriter.manifest(atlases).put("somethingNew", JSONObject().put("a", 1))
        manifest.getJSONArray("atlases").getJSONObject(0).put("extra", true)
        assertEquals(2, open(WanimWriter.write(manifest, atlases)).manifest.frameCount)
    }

    @Test
    fun fpsMayBeFractionalAndCompositionIdMayBeNull() {
        val atlases = listOf(png)
        val manifest = WanimWriter.manifest(atlases).put("fps", 29.97).put("compositionId", JSONObject.NULL)
        val parsed = open(WanimWriter.write(manifest, atlases)).manifest
        assertEquals(29.97, parsed.fps, 0.0)
        assertNull(parsed.compositionId)
    }

    @Test
    fun framesOfOnlyGapsNeedNoAtlas() {
        val manifest = WanimWriter.manifest(emptyList(), sprites = emptyList(), frames = listOf(-1, -1))
        assertEquals(0L, open(WanimWriter.write(manifest, emptyList())).manifest.gpuBytes)
    }

    @Test
    fun malformedManifestsAreRejected() {
        assertInvalidManifest { it.put("width", 0) }
        assertInvalidManifest { it.put("height", -4) }
        assertInvalidManifest { it.put("width", 1.5) }
        assertInvalidManifest { it.put("fps", 0) }
        assertInvalidManifest { it.put("frameCount", 5) }
        assertInvalidManifest { it.put("frames", JSONArray()).put("frameCount", 0) }
        assertInvalidManifest { it.put("frames", JSONArray().put(1).put(0)) }
        assertInvalidManifest { it.put("frames", JSONArray().put(-2).put(0)) }
        assertInvalidManifest { it.put("sprites", JSONArray().put(sprite(1, 0, 0, 4, 4, 0, 0))) }
        assertInvalidManifest { it.put("sprites", JSONArray().put(sprite(0, 0, 0, 4, 4, 0))) }
        assertInvalidManifest { it.put("sprites", JSONArray().put(sprite(0, 6, 0, 4, 4, 0, 0))) }
        assertInvalidManifest { it.put("sprites", JSONArray().put(sprite(0, 0, 6, 4, 4, 0, 0))) }
        assertInvalidManifest { it.put("sprites", JSONArray().put(sprite(0, -1, 0, 4, 4, 0, 0))) }
        assertInvalidManifest { it.put("sprites", JSONArray().put(sprite(0, 0, 0, 0, 4, 0, 0))) }
        assertInvalidManifest { it.getJSONArray("atlases").getJSONObject(0).put("format", "webp") }
        assertInvalidManifest { it.getJSONArray("atlases").getJSONObject(0).put("offset", 1) }
        assertInvalidManifest { it.getJSONArray("atlases").getJSONObject(0).put("length", 4) }
        assertInvalidManifest { it.remove("sprites") }
        assertInvalidManifest { it.remove("opaque") }
    }

    @Test
    fun manifestThatIsNotJsonIsRejected() {
        val key = ByteArray(32)
        for (text in listOf("{not json", "[]", "{}")) {
            val file = WanimWriter.writeRaw(text.toByteArray(), key)
            assertThrows(text, WanimException.InvalidFile::class.java) { open(file, "00".repeat(32)) }
        }
    }

    @Test
    fun hkdfMatchesRfc5869TestCase1() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = ByteArray(13) { it.toByte() }
        val info = ByteArray(10) { (0xf0 + it).toByte() }
        assertEquals(
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
            WanimCrypto.hkdfSha256(ikm, salt, info).joinToString("") { "%02x".format(it) },
        )
    }

    @Test
    fun officialKeyIsNotAPlainConstantOfTheClass() {
        val classFile = checkNotNull(
            WanimManifest::class.java.classLoader!!.getResourceAsStream("dev/remotion/wanim/internal/OfficialKey.class"),
        ).use { it.readBytes() }
        val key = dev.remotion.wanim.internal.OfficialKey.bytes()
        val text = String(classFile, Charsets.ISO_8859_1)
        assertFalse(text.contains(String(key, Charsets.ISO_8859_1)))
        assertFalse(text.contains(key.joinToString("") { "%02x".format(it) }))
    }
}
