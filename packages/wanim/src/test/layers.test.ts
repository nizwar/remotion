import {expect, test} from 'bun:test';
import {inflateSync} from 'node:zlib';
import {PNG} from 'pngjs';
import {generateWanimKey} from '../crypto';
import type {WanimLayersManifest} from '../format';
import {openWanim, readWanimHeader} from '../open-wanim';
import type {WanimLayeredAnimation} from '../pack-layers';
import {packWanimLayers} from '../pack-layers';
import {assignTracks, packSvga} from '../pack-svga';
import type {FrameDescription, LayerNode, Matrix} from '../plan-layers';
import {planLayers} from '../plan-layers';
import {sampleWanimFrames} from '../sample-frames';

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

test('a lower frame rate keeps the duration', () => {
	const {fps, frames, imageFrames} = sampleWanimFrames({
		firstFrame: 0,
		lastFrame: 59,
		fps: 30,
		frameRate: 12,
		imageRate: null,
	});
	expect(fps).toBe(12);
	expect(frames.length).toBe(24);
	expect(frames.slice(0, 6)).toEqual([0, 2, 5, 7, 10, 12]);
	expect(imageFrames).toEqual(frames);
	expect(frames[23]).toBe(57);
});

test('a frame rate above the composition keeps every frame', () => {
	const {fps, frames} = sampleWanimFrames({
		firstFrame: 10,
		lastFrame: 14,
		fps: 30,
		frameRate: 60,
		imageRate: null,
	});
	expect(fps).toBe(30);
	expect(frames).toEqual([10, 11, 12, 13, 14]);
});

test('pictures can change less often than the animation moves', () => {
	const {frames, imageFrames} = sampleWanimFrames({
		firstFrame: 0,
		lastFrame: 29,
		fps: 30,
		frameRate: null,
		imageRate: 10,
	});
	expect(frames.length).toBe(30);
	expect(imageFrames.slice(0, 7)).toEqual([0, 0, 0, 3, 3, 3, 6]);
});

test('invalid rates are rejected', () => {
	expect(() =>
		sampleWanimFrames({
			firstFrame: 0,
			lastFrame: 9,
			fps: 30,
			frameRate: 0,
			imageRate: null,
		}),
	).toThrow();
});

const node = (overrides: Partial<LayerNode> & {path: string}): LayerNode => ({
	kind: 'leaf',
	signature: 'look',
	matrix: [1, 0, 0, 1, 0, 0],
	opacity: 1,
	blocking: [],
	bounds: [0, 0, 10, 10],
	parent: -1,
	children: [],
	ownPaint: null,
	blend: false,
	zIndex: false,
	...overrides,
});

const describe = (nodes: LayerNode[]): FrameDescription => ({
	canvas: [0, 0, 400, 400],
	nodes,
});

// A group with a big static picture and a small ball that moves, turns and
// changes its color every 2 frames
const scene = (frame: number) =>
	describe([
		// A group changes its look whenever a child does
		node({
			path: '0',
			kind: 'group',
			children: [1, 2],
			signature: `group-${frame}`,
			bounds: [0, 0, 400, 400],
		}),
		node({
			path: '0/0',
			parent: 0,
			signature: 'background',
			bounds: [0, 0, 300, 300],
		}),
		node({
			path: '0/1',
			parent: 0,
			signature: `ball-${Math.floor(frame / 2)}`,
			matrix: [
				Math.cos(frame / 10),
				Math.sin(frame / 10),
				-Math.sin(frame / 10),
				Math.cos(frame / 10),
				frame * 5,
				20,
			],
			opacity: 1 - frame / 20,
			bounds: [frame * 5, 20, 20, 20],
		}),
	]);

test('moving parts become layers, parts that change get one picture per look', () => {
	const frames = Array.from({length: 8}, (_, i) => i);
	const plan = planLayers({
		descriptions: new Map(frames.map((f) => [f, scene(f)])),
		outputFrames: frames,
		imageFrames: frames,
		scale: 1,
	});
	expect(plan.frames.every((units) => units.length === 2)).toBe(true);
	// The background once, the ball in 4 looks
	expect(plan.captures.length).toBe(5);
	const background = plan.captures.find((c) => c.path === '0/0');
	expect(background?.uprightScale).toBe(null);
	// The ball turns, so it is captured upright
	const balls = plan.captures.filter((c) => c.path === '0/1');
	expect(balls.length).toBe(4);
	expect(plan.frames[3]?.[1]?.alpha).toBeCloseTo(1 - 3 / 20);
	expect(plan.frames[3]?.[1]?.matrix[4]).toBe(15);
});

