// Regenerates the version 3 fixtures: sample-animations.wanim,
// sample-animations-custom-key.wanim, sample-animations-webp.wanim,
// expected-animations.json and the reference frames
// animations-<key>-<n>.png, which show what a player draws. Run from
// packages/wanim: bun fixtures/generate-animations.ts
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {PNG} from 'pngjs';
import sharp from 'sharp';
import type {WanimAnimationsManifest, WanimDraw} from '../src/format';
import {openWanim} from '../src/open-wanim';
import type {
	WanimAnimationSet,
	WanimAtlasFormat,
} from '../src/pack-animations';
import {packWanimAnimations} from '../src/pack-animations';
import type {WanimLayerDrawInput} from '../src/pack-layers';
import {drawLayersFrame} from './reference-renderer';

const customKey =
	'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

const bitmap = (
	width: number,
	height: number,
	paint: (x: number, y: number) => [number, number, number, number],
) => {
	const png = new PNG({width, height});
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			png.data.set(paint(x, y), (y * width + x) * 4);
		}
	}

	return {width, height, png: new Uint8Array(PNG.sync.write(png))};
};

const turn = (degrees: number, x: number, y: number, size: number) => {
	const r = (degrees * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	// Turns around the center of the bitmap, then moves it to x, y
	return [
		c,
		s,
		-s,
		c,
		x - (c * size - s * size) / 2,
		y - (s * size + c * size) / 2,
	] as [number, number, number, number, number, number];
};

const star = (x: number, y: number): [number, number, number, number] =>
	Math.abs(x - 2) + Math.abs(y - 2) <= 2 ? [255, 230, 80, 255] : [0, 0, 0, 0];

// What `idle` shows, and where `transition_in` ends and `transition_out` starts
const badge: WanimLayerDrawInput = {
	bitmap: 0,
	matrix: [1, 0, 0, 1, 26, 18],
	alpha: 1,
};
const bar: WanimLayerDrawInput = {
	bitmap: 1,
	matrix: [1, 0, 0, 1, 22, 36],
	alpha: 1,
};

// A badge with a gradient flies in, idles with a star that blinks, and fades
// out. All 3 animations draw from the same 3 pictures.
const set: WanimAnimationSet = {
	width: 64,
	height: 48,
	fps: 12,
	bitmaps: [
		bitmap(12, 12, (x, y) => [255, x * 20, y * 20, 255]),
		bitmap(20, 6, () => [40, 120, 255, 160]),
		bitmap(5, 5, star),
		// The same pixels as bitmap 2: Stored once
		bitmap(5, 5, star),
	],
	animations: [
		{
			key: 'transition_in',
			loop: false,
			frames: [
				// Starts empty
				[],
				[{bitmap: 0, matrix: turn(60, 8, 24, 12), alpha: 0.5}],
				[
					{bitmap: 0, matrix: turn(30, 20, 24, 12), alpha: 0.75},
					{bitmap: 1, matrix: [0.5, 0, 0, 1, 27, 36], alpha: 0.5},
				],
				[badge, bar],
			],
		},
		{
			key: 'idle',
			loop: true,
			frames: [
				[badge, bar],
				[badge, bar, {bitmap: 2, matrix: [1, 0, 0, 1, 44, 8], alpha: 1}],
				// Held
				[badge, bar, {bitmap: 2, matrix: [1, 0, 0, 1, 44, 8], alpha: 1}],
				[
					badge,
					bar,
					{bitmap: 3, matrix: [2, 0, 0, 2, 40, 4], alpha: 0.5},
					{bitmap: 3, matrix: [1, 0, 0, 1, 12, 8], alpha: 1},
				],
			],
		},
		{
			key: 'transition_out',
			loop: false,
			frames: [
				[badge, bar],
				[
					{bitmap: 0, matrix: [1, 0, 0, 1, 26, 18], alpha: 0.5},
					{bitmap: 1, matrix: [1.5, 0, 0, 1, 17, 36], alpha: 0.5},
				],
				// Partly outside of the canvas, flipped
				[{bitmap: 0, matrix: [-1, 0, 0, 1, 70, 40], alpha: 0.25}],
			],
		},
	],
};

const pack = (key: string | null, atlasFormat: WanimAtlasFormat) =>
	packWanimAnimations({
		set,
		key,
		compositionId: 'sample-animations',
		atlasSize: null,
		compression: 'none',
		atlasFormat,
		onProgress: null,
	});

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

// The atlases as straight alpha RGBA pixels, whatever their format
const decodeAtlases = (file: Uint8Array) => {
	const opened = openWanim({file, key: null});
	return Promise.all(
		opened.manifest.atlases.map(async ({format}, index) => {
			const bytes = opened.readAtlas(index);
			if (format === 'png') {
				return PNG.sync.read(Buffer.from(bytes));
			}

			const {data, info} = await sharp(bytes)
				.ensureAlpha()
				.raw()
				.toBuffer({resolveWithObject: true});
			const png = new PNG({width: info.width, height: info.height});
			png.data.set(data);
			// A WebP encoder is free to change the color of invisible pixels
			for (let i = 0; i < png.data.length; i += 4) {
				if (png.data[i + 3] === 0) {
					png.data.fill(0, i, i + 3);
				}
			}

			return png;
		}),
	);
};

const {file} = await pack(null, 'png');
const {file: customKeyFile} = await pack(customKey, 'png');
const {file: webpFile} = await pack(null, 'webp');
writeFileSync(path.join(import.meta.dir, 'sample-animations.wanim'), file);
writeFileSync(
	path.join(import.meta.dir, 'sample-animations-custom-key.wanim'),
	customKeyFile,
);
writeFileSync(
	path.join(import.meta.dir, 'sample-animations-webp.wanim'),
	webpFile,
);

const opened = openWanim({file, key: null});
const manifest = opened.manifest as WanimAnimationsManifest;
const scene = opened.readScene();
const atlases = manifest.atlases.map((_, index) => opened.readAtlas(index));
const pixels = await decodeAtlases(file);
const webp = openWanim({file: webpFile, key: null});
const webpPixels = await decodeAtlases(webpFile);

const frameSha256: Record<string, string[]> = {};
for (const {key} of manifest.animations) {
	const timeline = (scene.frames[key] as number[]).map((list) =>
		(scene.lists[list] as number[]).map((draw) => scene.draws[draw] as WanimDraw),
	);
	frameSha256[key] = timeline.map((_, frame) => {
		const png = drawLayersFrame({manifest, timeline, atlases, frame});
		const fromWebp = drawLayersFrame({
			manifest,
			timeline,
			atlases: webpPixels.map((atlas) => new Uint8Array(PNG.sync.write(atlas))),
			frame,
		});
		if (!png.data.equals(fromWebp.data)) {
			throw new Error('The WebP file does not draw the same pixels');
		}

		writeFileSync(
			path.join(import.meta.dir, `animations-${key}-${frame}.png`),
			PNG.sync.write(png),
		);
		return sha256(png.data);
	});
}

writeFileSync(
	path.join(import.meta.dir, 'expected-animations.json'),
	`${JSON.stringify(
		{
			customKey,
			manifest,
			atlasSha256: atlases.map(sha256),
			// SHA-256 of the atlases as straight alpha RGBA pixels, with invisible
			// pixels set to 0
			atlasPixelsSha256: pixels.map((atlas) => sha256(atlas.data)),
			// sample-animations-webp.wanim: The same pixels and scene
			webp: {
				manifest: webp.manifest,
				atlasSha256: webp.manifest.atlases.map((_, index) =>
					sha256(webp.readAtlas(index)),
				),
				atlasPixelsSha256: webpPixels.map((atlas) => sha256(atlas.data)),
			},
			// Values as stored, as f32
			scene,
			// Per animation, the SHA-256 of the RGBA pixels of
			// animations-<key>-<n>.png
			frameSha256,
		},
		null,
		'\t',
	)}\n`,
);
