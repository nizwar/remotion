// Regenerates sample-layers.wanim, sample-layers-custom-key.wanim,
// expected-layers.json and the reference frames layers-frame-<n>.png, which
// show what a player draws. Run from packages/wanim:
// bun fixtures/generate-layers.ts
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {PNG} from 'pngjs';
import type {WanimLayersManifest} from '../src/format';
import {openWanim} from '../src/open-wanim';
import type {WanimLayeredAnimation} from '../src/pack-layers';
import {packWanimLayers} from '../src/pack-layers';
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

// A red square with a gradient turns, a translucent blue bar moves and fades,
// a frame is held, one is empty, and a star is drawn twice
const animation: WanimLayeredAnimation = {
	width: 64,
	height: 48,
	fps: 12,
	bitmaps: [
		bitmap(12, 12, (x, y) => [255, x * 20, y * 20, 255]),
		bitmap(20, 6, () => [40, 120, 255, 160]),
		bitmap(5, 5, (x, y) =>
			Math.abs(x - 2) + Math.abs(y - 2) <= 2
				? [255, 230, 80, 255]
				: [0, 0, 0, 0],
		),
	],
	frames: [
		[{bitmap: 0, matrix: [1, 0, 0, 1, 4, 4], alpha: 1}],
		[
			{bitmap: 0, matrix: turn(30, 16, 16, 12), alpha: 1},
			{bitmap: 1, matrix: [1, 0, 0, 1, 10, 34], alpha: 1},
		],
		[
			{bitmap: 0, matrix: turn(60, 24, 18, 12), alpha: 0.75},
			{bitmap: 1, matrix: [1.5, 0, 0, 1, 20, 34], alpha: 0.5},
			{bitmap: 2, matrix: [1, 0, 0, 1, 50, 6], alpha: 1},
			{bitmap: 2, matrix: [2, 0, 0, 2, 40, 20], alpha: 1},
		],
		// Held
		[
			{bitmap: 0, matrix: turn(60, 24, 18, 12), alpha: 0.75},
			{bitmap: 1, matrix: [1.5, 0, 0, 1, 20, 34], alpha: 0.5},
			{bitmap: 2, matrix: [1, 0, 0, 1, 50, 6], alpha: 1},
			{bitmap: 2, matrix: [2, 0, 0, 2, 40, 20], alpha: 1},
		],
		// Empty
		[],
		// Partly outside of the canvas, flipped
		[{bitmap: 0, matrix: [-1, 0, 0, 1, 70, 40], alpha: 1}],
	],
};

const pack = (key: string | null) =>
	packWanimLayers({
		animation,
		key,
		compositionId: 'sample-layers',
		atlasSize: null,
		compression: 'none',
		onProgress: null,
	});

const {file} = pack(null);
const {file: customKeyFile} = pack(customKey);
writeFileSync(path.join(import.meta.dir, 'sample-layers.wanim'), file);
writeFileSync(
	path.join(import.meta.dir, 'sample-layers-custom-key.wanim'),
	customKeyFile,
);

const opened = openWanim({file, key: null});
const manifest = opened.manifest as WanimLayersManifest;
const timeline = opened.readTimeline();
const atlases = manifest.atlases.map((_, index) => opened.readAtlas(index));
const frameSha256 = timeline.map((_, frame) => {
	const png = drawLayersFrame({manifest, timeline, atlases, frame});
	writeFileSync(
		path.join(import.meta.dir, `layers-frame-${frame}.png`),
		PNG.sync.write(png),
	);
	return createHash('sha256').update(png.data).digest('hex');
});

writeFileSync(
	path.join(import.meta.dir, 'expected-layers.json'),
	`${JSON.stringify(
		{
			customKey,
			manifest,
			atlasSha256: atlases.map((atlas) =>
				createHash('sha256').update(atlas).digest('hex'),
			),
			// Values as stored, as f32
			timeline,
			// SHA-256 of the RGBA pixels of layers-frame-<n>.png
			frameSha256,
		},
		null,
		'\t',
	)}\n`,
);
