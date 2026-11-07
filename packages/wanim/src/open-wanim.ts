import {decryptBlock, deriveFileKey, parseWanimKey} from './crypto';
import type {WanimManifest} from './format';
import {
	WANIM_HEADER_LENGTH,
	WANIM_MAGIC,
	WANIM_NONCE_PREFIX_LENGTH,
	WANIM_SALT_LENGTH,
	WANIM_VERSION,
} from './format';

export type WanimHeader = {
	version: number;
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
	if (version !== WANIM_VERSION) {
		throw new Error(`Unsupported .wanim version: ${version}`);
	}

	return {version, manifestLength: view.getUint32(12, true)};
};

export const openWanim = ({file, key}: {file: Uint8Array; key: string}) => {
	const {manifestLength} = readWanimHeader(file);
	const salt = file.subarray(16, 16 + WANIM_SALT_LENGTH);
	const noncePrefixStart = 16 + WANIM_SALT_LENGTH;
	const context = {
		fileKey: deriveFileKey({masterKey: parseWanimKey(key), salt}),
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
	) as WanimManifest;

	return {
		manifest,
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
