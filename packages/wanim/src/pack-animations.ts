import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import type {WanimCompression} from './compress-atlas';
import {deflate, encodePng, encryptedLength, writeWanimFile} from './container';
import {parseWanimKey} from './crypto';
import type {
	WanimAnimationsManifest,
	WanimAtlas,
	WanimLayerSprite,
} from './format';
import {WANIM_ANIMATION_KEY_PATTERN, WANIM_ANIMATIONS_VERSION} from './format';
import {WANIM_OFFICIAL_KEY} from './official-key';
import type {WanimLayerBitmap, WanimLayerDrawInput} from './pack-layers';
import {cullDraws} from './pack-layers';
import {packSprites} from './pack-sprites';
import type {Matrix} from './plan-layers';
import {multiplyMatrix} from './plan-layers';
import {encodeWebp} from './webp';

export type WanimAnimationInput = {
	// What the app plays the animation by: Letters, digits, `_`, `.` and `-`
	key: string;
	// Whether the animation is meant to repeat
	loop: boolean;
	// What to draw in each frame, from back to front
	frames: WanimLayerDrawInput[][];
};

// Several animations that draw from the same pictures
export type WanimAnimationSet = {
	width: number;
	height: number;
	fps: number;
	animations: WanimAnimationInput[];
	bitmaps: WanimLayerBitmap[];
};

export type WanimAtlasFormat = 'png' | 'webp';

export type PackWanimAnimationsOptions = {
	set: WanimAnimationSet;
	// A key of its own for this file. If `null`, the official key is used.
	key: string | null;
	compositionId: string | null;
	// Size limit of an atlas. By default 2048, or 4096 for larger pictures.
	atlasSize: number | null;
	compression: WanimCompression;
	atlasFormat: WanimAtlasFormat;
	onProgress: ((progress: number) => void) | null;
};

export type PackWanimAnimationsResult = {
	file: Uint8Array;
	manifest: WanimAnimationsManifest;
};

