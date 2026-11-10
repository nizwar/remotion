import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {PNG} from 'pngjs';
import {readWanimAsSet, rekeyAnimationSet, splitFrames} from '../convert-wanim';
import {generateWanimKey} from '../crypto';
import type {WanimAnimationsManifest, WanimDraw} from '../format';
import {openWanim, readWanimHeader} from '../open-wanim';
import type {WanimAnimationSet} from '../pack-animations';
import {packWanimAnimations} from '../pack-animations';
import {packSprites} from '../pack-sprites';
import {sampleWanimAnimations} from '../sample-frames';

const fixture = (name: string) =>
	new Uint8Array(
		readFileSync(path.join(__dirname, '..', '..', 'fixtures', name)),
	);
const expected = JSON.parse(
	new TextDecoder().decode(fixture('expected-animations.json')),
);

const solid = (
	width: number,
	height: number,
	rgba: [number, number, number, number],
) => {
	const png = new PNG({width, height});
	for (let i = 0; i < width * height; i++) {
		png.data.set(rgba, i * 4);
	}

	return {width, height, png: new Uint8Array(PNG.sync.write(png))};
};

const pack = (set: WanimAnimationSet, key: string | null = null) =>
	packWanimAnimations({
		set,
		key,
		compositionId: 'test',
		atlasSize: null,
		compression: 'none',
		atlasFormat: 'png',
		onProgress: null,
	});

const twoAnimations = (): WanimAnimationSet => ({
	width: 20,
	height: 20,
	fps: 30,
	bitmaps: [
		solid(4, 4, [255, 0, 0, 255]),
		solid(6, 2, [0, 255, 0, 128]),
		// The same pixels as bitmap 0
		solid(4, 4, [255, 0, 0, 255]),
	],
	animations: [
		{
			key: 'in',
			loop: false,
			frames: [
				[{bitmap: 0, matrix: [1, 0, 0, 1, 2, 2], alpha: 0.5}],
				[{bitmap: 0, matrix: [1, 0, 0, 1, 2, 2], alpha: 1}],
			],
		},
		{
			key: 'idle',
			loop: true,
			frames: [
				[
					{bitmap: 2, matrix: [1, 0, 0, 1, 2, 2], alpha: 1},
					{bitmap: 1, matrix: [1, 0, 0, 1, 8, 8], alpha: 1},
				],
				[
					{bitmap: 2, matrix: [1, 0, 0, 1, 2, 2], alpha: 1},
					{bitmap: 1, matrix: [1, 0, 0, 1, 8, 8], alpha: 1},
				],
				[{bitmap: 2, matrix: [1, 0, 0, 1, 2, 2], alpha: 1}],
			],
		},
	],
});

test('the fixtures are read as the expected manifest and scene', () => {
	for (const [name, key] of [
		['sample-animations.wanim', null],
		['sample-animations-custom-key.wanim', expected.customKey],
	] as const) {
		const file = fixture(name);
		expect(readWanimHeader(file).version).toBe(3);
		const opened = openWanim({file, key});
		expect(opened.manifest).toEqual(expected.manifest);
		expect(opened.readScene()).toEqual(expected.scene);
	}

	const webp = openWanim({
		file: fixture('sample-animations-webp.wanim'),
		key: null,
	});
	expect(webp.manifest).toEqual(expected.webp.manifest);
	expect(webp.readScene()).toEqual(expected.scene);
});

test('animations share pictures, draws and frames', async () => {
	const {file, manifest} = await pack(twoAnimations());
	expect(manifest.version).toBe(3);
	expect(manifest.frameCount).toBe(5);
	// Bitmaps 0 and 2 have the same pixels
	expect(manifest.sprites.length).toBe(2);
	expect(manifest.animations).toEqual([
		{key: 'in', frameCount: 2, loop: false, atlases: [0]},
		{key: 'idle', frameCount: 3, loop: true, atlases: [0, 1]},
	]);
	const scene = openWanim({file, key: null}).readScene();
	// The red square at full alpha is one draw for both animations
	expect(scene.draws.length).toBe(3);
	expect(scene.frames).toEqual({in: [0, 1], idle: [2, 2, 1]});
	expect(scene.lists).toEqual([[0], [1], [1, 2]]);
	expect(manifest.scene).toMatchObject({draws: 3, lists: 3, items: 4});
});

