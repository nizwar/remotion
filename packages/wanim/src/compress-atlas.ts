import {deflateSync} from 'node:zlib';
import type {PNG} from 'pngjs';
import {concatBytes} from './crypto';

// `lossy` needs WebP atlases, which only version 3 files can hold
export type WanimCompression = 'none' | 'balanced' | 'small' | 'lossy';

const MAX_COLORS = 256;
// Keeps 6 bits per color channel, which deflate packs far better than 8.
// Alpha stays untouched, so that opaque pixels stay fully opaque.
export const posterize = (data: Uint8Array) => {
	for (let i = 0; i < data.length; i += 4) {
		for (let channel = i; channel < i + 3; channel++) {
			const value = (data[channel] as number) & 0xfc;
			data[channel] = value | (value >> 6);
		}
	}
};

type Bucket = {rgba: [number, number, number, number]; count: number};

// Colors in the same bucket are treated as one. Alpha keeps more detail than
// color, because soft shadows are nothing but alpha steps of a single color.
const bucketKey = (data: Uint8Array, i: number) =>
	(((data[i] as number) >> 3) << 18) |
	(((data[i + 1] as number) >> 3) << 13) |
	(((data[i + 2] as number) >> 3) << 8) |
	(data[i + 3] as number);

const widestChannel = (buckets: Bucket[]) => {
	let best = {channel: 0, range: -1};
	for (let channel = 0; channel < 4; channel++) {
		let min = 255;
		let max = 0;
		for (const {rgba} of buckets) {
			min = Math.min(min, rgba[channel] as number);
			max = Math.max(max, rgba[channel] as number);
		}

		if (max - min > best.range) {
			best = {channel, range: max - min};
		}
	}

	return best;
};

// Median cut: Splits the color box with the widest range until the palette is full
const makePalette = (buckets: Bucket[], maxColors: number) => {
	const boxes = [buckets];
	while (boxes.length < maxColors) {
		let target = -1;
		let targetRange = 0;
		boxes.forEach((candidate, index) => {
			const {range} = widestChannel(candidate);
			// Weighs the range by the root of the pixel count, so that rare but
			// visible steps of a gradient still get their own colors
			const pixels = candidate.reduce((sum, bucket) => sum + bucket.count, 0);
			const score = range * Math.sqrt(pixels);
			if (candidate.length > 1 && score > targetRange) {
				target = index;
				targetRange = score;
			}
		});
		if (target === -1) {
			break;
		}

		const box = boxes[target] as Bucket[];
		const {channel} = widestChannel(box);
		box.sort(
			(a, b) => (a.rgba[channel] as number) - (b.rgba[channel] as number),
		);
		const half = box.reduce((sum, bucket) => sum + bucket.count, 0) / 2;
		let seen = 0;
		let split = 1;
		for (let i = 0; i < box.length - 1; i++) {
			seen += (box[i] as Bucket).count;
			split = i + 1;
			if (seen >= half) {
				break;
			}
		}

		boxes[target] = box.slice(0, split);
		boxes.push(box.slice(split));
	}

	return boxes.map((box) => {
		const total = box.reduce((sum, bucket) => sum + bucket.count, 0);
		const average = (channel: number) =>
			Math.round(
				box.reduce(
					(sum, bucket) =>
						sum + (bucket.rgba[channel] as number) * bucket.count,
					0,
				) / total,
			);
		// A box of opaque colors must average to exactly opaque
		return [average(0), average(1), average(2), average(3)];
	});
};

const crcTable = Array.from({length: 256}, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}

	return c >>> 0;
});

const chunk = (type: string, data: Uint8Array) => {
	const body = concatBytes([new TextEncoder().encode(type), data]);
	let crc = 0xffffffff;
	for (const byte of body) {
		crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	}

	const out = new Uint8Array(body.length + 8);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(body, 4);
	view.setUint32(body.length + 4, (crc ^ 0xffffffff) >>> 0);
	return out;
};

// Up to 256 colors, and the color of each pixel as PNG rows of 1 byte per pixel
type Pixels = {data: Uint8Array; width: number; height: number};

const indexPixels = (png: Pixels) => {
	const {data, width, height} = png;
	const histogram = new Map<number, Bucket>();
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] === 0) {
			continue;
		}

		const key = bucketKey(data, i);
		const bucket = histogram.get(key);
		if (bucket) {
			bucket.count++;
		} else {
			histogram.set(key, {
				rgba: [
					data[i] as number,
					data[i + 1] as number,
					data[i + 2] as number,
					data[i + 3] as number,
				],
				count: 1,
			});
		}
	}

	// Index 0 is reserved for transparent pixels
	const palette = [
		[0, 0, 0, 0],
		...makePalette([...histogram.values()], MAX_COLORS - 1),
	];
	const nearest = new Map<number, number>();
	const findIndex = (i: number) => {
		const key = bucketKey(data, i);
		const cached = nearest.get(key);
		if (cached !== undefined) {
			return cached;
		}

		let best = 1;
		let bestDistance = Infinity;
		for (let index = 1; index < palette.length; index++) {
			const color = palette[index] as number[];
			let distance = 0;
			for (let channel = 0; channel < 4; channel++) {
				const difference =
					(color[channel] as number) - (data[i + channel] as number);
				distance += difference * difference;
			}

			if (distance < bestDistance) {
				bestDistance = distance;
				best = index;
			}
		}

		nearest.set(key, best);
		return best;
	};

	const rows = new Uint8Array((width + 1) * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			rows[y * (width + 1) + 1 + x] = data[i + 3] === 0 ? 0 : findIndex(i);
		}
	}

	return {palette, rows};
};

// Reduces the pixels to up to 256 colors in place, for formats that find the
// palette by themselves
export const quantize = (png: Pixels) => {
	const {data, width, height} = png;
	const {palette, rows} = indexPixels(png);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			data.set(
				palette[rows[y * (width + 1) + 1 + x] as number] as number[],
				(y * width + x) * 4,
			);
		}
	}
};

// Writes an indexed PNG with up to 256 colors
export const encodePalettePng = (png: PNG): Uint8Array => {
	const {width, height} = png;
	const {palette, rows} = indexPixels(png);

	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 3, 0, 0, 0], 8);

	return concatBytes([
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		chunk('IHDR', header),
		chunk(
			'PLTE',
			new Uint8Array(palette.flatMap((color) => color.slice(0, 3))),
		),
		chunk('tRNS', new Uint8Array(palette.map((color) => color[3] as number))),
		chunk('IDAT', new Uint8Array(deflateSync(rows, {level: 9}))),
		chunk('IEND', new Uint8Array(0)),
	]);
};
