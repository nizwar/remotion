package dev.remotion.wanim.internal

import java.security.GeneralSecurityException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import dev.remotion.wanim.WanimException

internal object WanimCrypto {
    private const val TAG_BITS = 128
    private const val SHA256_LENGTH = 32

    // RFC 5869 with an output of a single hash length, so one expand round is enough
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val pseudoRandomKey = mac.doFinal(ikm)
        mac.init(SecretKeySpec(pseudoRandomKey, "HmacSHA256"))
        mac.update(info)
        mac.update(1)
        return mac.doFinal().also { check(it.size == SHA256_LENGTH) }
    }

    fun decryptBlock(key: SecretKeySpec, nonce: ByteArray, aad: ByteArray, block: ByteArray): ByteArray {
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, nonce))
            cipher.updateAAD(aad)
            return cipher.doFinal(block)
        } catch (e: AEADBadTagException) {
            throw WanimException.WrongKeyOrTampered(
                "Could not decrypt .wanim file: The key is wrong or the file was modified.",
                e,
            )
        } catch (e: GeneralSecurityException) {
            throw WanimException.WrongKeyOrTampered("Could not decrypt .wanim file: ${e.message}", e)
        }
    }

    fun parseKey(hex: String): ByteArray {
        val trimmed = hex.trim()
        require(trimmed.length == 64 && trimmed.all { Character.digit(it, 16) >= 0 }) {
            "A .wanim key must be 64 hexadecimal characters (32 bytes)."
        }
        return ByteArray(32) { index ->
            val high = Character.digit(trimmed[index * 2], 16)
            val low = Character.digit(trimmed[index * 2 + 1], 16)
            ((high shl 4) or low).toByte()
        }
    }
}