test('a sprite keeps a transparent border and the matrix accounts for it', async () => {
	const {file, manifest} = await pack(twoAnimations());
	const [atlas, x, y, w, h] = manifest.sprites[0] as number[];
	expect([w, h]).toEqual([6, 6]);
	const opened = openWanim({file, key: null});
	const png = PNG.sync.read(Buffer.from(opened.readAtlas(atlas as number)));
	const alphaAt = (px: number, py: number) =>
		png.data[(((y as number) + py) * png.width + (x as number) + px) * 4 + 3];
	expect(alphaAt(0, 0)).toBe(0);
	expect(alphaAt(1, 1)).toBe(255);
	expect(alphaAt(5, 5)).toBe(0);
	const draw = opened.readScene().draws[1] as WanimDraw;
	expect(draw.matrix).toEqual([1, 0, 0, 1, 1, 1]);
});

test('invalid animations are rejected', async () => {
	const set = twoAnimations();
	const withKeys = (...keys: string[]) => ({
		...set,
		animations: keys.map((key) => ({...set.animations[0]!, key})),
	});
	await expect(pack(withKeys('a', 'a'))).rejects.toThrow('used twice');
	await expect(pack(withKeys('has space'))).rejects.toThrow('animation key');
	await expect(pack(withKeys(''))).rejects.toThrow('animation key');
	await expect(pack({...set, animations: []})).rejects.toThrow(
		'without animations',
	);
	await expect(
		pack({...set, animations: [{key: 'a', loop: false, frames: []}]}),
	).rejects.toThrow('no frames');
});

test('a custom key is needed to read its file', async () => {
	const key = generateWanimKey();
	const {file} = await pack(twoAnimations(), key);
	expect(readWanimHeader(file).customKey).toBe(true);
	expect(() => openWanim({file, key: null})).toThrow();
	expect(() => openWanim({file, key: generateWanimKey()})).toThrow();
	expect(openWanim({file, key}).manifest.version).toBe(3);
});

test('a modified file is rejected', async () => {
	const {file} = await pack(twoAnimations());
	const broken = new Uint8Array(file);
	broken[broken.length - 20] ^= 1;
	expect(() => openWanim({file: broken, key: null}).readScene()).toThrow();
});

test('an opaque picture covering the canvas turns blending off', async () => {
	const full = solid(20, 20, [10, 20, 30, 255]);
	const set: WanimAnimationSet = {
		width: 20,
		height: 20,
		fps: 30,
		bitmaps: [full],
		animations: [
			{
				key: 'main',
				loop: true,
				frames: [[{bitmap: 0, matrix: [1, 0, 0, 1, 0, 0], alpha: 1}]],
			},
		],
	};
	expect((await pack(set)).manifest.opaque).toBe(true);
	set.animations[0]!.frames.push([]);
	expect((await pack(set)).manifest.opaque).toBe(false);
});

test('older files convert to version 3 with the same draws', async () => {
	const layers = await readWanimAsSet({
		file: fixture('sample-layers.wanim'),
		key: null,
		decodeWebp: null,
	});
	expect(layers.animations.map((a) => a.key)).toEqual(['main']);
	const {file, manifest} = await pack(layers);
	const old = openWanim({file: fixture('sample-layers.wanim'), key: null});
	const scene = openWanim({file, key: null}).readScene();
	const timeline = (scene.frames.main as number[]).map((list) =>
		(scene.lists[list] as number[]).map(
			(draw) => scene.draws[draw] as WanimDraw,
		),
	);
	const oldTimeline = old.readTimeline();
	expect(timeline.length).toBe(oldTimeline.length);
	timeline.forEach((draws, frame) => {
		// The flipped square of the last frame is partly outside, but drawn
		expect(draws.map((d) => [d.matrix, d.alpha])).toEqual(
			(oldTimeline[frame] as WanimDraw[]).map((d) => [d.matrix, d.alpha]),
		);
	});
	expect(manifest.gpuBytes).toBeLessThanOrEqual(old.manifest.gpuBytes);

	const frames = await readWanimAsSet({
		file: fixture('sample.wanim'),
		key: null,
		decodeWebp: null,
	});
	const sample = openWanim({file: fixture('sample.wanim'), key: null}).manifest;
	expect(frames.animations[0]!.frames.length).toBe(sample.frameCount);
	expect((await pack(frames)).manifest.frameCount).toBe(sample.frameCount);
});

test('frames are split into animations by range', async () => {
	const set = await readWanimAsSet({
		file: fixture('sample-layers.wanim'),
		key: null,
		decodeWebp: null,
	});
	const split = rekeyAnimationSet(set, [
		{key: 'in', from: 0, to: 1, loop: false},
		{key: 'idle', from: 2, to: 3, loop: true},
		{key: 'out', from: 4, to: 5, loop: false},
	]);
	const {manifest} = await pack(split);
	expect(
		(manifest as WanimAnimationsManifest).animations.map((a) => [
			a.key,
			a.frameCount,
			a.loop,
		]),
	).toEqual([
		['in', 2, false],
		['idle', 2, true],
		['out', 2, false],
	]);
	expect(() =>
		splitFrames([1, 2, 3], [{key: 'a', from: 2, to: 3, loop: false}]),
	).toThrow('spans');
	expect(splitFrames([1, 2, 3], null)).toEqual([
		{key: 'main', loop: true, frames: [1, 2, 3]},
	]);
});

