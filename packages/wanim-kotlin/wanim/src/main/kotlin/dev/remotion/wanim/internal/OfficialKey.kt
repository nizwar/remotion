package dev.remotion.wanim.internal

// The key is masked so that it does not appear as a searchable constant in the
// compiled library. Callers own the returned bytes and should clear them.
internal object OfficialKey {
    private const val SEED = 0x30BBCE35.toInt()

    private val MASKED = intArrayOf(
        0x95, 0x9B, 0x0C, 0x12, 0xE7, 0xA9, 0x52, 0x65,
        0x82, 0x0A, 0xE4, 0x43, 0x7E, 0xF1, 0x56, 0x89,
        0xBD, 0x37, 0xB4, 0xCE, 0xBC, 0x48, 0xC7, 0x13,
        0xD9, 0x23, 0x36, 0xAE, 0x3A, 0x74, 0x72, 0xB4,
    )

    fun bytes(): ByteArray {
        var state = SEED
        return ByteArray(MASKED.size) { index ->
            state = state xor (state shl 13)
            state = state xor (state ushr 17)
            state = state xor (state shl 5)
            (MASKED[index] xor ((state ushr 11) and 0xFF)).toByte()
        }
    }
}
