// Draws a frame of a version 2 or 3 file on the CPU, the way the spec describes it
// for the GPU: premultiplied alpha, bilinear sampling inside of the sprite,
// blending with ONE, ONE_MINUS_SRC_ALPHA. Returns straight alpha pixels.
import {PNG} from 'pngjs';
import type {WanimDraw, WanimLayerSprite} from '../src/format';

export const drawLayersFrame = ({
	manifest,
	timeline,
	atlases,
	frame,
}: {
	manifest: {width: number; height: number; sprites: WanimLayerSprite[]};
	// The draws of each frame
	timeline: WanimDraw[][];
	// As PNG files
	atlases: Uint8Array[];
	frame: number;
}) => {
	const textures = atlases.map((bytes) => {
		const png = PNG.sync.read(Buffer.from(bytes));
		const premultiplied = new Float64Array(png.width * png.height * 4);
		for (let i = 0; i < png.width * png.height; i++) {
			const a = (png.data[i * 4 + 3] as number) / 255;
			for (let c = 0; c < 3; c++) {
				premultiplied[i * 4 + c] = ((png.data[i * 4 + c] as number) / 255) * a;
			}

			premultiplied[i * 4 + 3] = a;
		}

		return {width: png.width, data: premultiplied};
	});
	const {width, height} = manifest;
	const canvas = new Float64Array(width * height * 4);
	for (const draw of timeline[frame] ?? []) {
		const [atlas, sx, sy, sw, sh] = manifest.sprites[draw.sprite] as number[];
		const texture = textures[atlas as number] as (typeof textures)[number];
		const [a, b, c, d, tx, ty] = draw.matrix;
		const det = a * d - b * c;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				// The pixel center, back in sprite space
				const px = x + 0.5 - tx;
				const py = y + 0.5 - ty;
				const u = (d * px - c * py) / det;
				const v = (-b * px + a * py) / det;
				if (u < 0 || v < 0 || u > (sw as number) || v > (sh as number)) {
					continue;
				}

				const fx0 = (sx as number) + u - 0.5;
				const fy0 = (sy as number) + v - 0.5;
				const ix = Math.floor(fx0);
				const iy = Math.floor(fy0);
				const fx = fx0 - ix;
				const fy = fy0 - iy;
				const sample = [0, 0, 0, 0];
				for (const [ox, oy, weight] of [
					[0, 0, (1 - fx) * (1 - fy)],
					[1, 0, fx * (1 - fy)],
					[0, 1, (1 - fx) * fy],
					[1, 1, fx * fy],
				] as const) {
					const index = ((iy + oy) * texture.width + ix + ox) * 4;
					for (let ch = 0; ch < 4; ch++) {
						sample[ch] += weight * (texture.data[index + ch] ?? 0);
					}
				}

				const out = (y * width + x) * 4;
				const sourceAlpha = (sample[3] as number) * draw.alpha;
				for (let ch = 0; ch < 4; ch++) {
					canvas[out + ch] =
						(sample[ch] as number) * draw.alpha +
						(canvas[out + ch] as number) * (1 - sourceAlpha);
				}
			}
		}
	}

	const png = new PNG({width, height});
	for (let i = 0; i < width * height; i++) {
		const alpha = canvas[i * 4 + 3] as number;
		for (let ch = 0; ch < 3; ch++) {
			png.data[i * 4 + ch] =
				alpha === 0
					? 0
					: Math.round(((canvas[i * 4 + ch] as number) / alpha) * 255);
		}

		png.data[i * 4 + 3] = Math.round(alpha * 255);
	}

	return png;
};
