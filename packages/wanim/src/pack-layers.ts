import {PNG} from 'pngjs';
import type {WanimCompression} from './compress-atlas';
import {
	encodePng,
	encryptedLength,
	shelfPack,
	writeWanimFile,
} from './container';
import {parseWanimKey} from './crypto';
import type {WanimAtlas, WanimLayerSprite, WanimLayersManifest} from './format';
import {WANIM_DRAW_BYTES, WANIM_LAYERS_VERSION} from './format';
import {WANIM_OFFICIAL_KEY} from './official-key';
import type {Matrix} from './plan-layers';
import {multiplyMatrix} from './plan-layers';

// A picture of a part of the animation, trimmed to its pixels
export type WanimLayerBitmap = {
	width: number;
	height: number;
	// PNG with straight alpha, of exactly `width` x `height`
	png: Uint8Array;
};

export type WanimLayerDrawInput = {
	bitmap: number;
	// Maps a pixel of the bitmap to a pixel of the canvas
	matrix: Matrix;
	alpha: number;
};

export type WanimLayeredAnimation = {
	width: number;
	height: number;
	fps: number;
	// What to draw in each frame, from back to front
	frames: WanimLayerDrawInput[][];
	bitmaps: WanimLayerBitmap[];
};

export type PackWanimLayersOptions = {
	animation: WanimLayeredAnimation;
	// A key of its own for this file. If `null`, the official key is used.
	key: string | null;
	compositionId: string | null;
	// Size limit of an atlas. By default 2048, or 4096 for larger pictures.
	atlasSize: number | null;
	compression: WanimCompression;
	onProgress: ((progress: number) => void) | null;
};

const MAX_ATLAS_SIZE = 4096;
const DEFAULT_ATLAS_SIZE = 2048;
// Transparent pixels around each sprite, inside of its rectangle: A transformed
// sprite then gets smooth edges, and sampling never reaches a neighbor.
const BORDER = 1;
const PADDING = 2;
// Draws that would change no pixel
const MIN_ALPHA = 1 / 512;

export const cullDraws = (animation: WanimLayeredAnimation) =>
	animation.frames.map((draws) =>
		draws.filter(({bitmap, matrix, alpha}) => {
			if (!(alpha >= MIN_ALPHA) || matrix.some((v) => !Number.isFinite(v))) {
				return false;
			}

			const image = animation.bitmaps[bitmap];
			if (!image) {
				throw new RangeError(`No bitmap with index ${bitmap}`);
			}

			const corners = [
				[0, 0],
				[image.width, 0],
				[0, image.height],
				[image.width, image.height],
			].map(([x, y]) => [
				matrix[0] * (x as number) + matrix[2] * (y as number) + matrix[4],
				matrix[1] * (x as number) + matrix[3] * (y as number) + matrix[5],
			]);
			const xs = corners.map((c) => c[0] as number);
			const ys = corners.map((c) => c[1] as number);
			return (
				Math.max(...xs) > 0 &&
				Math.min(...xs) < animation.width &&
				Math.max(...ys) > 0 &&
				Math.min(...ys) < animation.height
			);
		}),
	);

