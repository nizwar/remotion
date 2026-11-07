package dev.remotion.wanim.internal

import dev.remotion.wanim.WanimException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

internal class WanimAtlasInfo(
    val offset: Long,
    val length: Long,
    val width: Int,
    val height: Int,
    val format: String,
)

/**
 * `sprites` holds [SPRITE_FIELDS] values per sprite, and `frames` one sprite index per frame.
 * Both are flat so that playback touches no objects.
 */
internal class WanimManifest(
    val version: Int,
    val compositionId: String?,
    val width: Int,
    val height: Int,
    val fps: Double,
    val frameCount: Int,
    val opaque: Boolean,
    val gpuBytes: Long,
    val atlases: List<WanimAtlasInfo>,
    val sprites: IntArray,
    val frames: IntArray,
) {
    val spriteCount: Int get() = sprites.size / SPRITE_FIELDS

    companion object {
        const val SPRITE_FIELDS = 7
        const val SPRITE_ATLAS = 0
        const val SPRITE_X = 1
        const val SPRITE_Y = 2
        const val SPRITE_W = 3
        const val SPRITE_H = 4
        const val SPRITE_DX = 5
        const val SPRITE_DY = 6
        const val EMPTY_FRAME = -1

        fun parse(json: String, dataSectionLength: Long): WanimManifest {
            try {
                return parse(JSONObject(json), dataSectionLength)
            } catch (e: JSONException) {
                throw WanimException.InvalidFile("Invalid .wanim manifest: ${e.message}", e)
            }
        }

        private fun parse(root: JSONObject, dataSectionLength: Long): WanimManifest {
            val version = wholeNumber(root.getDouble("version")).toInt()
            if (version != WanimFile.VERSION) {
                throw WanimException.UnsupportedVersion(version)
            }

            val width = positiveInt(root.getDouble("width"), "width")
            val height = positiveInt(root.getDouble("height"), "height")
            val fps = root.getDouble("fps")
            if (fps.isNaN() || fps.isInfinite() || fps <= 0) {
                invalid("\"fps\" must be positive, got $fps")
            }

            val atlasArray = root.getJSONArray("atlases")
            val atlases = List(atlasArray.length()) { index ->
                val atlas = atlasArray.getJSONObject(index)
                WanimAtlasInfo(
                    offset = wholeNumber(atlas.getDouble("offset")),
                    length = wholeNumber(atlas.getDouble("length")),
                    width = positiveInt(atlas.getDouble("width"), "atlas width"),
                    height = positiveInt(atlas.getDouble("height"), "atlas height"),
                    format = atlas.getString("format"),
                )
            }
            for ((index, atlas) in atlases.withIndex()) {
                if (atlas.format != "png") {
                    invalid("Atlas $index has the unknown format \"${atlas.format}\"")
                }
                if (atlas.offset < 0 || atlas.length < WanimFile.TAG_LENGTH ||
                    atlas.offset + atlas.length > dataSectionLength
                ) {
                    invalid("Atlas $index is outside of the file: The file is truncated")
                }
            }

            val spriteArray = root.getJSONArray("sprites")
            val sprites = IntArray(spriteArray.length() * SPRITE_FIELDS)
            for (index in 0 until spriteArray.length()) {
                val sprite = spriteArray.getJSONArray(index)
                if (sprite.length() != SPRITE_FIELDS) {
                    invalid("Sprite $index must have $SPRITE_FIELDS fields")
                }
                val base = index * SPRITE_FIELDS
                for (field in 0 until SPRITE_FIELDS) {
                    sprites[base + field] = intValue(sprite.getDouble(field), "sprite")
                }
                val atlasIndex = sprites[base + SPRITE_ATLAS]
                val atlas = atlases.getOrNull(atlasIndex)
                    ?: invalid("Sprite $index points to the missing atlas $atlasIndex")
                val x = sprites[base + SPRITE_X].toLong()
                val y = sprites[base + SPRITE_Y].toLong()
                val w = sprites[base + SPRITE_W].toLong()
                val h = sprites[base + SPRITE_H].toLong()
                if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > atlas.width || y + h > atlas.height) {
                    invalid("Sprite $index is outside of atlas $atlasIndex")
                }
            }

            val frameArray = root.getJSONArray("frames")
            val frameCount = wholeNumber(root.getDouble("frameCount"))
            if (frameCount <= 0 || frameCount != frameArray.length().toLong()) {
                invalid("\"frameCount\" is $frameCount, but there are ${frameArray.length()} frames")
            }
            val spriteCount = sprites.size / SPRITE_FIELDS
            val frames = IntArray(frameArray.length()) { index ->
                val sprite = intValue(frameArray.getDouble(index), "frame")
                if (sprite < EMPTY_FRAME || sprite >= spriteCount) {
                    invalid("Frame $index points to the missing sprite $sprite")
                }
                sprite
            }

            return WanimManifest(
                version = version,
                compositionId = if (root.isNull("compositionId")) null else root.getString("compositionId"),
                width = width,
                height = height,
                fps = fps,
                frameCount = frames.size,
                opaque = root.getBoolean("opaque"),
                gpuBytes = atlases.sumOf { it.width.toLong() * it.height * 4 },
                atlases = atlases,
                sprites = sprites,
                frames = frames,
            )
        }

        private fun wholeNumber(value: Double): Long {
            if (value.isNaN() || value.isInfinite() || value != Math.rint(value) ||
                Math.abs(value) > MAX_SAFE_INTEGER
            ) {
                invalid("Expected a whole number, got $value")
            }
            return value.toLong()
        }

        private fun intValue(value: Double, name: String): Int {
            val number = wholeNumber(value)
            if (number < Int.MIN_VALUE || number > Int.MAX_VALUE) {
                invalid("A $name value is out of range: $number")
            }
            return number.toInt()
        }

        private fun positiveInt(value: Double, name: String): Int {
            val number = intValue(value, name)
            if (number <= 0) {
                invalid("\"$name\" must be positive, got $number")
            }
            return number
        }

        private fun invalid(message: String): Nothing =
            throw WanimException.InvalidFile("Invalid .wanim manifest: $message")

        private const val MAX_SAFE_INTEGER = 9007199254740991.0
    }
}
