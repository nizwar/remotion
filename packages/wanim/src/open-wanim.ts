import {decryptBlock, deriveFileKey, parseWanimKey} from './crypto';
import type {WanimDraw, WanimLayersManifest, WanimManifest} from './format';
import {
	WANIM_DRAW_BYTES,
	WANIM_FLAG_CUSTOM_KEY,
	WANIM_HEADER_LENGTH,
	WANIM_LAYERS_VERSION,
	WANIM_MAGIC,
	WANIM_NONCE_PREFIX_LENGTH,
	WANIM_SALT_LENGTH,
	WANIM_VERSION,
} from './format';
import {WANIM_OFFICIAL_KEY} from './official-key';

export type WanimHeader = {
	version: number;
	customKey: boolean;
	manifestLength: number;
};

export const readWanimHeader = (file: Uint8Array): WanimHeader => {
	if (
		file.length < WANIM_HEADER_LENGTH ||
		!WANIM_MAGIC.every((byte, index) => file[index] === byte)
	) {
		throw new Error('Not a .wanim file');
	}

	const view = new DataView(file.buffer, file.byteOffset, WANIM_HEADER_LENGTH);
	const version = view.getUint16(8, true);
	if (version !== WANIM_VERSION && version !== WANIM_LAYERS_VERSION) {
		throw new Error(`Unsupported .wanim version: ${version}`);
	}

	const flags = view.getUint16(10, true);
	if ((flags & ~WANIM_FLAG_CUSTOM_KEY) !== 0) {
		throw new Error(`Unsupported .wanim flags: ${flags}`);
	}

	return {
		version,
		customKey: (flags & WANIM_FLAG_CUSTOM_KEY) !== 0,
		manifestLength: view.getUint32(12, true),
	};
};

export const openWanim = ({
	file,
	key,
}: {
	file: Uint8Array;
	key: string | null;
}) => {
	const {customKey, manifestLength} = readWanimHeader(file);
	if (customKey && key === null) {
		throw new Error('This .wanim file was encrypted with a key of its own.');
	}

	const salt = file.subarray(16, 16 + WANIM_SALT_LENGTH);
	const noncePrefixStart = 16 + WANIM_SALT_LENGTH;
	const context = {
		fileKey: deriveFileKey({
			masterKey: parseWanimKey(
				customKey ? (key as string) : WANIM_OFFICIAL_KEY,
			),
			salt,
		}),
		noncePrefix: file.subarray(
			noncePrefixStart,
			noncePrefixStart + WANIM_NONCE_PREFIX_LENGTH,
		),
		header: file.subarray(0, WANIM_HEADER_LENGTH),
	};

	const dataStart = WANIM_HEADER_LENGTH + manifestLength;
	const manifest = JSON.parse(
		new TextDecoder().decode(
			decryptBlock({
				context,
				blockIndex: 0,
				ciphertext: file.subarray(WANIM_HEADER_LENGTH, dataStart),
			}),
		),
	) as WanimManifest | WanimLayersManifest;

	return {
		manifest,
		// Version 2 only: What to draw in each frame
		readTimeline: (): WanimDraw[][] => {
			if (manifest.version !== WANIM_LAYERS_VERSION) {
				throw new Error('Only version 2 files have a timeline');
			}

			const start = dataStart + manifest.timeline.offset;
			const bytes = decryptBlock({
				context,
				blockIndex: manifest.atlases.length + 1,
				ciphertext: file.subarray(start, start + manifest.timeline.length),
			});
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
			const drawsStart = (manifest.frameCount + 1) * 4;
			if (
				bytes.length !==
				drawsStart + manifest.timeline.draws * WANIM_DRAW_BYTES
			) {
				throw new Error('Invalid .wanim file: The timeline has a wrong size');
			}

			return Array.from({length: manifest.frameCount}, (_, frame) => {
				const from = view.getUint32(frame * 4, true);
				const to = view.getUint32(frame * 4 + 4, true);
				const draws: WanimDraw[] = [];
				for (let index = from; index < to; index++) {
					const offset = drawsStart + index * WANIM_DRAW_BYTES;
					const float = (i: number) =>
						view.getFloat32(offset + 4 + i * 4, true);
					draws.push({
						sprite: view.getUint32(offset, true),
						matrix: [
							float(0),
							float(1),
							float(2),
							float(3),
							float(4),
							float(5),
						],
						alpha: float(6),
					});
				}

				return draws;
			});
		},
		// Atlases are encrypted separately so that a player only has to decrypt
		// the one it is about to upload to the GPU.
		readAtlas: (index: number): Uint8Array => {
			const atlas = manifest.atlases[index];
			if (!atlas) {
				throw new RangeError(`No atlas with index ${index}`);
			}

			const start = dataStart + atlas.offset;
			return decryptBlock({
				context,
				blockIndex: index + 1,
				ciphertext: file.subarray(start, start + atlas.length),
			});
		},
	};
};