test('sprites are packed without overlap, within the page', () => {
	const sizes = Array.from({length: 200}, (_, i) => ({
		width: 10 + ((i * 37) % 90),
		height: 10 + ((i * 53) % 70),
	}));
	const {pages, places} = packSprites({sizes, pageSize: 512, padding: 0});
	expect(pages.length).toBeGreaterThan(1);
	// Pages are filled in order
	expect(places.map((p) => p.page)).toEqual(
		[...places.map((p) => p.page)].sort((a, b) => a - b),
	);
	places.forEach((a, i) => {
		const sizeA = sizes[i]!;
		const page = pages[a.page]!;
		expect(a.x + sizeA.width).toBeLessThanOrEqual(page.width);
		expect(a.y + sizeA.height).toBeLessThanOrEqual(page.height);
		expect(page.width).toBeLessThanOrEqual(512);
		expect(page.height).toBeLessThanOrEqual(512);
		for (let j = i + 1; j < places.length; j++) {
			const b = places[j]!;
			const sizeB = sizes[j]!;
			const apart =
				a.page !== b.page ||
				a.x + sizeA.width <= b.x ||
				b.x + sizeB.width <= a.x ||
				a.y + sizeA.height <= b.y ||
				b.y + sizeB.height <= a.y;
			expect(apart).toBe(true);
		}
	});
	expect(() =>
		packSprites({sizes: [{width: 600, height: 5}], pageSize: 512, padding: 0}),
	).toThrow('does not fit');
});

test('WebP atlases hold the same pixels as PNG atlases', async () => {
	const set = twoAnimations();
	const options = {
		set,
		key: null,
		compositionId: 'test',
		atlasSize: null,
		compression: 'none' as const,
		onProgress: null,
	};
	const webp = await packWanimAnimations({...options, atlasFormat: 'webp'});
	expect(webp.manifest.atlases.every((a) => a.format === 'webp')).toBe(true);
	const sharp = (await import('sharp')).default;
	const again = await readWanimAsSet({
		file: webp.file,
		key: null,
		decodeWebp: async (bytes) => {
			const {data, info} = await sharp(bytes)
				.ensureAlpha()
				.raw()
				.toBuffer({resolveWithObject: true});
			return {
				width: info.width,
				height: info.height,
				data: new Uint8Array(data),
			};
		},
	});
	const original = await readWanimAsSet({
		file: (await packWanimAnimations({...options, atlasFormat: 'png'})).file,
		key: null,
		decodeWebp: null,
	});
	expect(
		again.bitmaps.map((b) => PNG.sync.read(Buffer.from(b.png)).data),
	).toEqual(
		original.bitmaps.map((b) => PNG.sync.read(Buffer.from(b.png)).data),
	);
	await expect(
		packWanimAnimations({...options, atlasFormat: 'png', compression: 'lossy'}),
	).rejects.toThrow('WebP');
	const lossy = await packWanimAnimations({
		...options,
		atlasFormat: 'webp',
		compression: 'lossy',
	});
	expect(lossy.manifest.atlases.length).toBe(webp.manifest.atlases.length);
});

test('each animation is sampled on its own', () => {
	const sampled = sampleWanimAnimations({
		firstFrame: 0,
		lastFrame: 89,
		fps: 30,
		frameRate: 15,
		imageRate: null,
		animations: [
			{key: 'in', from: 0, to: 29, loop: false},
			{key: 'idle', from: 31, to: 60, loop: true},
		],
	});
	expect(sampled.fps).toBe(15);
	expect(sampled.frames.length).toBe(30);
	expect(sampled.frames.slice(0, 3)).toEqual([0, 2, 4]);
	// Starts on its own first frame, not on the grid of the one before
	expect(sampled.frames.slice(15, 18)).toEqual([31, 33, 35]);
	expect(sampled.animations).toEqual([
		{key: 'in', from: 0, to: 14, loop: false},
		{key: 'idle', from: 15, to: 29, loop: true},
	]);
	expect(() =>
		sampleWanimAnimations({
			firstFrame: 10,
			lastFrame: 20,
			fps: 30,
			frameRate: null,
			imageRate: null,
			animations: [{key: 'a', from: 0, to: 12, loop: false}],
		}),
	).toThrow('spans');
	expect(
		sampleWanimAnimations({
			firstFrame: 0,
			lastFrame: 9,
			fps: 30,
			frameRate: null,
			imageRate: null,
			animations: null,
		}).animations,
	).toBe(null);
});
