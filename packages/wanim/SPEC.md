# The `.wanim` format, versions 1, 2 and 3

A `.wanim` file is an encrypted sprite animation: one or more texture atlases, plus a JSON manifest that says which part of which atlas to draw for each frame. Official players open every official file without any setup, and other tools cannot read anything but the header below.

All integers are little-endian. The files in [`fixtures/`](./fixtures) are the conformance test: `sample.wanim` uses the official key, `sample-custom-key.wanim` uses `expected.json.customKey`, and `sample-compressed.wanim` holds indexed PNG atlases with the same frames. For the first two, a correct reader reproduces `expected.json.manifest`, and the SHA-256 of each decrypted atlas matches `expected.json.atlasSha256`.

## File layout

| Offset | Size | Field                                                       |
| ------ | ---- | ----------------------------------------------------------- |
| 0      | 8    | Magic: `89 57 41 4E 49 4D 0D 0A`                            |
| 8      | 2    | `u16` format version: `1`, `2` or `3`                       |
| 10     | 2    | `u16` flags: Bit 0 is set if the file uses a custom key     |
| 12     | 4    | `u32` `manifestLength`: Size of block 0, including its tag  |
| 16     | 16   | `salt`                                                      |
| 32     | 8    | `noncePrefix`                                               |
| 40     | ...  | Block 0: Encrypted manifest                                 |
| ...    | ...  | Data section, starts at `40 + manifestLength`: Atlas blocks |

