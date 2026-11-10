import {randomBytes} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {PNG} from 'pngjs';
import type {WanimCompression} from './compress-atlas';
import {encodePalettePng, posterize} from './compress-atlas';
import {
	concatBytes,
	deriveFileKey,
	encryptBlock,
	parseWanimKey,
} from './crypto';
import {
	WANIM_FLAG_CUSTOM_KEY,
	WANIM_HEADER_LENGTH,
	WANIM_MAGIC,
	WANIM_NONCE_PREFIX_LENGTH,
	WANIM_SALT_LENGTH,
	WANIM_TAG_LENGTH,
} from './format';
import {WANIM_OFFICIAL_KEY} from './official-key';

// Size of a block once it is encrypted
export const encryptedLength = (plaintextLength: number) =>
	plaintextLength + WANIM_TAG_LENGTH;

// Raw DEFLATE, without a zlib header
export const deflate = (bytes: Uint8Array): Uint8Array =>
	new Uint8Array(deflateRawSync(bytes, {level: 9}));

// Header, then block 0 (the manifest), then the data blocks in order
export const writeWanimFile = ({
	version,
	key,
	manifest,
	blocks,
	deflateManifest,
}: {
	version: number;
	// `null` for the official key
	key: string | null;
	manifest: object;
	blocks: Uint8Array[];
	// Version 3 deflates the manifest before it is encrypted
	deflateManifest?: boolean;
}): Uint8Array => {
	const masterKey = parseWanimKey(key ?? WANIM_OFFICIAL_KEY);
	const manifestJson = new TextEncoder().encode(JSON.stringify(manifest));
	const manifestBytes = deflateManifest ? deflate(manifestJson) : manifestJson;
	const salt = new Uint8Array(randomBytes(WANIM_SALT_LENGTH));
	const noncePrefix = new Uint8Array(randomBytes(WANIM_NONCE_PREFIX_LENGTH));

	const header = new Uint8Array(WANIM_HEADER_LENGTH);
	const view = new DataView(header.buffer);
	header.set(WANIM_MAGIC);
	view.setUint16(8, version, true);
	view.setUint16(10, key === null ? 0 : WANIM_FLAG_CUSTOM_KEY, true);
	view.setUint32(12, encryptedLength(manifestBytes.length), true);
	header.set(salt, 16);
	header.set(noncePrefix, 16 + WANIM_SALT_LENGTH);

	const context = {
		fileKey: deriveFileKey({masterKey, salt}),
		noncePrefix,
		header,
	};

	return concatBytes([
		header,
		encryptBlock({context, blockIndex: 0, plaintext: manifestBytes}),
		...blocks.map((plaintext, index) =>
			encryptBlock({context, blockIndex: index + 1, plaintext}),
		),
	]);
};

// Lossy compression changes the pixels in place
export const encodePng = (
	png: PNG,
	compression: WanimCompression,
): Uint8Array => {
	if (compression === 'lossy') {
		throw new TypeError(
			'The compression "lossy" needs WebP atlases, which only version 3 files have',
		);
	}

	if (compression === 'balanced') {
		posterize(png.data);
	}

	return compression === 'small'
		? encodePalettePng(png)
		: new Uint8Array(
				PNG.sync.write(png, {colorType: 6, deflateLevel: 9, filterType: -1}),
			);
};

// Places rectangles in rows, in the given order, on pages of `pageSize`
export const shelfPack = ({
	sizes,
	pageSize,
	padding,
}: {
	sizes: {width: number; height: number}[];
	pageSize: number;
	padding: number;
}) => {
	const pages: {width: number; height: number}[] = [{width: 0, height: 0}];
	const places: {page: number; x: number; y: number}[] = [];
	let cursorX = padding;
	let cursorY = padding;
	let shelfHeight = 0;
	for (const {width, height} of sizes) {
		if (width + padding * 2 > pageSize || height + padding * 2 > pageSize) {
			throw new Error(
				`A picture of ${width}x${height}px does not fit into an atlas of ${pageSize}px. Render with a lower scale.`,
			);
		}

		if (cursorX + width + padding > pageSize) {
			cursorX = padding;
			cursorY += shelfHeight + padding;
			shelfHeight = 0;
		}

		if (cursorY + height + padding > pageSize) {
			pages.push({width: 0, height: 0});
			cursorX = padding;
			cursorY = padding;
			shelfHeight = 0;
		}

		const page = pages[pages.length - 1] as (typeof pages)[number];
		places.push({page: pages.length - 1, x: cursorX, y: cursorY});
		page.width = Math.max(page.width, cursorX + width + padding);
		page.height = Math.max(page.height, cursorY + height + padding);
		cursorX += width + padding;
		shelfHeight = Math.max(shelfHeight, height);
	}

	return {pages, places};
};