export const packWanimLayers = ({
	animation,
	key,
	compositionId,
	atlasSize,
	compression,
	onProgress,
}: PackWanimLayersOptions) => {
	// Fails early on an invalid key
	parseWanimKey(key ?? WANIM_OFFICIAL_KEY);
	if (animation.frames.length === 0) {
		throw new Error('Cannot create a .wanim file without frames');
	}

	if (!(animation.fps > 0)) {
		throw new TypeError(`"fps" must be positive, got ${animation.fps}`);
	}

	if (
		atlasSize !== null &&
		(!Number.isInteger(atlasSize) ||
			atlasSize < 1 ||
			atlasSize > MAX_ATLAS_SIZE)
	) {
		throw new TypeError(
			`"atlasSize" must be an integer up to ${MAX_ATLAS_SIZE}, got ${atlasSize}`,
		);
	}

	const frames = cullDraws(animation);

	// Sprites in the order they are first drawn, so that atlases are in
	// playback order too
	const spriteOf = new Map<number, number>();
	const used: number[] = [];
	for (const draws of frames) {
		for (const {bitmap} of draws) {
			if (!spriteOf.has(bitmap)) {
				spriteOf.set(bitmap, used.length);
				used.push(bitmap);
			}
		}
	}

	const sizes = used.map((bitmap) => {
		const image = animation.bitmaps[bitmap] as WanimLayerBitmap;
		return {width: image.width + BORDER * 2, height: image.height + BORDER * 2};
	});
	const largestSide = sizes.reduce(
		(max, size) => Math.max(max, size.width, size.height),
		0,
	);
	const pageSize =
		atlasSize ??
		(largestSide + PADDING * 2 > DEFAULT_ATLAS_SIZE ||
		largestSide > DEFAULT_ATLAS_SIZE / 2
			? MAX_ATLAS_SIZE
			: DEFAULT_ATLAS_SIZE);
	const {pages, places} = shelfPack({sizes, pageSize, padding: PADDING});

	const sprites: WanimLayerSprite[] = used.map((_, index) => {
		const place = places[index] as (typeof places)[number];
		const size = sizes[index] as (typeof sizes)[number];
		return [place.page, place.x, place.y, size.width, size.height];
	});

	const opaqueBitmaps = new Set<number>();
	const pngs: Uint8Array[] = [];
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
		const page = pages[pageIndex] as (typeof pages)[number];
		if (page.width === 0) {
			continue;
		}

		const atlas = new PNG({width: page.width, height: page.height});
		atlas.data.fill(0);
		used.forEach((bitmap, index) => {
			const place = places[index] as (typeof places)[number];
			if (place.page !== pageIndex) {
				return;
			}

			const image = animation.bitmaps[bitmap] as WanimLayerBitmap;
			const source = PNG.sync.read(Buffer.from(image.png));
			if (source.width !== image.width || source.height !== image.height) {
				throw new Error(
					`Bitmap ${bitmap} is ${source.width}x${source.height}, but was declared as ${image.width}x${image.height}`,
				);
			}

			let isOpaque = true;
			for (let i = 3; isOpaque && i < source.data.length; i += 4) {
				isOpaque = source.data[i] === 255;
			}

			if (isOpaque) {
				opaqueBitmaps.add(bitmap);
			}

			PNG.bitblt(
				source,
				atlas,
				0,
				0,
				image.width,
				image.height,
				place.x + BORDER,
				place.y + BORDER,
			);
		});
		pngs.push(encodePng(atlas, compression));
		onProgress?.((pageIndex + 1) / pages.length);
	}

	// The matrices map bitmap pixels, the sprites include the border
	const fromSprite: Matrix = [1, 0, 0, 1, -BORDER, -BORDER];
	const drawCount = frames.reduce((sum, draws) => sum + draws.length, 0);
	const timeline = new Uint8Array(
		(frames.length + 1) * 4 + drawCount * WANIM_DRAW_BYTES,
	);
	const view = new DataView(timeline.buffer);
	let drawIndex = 0;
	frames.forEach((draws, frame) => {
		view.setUint32(frame * 4, drawIndex, true);
		for (const draw of draws) {
			const drawOffset = (frames.length + 1) * 4 + drawIndex * WANIM_DRAW_BYTES;
			view.setUint32(drawOffset, spriteOf.get(draw.bitmap) as number, true);
			multiplyMatrix(draw.matrix, fromSprite).forEach((value, i) => {
				view.setFloat32(drawOffset + 4 + i * 4, value, true);
			});
			view.setFloat32(drawOffset + 28, Math.min(1, draw.alpha), true);
			drawIndex++;
		}
	});
	view.setUint32(frames.length * 4, drawIndex, true);

	// Blending can only be turned off if every frame is one opaque picture
	// covering the canvas
	const opaque = frames.every(
		(draws) =>
			draws.length === 1 &&
			opaqueBitmaps.has((draws[0] as WanimLayerDrawInput).bitmap) &&
			(draws[0] as WanimLayerDrawInput).alpha >= 1 &&
			(draws[0] as WanimLayerDrawInput).matrix.every(
				(v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]!) < 1e-6,
			) &&
			animation.bitmaps[(draws[0] as WanimLayerDrawInput).bitmap]!.width ===
				animation.width &&
			animation.bitmaps[(draws[0] as WanimLayerDrawInput).bitmap]!.height ===
				animation.height,
	);

	let offset = 0;
	const atlases: WanimAtlas[] = pngs.map((png, index) => {
		const page = pages[index] as (typeof pages)[number];
		const length = encryptedLength(png.length);
		const atlas: WanimAtlas = {
			offset,
			length,
			width: page.width,
			height: page.height,
			format: 'png',
		};
		offset += length;
		return atlas;
	});

	const manifest: WanimLayersManifest = {
		version: WANIM_LAYERS_VERSION,
		compositionId,
		width: animation.width,
		height: animation.height,
		fps: animation.fps,
		frameCount: frames.length,
		opaque,
		gpuBytes: atlases.reduce((sum, a) => sum + a.width * a.height * 4, 0),
		atlases,
		sprites,
		timeline: {
			offset,
			length: encryptedLength(timeline.length),
			draws: drawCount,
		},
	};

	return {
		file: writeWanimFile({
			version: WANIM_LAYERS_VERSION,
			key,
			manifest,
			blocks: [...pngs, timeline],
		}),
		manifest,
	};
};