test('with a lower image rate, a part keeps its look for longer', () => {
	const frames = Array.from({length: 8}, (_, i) => i);
	const imageFrames = frames.map((f) => Math.floor(f / 4) * 4);
	const plan = planLayers({
		descriptions: new Map(frames.map((f) => [f, scene(f)])),
		outputFrames: frames,
		imageFrames,
		scale: 1,
	});
	expect(plan.captures.filter((c) => c.path === '0/1').length).toBe(2);
	// Still moves in every frame
	expect(plan.frames[5]?.[1]?.matrix[4]).toBe(25);
	expect(plan.frames[5]?.[1]?.key).toBe(plan.frames[4]?.[1]?.key);
});

test('a composition that changes everywhere is captured whole', () => {
	const frames = [0, 1, 2];
	const descriptions = new Map(
		frames.map((f) => [
			f,
			describe([
				node({
					path: '0',
					signature: `frame-${f}`,
					bounds: [0, 0, 400, 400],
				}),
			]),
		]),
	);
	const plan = planLayers({
		descriptions,
		outputFrames: frames,
		imageFrames: frames,
		scale: 1,
	});
	expect(plan.captures.map((c) => c.path)).toEqual(['', '', '']);
});

test('the opacity of a group only moves to children that do not overlap', () => {
	const frames = [0, 1];
	const make = (overlap: boolean) =>
		new Map(
			frames.map((f) => [
				f,
				describe([
					node({
						path: '0',
						kind: 'group',
						children: [1, 2],
						opacity: 0.5,
						signature: `group-${f}`,
						bounds: [0, 0, 400, 400],
					}),
					node({
						path: '0/0',
						parent: 0,
						signature: 'a',
						matrix: [1, 0, 0, 1, f * 50, 0],
						bounds: [f * 50, 0, 100, 100],
					}),
					node({
						path: '0/1',
						parent: 0,
						signature: 'b',
						matrix: [1, 0, 0, 1, overlap ? 50 : 200, 200],
						bounds: [overlap ? 50 : 200, overlap ? 0 : 200, 100, 100],
					}),
				]),
			]),
		);
	const apart = planLayers({
		descriptions: make(false),
		outputFrames: frames,
		imageFrames: frames,
		scale: 1,
	});
	expect(apart.frames[1]?.map((u) => u.alpha)).toEqual([0.5, 0.5]);
	const together = planLayers({
		descriptions: make(true),
		outputFrames: frames,
		imageFrames: frames,
		scale: 1,
	});
	expect(together.frames[1]?.length).toBe(1);
});

const animation = (): WanimLayeredAnimation => ({
	width: 40,
	height: 30,
	fps: 10,
	bitmaps: [solid(4, 4, [255, 0, 0, 255]), solid(6, 2, [0, 0, 255, 128])],
	frames: [
		[{bitmap: 0, matrix: [1, 0, 0, 1, 2, 3], alpha: 1}],
		[
			{bitmap: 0, matrix: [1, 0, 0, 1, 10, 3], alpha: 0.5},
			{bitmap: 1, matrix: [0, 1, -1, 0, 20, 10], alpha: 1},
		],
		// Fully outside of the canvas, and invisible: Both are dropped
		[
			{bitmap: 1, matrix: [1, 0, 0, 1, 100, 100], alpha: 1},
			{bitmap: 0, matrix: [1, 0, 0, 1, 0, 0], alpha: 0},
		],
	],
});

