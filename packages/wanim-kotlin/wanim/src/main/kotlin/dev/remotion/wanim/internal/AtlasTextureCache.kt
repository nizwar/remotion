package dev.remotion.wanim.internal

import android.opengl.GLES30
import dev.remotion.wanim.WanimAnimation

/**
 * The textures of one animation in one EGL context. Used on the render thread only.
 *
 * If all atlases fit into [memoryBudgetBytes], they stay resident. Otherwise this is an LRU that
 * holds as many atlases as the budget allows, but at least the current and the next one.
 */
internal class AtlasTextureCache(
    private val animation: WanimAnimation,
    private val loader: AtlasLoader,
    val generation: Int,
    memoryBudgetBytes: Long,
) {
    private val atlases = animation.manifest.atlases
    private val textures = IntArray(atlases.size)
    private val pending = BooleanArray(atlases.size)
    private val lastUsed = LongArray(atlases.size)
    private var useCounter = 0L
    private val scratch = IntArray(1)

    private val fitsBudget = animation.manifest.gpuBytes <= memoryBudgetBytes
    private val budgetCapacity = if (fitsBudget) {
        atlases.size
    } else {
        val largest = atlases.maxOf { it.width.toLong() * it.height * 4 }
        (memoryBudgetBytes / largest).toInt().coerceIn(MIN_CAPACITY, atlases.size)
    }

    var resident: Boolean = fitsBudget
        private set

    var capacity: Int = budgetCapacity
        private set

    val loadedCount: Int get() = textures.count { it != 0 }

    fun texture(atlas: Int): Int = textures[atlas]

    fun request(atlas: Int) {
        if (textures[atlas] == 0 && !pending[atlas]) {
            pending[atlas] = true
            loader.load(animation, generation, atlas)
        }
    }

    fun touch(atlas: Int) {
        lastUsed[atlas] = ++useCounter
    }

    fun accept(atlas: Int, texture: Int, fence: Long, keep: Int) {
        // A wait in the GPU queue. The render thread itself does not block.
        GLES30.glWaitSync(fence, 0, GLES30.GL_TIMEOUT_IGNORED)
        GLES30.glDeleteSync(fence)
        pending[atlas] = false
        textures[atlas] = texture
        touch(atlas)
        evict(keep)
    }

    /** After this, only [keep] stays on the GPU, and the cache streams with its smallest size. */
    fun trim(keep: Int) {
        resident = false
        capacity = MIN_CAPACITY.coerceAtMost(atlases.size)
        for (atlas in textures.indices) {
            if (atlas != keep) {
                delete(atlas)
            }
        }
    }

    /** Undoes [trim]. Loading what is missing is up to the caller. */
    fun restore() {
        resident = fitsBudget
        capacity = budgetCapacity
    }

    fun deleteAll() {
        for (atlas in textures.indices) {
            delete(atlas)
        }
    }

    private fun evict(keep: Int) {
        while (loadedCount > capacity) {
            var oldest = -1
            for (atlas in textures.indices) {
                if (textures[atlas] != 0 && atlas != keep && (oldest == -1 || lastUsed[atlas] < lastUsed[oldest])) {
                    oldest = atlas
                }
            }
            if (oldest == -1) {
                return
            }
            delete(oldest)
        }
    }

    private fun delete(atlas: Int) {
        if (textures[atlas] != 0) {
            scratch[0] = textures[atlas]
            GLES30.glDeleteTextures(1, scratch, 0)
            textures[atlas] = 0
        }
    }

    private companion object {
        const val MIN_CAPACITY = 2
    }
}
