import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import type {WanimCanvas} from './fit-frame';
import {fitFrame} from './fit-frame';
import type {
	WanimLayerBitmap,
	WanimLayerDrawInput,
	WanimLayeredAnimation,
} from './pack-layers';

// Turns rendered frames into an animation that draws one trimmed picture per
// frame. Frames with the same pixels share a picture.
export const readFramesAsAnimation = async ({
	framePaths,
	fps,
	canvas,
	onProgress,
}: {
	// PNG files, in playback order
	framePaths: string[];
	fps: number;
	// The size of the animation, if it differs from the size of the frames
	canvas: WanimCanvas | null;
	onProgress: ((progress: number) => void) | null;
}): Promise<WanimLayeredAnimation> => {
	if (framePaths.length === 0) {
		throw new Error('Cannot create a .wanim file without frames');
	}

	const bitmaps: WanimLayerBitmap[] = [];
	const bitmapOfPixels = new Map<string, number>();
	// The same file is often passed for many frames
	const drawsOfPath = new Map<string, WanimLayerDrawInput[]>();
	const frames: WanimLayerDrawInput[][] = [];
	let width = 0;
	let height = 0;
	for (const [frameIndex, framePath] of framePaths.entries()) {
		const known = drawsOfPath.get(framePath);
		if (known) {
			frames.push(known);
			continue;
		}

		const source = PNG.sync.read(await readFile(framePath));
		const png = canvas === null ? source : fitFrame(source, canvas);
		if (frameIndex === 0) {
			width = png.width;
			height = png.height;
		} else if (png.width !== width || png.height !== height) {
			throw new Error(
				`All frames must have the same size, but ${framePath} is ${png.width}x${png.height} instead of ${width}x${height}`,
			);
		}

		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (png.data[(y * width + x) * 4 + 3] === 0) {
					continue;
				}

				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}

		let draws: WanimLayerDrawInput[] = [];
		if (maxX !== -1) {
			const trimmed = new PNG({
				width: maxX - minX + 1,
				height: maxY - minY + 1,
			});
			PNG.bitblt(png, trimmed, minX, minY, trimmed.width, trimmed.height, 0, 0);
			const pixels = createHash('sha256')
				.update(`${trimmed.width}x${trimmed.height}:`)
				.update(trimmed.data)
				.digest('base64');
			let bitmap = bitmapOfPixels.get(pixels);
			if (bitmap === undefined) {
				bitmap = bitmaps.length;
				bitmapOfPixels.set(pixels, bitmap);
				bitmaps.push({
					width: trimmed.width,
					height: trimmed.height,
					// Only kept until the atlases are made
					png: new Uint8Array(PNG.sync.write(trimmed, {deflateLevel: 1})),
				});
			}

			draws = [{bitmap, matrix: [1, 0, 0, 1, minX, minY], alpha: 1}];
		}

		drawsOfPath.set(framePath, draws);
		frames.push(draws);
		onProgress?.((frameIndex + 1) / framePaths.length);
	}

	return {width, height, fps, frames, bitmaps};
};
