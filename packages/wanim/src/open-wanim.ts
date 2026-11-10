import {inflateRawSync} from 'node:zlib';
import {decryptBlock, deriveFileKey, parseWanimKey} from './crypto';
import type {
	WanimAnimationsManifest,
	WanimDraw,
	WanimLayersManifest,
	WanimManifest,
	WanimSceneData,
} from './format';
import {
	WANIM_ANIMATION_KEY_PATTERN,
	WANIM_ANIMATIONS_VERSION,
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
	if (
		version !== WANIM_VERSION &&
		version !== WANIM_LAYERS_VERSION &&
		version !== WANIM_ANIMATIONS_VERSION
	) {
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

// A manifest is far smaller. The limit keeps a forged block from inflating
// without end.
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

const inflate = (bytes: Uint8Array, maxLength: number): Uint8Array => {
	try {
		return new Uint8Array(inflateRawSync(bytes, {maxOutputLength: maxLength}));
	} catch {
		throw new Error('Invalid .wanim file: A block could not be inflated');
	}
};

const validateAnimations = (manifest: WanimAnimationsManifest) => {
	const keys = new Set<string>();
	let frames = 0;
	for (const {key, frameCount, atlases} of manifest.animations) {
		if (
			!WANIM_ANIMATION_KEY_PATTERN.test(key) ||
			keys.has(key) ||
			!Number.isInteger(frameCount) ||
			frameCount < 1 ||
			!Array.isArray(atlases) ||
			atlases.some(
				(atlas) =>
					!Number.isInteger(atlas) ||
					atlas < 0 ||
					atlas >= manifest.atlases.length,
			)
		) {
			throw new Error(`Invalid .wanim file: Bad animation "${key}"`);
		}

		keys.add(key);
		frames += frameCount;
	}

	if (manifest.animations.length === 0 || frames !== manifest.frameCount) {
		throw new Error(
			'Invalid .wanim file: The animations do not add up to the frames',
		);
	}
};

export const openWanim = ({
	file,
	key,
}: {
	file: Uint8Array;
	key: string | null;
}) => {
	const {customKey, manifestLength, version} = readWanimHeader(file);
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
	const manifestBlock = decryptBlock({
		context,
		blockIndex: 0,
		ciphertext: file.subarray(WANIM_HEADER_LENGTH, dataStart),
	});
	const manifest = JSON.parse(
		new TextDecoder().decode(
			version === WANIM_ANIMATIONS_VERSION
				? inflate(manifestBlock, MAX_MANIFEST_BYTES)
				: manifestBlock,
		),
	) as WanimManifest | WanimLayersManifest | WanimAnimationsManifest;
	if (manifest.version !== version) {
		throw new Error(
			'Invalid .wanim file: The manifest is of another version than the file',
		);
	}

	if (manifest.version === WANIM_ANIMATIONS_VERSION) {
		validateAnimations(manifest);
	}

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
		// Version 3 only: Every different draw and frame, and the frames of
		// each animation
		readScene: (): WanimSceneData => {
			if (manifest.version !== WANIM_ANIMATIONS_VERSION) {
				throw new Error('Only version 3 files have a scene');
			}

			const {scene, sprites, animations, frameCount} = manifest;
			const size =
				scene.draws * WANIM_DRAW_BYTES +
				(scene.lists + 1) * 4 +
				scene.items * 4 +
				frameCount * 4;
			const start = dataStart + scene.offset;
			const bytes = inflate(
				decryptBlock({
					context,
					blockIndex: manifest.atlases.length + 1,
					ciphertext: file.subarray(start, start + scene.length),
				}),
				size,
			);
			if (bytes.length !== size) {
				throw new Error('Invalid .wanim file: The scene has a wrong size');
			}

			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
			const column = (index: number, draw: number) =>
				(index * scene.draws + draw) * 4;
			const draws: WanimDraw[] = Array.from({length: scene.draws}, (_, i) => {
				const float = (index: number) =>
					view.getFloat32(column(index, i), true);
				const sprite = view.getUint32(column(0, i), true);
				if (sprite >= sprites.length) {
					throw new Error('Invalid .wanim file: A draw has no sprite');
				}

				return {
					sprite,
					matrix: [float(1), float(2), float(3), float(4), float(5), float(6)],
					alpha: float(7),
				};
			});

			const listsStart = scene.draws * WANIM_DRAW_BYTES;
			const itemsStart = listsStart + (scene.lists + 1) * 4;
			const framesStart = itemsStart + scene.items * 4;
			const lists: number[][] = [];
			for (let list = 0; list < scene.lists; list++) {
				const from = view.getUint32(listsStart + list * 4, true);
				const to = view.getUint32(listsStart + list * 4 + 4, true);
				if ((list === 0 && from !== 0) || to < from || to > scene.items) {
					throw new Error('Invalid .wanim file: A frame has a wrong range');
				}

				const items: number[] = [];
				for (let item = from; item < to; item++) {
					const draw = view.getUint32(itemsStart + item * 4, true);
					if (draw >= scene.draws) {
						throw new Error('Invalid .wanim file: A frame has no draw');
					}

					items.push(draw);
				}

				lists.push(items);
			}

			if (view.getUint32(listsStart + scene.lists * 4, true) !== scene.items) {
				throw new Error('Invalid .wanim file: A frame has a wrong range');
			}

			const frames: Record<string, number[]> = {};
			let frame = 0;
			for (const animation of animations) {
				frames[animation.key] = Array.from(
					{length: animation.frameCount},
					() => {
						const list = view.getUint32(framesStart + frame * 4, true);
						frame++;
						if (list >= scene.lists) {
							throw new Error('Invalid .wanim file: A frame does not exist');
						}

						return list;
					},
				);
			}

			return {draws, lists, frames};
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
