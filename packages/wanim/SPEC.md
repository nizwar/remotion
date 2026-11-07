# The `.wanim` format, version 1

A `.wanim` file is an encrypted sprite animation: one or more texture atlases, plus a JSON manifest that says which part of which atlas to draw for each frame. Official players open every official file without any setup, and other tools cannot read anything but the header below.

All integers are little-endian. The files in [`fixtures/`](./fixtures) are the conformance test: `sample.wanim` uses the official key, `sample-custom-key.wanim` uses `expected.json.customKey`, and `sample-compressed.wanim` holds indexed PNG atlases with the same frames. For the first two, a correct reader reproduces `expected.json.manifest`, and the SHA-256 of each decrypted atlas matches `expected.json.atlasSha256`.

## File layout

| Offset | Size | Field                                                       |
| ------ | ---- | ----------------------------------------------------------- |
| 0      | 8    | Magic: `89 57 41 4E 49 4D 0D 0A`                            |
| 8      | 2    | `u16` format version, currently `1`                         |
| 10     | 2    | `u16` flags: Bit 0 is set if the file uses a custom key     |
| 12     | 4    | `u32` `manifestLength`: Size of block 0, including its tag  |
| 16     | 16   | `salt`                                                      |
| 32     | 8    | `noncePrefix`                                               |
| 40     | ...  | Block 0: Encrypted manifest                                 |
| ...    | ...  | Data section, starts at `40 + manifestLength`: Atlas blocks |

Reject a file if the magic or version differ.

Block `i + 1` holds atlas `i`. Its position is `40 + manifestLength + atlases[i].offset`, and its size is `atlases[i].length`. Blocks are encrypted separately, so that a reader can read the manifest and then decrypt only the atlas it needs next.

## Decryption

The key is 32 bytes, usually written as 64 hexadecimal characters.

If bit 0 of the flags is not set, the file uses the official key, which is `WANIM_OFFICIAL_KEY` in [`src/official-key.ts`](./src/official-key.ts). Official players have it built in. If the bit is set, the app has to provide the key of that file. Reject files with any other flag set.

1. Derive the key of this file: `fileKey = HKDF-SHA256(ikm = key, salt = salt, info = "wanim/v1/aes-256-gcm", length = 32)`
2. Each block is `ciphertext || tag`, with a 16 byte tag at the end. Decrypt it using AES-256-GCM:
   - `nonce = noncePrefix || u32(blockIndex)`, 12 bytes
   - `aad = header || u32(blockIndex)`, where `header` is the first 40 bytes of the file

A failed tag check means that the key is wrong or the file was modified. Never use the output of a block that failed.

## Manifest

Block 0 decrypts to UTF-8 JSON. Ignore unknown fields.

```json
{
	"version": 1,
	"compositionId": "ball",
	"width": 400,
	"height": 300,
	"fps": 30,
	"frameCount": 60,
	"opaque": false,
	"gpuBytes": 1962176,
	"atlases": [
		{"offset": 0, "length": 398256, "width": 1978, "height": 248, "format": "png"}
	],
	"sprites": [[0, 2, 2, 80, 80, 20, 100]],
	"frames": [0, 0, -1]
}
```

| Field                     | Meaning                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `width`, `height`         | Size of the canvas in pixels                                                                        |
| `fps`                     | Playback speed, may be fractional                                                                   |
| `frames`                  | One entry per frame: An index into `sprites`, or `-1` for an empty frame                            |
| `sprites`                 | `[atlas, x, y, w, h, dx, dy]`: Copy the rectangle `x, y, w, h` of `atlas` to `dx, dy` on the canvas |
| `opaque`                  | Every frame covers the whole canvas with fully opaque pixels                                        |
| `gpuBytes`                | Memory of all atlases as RGBA8 textures                                                             |
| `atlases[].format`        | `png`: Any 8 bit PNG with straight alpha, sRGB                                                         |

`x` and `y` count from the top left corner. Atlas sizes are at most 4096, are not powers of two, and sprites have a transparent gutter of 2 pixels. A sprite may be shared by many frames, and several sprites may point to the same rectangle.

## Rendering on the GPU

Each atlas is one texture, and each frame is one textured quad: one draw call, no CPU pixel work during playback.

Textures:

- Premultiply alpha when decoding, and upload RGBA8. Filtering straight alpha creates dark fringes.
- Use linear filtering, clamp to edge, no mipmaps.
- Do not use an sRGB texture or render target format: Colors are blended as stored, as the browser does.

Drawing frame `f`:

1. Clear to transparent, or to the background of the host view.
2. If `frames[f]` is `-1`, stop here.
3. `scale` and `origin` map the canvas into the view, depending on the fit mode. The quad is at `origin + (dx, dy) * scale`, with size `(w, h) * scale`.
4. Texture coordinates go from `(x, y) / atlasSize` to `(x + w, y + h) / atlasSize`. If `scale` is not 1, move each edge inwards by half a texel so that sampling stays inside of the sprite.
5. Blend with `src = ONE, dst = ONE_MINUS_SRC_ALPHA`, or disable blending if `opaque` is true.

Playback:

- Derive the frame from a monotonic clock: `f = floor(elapsedSeconds * fps) % frameCount`. Do not add 1 per tick: Timing would depend on the display rate and drift whenever a tick is late. Late frames are skipped.
- Run on the display's vsync callback. If `frames[f]` is the same sprite as the frame on screen, skip the draw entirely. Many animations hold a frame or are slower than the display.
- Stop the vsync callback while paused, finished, off screen or in the background.
- Never decrypt or decode on the render thread or UI thread.

Memory:

- If `gpuBytes` fits the budget of the player (default 192 MB), decode all atlases before reporting ready. Playback then does no work besides drawing.
- Otherwise stream: Atlases are in playback order, so while atlas `n` is on screen, prepare atlas `n + 1` (wrapping around when looping) on a background thread. Keep a small LRU of textures. If an atlas is not ready in time, hold the last frame and do not block.
- Keep only the encrypted file in memory, or better a memory map of it. Decrypted PNG bytes can be released once they are decoded.
- Texture memory is the limit, not file size: A 1 MB file can need 40 MB on the GPU.
