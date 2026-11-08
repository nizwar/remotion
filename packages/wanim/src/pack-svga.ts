// Writes an SVGA 2.0 file: A zlib compressed protobuf `MovieEntity`, see
// https://github.com/svga/SVGA-Format. SVGA files are not encrypted.
import {deflateSync} from 'node:zlib';
import {PNG} from 'pngjs';
import type {WanimCompression} from './compress-atlas';
import {encodePng} from './container';
import {concatBytes} from './crypto';
import type {WanimLayerDrawInput, WanimLayeredAnimation} from './pack-layers';
import {cullDraws} from './pack-layers';

// Minimal protobuf encoder: Only what MovieEntity needs
const varint = (value: number) => {
	const bytes: number[] = [];
	let v = value;
	while (v > 0x7f) {
		bytes.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}

	bytes.push(v);
	return bytes;
};

const tag = (field: number, wireType: number) => varint(field * 8 + wireType);

const floatField = (field: number, value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setFloat32(0, value, true);
	return concatBytes([tag(field, 5), bytes]);
};

const intField = (field: number, value: number) =>
	new Uint8Array([...tag(field, 0), ...varint(value)]);

const bytesField = (field: number, value: Uint8Array) =>
	concatBytes([tag(field, 2), varint(value.length), value]);

const stringField = (field: number, value: string) =>
	bytesField(field, new TextEncoder().encode(value));

// Players read a missing `a` or `d` as 1, and protobuf leaves out zeros. A
// sprite turned by 90 degrees would then be drawn wrong.
const NEARLY_ZERO = 1e-7;

const frameEntity = (
	draw: WanimLayerDrawInput | null,
	width: number,
	height: number,
) => {
	if (draw === null) {
		return new Uint8Array(0);
	}

	const [a, b, c, d, tx, ty] = draw.matrix;
	return concatBytes([
		floatField(1, Math.min(1, draw.alpha)),
		bytesField(2, concatBytes([floatField(3, width), floatField(4, height)])),
		bytesField(
			3,
			concatBytes([
				floatField(1, a === 0 ? NEARLY_ZERO : a),
				floatField(2, b),
				floatField(3, c),
				floatField(4, d === 0 ? NEARLY_ZERO : d),
				floatField(5, tx),
				floatField(6, ty),
			]),
		),
	]);
};

type Track = {bitmap: number; draws: (WanimLayerDrawInput | null)[]};

// SVGA draws its sprites in one fixed order, each sprite showing one image.
// Draws are assigned to sprites so that every frame keeps its own order: A
// draw takes the next sprite of its image after the previous draw, or a new
// sprite right there.
export const assignTracks = (frames: WanimLayerDrawInput[][]): Track[] => {
	const tracks: Track[] = [];
	frames.forEach((draws, frame) => {
		let position = -1;
		for (const draw of draws) {
			let found = -1;
			for (let index = position + 1; index < tracks.length; index++) {
				const track = tracks[index] as Track;
				if (track.bitmap === draw.bitmap && !track.draws[frame]) {
					found = index;
					break;
				}
			}

			if (found === -1) {
				found = position + 1;
				tracks.splice(found, 0, {
					bitmap: draw.bitmap,
					draws: new Array(frames.length).fill(null),
				});
			}

			(tracks[found] as Track).draws[frame] = draw;
			position = found;
		}
	});
	return tracks;
};

export const packSvga = ({
	animation,
	compression,
}: {
	animation: WanimLayeredAnimation;
	compression: WanimCompression;
}): {file: Uint8Array; fps: number; sprites: number; images: number} => {
	if (animation.frames.length === 0) {
		throw new Error('Cannot create an SVGA file without frames');
	}

	const frames = cullDraws(animation);
	const tracks = assignTracks(frames);
	const usedBitmaps = [...new Set(tracks.map((track) => track.bitmap))];
	const imageKey = (bitmap: number) => `img_${usedBitmaps.indexOf(bitmap)}`;

	// SVGA only knows whole frame rates
	const fps = Math.max(1, Math.round(animation.fps));
	const params = concatBytes([
		floatField(1, animation.width),
		floatField(2, animation.height),
		intField(3, fps),
		intField(4, frames.length),
	]);

	const images = usedBitmaps.map((bitmap) => {
		const image = animation.bitmaps[bitmap];
		if (!image) {
			throw new RangeError(`No bitmap with index ${bitmap}`);
		}

		const png =
			compression === 'none'
				? image.png
				: encodePng(PNG.sync.read(Buffer.from(image.png)), compression);
		return bytesField(
			3,
			concatBytes([stringField(1, imageKey(bitmap)), bytesField(2, png)]),
		);
	});

	const sprites = tracks.map((track) => {
		const image = animation.bitmaps[track.bitmap];
		if (!image) {
			throw new RangeError(`No bitmap with index ${track.bitmap}`);
		}

		return bytesField(
			4,
			concatBytes([
				stringField(1, imageKey(track.bitmap)),
				...track.draws.map((draw) =>
					bytesField(2, frameEntity(draw, image.width, image.height)),
				),
			]),
		);
	});

	const movie = concatBytes([
		stringField(1, '2.0'),
		bytesField(2, params),
		...images,
		...sprites,
	]);

	return {
		file: new Uint8Array(deflateSync(movie, {level: 9})),
		fps,
		sprites: tracks.length,
		images: usedBitmaps.length,
	};
};