test('version 2 files keep the draws of each frame', async () => {
	const key = generateWanimKey();
	const {file, manifest} = await packWanimLayers({
		animation: animation(),
		key,
		compositionId: 'layers',
		atlasSize: null,
		compression: 'none',
		onProgress: null,
	});
	expect(readWanimHeader(file)).toEqual({
		version: 2,
		customKey: true,
		manifestLength: expect.any(Number),
	});
	const opened = openWanim({file, key});
	expect(opened.manifest).toEqual(manifest);
	const layers = opened.manifest as WanimLayersManifest;
	expect(layers.frameCount).toBe(3);
	expect(layers.timeline.draws).toBe(3);
	expect(layers.opaque).toBe(false);
	// One pixel of transparent border around each sprite
	expect(layers.sprites.map((s) => [s[3], s[4]])).toEqual([
		[6, 6],
		[8, 4],
	]);

	const timeline = opened.readTimeline();
	expect(timeline.map((draws) => draws.length)).toEqual([1, 2, 0]);
	// The border moves the sprite by one pixel
	expect(timeline[0]?.[0]?.matrix).toEqual([1, 0, 0, 1, 1, 2]);
	expect(timeline[1]?.[0]?.alpha).toBe(0.5);
	expect(timeline[1]?.[1]?.matrix).toEqual([0, 1, -1, 0, 21, 9]);

	const [atlasIndex, x, y, w, h] = layers.sprites[0]!;
	const atlas = PNG.sync.read(Buffer.from(opened.readAtlas(atlasIndex)));
	const pixel = (px: number, py: number) => [
		...atlas.data.subarray(
			(py * atlas.width + px) * 4,
			(py * atlas.width + px) * 4 + 4,
		),
	];
	expect(pixel(x, y)).toEqual([0, 0, 0, 0]);
	expect(pixel(x + 1, y + 1)).toEqual([255, 0, 0, 255]);
	expect(pixel(x + w - 2, y + h - 2)).toEqual([255, 0, 0, 255]);
	expect(pixel(x + w - 1, y + h - 1)).toEqual([0, 0, 0, 0]);
});

test('version 2 with the official key', async () => {
	const {file} = await packWanimLayers({
		animation: animation(),
		key: null,
		compositionId: null,
		atlasSize: null,
		compression: 'small',
		onProgress: null,
	});
	expect(readWanimHeader(file).customKey).toBe(false);
	expect(openWanim({file, key: null}).readTimeline().length).toBe(3);
});

test('a single opaque picture covering the canvas needs no blending', async () => {
	const {manifest} = await packWanimLayers({
		animation: {
			width: 4,
			height: 4,
			fps: 1,
			bitmaps: [solid(4, 4, [1, 2, 3, 255])],
			frames: [[{bitmap: 0, matrix: [1, 0, 0, 1, 0, 0], alpha: 1}]],
		},
		key: null,
		compositionId: null,
		atlasSize: null,
		compression: 'none',
		onProgress: null,
	});
	expect(manifest.opaque).toBe(true);
});

test('version 1 files have no timeline', async () => {
	const {file} = await packWanimLayers({
		animation: animation(),
		key: null,
		compositionId: null,
		atlasSize: null,
		compression: 'none',
		onProgress: null,
	});
	// Changing the version breaks the authentication of every block
	const copy = new Uint8Array(file);
	copy[8] = 3;
	expect(() => openWanim({file: copy, key: null})).toThrow(
		'Unsupported .wanim version: 3',
	);
});

// Decodes protobuf into {field: [values]}, nested messages stay bytes
const decodeMessage = (bytes: Uint8Array) => {
	const fields = new Map<number, (number | Uint8Array)[]>();
	let i = 0;
	const varint = () => {
		let result = 0;
		let shift = 1;
		for (;;) {
			const byte = bytes[i++] as number;
			result += (byte & 0x7f) * shift;
			shift *= 128;
			if (byte < 0x80) {
				return result;
			}
		}
	};

	while (i < bytes.length) {
		const key = varint();
		const field = Math.floor(key / 8);
		let value: number | Uint8Array;
		if (key % 8 === 0) {
			value = varint();
		} else if (key % 8 === 5) {
			value = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getFloat32(
				0,
				true,
			);
			i += 4;
		} else if (key % 8 === 2) {
			const length = varint();
			value = bytes.subarray(i, i + length);
			i += length;
		} else {
			throw new Error(`Unexpected wire type ${key % 8}`);
		}

		fields.set(field, [...(fields.get(field) ?? []), value]);
	}

	return fields;
};

const text = (value: number | Uint8Array | undefined) =>
	new TextDecoder().decode(value as Uint8Array);

