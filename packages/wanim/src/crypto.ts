import {
	createCipheriv,
	createDecipheriv,
	hkdfSync,
	randomBytes,
} from 'node:crypto';
import {
	WANIM_HKDF_INFO,
	WANIM_KEY_LENGTH,
	WANIM_NONCE_PREFIX_LENGTH,
	WANIM_TAG_LENGTH,
} from './format';

export const generateWanimKey = (): string => {
	return randomBytes(WANIM_KEY_LENGTH).toString('hex');
};

export const concatBytes = (parts: ArrayLike<number>[]): Uint8Array => {
	const result = new Uint8Array(
		parts.reduce((sum, part) => sum + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}

	return result;
};

export const parseWanimKey = (key: string): Uint8Array => {
	const trimmed = key.trim();
	if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		throw new TypeError(
			'A .wanim key must be 64 hexadecimal characters (32 bytes). Create one using generateWanimKey() or `remotion wanim keygen`.',
		);
	}

	return new Uint8Array(Buffer.from(trimmed, 'hex'));
};

export const deriveFileKey = ({
	masterKey,
	salt,
}: {
	masterKey: Uint8Array;
	salt: Uint8Array;
}): Uint8Array => {
	return new Uint8Array(
		hkdfSync('sha256', masterKey, salt, WANIM_HKDF_INFO, WANIM_KEY_LENGTH),
	);
};

const blockIv = ({
	noncePrefix,
	blockIndex,
}: {
	noncePrefix: Uint8Array;
	blockIndex: number;
}) => {
	const iv = new Uint8Array(WANIM_NONCE_PREFIX_LENGTH + 4);
	iv.set(noncePrefix);
	new DataView(iv.buffer).setUint32(
		WANIM_NONCE_PREFIX_LENGTH,
		blockIndex,
		true,
	);
	return iv;
};

const blockAad = ({
	header,
	blockIndex,
}: {
	header: Uint8Array;
	blockIndex: number;
}) => {
	const index = new Uint8Array(4);
	new DataView(index.buffer).setUint32(0, blockIndex, true);
	return concatBytes([header, index]);
};

export type WanimBlockContext = {
	fileKey: Uint8Array;
	noncePrefix: Uint8Array;
	// Each block authenticates the header and its own index, so blocks can
	// neither be reordered nor moved into another file.
	header: Uint8Array;
};

export const encryptBlock = ({
	context,
	blockIndex,
	plaintext,
}: {
	context: WanimBlockContext;
	blockIndex: number;
	plaintext: Uint8Array;
}): Uint8Array => {
	const cipher = createCipheriv(
		'aes-256-gcm',
		context.fileKey,
		blockIv({noncePrefix: context.noncePrefix, blockIndex}),
	);
	cipher.setAAD(blockAad({header: context.header, blockIndex}));
	return concatBytes([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
};

export const decryptBlock = ({
	context,
	blockIndex,
	ciphertext,
}: {
	context: WanimBlockContext;
	blockIndex: number;
	ciphertext: Uint8Array;
}): Uint8Array => {
	if (ciphertext.length < WANIM_TAG_LENGTH) {
		throw new Error('Invalid .wanim file: Encrypted block is truncated');
	}

	const tagStart = ciphertext.length - WANIM_TAG_LENGTH;
	const decipher = createDecipheriv(
		'aes-256-gcm',
		context.fileKey,
		blockIv({noncePrefix: context.noncePrefix, blockIndex}),
	);
	decipher.setAAD(blockAad({header: context.header, blockIndex}));
	decipher.setAuthTag(ciphertext.subarray(tagStart));
	try {
		return concatBytes([
			decipher.update(ciphertext.subarray(0, tagStart)),
			decipher.final(),
		]);
	} catch {
		throw new Error(
			'Could not decrypt .wanim file: The key is wrong or the file was modified.',
		);
	}
};