const MAX_ATLAS_SIZE = 4096;
const DEFAULT_ATLAS_SIZE = 2048;
// Transparent pixels around each sprite, inside of its rectangle: A transformed
// sprite then gets smooth edges, and sampling never reaches a neighbor.
const BORDER = 1;
// The borders of 2 neighbors already keep their pixels apart
const PADDING = 0;
const MAX_GROUPS = 8;
const MIN_GROUP_PIXELS = 128 * 128;
type Size = {width: number; height: number};
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export const packWanimAnimations = async ({
	set,
	key,
	compositionId,
	atlasSize,
	compression,
	atlasFormat,
	onProgress,
}: PackWanimAnimationsOptions): Promise<PackWanimAnimationsResult> => {
	// Fails early on an invalid key
	parseWanimKey(key ?? WANIM_OFFICIAL_KEY);
	if (set.animations.length === 0) {
		throw new Error('Cannot create a .wanim file without animations');
	}

	const keys = new Set<string>();
	for (const animation of set.animations) {
		if (!WANIM_ANIMATION_KEY_PATTERN.test(animation.key)) {
			throw new TypeError(
				`An animation key must be 1 to 64 letters, digits, "_", "." or "-", got "${animation.key}"`,
			);
		}

		if (keys.has(animation.key)) {
			throw new TypeError(`The animation key "${animation.key}" is used twice`);
		}

		keys.add(animation.key);
		if (animation.frames.length === 0) {
			throw new Error(`The animation "${animation.key}" has no frames`);
		}
	}

	if (!(set.fps > 0)) {
		throw new TypeError(`"fps" must be positive, got ${set.fps}`);
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

	if (compression === 'lossy' && atlasFormat !== 'webp') {
		throw new TypeError('The compression "lossy" needs WebP atlases');
	}

	const animations = set.animations.map((animation) => ({
		...animation,
		frames: cullDraws({...set, frames: animation.frames}),
	}));

	// Pictures in the order they are first drawn, so that atlases are in
	// playback order too. Bitmaps with the same pixels become one picture.
	type Picture = {width: number; height: number; data: Uint8Array};
	const pictures: Picture[] = [];
	// The animations that draw each picture
	const users: Set<number>[] = [];
	const opaquePictures = new Set<number>();
	const pictureOfBitmap = new Map<number, number>();
	const pictureOfPixels = new Map<string, number>();
	for (const [animationIndex, {frames}] of animations.entries()) {
		for (const draws of frames) {
			for (const {bitmap} of draws) {
				const known = pictureOfBitmap.get(bitmap);
				if (known !== undefined) {
					(users[known] as Set<number>).add(animationIndex);
					continue;
				}

				const image = set.bitmaps[bitmap] as WanimLayerBitmap;
				const source = PNG.sync.read(Buffer.from(image.png));
				if (source.width !== image.width || source.height !== image.height) {
					throw new Error(
						`Bitmap ${bitmap} is ${source.width}x${source.height}, but was declared as ${image.width}x${image.height}`,
					);
				}

				const data = new Uint8Array(source.data);
				const pixels = createHash('sha256')
					.update(`${image.width}x${image.height}:`)
					.update(data)
					.digest('base64');
				let picture = pictureOfPixels.get(pixels);
				if (picture === undefined) {
					picture = pictures.length;
					pictureOfPixels.set(pixels, picture);
					let isOpaque = true;
					for (let i = 3; isOpaque && i < data.length; i += 4) {
						isOpaque = data[i] === 255;
					}

					if (isOpaque) {
						opaquePictures.add(picture);
					}

					pictures.push({width: image.width, height: image.height, data});
					users.push(new Set());
				}

				(users[picture] as Set<number>).add(animationIndex);
				pictureOfBitmap.set(bitmap, picture);
			}
		}
	}

	const sizes: Size[] = pictures.map(({width, height}) => ({
		width: width + BORDER * 2,
		height: height + BORDER * 2,
	}));
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

	// Pictures that the same animations draw share atlases, so that a player
	// can drop the atlases that only animations it no longer plays need. An
	// atlas is as large as what is on it, so more atlases cost no memory.
	const groups = new Map<string, number[]>();
	pictures.forEach((_, index) => {
		const id = [...(users[index] as Set<number>)].sort((a, b) => a - b).join();
		const group = groups.get(id);
		if (group) {
			group.push(index);
		} else {
			groups.set(id, [index]);
		}
	});
	// With many animations, a texture of its own is not worth it for a few
	// pixels: Those pictures share atlases
	if (groups.size > MAX_GROUPS) {
		const small: number[] = [];
		for (const [id, group] of [...groups]) {
			const area = group.reduce(
				(sum, index) =>
					sum + (sizes[index] as Size).width * (sizes[index] as Size).height,
				0,
			);
			if (area < MIN_GROUP_PIXELS) {
				small.push(...group);
				groups.delete(id);
			}
		}

		if (small.length > 0) {
			groups.set(
				'small',
				small.sort((x, y) => x - y),
			);
		}
	}

	const pages: {width: number; height: number}[] = [];
	const places: {page: number; x: number; y: number}[] = new Array(
		pictures.length,
	);
	for (const group of groups.values()) {
		const packed = packSprites({
			sizes: group.map((index) => sizes[index] as (typeof sizes)[number]),
			pageSize,
			padding: PADDING,
		});
		group.forEach((index, i) => {
			const place = packed.places[i] as (typeof packed.places)[number];
			places[index] = {...place, page: pages.length + place.page};
		});
		pages.push(...packed.pages);
	}

	const sprites: WanimLayerSprite[] = pictures.map((_, index) => {
		const place = places[index] as (typeof places)[number];
		const size = sizes[index] as (typeof sizes)[number];
		return [place.page, place.x, place.y, size.width, size.height];
	});

	const images: Uint8Array[] = [];
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
		const page = pages[pageIndex] as (typeof pages)[number];
		const atlas = new PNG({width: page.width, height: page.height});
		atlas.data.fill(0);
		pictures.forEach((picture, index) => {
			const place = places[index] as (typeof places)[number];
			if (place.page !== pageIndex) {
				return;
			}

			for (let y = 0; y < picture.height; y++) {
				atlas.data.set(
					picture.data.subarray(
						y * picture.width * 4,
						(y + 1) * picture.width * 4,
					),
					((place.y + BORDER + y) * page.width + place.x + BORDER) * 4,
				);
			}
		});
		images.push(
			atlasFormat === 'webp'
				? await encodeWebp({
						data: atlas.data,
						width: page.width,
						height: page.height,
						compression,
					})
				: encodePng(atlas, compression),
		);
		onProgress?.((pageIndex + 1) / pages.length);
	}

	// Every different draw and every different frame is stored once
	const fromSprite: Matrix = [1, 0, 0, 1, -BORDER, -BORDER];
	const drawValues: number[][] = [];
	const drawOf = new Map<string, number>();
	const lists: number[][] = [];
	const listOf = new Map<string, number>();
	const frameLists: number[] = [];
	for (const {frames} of animations) {
		for (const draws of frames) {
			const list = draws.map((draw) => {
				const values = [
					pictureOfBitmap.get(draw.bitmap) as number,
					...multiplyMatrix(draw.matrix, fromSprite).map((v) => Math.fround(v)),
					Math.fround(Math.min(1, draw.alpha)),
				];
				const drawId = values.join(',');
				let drawIndex = drawOf.get(drawId);
				if (drawIndex === undefined) {
					drawIndex = drawValues.length;
					drawOf.set(drawId, drawIndex);
					drawValues.push(values);
				}

				return drawIndex;
			});
			const id = list.join(',');
			let index = listOf.get(id);
			if (index === undefined) {
				index = lists.length;
				listOf.set(id, index);
				lists.push(list);
			}

			frameLists.push(index);
		}
	}

	const itemCount = lists.reduce((sum, list) => sum + list.length, 0);
	const scene = new Uint8Array(
		drawValues.length * 32 +
			(lists.length + 1) * 4 +
			itemCount * 4 +
			frameLists.length * 4,
	);
	const view = new DataView(scene.buffer);
	let offset = 0;
	// One column per field: Equal values end up next to each other
	for (let column = 0; column < 8; column++) {
		for (const values of drawValues) {
			if (column === 0) {
				view.setUint32(offset, values[0] as number, true);
			} else {
				view.setFloat32(offset, values[column] as number, true);
			}

			offset += 4;
		}
	}

	let listStart = 0;
	for (const list of lists) {
		view.setUint32(offset, listStart, true);
		offset += 4;
		listStart += list.length;
	}

	view.setUint32(offset, listStart, true);
	offset += 4;
	for (const list of lists) {
		for (const draw of list) {
			view.setUint32(offset, draw, true);
			offset += 4;
		}
	}

	for (const list of frameLists) {
		view.setUint32(offset, list, true);
		offset += 4;
	}

	const sceneBlock = deflate(scene);

	// Blending can only be turned off if every frame is one opaque picture
	// covering the canvas
	const opaque = animations.every(({frames}) =>
		frames.every((draws) => {
			const draw = draws[0];
			if (draws.length !== 1 || !draw) {
				return false;
			}

			const picture = pictureOfBitmap.get(draw.bitmap) as number;
			const {width, height} = pictures[picture] as Picture;
			return (
				opaquePictures.has(picture) &&
				draw.alpha >= 1 &&
				draw.matrix.every((v, i) => Math.abs(v - IDENTITY[i]!) < 1e-6) &&
				width === set.width &&
				height === set.height
			);
		}),
	);

	let blockOffset = 0;
	const atlases: WanimAtlas[] = images.map((image, index) => {
		const page = pages[index] as (typeof pages)[number];
		const length = encryptedLength(image.length);
		const atlas: WanimAtlas = {
			offset: blockOffset,
			length,
			width: page.width,
			height: page.height,
			format: atlasFormat,
		};
		blockOffset += length;
		return atlas;
	});

	const manifest: WanimAnimationsManifest = {
		version: WANIM_ANIMATIONS_VERSION,
		compositionId,
		width: set.width,
		height: set.height,
		fps: set.fps,
		frameCount: frameLists.length,
		opaque,
		gpuBytes: atlases.reduce((sum, a) => sum + a.width * a.height * 4, 0),
		atlases,
		sprites,
		animations: animations.map(({key: animationKey, loop, frames}, index) => ({
			key: animationKey,
			frameCount: frames.length,
			loop,
			atlases: [
				...new Set(
					sprites
						.filter((_, picture) => (users[picture] as Set<number>).has(index))
						.map((sprite) => sprite[0]),
				),
			].sort((a, b) => a - b),
		})),
		scene: {
			offset: blockOffset,
			length: encryptedLength(sceneBlock.length),
			draws: drawValues.length,
			lists: lists.length,
			items: itemCount,
		},
	};

	return {
		file: writeWanimFile({
			version: WANIM_ANIMATIONS_VERSION,
			key,
			manifest,
			blocks: [...images, sceneBlock],
			deflateManifest: true,
		}),
		manifest,
	};
};