test('svga files hold the images and one sprite per image and layer', () => {
	const {file, fps, sprites, images} = packSvga({
		animation: animation(),
		compression: 'none',
	});
	expect(fps).toBe(10);
	expect(sprites).toBe(2);
	expect(images).toBe(2);

	const movie = decodeMessage(new Uint8Array(inflateSync(file)));
	expect(text(movie.get(1)?.[0])).toBe('2.0');
	const params = decodeMessage(movie.get(2)?.[0] as Uint8Array);
	expect(params.get(1)).toEqual([40]);
	expect(params.get(2)).toEqual([30]);
	expect(params.get(3)).toEqual([10]);
	expect(params.get(4)).toEqual([3]);

	const imageEntries = (movie.get(3) ?? []).map((entry) =>
		decodeMessage(entry as Uint8Array),
	);
	expect(imageEntries.map((e) => text(e.get(1)?.[0]))).toEqual([
		'img_0',
		'img_1',
	]);
	const red = PNG.sync.read(
		Buffer.from(imageEntries[0]?.get(2)?.[0] as Uint8Array),
	);
	expect([red.width, red.height]).toEqual([4, 4]);

	const spriteEntries = (movie.get(4) ?? []).map((entry) =>
		decodeMessage(entry as Uint8Array),
	);
	expect(spriteEntries.map((s) => text(s.get(1)?.[0]))).toEqual([
		'img_0',
		'img_1',
	]);
	const frames = spriteEntries[1]?.get(2) as Uint8Array[];
	expect(frames.length).toBe(3);
	// Not drawn in the first frame
	expect(frames[0]?.length).toBe(0);
	const second = decodeMessage(frames[1] as Uint8Array);
	expect(second.get(1)).toEqual([1]);
	const layout = decodeMessage(second.get(2)?.[0] as Uint8Array);
	expect(layout.get(3)).toEqual([6]);
	expect(layout.get(4)).toEqual([2]);
	const transform = decodeMessage(second.get(3)?.[0] as Uint8Array);
	// A zero `a` or `d` would be read as 1
	expect(transform.get(1)?.[0]).toBeGreaterThan(0);
	expect(transform.get(1)?.[0]).toBeLessThan(1e-6);
	expect(transform.get(2)).toEqual([1]);
	expect(transform.get(3)).toEqual([-1]);
	expect(transform.get(5)).toEqual([20]);
});

test('svga sprites keep the order of every frame', () => {
	const draw = (bitmap: number) => ({
		bitmap,
		matrix: [1, 0, 0, 1, 0, 0] as Matrix,
		alpha: 1,
	});
	// 0 is in front of 1 first, then behind it, and drawn twice in frame 2
	const tracks = assignTracks([
		[draw(1), draw(0)],
		[draw(0), draw(1)],
		[draw(0), draw(2), draw(0)],
	]);
	for (let frame = 0; frame < 3; frame++) {
		const order = tracks
			.map((track, index) => ({index, draw: track.draws[frame]}))
			.filter((t) => t.draw !== null)
			.map((t) => tracks[t.index]?.bitmap);
		expect(order).toEqual(
			[
				[1, 0],
				[0, 1],
				[0, 2, 0],
			][frame],
		);
	}
});

test('the version 2 fixtures match expected-layers.json', async () => {
	const {readFileSync} = await import('node:fs');
	const {createHash} = await import('node:crypto');
	const dir = `${__dirname}/../../fixtures/`;
	const expected = JSON.parse(
		readFileSync(`${dir}expected-layers.json`, 'utf8'),
	);
	for (const [name, fixtureKey] of [
		['sample-layers.wanim', null],
		['sample-layers-custom-key.wanim', expected.customKey],
	] as const) {
		const opened = openWanim({
			file: new Uint8Array(readFileSync(`${dir}${name}`)),
			key: fixtureKey,
		});
		expect(opened.manifest).toEqual(expected.manifest);
		expect(opened.readTimeline()).toEqual(expected.timeline);
		expect(
			expected.manifest.atlases.map((_: unknown, i: number) =>
				createHash('sha256').update(opened.readAtlas(i)).digest('hex'),
			),
		).toEqual(expected.atlasSha256);
	}

	expected.frameSha256.forEach((sha: string, frame: number) => {
		const png = PNG.sync.read(readFileSync(`${dir}layers-frame-${frame}.png`));
		expect(createHash('sha256').update(png.data).digest('hex')).toBe(sha);
	});
});
