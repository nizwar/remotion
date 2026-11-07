import {afterAll, beforeAll, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {concatBytes, generateWanimKey} from '../crypto';
import {openWanim, readWanimHeader} from '../open-wanim';
import {packWanim} from '../pack-wanim';

const key = generateWanimKey();
let dir = '';

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'wanim-test-'));
});

afterAll(() => {
	rmSync(dir, {recursive: true});
});

let counter = 0;
const writeFrame = (
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

	const framePath = path.join(dir, `${counter++}.png`);
	writeFileSync(framePath, PNG.sync.write(png));
	return framePath;
};

const square =
	(left: number, top: number, size: number) => (x: number, y: number) =>
		(x >= left && x < left + size && y >= top && y < top + size
			? [x - left, y - top, 200, 255]
			: [0, 0, 0, 0]) as [number, number, number, number];

const pack = (framePaths: string[], atlasSize: number | null = null) =>
	packWanim({
		framePaths,
		fps: 30,
		key,
		compositionId: 'test',
		atlasSize,
		onProgress: null,
	});

// Compares what a player draws with the source frame
const reconstruct = (
	file: Uint8Array,
	frame: number,
): {width: number; data: Uint8Array} => {
	const {manifest, readAtlas} = openWanim({file, key});
	const canvas = new Uint8Array(manifest.width * manifest.height * 4);
	const spriteIndex = manifest.frames[frame] as number;
	if (spriteIndex === -1) {
		return {width: manifest.width, data: canvas};
	}

	const [atlas, x, y, w, h, dx, dy] = manifest.sprites[spriteIndex]!;
	const png = PNG.sync.read(Buffer.from(readAtlas(atlas)));
	for (let row = 0; row < h; row++) {
		const start = ((y + row) * png.width + x) * 4;
		canvas.set(
			png.data.subarray(start, start + w * 4),
			((dy + row) * manifest.width + dx) * 4,
		);
	}

	return {width: manifest.width, data: canvas};
};

test('reconstructs every frame pixel for pixel', async () => {
	const framePaths = [
		writeFrame(40, 30, square(2, 3, 10)),
		writeFrame(40, 30, square(20, 5, 12)),
		writeFrame(40, 30, () => [0, 0, 0, 0]),
		writeFrame(40, 30, () => [10, 20, 30, 40]),
	];
	const {file} = await pack(framePaths, 64);
	framePaths.forEach((framePath, frame) => {
		expect(Array.from(reconstruct(file, frame).data)).toEqual(
			Array.from(PNG.sync.read(readFileSync(framePath)).data),
		);
	});
});

test('moved and repeated pictures share atlas space', async () => {
	const {manifest} = await pack([
		writeFrame(40, 30, square(2, 3, 10)),
		writeFrame(40, 30, square(2, 3, 10)),
		writeFrame(40, 30, square(15, 9, 10)),
	]);
	expect(manifest.frames).toEqual([0, 0, 1]);
	expect(manifest.sprites).toHaveLength(2);
	expect(manifest.sprites[0]!.slice(0, 5)).toEqual(
		manifest.sprites[1]!.slice(0, 5),
	);
	expect(manifest.sprites[0]!.slice(5)).toEqual([2, 3]);
	expect(manifest.sprites[1]!.slice(5)).toEqual([15, 9]);
});

test('atlases are cropped and split in playback order', async () => {
	const {manifest} = await pack(
		[1, 2, 3, 4, 5].map((size) => writeFrame(40, 30, square(0, 0, 20 + size))),
		32,
	);
	expect(manifest.atlases).toHaveLength(5);
	manifest.sprites.forEach((sprite, index) => {
		expect(sprite[0]).toBe(index);
	});
	expect(manifest.atlases[0]!.width).toBe(25);
});

test('sets opaque only if the whole canvas is covered', async () => {
	const full = writeFrame(8, 8, () => [1, 2, 3, 255]);
	expect((await pack([full])).manifest.opaque).toBe(true);
	expect(
		(await pack([full, writeFrame(8, 8, square(0, 0, 4))])).manifest.opaque,
	).toBe(false);
	expect(
		(await pack([writeFrame(8, 8, () => [1, 2, 3, 254])])).manifest.opaque,
	).toBe(false);
});

