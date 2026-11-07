package dev.remotion.wanim

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.opengl.GLES30
import android.os.Debug
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.remotion.wanim.internal.WanimManifest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GpuPixelTest {
    private fun <T> withPlayer(player: OffscreenPlayer, block: (OffscreenPlayer) -> T): T =
        try {
            block(player)
        } finally {
            player.shutdown()
        }

    private fun expectedFrame(animation: WanimAnimation, frame: Int): ByteArray {
        val manifest = animation.manifest
        val canvas = ByteArray(manifest.width * manifest.height * 4)
        val sprite = manifest.frames[frame]
        if (sprite == WanimManifest.EMPTY_FRAME) {
            return canvas
        }
        val base = sprite * WanimManifest.SPRITE_FIELDS
        val atlasIndex = manifest.sprites[base + WanimManifest.SPRITE_ATLAS]
        val atlas = manifest.atlases[atlasIndex]
        val pixels = Fixtures.premultipliedAtlas(animation, atlasIndex)
        val x = manifest.sprites[base + WanimManifest.SPRITE_X]
        val y = manifest.sprites[base + WanimManifest.SPRITE_Y]
        val w = manifest.sprites[base + WanimManifest.SPRITE_W]
        val h = manifest.sprites[base + WanimManifest.SPRITE_H]
        val dx = manifest.sprites[base + WanimManifest.SPRITE_DX]
        val dy = manifest.sprites[base + WanimManifest.SPRITE_DY]
        for (row in 0 until h) {
            pixels.copyInto(
                canvas,
                ((dy + row) * manifest.width + dx) * 4,
                ((y + row) * atlas.width + x) * 4,
                ((y + row) * atlas.width + x + w) * 4,
            )
        }
        return canvas
    }

    private fun assertEveryFrameExact(animation: WanimAnimation) {
        val manifest = animation.manifest
        withPlayer(OffscreenPlayer(animation, manifest.width, manifest.height)) { player ->
            player.awaitReady()
            for (frame in 0 until manifest.frameCount) {
                assertArrayEquals("frame $frame", expectedFrame(animation, frame), player.render(frame))
            }
        }
    }

    @Test
    fun everyFrameOfOfficialFixtureMatchesExactly() = assertEveryFrameExact(Fixtures.official())

    @Test
    fun everyFrameOfCustomKeyFixtureMatchesExactly() = assertEveryFrameExact(Fixtures.custom())

    @Test
    fun framesMatchInReverseOrderToo() {
        val animation = Fixtures.official()
        withPlayer(OffscreenPlayer(animation, 64, 48)) { player ->
            player.awaitReady()
            for (frame in animation.frameCount - 1 downTo 0) {
                assertArrayEquals("frame $frame", expectedFrame(animation, frame), player.render(frame))
            }
        }
    }

    // Colors from fixtures/generate.ts, independent of how this device premultiplies
    @Test
    fun knownColorsArePremultiplied() {
        withPlayer(OffscreenPlayer(Fixtures.official(), 64, 48)) { player ->
            player.awaitReady()
            val red = player.render(0)
            assertArrayEquals(intArrayOf(128, 20, 20, 128), player.pixel(red, 4, 8))
            assertArrayEquals(intArrayOf(128, 20, 20, 128), player.pixel(red, 19, 23))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(red, 3, 8))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(red, 20, 23))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(red, 4, 24))

            val blue = player.render(7)
            assertArrayEquals(intArrayOf(40, 120, 255, 255), player.pixel(blue, 8, 30))
            assertArrayEquals(intArrayOf(40, 120, 255, 255), player.pixel(blue, 53, 39))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(blue, 54, 39))
        }
    }

    @Test
    fun heldAndEmptyFrames() {
        withPlayer(OffscreenPlayer(Fixtures.official(), 64, 48)) { player ->
            player.awaitReady()
            val first = player.render(7)
            val drawn = player.state.drawnFrames
            assertArrayEquals(first, player.render(8))
            assertArrayEquals(first, player.render(9))
            assertEquals("held frames must not draw", drawn, player.state.drawnFrames)
            assertTrue(player.render(10).all { it == 0.toByte() })
            assertEquals(drawn + 1, player.state.drawnFrames)
        }
    }

    // A sprite of one color: Any sample from the gutter would show as a darker pixel
    private fun assertScaledSpriteStaysInside(width: Int, height: Int, fit: WanimFit) {
        withPlayer(OffscreenPlayer(Fixtures.official(), width, height, fit)) { player ->
            player.awaitReady()
            val pixels = player.render(0)
            var covered = 0
            for (y in 0 until height) {
                for (x in 0 until width) {
                    val pixel = player.pixel(pixels, x, y)
                    if (pixel[3] != 0) {
                        covered++
                        assertArrayEquals("$x, $y in ${width}x$height", intArrayOf(128, 20, 20, 128), pixel)
                    }
                }
            }
            assertTrue("sprite is missing", covered > 0)
        }
    }

    @Test
    fun scaledSpritesDoNotSampleTheGutter() {
        for (fit in WanimFit.entries) {
            assertScaledSpriteStaysInside(128, 96, fit)
            assertScaledSpriteStaysInside(109, 82, fit)
            assertScaledSpriteStaysInside(37, 29, fit)
            assertScaledSpriteStaysInside(300, 500, fit)
        }
    }

    @Test
    fun containCentersTheCanvas() {
        withPlayer(OffscreenPlayer(Fixtures.official(), 128, 200, WanimFit.Contain)) { player ->
            player.awaitReady()
            val pixels = player.render(0)
            // Scale 2, 4 pixels from the left and 8 from the top of a canvas that starts at y = 52
            assertArrayEquals(intArrayOf(128, 20, 20, 128), player.pixel(pixels, 8, 68))
            assertArrayEquals(intArrayOf(128, 20, 20, 128), player.pixel(pixels, 39, 99))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(pixels, 7, 68))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(pixels, 8, 67))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(pixels, 40, 99))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(pixels, 39, 100))
        }
    }

    @Test
    fun coverCropsAndFillStretches() {
        withPlayer(OffscreenPlayer(Fixtures.official(), 96, 96, WanimFit.Cover)) { player ->
            player.awaitReady()
            val pixels = player.render(0)
            // Scale 2, the canvas starts at x = -16
            assertArrayEquals(intArrayOf(128, 20, 20, 128), player.pixel(pixels, 0, 16))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(pixels, 24, 16))
        }
        withPlayer(OffscreenPlayer(Fixtures.official(), 128, 48, WanimFit.Fill)) { player ->
            player.awaitReady()
            val pixels = player.render(0)
            assertArrayEquals(intArrayOf(128, 20, 20, 128), player.pixel(pixels, 8, 8))
            assertArrayEquals(intArrayOf(128, 20, 20, 128), player.pixel(pixels, 39, 23))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(pixels, 40, 23))
            assertArrayEquals(intArrayOf(0, 0, 0, 0), player.pixel(pixels, 39, 24))
        }
    }

    @Test
    fun opaqueAnimationsDrawWithoutBlending() {
        val animation = Fixtures.solidAtlases(listOf(Color.RED), opaque = true)
        withPlayer(OffscreenPlayer(animation, 16, 16)) { player ->
            player.awaitReady()
            assertFalse(player.thread.runOnRenderThreadForTest { GLES30.glIsEnabled(GLES30.GL_BLEND) })
            assertArrayEquals(intArrayOf(255, 0, 0, 255), player.pixel(player.render(0), 8, 8))
        }
        withPlayer(OffscreenPlayer(Fixtures.official(), 64, 48)) { player ->
            player.awaitReady()
            assertTrue(player.thread.runOnRenderThreadForTest { GLES30.glIsEnabled(GLES30.GL_BLEND) })
        }
    }

    @Test
    fun streamsWithinBudget() {
        val colors = listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW, Color.CYAN)
        val animation = Fixtures.solidAtlases(colors)
        withPlayer(OffscreenPlayer(animation, 16, 16, memoryBudgetBytes = 1)) { player ->
            player.awaitReady()
            assertEquals(2, player.thread.cacheCapacityForTest)
            repeat(3) {
                for (frame in colors.indices) {
                    player.seek(frame)
                    val want = Fixtures.rgba(colors[frame])
                    waitUntil("frame $frame") {
                        player.pixel(player.readPixels(), 8, 8).contentEquals(want)
                    }
                    assertTrue(player.thread.runOnRenderThreadForTest { player.thread.loadedAtlasCountForTest } <= 2)
                }
            }
            assertTrue("a missing atlas must hold, not block", player.state.heldFrames > 0)
            assertTrue(player.errors.isEmpty())
        }
    }

    @Test
    fun budgetLargerThanOneAtlasKeepsSeveral() {
        val colors = listOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW, Color.CYAN)
        val budget = 8L * 8 * 4 * 3
        withPlayer(OffscreenPlayer(Fixtures.solidAtlases(colors), 16, 16, memoryBudgetBytes = budget)) { player ->
            player.awaitReady()
            assertEquals(3, player.thread.cacheCapacityForTest)
        }
    }

    @Test
    fun everythingIsResidentBeforeReady() {
        val colors = listOf(Color.RED, Color.GREEN, Color.BLUE)
        withPlayer(OffscreenPlayer(Fixtures.solidAtlases(colors), 16, 16)) { player ->
            player.awaitReady()
            assertEquals(3, player.thread.runOnRenderThreadForTest { player.thread.loadedAtlasCountForTest })
        }
    }

    @Test
    fun recoversFromContextLoss() {
        val animation = Fixtures.official()
        withPlayer(OffscreenPlayer(animation, 64, 48)) { player ->
            player.awaitReady()
            val before = player.render(3)
            player.thread.simulateContextLossForTest()
            waitUntil("textures are uploaded again") {
                player.thread.runOnRenderThreadForTest { player.thread.isReadyForTest }
            }
            assertArrayEquals(before, player.readPixels())
            assertArrayEquals(expectedFrame(animation, 7), player.render(7))
            assertTrue(player.errors.isEmpty())
        }
    }

    @Test
    fun trimKeepsOnlyTheCurrentAtlasAndRestores() {
        val colors = listOf(Color.RED, Color.GREEN, Color.BLUE)
        withPlayer(OffscreenPlayer(Fixtures.solidAtlases(colors), 16, 16)) { player ->
            player.awaitReady()
            player.render(1)
            player.thread.trimMemory()
            assertEquals(1, player.thread.runOnRenderThreadForTest { player.thread.loadedAtlasCountForTest })
            assertArrayEquals(Fixtures.rgba(Color.GREEN), player.pixel(player.readPixels(), 8, 8))

            player.thread.requestSync()
            waitUntil("atlases come back when shown") {
                player.thread.runOnRenderThreadForTest { player.thread.loadedAtlasCountForTest } == 3
            }
            assertEquals(3, player.thread.cacheCapacityForTest)
        }
    }

    @Test
    fun atlasLargerThanTheGpuLimitIsAnError() {
        val player = OffscreenPlayer(Fixtures.official(), 64, 48, maxTextureSizeOverride = 40)
        withPlayer(player) {
            waitUntil("error") { it.errors.isNotEmpty() }
            val error = it.errors.peek() as WanimException.TextureTooLarge
            assertEquals(50, error.atlasSize)
            assertEquals(40, error.maxTextureSize)
        }
    }

    private fun assertLoadError(file: ByteArray, type: Class<out WanimException>) {
        withPlayer(OffscreenPlayer(Fixtures.fromBytes(file), 16, 16)) { player ->
            waitUntil("error") { player.errors.isNotEmpty() }
            assertEquals(type, player.errors.peek()!!.javaClass)
        }
    }

    @Test
    fun tamperedAtlasIsReportedWithoutUsingIt() {
        val png = Fixtures.solidPng(Color.RED)
        val pngs = listOf(png)
        val file = WanimWriter.write(WanimWriter.manifest(pngs), pngs)
        file[file.size - 20] = (file[file.size - 20] + 1).toByte()
        assertLoadError(file, WanimException.WrongKeyOrTampered::class.java)
    }

    @Test
    fun atlasThatIsNoPngIsReported() {
        val atlases = listOf(ByteArray(64) { 7 })
        assertLoadError(WanimWriter.write(WanimWriter.manifest(atlases), atlases), WanimException.InvalidFile::class.java)
    }

    @Test
    fun atlasOfTheWrongSizeIsReported() {
        val atlases = listOf(Fixtures.solidPng(Color.RED, 9, 8))
        assertLoadError(WanimWriter.write(WanimWriter.manifest(atlases), atlases), WanimException.InvalidFile::class.java)
    }

    @Test
    fun animationWithoutAtlasesShowsNothing() {
        val manifest = WanimWriter.manifest(emptyList(), sprites = emptyList(), frames = listOf(-1, -1))
        val animation = Fixtures.fromBytes(WanimWriter.write(manifest, emptyList()))
        withPlayer(OffscreenPlayer(animation, 16, 16)) { player ->
            player.awaitReady()
            assertTrue(player.render(1).all { it == 0.toByte() })
        }
    }

    @Test
    fun playersOfOneAnimationShareDecodedBitmaps() {
        val animation = Fixtures.official()
        val first = animation.acquireAtlas(0)
        val second = animation.acquireAtlas(0)
        assertTrue(first === second)
        assertEquals(Bitmap.Config.ARGB_8888, first.config)
        assertTrue(first.isPremultiplied)
        animation.releaseAtlas(0)
        assertFalse(first.isRecycled)
        animation.releaseAtlas(0)
        assertTrue(first.isRecycled)
    }

    @Test
    fun severalPlayersRenderTheSameAnimationAtOnce() {
        val animation = Fixtures.official()
        val players = List(4) { OffscreenPlayer(animation, 64, 48) }
        try {
            players.forEach { it.awaitReady() }
            for (frame in 0 until animation.frameCount) {
                val want = expectedFrame(animation, frame)
                players.forEach { assertArrayEquals(want, it.render(frame)) }
            }
            players[0].shutdown()
            assertArrayEquals(expectedFrame(animation, 2), players[1].render(2))
        } finally {
            players.drop(1).forEach { it.shutdown() }
        }
    }

    @Test
    fun drawLoopDoesNotAllocate() {
        withPlayer(OffscreenPlayer(Fixtures.official(), 64, 48)) { player ->
            player.awaitReady()
            val counted = player.thread.runOnRenderThreadForTest {
                Debug.startAllocCounting()
                Debug.resetThreadAllocCount()
                val control = Array(100) { ByteArray(8) }
                val controlCount = Debug.getThreadAllocCount()
                Debug.resetThreadAllocCount()
                for (round in 0 until 500) {
                    for (frame in 0 until 12) {
                        player.thread.presentForTest(frame)
                    }
                }
                val drawCount = Debug.getThreadAllocCount()
                Debug.stopAllocCounting()
                control.size to (controlCount to drawCount)
            }
            assertTrue("allocation counting does not work: $counted", counted.second.first >= 100)
            assertEquals("allocations in 6000 presented frames", 0, counted.second.second)
        }
    }

    @Test
    fun premultiplicationIsWithinRoundingOfTheMath() {
        val animation = Fixtures.official()
        for (index in animation.manifest.atlases.indices) {
            val png = animation.file.readAtlas(index)
            val straight = BitmapFactory.decodeByteArray(
                png,
                0,
                png.size,
                BitmapFactory.Options().apply { inPremultiplied = false },
            )
            val raw = Fixtures.premultipliedAtlas(animation, index)
            for (y in 0 until straight.height) {
                for (x in 0 until straight.width) {
                    val color = straight.getPixel(x, y)
                    val alpha = Color.alpha(color)
                    val start = (y * straight.width + x) * 4
                    assertEquals(alpha, raw[start + 3].toInt() and 0xFF)
                    for ((channel, value) in listOf(Color.red(color), Color.green(color), Color.blue(color)).withIndex()) {
                        val want = Math.round(value * alpha / 255.0).toInt()
                        assertEquals(want.toDouble(), (raw[start + channel].toInt() and 0xFF).toDouble(), 1.0)
                    }
                }
            }
            straight.recycle()
        }
    }
}
