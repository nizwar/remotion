import {createHash, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {
	concatBytes,
	deriveFileKey,
	encryptBlock,
	parseWanimKey,
} from './crypto';
import type {WanimAtlas, WanimManifest, WanimSprite} from './format';
import {
	WANIM_HEADER_LENGTH,
	WANIM_MAGIC,
	WANIM_NONCE_PREFIX_LENGTH,
	WANIM_SALT_LENGTH,
	WANIM_TAG_LENGTH,
	WANIM_VERSION,
} from './format';

// Every GPU that Android and iOS devices ship with supports at least this size
const MAX_ATLAS_SIZE = 4096;
const DEFAULT_ATLAS_SIZE = 2048;
// Transparent gutter, so that linear filtering does not sample a neighbor
const PADDING = 2;

type Rect = {
	// A frame which shows this picture, to read the pixels from in the 2nd pass
	frameIndex: number;
	sourceX: number;
	sourceY: number;
	width: number;
	height: number;
	atlas: number;
	x: number;
	y: number;
};

export type PackWanimOptions = {
	// PNG files, in playback order
	framePaths: string[];
	fps: number;
	key: string;
	compositionId: string | null;
	// Size limit of an atlas. By default 2048, or 4096 for frames larger than 1024.
	atlasSize: number | null;
	onProgress: ((progress: number) => void) | null;
};

export type PackWanimResult = {
	file: Uint8Array;
	manifest: WanimManifest;
};

export const packWanim = async ({
	framePaths,
	fps,
	key,
	compositionId,
	atlasSize,
	onProgress,
}: PackWanimOptions): Promise<PackWanimResult> => {
	const masterKey = parseWanimKey(key);
	if (framePaths.length === 0) {
		throw new Error('Cannot create a .wanim file without frames');
	}

	if (!(fps > 0)) {
		throw new TypeError(`"fps" must be positive, got ${fps}`);
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

	const readFrame = async (frameIndex: number) => {
		return PNG.sync.read(await readFile(framePaths[frameIndex] as string));
	};

	// 1st pass: Only keeps the bounds of each picture, because all frames of a
	// composition would not fit into memory as raw pixels.
	const rects: Rect[] = [];
	const rectByPixels = new Map<string, number>();
	const sprites: WanimSprite[] = [];
	const spriteByPlacement = new Map<string, number>();
	const frames: number[] = [];
	let width = 0;
	let height = 0;
	let opaque = true;

	for (let frameIndex = 0; frameIndex < framePaths.length; frameIndex++) {
		const png = await readFrame(frameIndex);
		if (frameIndex === 0) {
			width = png.width;
			height = png.height;
		} else if (png.width !== width || png.height !== height) {
			throw new Error(
				`All frames must have the same size, but ${framePaths[frameIndex]} is ${png.width}x${png.height} instead of ${width}x${height}`,
			);
		}

		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const alpha = png.data[(y * width + x) * 4 + 3] as number;
				if (alpha === 0) {
					continue;
				}

				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}

		if (maxX === -1) {
			opaque = false;
			frames.push(-1);
			onProgress?.((frameIndex + 1) / framePaths.length / 2);
			continue;
		}

		const rectWidth = maxX - minX + 1;
		const rectHeight = maxY - minY + 1;
		const hash = createHash('sha256').update(`${rectWidth}x${rectHeight}:`);
		for (let y = minY; y <= maxY; y++) {
			const rowStart = (y * width + minX) * 4;
			const row = png.data.subarray(rowStart, rowStart + rectWidth * 4);
			hash.update(row);
			for (let i = 3; opaque && i < row.length; i += 4) {
				opaque = row[i] === 255;
			}
		}

		if (rectWidth !== width || rectHeight !== height) {
			opaque = false;
		}

		const pixels = hash.digest('base64');
		let rectIndex = rectByPixels.get(pixels);
		if (rectIndex === undefined) {
			rectIndex = rects.length;
			rectByPixels.set(pixels, rectIndex);
			rects.push({
				frameIndex,
				sourceX: minX,
				sourceY: minY,
				width: rectWidth,
				height: rectHeight,
				atlas: 0,
				x: 0,
				y: 0,
			});
		}

		// Same picture at another position: Costs no extra atlas space
		const placement = `${rectIndex}:${minX}:${minY}`;
		let spriteIndex = spriteByPlacement.get(placement);
		if (spriteIndex === undefined) {
			spriteIndex = sprites.length;
			spriteByPlacement.set(placement, spriteIndex);
			sprites.push([rectIndex, 0, 0, rectWidth, rectHeight, minX, minY]);
		}

		frames.push(spriteIndex);
		onProgress?.((frameIndex + 1) / framePaths.length / 2);
	}

	const largestSide = rects.reduce(
		(max, rect) => Math.max(max, rect.width, rect.height),
		0,
	);
	const pageSize =
		atlasSize ??
		(largestSide > DEFAULT_ATLAS_SIZE / 2
			? MAX_ATLAS_SIZE
			: DEFAULT_ATLAS_SIZE);
	if (largestSide + PADDING * 2 > pageSize) {
		throw new Error(
			`A frame is ${largestSide}px large, which does not fit into an atlas of ${pageSize}px. Render with a lower scale.`,
		);
	}

	// Shelves are filled in playback order: Neighboring frames share an atlas,
	// so a player needs few texture switches and can predict the next atlas.
	const pages: {width: number; height: number; rects: Rect[]}[] = [
		{width: 0, height: 0, rects: []},
	];
	let cursorX = PADDING;
	let cursorY = PADDING;
	let shelfHeight = 0;
	for (const rect of rects) {
		if (cursorX + rect.width + PADDING > pageSize) {
			cursorX = PADDING;
			cursorY += shelfHeight + PADDING;
			shelfHeight = 0;
		}

		if (cursorY + rect.height + PADDING > pageSize) {
			pages.push({width: 0, height: 0, rects: []});
			cursorX = PADDING;
			cursorY = PADDING;
			shelfHeight = 0;
		}

		const page = pages[pages.length - 1] as (typeof pages)[number];
		rect.atlas = pages.length - 1;
		rect.x = cursorX;
		rect.y = cursorY;
		page.rects.push(rect);
		page.width = Math.max(page.width, cursorX + rect.width + PADDING);
		page.height = Math.max(page.height, cursorY + rect.height + PADDING);
		cursorX += rect.width + PADDING;
		shelfHeight = Math.max(shelfHeight, rect.height);
	}

	// 2nd pass: Draw one atlas at a time, keeping peak memory at one atlas
	const pngs: Uint8Array[] = [];
	for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
		const page = pages[pageIndex] as (typeof pages)[number];
		if (page.rects.length === 0) {
			continue;
		}

		const atlas = new PNG({width: page.width, height: page.height});
		atlas.data.fill(0);
		for (const rect of page.rects) {
			const source = await readFrame(rect.frameIndex);
			PNG.bitblt(
				source,
				atlas,
				rect.sourceX,
				rect.sourceY,
				rect.width,
				rect.height,
				rect.x,
				rect.y,
			);
		}

		pngs.push(
			PNG.sync.write(atlas, {
				colorType: 6,
				deflateLevel: 9,
				filterType: -1,
			}),
		);
		onProgress?.(0.5 + (pageIndex + 1) / pages.length / 2);
	}

	for (const sprite of sprites) {
		const rect = rects[sprite[0]] as Rect;
		sprite[0] = rect.atlas;
		sprite[1] = rect.x;
		sprite[2] = rect.y;
	}

	let offset = 0;
	const atlases: WanimAtlas[] = pngs.map((png, index) => {
		const page = pages[index] as (typeof pages)[number];
		const length = png.length + WANIM_TAG_LENGTH;
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

	const manifest: WanimManifest = {
		version: WANIM_VERSION,
		compositionId,
		width,
		height,
		fps,
		frameCount: frames.length,
		opaque,
		gpuBytes: atlases.reduce((sum, a) => sum + a.width * a.height * 4, 0),
		atlases,
		sprites,
		frames,
	};

	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
	const salt = new Uint8Array(randomBytes(WANIM_SALT_LENGTH));
	const noncePrefix = new Uint8Array(randomBytes(WANIM_NONCE_PREFIX_LENGTH));

	const header = new Uint8Array(WANIM_HEADER_LENGTH);
	const view = new DataView(header.buffer);
	header.set(WANIM_MAGIC);
	view.setUint16(8, WANIM_VERSION, true);
	view.setUint32(12, manifestBytes.length + WANIM_TAG_LENGTH, true);
	header.set(salt, 16);
	header.set(noncePrefix, 16 + WANIM_SALT_LENGTH);

	const context = {
		fileKey: deriveFileKey({masterKey, salt}),
		noncePrefix,
		header,
	};

	return {
		file: concatBytes([
			header,
			encryptBlock({context, blockIndex: 0, plaintext: manifestBytes}),
			...pngs.map((plaintext, index) =>
				encryptBlock({context, blockIndex: index + 1, plaintext}),
			),
		]),
		manifest,
	};
};