test('an animation of only empty frames has no atlases', async () => {
	const {file, manifest} = await pack([writeFrame(8, 8, () => [0, 0, 0, 0])]);
	expect(manifest.frames).toEqual([-1]);
	expect(manifest.atlases).toEqual([]);
	expect(openWanim({file, key}).manifest.frameCount).toBe(1);
});

test('rejects frames of different sizes and frames larger than an atlas', async () => {
	await expect(
		pack([
			writeFrame(8, 8, square(0, 0, 4)),
			writeFrame(9, 8, square(0, 0, 4)),
		]),
	).rejects.toThrow(/same size/);
	await expect(
		pack([writeFrame(40, 30, square(0, 0, 30))], 32),
	).rejects.toThrow(/does not fit/);
});

test('the file reveals nothing without the key', async () => {
	const {file} = await pack([writeFrame(8, 8, square(0, 0, 4))]);
	const text = new TextDecoder('latin1').decode(file);
	expect(text.includes('PNG')).toBe(false);
	expect(text.includes('frames')).toBe(false);
	expect(readWanimHeader(file).version).toBe(1);
	expect(() => openWanim({file, key: generateWanimKey()})).toThrow(
		/key is wrong/,
	);
});

test('detects tampering, swapped atlases and foreign headers', async () => {
	const frames = [
		writeFrame(40, 30, square(0, 0, 25)),
		writeFrame(40, 30, square(0, 0, 26)),
	];
	const {file} = await pack(frames, 32);

	const header = file.slice();
	header[20]! ^= 1;
	expect(() => openWanim({file: header, key})).toThrow(/key is wrong/);

	const lastByte = file.slice();
	lastByte[lastByte.length - 1]! ^= 1;
	const tampered = openWanim({file: lastByte, key});
	expect(tampered.readAtlas(0).length).toBeGreaterThan(0);
	expect(() => tampered.readAtlas(1)).toThrow(/key is wrong/);

	const {manifest} = openWanim({file, key});
	const [first, second] = manifest.atlases;
	const dataStart = file.length - first!.length - second!.length;
	const swapped = concatBytes([
		file.subarray(0, dataStart),
		file.subarray(dataStart + second!.offset),
		file.subarray(dataStart, dataStart + second!.offset),
	]);
	expect(() => openWanim({file: swapped, key}).readAtlas(0)).toThrow(
		/key is wrong/,
	);
});

test('two files of the same frames share no ciphertext', async () => {
	const frame = writeFrame(8, 8, square(0, 0, 4));
	const [a, b] = await Promise.all([pack([frame]), pack([frame])]);
	expect(Array.from(a.file.subarray(40))).not.toEqual(
		Array.from(b.file.subarray(40)),
	);
});

test('rejects malformed keys and files', async () => {
	await expect(
		packWanim({
			framePaths: [],
			fps: 30,
			key: 'short',
			compositionId: null,
			atlasSize: null,
			onProgress: null,
		}),
	).rejects.toThrow(/64 hexadecimal/);
	expect(() => readWanimHeader(new Uint8Array(4))).toThrow(/Not a .wanim/);
});

test('the shared fixture still opens', () => {
	const fixtures = path.join(__dirname, '..', '..', 'fixtures');
	const expected = JSON.parse(
		readFileSync(path.join(fixtures, 'expected.json'), 'utf8'),
	);
	const {manifest, readAtlas} = openWanim({
		file: new Uint8Array(readFileSync(path.join(fixtures, 'sample.wanim'))),
		key: expected.key,
	});
	expect(manifest).toEqual(expected.manifest);
	expected.atlasSha256.forEach((sha256: string, index: number) => {
		expect(createHash('sha256').update(readAtlas(index)).digest('hex')).toBe(
			sha256,
		);
	});
});
