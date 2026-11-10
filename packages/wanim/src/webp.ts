import type {WanimCompression} from './compress-atlas';
import {posterize, quantize} from './compress-atlas';

type Sharp = (
	input: Uint8Array,
	options: {raw: {width: number; height: number; channels: 4}},
) => {
	webp: (options: Record<string, unknown>) => {toBuffer: () => Promise<Buffer>};
};

const loadSharp = async (): Promise<Sharp> => {
	try {
		// Not a static import: Only WebP atlases need it
		const name = 'sharp';
		const imported = await import(name);
		return (imported.default ?? imported) as Sharp;
	} catch {
		throw new Error(
			'WebP atlases need the "sharp" package. Install it, or use PNG atlases.',
		);
	}
};

// Straight alpha RGBA to WebP. `none`, `balanced` and `small` are lossless
// encodings of pixels that were reduced like for a PNG, `lossy` is a lossy
// WebP with lossless alpha. The pixels are changed in place.
export const encodeWebp = async ({
	data,
	width,
	height,
	compression,
}: {
	data: Uint8Array;
	width: number;
	height: number;
	compression: WanimCompression;
}): Promise<Uint8Array> => {
	const sharp = await loadSharp();
	if (compression === 'balanced') {
		posterize(data);
	} else if (compression === 'small') {
		quantize({data, width, height});
	}

	const image = sharp(data, {raw: {width, height, channels: 4}});
	const encoded = await image
		.webp(
			compression === 'lossy'
				? {
						quality: 90,
						alphaQuality: 100,
						effort: 6,
						smartSubsample: true,
					}
				: {lossless: true, effort: 6},
		)
		.toBuffer();
	return new Uint8Array(encoded);
};