Reject a file if the magic differs or the version is not 1, 2 or 3. Version 1 stores one sprite per frame. Version 2 stores a list of transformed sprites per frame ("layers"), see [Version 2](#version-2-layers). Version 3 stores several animations that are played by key and share their sprites, see [Version 3](#version-3-animations). Header and encryption are the same in all of them.

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

## Version 3: Animations

One file holds several animations, each with a key, for example `transition_in`, `idle` and `transition_out`. They draw from the same sprites, so a picture that 2 animations show is stored once, and the app plays an animation by its key. A file with one animation is the replacement of versions 1 and 2: A frame of version 1 is a frame with one draw.

Compared to version 2:

- Animations with keys, which share atlases, sprites, draws and frames.
- Every different draw and every different frame is stored once. A layer that stands still costs 4 bytes per frame instead of 32, and a held frame costs 4 bytes.
- The manifest and the scene are deflated before they are encrypted.
- Atlases may be WebP, which is smaller than PNG at the same pixels.
- Sprites touch each other on the atlas, and each atlas is as small as its sprites allow.
- Atlases are grouped by the animations that use them, so a player can drop the textures of animations that it does not play.

The fixtures are `sample-animations.wanim` (official key, PNG atlases), `sample-animations-custom-key.wanim` and `sample-animations-webp.wanim` (the same pixels in WebP atlases). `expected-animations.json` holds the manifest, the SHA-256 of each atlas, the SHA-256 of the pixels of each atlas (straight alpha RGBA, invisible pixels set to 0), the decoded scene, and per animation the SHA-256 of the pixels of `animations-<key>-<n>.png`, which show what a player draws for frame `n` of the animation `key` (computed by `fixtures/reference-renderer.ts`).

### Blocks

Block 0 and the scene are compressed: The decrypted block is a raw DEFLATE stream (RFC 1951, no zlib or gzip header). Atlases are not compressed again.

- Block `0`: The deflated manifest. Stop inflating after 64 MB and reject the file.
- Block `i + 1`: Atlas `i`, as in versions 1 and 2.
- Block `atlases.length + 1`: The deflated scene, at `40 + manifestLength + scene.offset`. Its inflated size follows from the manifest, see below. Stop inflating at that size and reject the file if the stream holds more or less.

### Manifest

```json
{
	"version": 3,
	"compositionId": "sample-animations",
	"width": 64,
	"height": 48,
	"fps": 12,
	"frameCount": 11,
	"opaque": false,
	"gpuBytes": 2132,
	"atlases": [
		{"offset": 0, "length": 189, "width": 22, "height": 22, "format": "png"},
		{"offset": 189, "length": 130, "width": 7, "height": 7, "format": "png"}
	],
	"sprites": [[0, 0, 0, 14, 14], [0, 0, 14, 22, 8], [1, 0, 0, 7, 7]],
	"animations": [
		{"key": "transition_in", "frameCount": 4, "loop": false, "atlases": [0]},
		{"key": "idle", "frameCount": 4, "loop": true, "atlases": [0, 1]},
		{"key": "transition_out", "frameCount": 3, "loop": false, "atlases": [0]}
	],
	"scene": {"offset": 319, "length": 179, "draws": 11, "lists": 8, "items": 15}
}
```

| Field                    | Meaning                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `frameCount`             | Frames of all animations together                                                                    |
| `atlases[].format`       | `png`, or `webp`: Any WebP with straight alpha, lossless or lossy                                    |
| `sprites`                | `[atlas, x, y, w, h]`, as in version 2                                                               |
| `animations`             | At least one. Their frames follow each other in the scene, in this order                             |
| `animations[].key`       | 1 to 64 characters of `A-Z a-z 0-9 _ . -`, unique in the file                                        |
| `animations[].frameCount`| At least 1                                                                                           |
| `animations[].loop`      | Whether the animation is meant to repeat. The default of a player, which the app can override        |
| `animations[].atlases`   | The atlases that the draws of this animation use, ascending                                          |
| `scene`                  | Position and size of the scene block, and the sizes of its tables                                    |

`width`, `height`, `fps`, `opaque` and `gpuBytes` are as before and count for all animations. A file that was exported without keys has one animation with the key `main`.

Reject a manifest whose `version` is not 3, whose keys are not unique or do not match the pattern, whose `frameCount` values are not at least 1 or do not add up to `frameCount`, or whose `animations[].atlases` name an atlas that does not exist.

Each sprite has a transparent border of 1 pixel inside of its rectangle, as in version 2. Sprites are not apart: The borders of 2 neighbors are the 2 transparent pixels between their pictures. Sample with the exact rectangle.

A WebP encoder may give invisible pixels any color. Premultiplying when decoding, which is required anyway, makes them transparent black.

### Scene

The inflated scene is binary, little-endian. With `D = scene.draws`, `L = scene.lists`, `I = scene.items` and `F = frameCount`, its size is `D * 32 + (L + 1) * 4 + I * 4 + F * 4`:

| Part | Type                 | Meaning                                                                                  |
| ---- | -------------------- | ---------------------------------------------------------------------------------------- |
| 1    | `u32 sprite[D]`      | Index into `sprites`, for each draw                                                      |
| 2    | `f32 a[D]`           | Then `b[D]`, `c[D]`, `d[D]`, `tx[D]`, `ty[D]` and `alpha[D]`: One array per field        |
| 3    | `u32 listStart[L+1]` | The draws of list `l` are `items[listStart[l]]` to `items[listStart[l + 1] - 1]`         |
| 4    | `u32 items[I]`       | Indices into the draws, from back to front                                               |
| 5    | `u32 frames[F]`      | For each frame, an index into the lists. The frames of the first animation come first    |

A draw is a sprite, a matrix and an alpha with the meaning of version 2. A list is what one frame draws, and may be empty. Frame `n` of an animation is `frames[start + n]`, where `start` is the sum of the `frameCount` of the animations before it.

Draws and lists are unique: 2 frames show the same picture exactly if they have the same list index. That makes skipping a draw one integer comparison.

Reject a scene if a sprite index is not below `sprites.length`, if `listStart[0]` is not 0, `listStart` decreases or `listStart[L]` is not `I`, if an item is not below `D`, or if a frame is not below `L`.

Keep the scene as it is in memory: The arrays are small and can be read in place. Do not expand it to a list of draws per frame.

### Rendering version 3

A frame is drawn like a frame of version 2, with the draws of its list. Textures, blending, clipping to the canvas and the choice between nearest and linear filtering are the same.

### Playing version 3

A player plays one animation at a time:

- `play(key)` starts the animation with that key at its first frame. Without a key, the first animation of the file is played. An unknown key is an error that the app gets to know, and the player keeps doing what it did.
- The frame is `floor(elapsedSeconds * fps)`, counted from the start of the animation: With `loop`, modulo its `frameCount`. Without, the animation ends on its last frame, which stays on screen, and the app is told once that the animation with this key has finished.
- `loop` of the manifest is the default. The app can override it for each `play`.
- `play(key, then: nextKey)` plays `key` once, and then `nextKey` with its own `loop`. The first frame of `nextKey` replaces the last frame of `key` at the time that frame would end, so no frame is shown twice or left out, and the canvas is never empty in between. `transition_in` followed by `idle` is the usual case.
- Switching animations does not reload anything that is already loaded, and a file opens with every animation ready to play if it fits the budget.

Do not wake up for nothing:

- Compare the list index of the next frame with the one on screen, and skip the draw if they are equal.
- If the display refreshes more often than `fps`, do not run on every vsync: Ask for a callback at the frame rate of the file where the platform allows it (`preferredFrameRateRange` on iOS), or skip the work of a callback that cannot change the frame before anything else is done.
- When the rest of a non-looping animation, or a whole looping animation, is one list, stop the vsync callback after drawing it. A looping animation of one still picture costs nothing while it is on screen.

### Memory in version 3

`gpuBytes` and the budget work as before, for the whole file. In addition, a player lets the app say which animations it still needs:

- `release(keys)`, or `retain(keys)` for the opposite, drops the textures of the atlases that only the released animations use. `animations[].atlases` says which. An atlas that an animation in use needs is never dropped.
- Playing an animation whose textures were dropped loads them again on a background thread, and keeps the frame on screen until they are ready. The app can load them ahead of time with `prepare(keys)`.

An app that shows `transition_in` once and then `idle` for minutes releases `transition_in` and holds only the atlases of `idle`.

When streaming, prepare the atlases of the animation that is playing and of the one that follows it.
