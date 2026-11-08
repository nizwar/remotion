# The `.wanim` format, versions 1 and 2

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

Reject a file if the magic differs or the version is not 1 or 2. Version 1 stores one sprite per frame. Version 2 stores a list of transformed sprites per frame ("layers"), see [Version 2](#version-2-layers). Header, encryption and atlases are the same in both.

Block `i + 1` holds atlas `i`. Its position is `40 + manifestLength + atlases[i].offset`, and its size is `atlases[i].length`. Blocks are encrypted separately, so that a reader can read the manifest and then decrypt only the atlas it needs next.

## Decryption

The key is 32 bytes, usually written as 64 hexadecimal characters.

If bit 0 of the flags is not set, the file uses the official key, which every official player has built in. Its source is `packages/wanim/src/official-key.ts` in the Remotion fork. If the bit is set, the app has to provide the key of that file. Reject files with any other flag set.

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
- Use linear filtering, clamp to edge, no mipmaps. Use nearest filtering when drawing 1:1 on whole pixels, as some GPUs are not exact at texel centers.
- Do not use an sRGB texture or render target format: Colors are blended as stored, as the browser does.

Drawing frame `f`:

1. Clear to transparent, or to the background of the host view.
2. If `frames[f]` is `-1`, stop here.
3. `scale` and `origin` map the canvas into the view, depending on the fit mode. The quad is at `origin + (dx, dy) * scale`, with size `(w, h) * scale`.
4. Texture coordinates go from `(x, y) / atlasSize` to `(x + w, y + h) / atlasSize`. If `scale` is not 1, move each edge inwards by slightly more than half a texel (`0.5 + 1/64`) so that sampling stays inside of the sprite: Some GPUs read a neighboring texel when sampling exactly on a texel center.
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

## Version 2: Layers

A part of the animation that only moves, turns, scales or fades is stored once, and drawn with a matrix in every frame. Parts that change their look get one sprite per look. The fixtures are `sample-layers.wanim` (official key) and `sample-layers-custom-key.wanim`. `expected-layers.json` holds the manifest, the SHA-256 of each atlas, the decoded timeline, and the SHA-256 of the pixels of `layers-frame-<n>.png`, which show what a player draws for each frame (computed by `fixtures/reference-renderer.ts`).

### Manifest

```json
{
	"version": 2,
	"compositionId": "sample-layers",
	"width": 64,
	"height": 48,
	"fps": 12,
	"frameCount": 6,
	"opaque": false,
	"gpuBytes": 3672,
	"atlases": [{"offset": 0, "length": 270, "width": 51, "height": 18, "format": "png"}],
	"sprites": [[0, 2, 2, 14, 14], [0, 18, 2, 22, 8], [0, 42, 2, 7, 7]],
	"timeline": {"offset": 270, "length": 428, "draws": 12}
}
```

| Field      | Meaning                                                                               |
| ---------- | ------------------------------------------------------------------------------------- |
| `sprites`  | `[atlas, x, y, w, h]`: A rectangle of an atlas. There is no offset, the matrix places it |
| `timeline` | Position and size of the timeline block in the data section, and the number of draws |

Blocks: `0` is the manifest, `i + 1` is atlas `i`, and the timeline is block `atlases.length + 1`, at `40 + manifestLength + timeline.offset`.

Each sprite has a transparent border of 1 pixel inside of its rectangle, and sprites are 2 pixels apart. Sample with the exact rectangle, there is no inset like in version 1: The border fades a transformed edge to transparent.

### Timeline

The decrypted timeline is binary, little-endian:

1. `u32 frameStart[frameCount + 1]`: The draws of frame `f` are `frameStart[f]` to `frameStart[f + 1] - 1`. `frameStart[frameCount]` equals `timeline.draws`.
2. `timeline.draws` draws of 32 bytes each:

| Offset | Type  | Field                                     |
| ------ | ----- | ----------------------------------------- |
| 0      | `u32` | Index into `sprites`                      |
| 4      | `f32` | `a`                                       |
| 8      | `f32` | `b`                                       |
| 12     | `f32` | `c`                                       |
| 16     | `f32` | `d`                                       |
| 20     | `f32` | `tx`                                      |
| 24     | `f32` | `ty`                                      |
| 28     | `f32` | `alpha`, from 0 to 1                      |

Reject a timeline whose size is not `(frameCount + 1) * 4 + draws * 32`, or whose `frameStart` decreases.

The matrix maps a point of the sprite, `(0, 0)` to `(w, h)`, to a point of the canvas:

```
x' = a * x + c * y + tx
y' = b * x + d * y + ty
```

A frame can have no draws, which is an empty frame. Draws are in order, from back to front.

### Rendering version 2

Textures are set up as in version 1 (premultiplied, linear filtering, clamp to edge, no mipmaps, no sRGB).

Drawing frame `f`:

1. Clear to transparent, or to the background of the host view.
2. Map the canvas into the view with `scale` and `origin` as in version 1, and clip to the canvas: Draws may reach outside of it. A scissor rectangle does this for free.
3. For each draw, transform the 4 corners of its sprite with its matrix, then with `scale` and `origin`. Texture coordinates go from `(x, y) / atlasSize` to `(x + w, y + h) / atlasSize`.
4. Multiply the sampled color by `alpha`, all 4 channels, as it is premultiplied.
5. Blend with `src = ONE, dst = ONE_MINUS_SRC_ALPHA`, or disable blending if `opaque` is true.

Put all draws of a frame into one vertex buffer and issue one draw call per run of draws that use the same atlas. Use nearest filtering only if a matrix is a whole pixel translation and `scale` is 1, otherwise linear.

Playback is the same as in version 1. Skip the draw if the draws of the frame on screen are equal to those of the next frame, for example by comparing the byte ranges of the 2 frames once when loading.

Memory: `gpuBytes` and the budget work the same. When streaming, prepare the atlases that the draws of the upcoming frames use. Atlases are in the order in which they are first used.
