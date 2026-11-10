import {PNG} from 'pngjs';
import type {
	WanimAnimationsManifest,
	WanimDraw,
	WanimLayerSprite,
	WanimLayersManifest,
	WanimManifest,
} from './format';
import {
	WANIM_ANIMATIONS_VERSION,
	WANIM_DEFAULT_ANIMATION_KEY,
	WANIM_LAYERS_VERSION,
} from './format';
import {openWanim} from './open-wanim';
import type {WanimAnimationInput, WanimAnimationSet} from './pack-animations';
import type {WanimLayerBitmap, WanimLayerDrawInput} from './pack-layers';

// Splits the frames of an animation into several animations with keys
export type WanimAnimationRange = {
	key: string;
	// First and last frame, both included
	from: number;
	to: number;
	loop: boolean;
};

export const splitFrames = <T>(
	frames: T[],
	ranges: WanimAnimationRange[] | null,
): {key: string; loop: boolean; frames: T[]}[] => {
	if (ranges === null) {
		return [{key: WANIM_DEFAULT_ANIMATION_KEY, loop: true, frames}];
	}

	return ranges.map(({key, from, to, loop}) => {
		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			from < 0 ||
			to < from ||
			to >= frames.length
		) {
			throw new RangeError(
				`The animation "${key}" spans the frames ${from}-${to}, but there are the frames 0-${frames.length - 1}`,
			);
		}

		return {key, loop, frames: frames.slice(from, to + 1)};
	});
};

// Reads the pictures and draws of a file of any version, to pack them again.
// A decoder for WebP atlases is only needed for version 3 files that use them.
export const readWanimAsSet = async ({
	file,
	key,
	decodeWebp,
}: {
	file: Uint8Array;
	key: string | null;
	decodeWebp:
		| ((
				bytes: Uint8Array,
		  ) => Promise<{width: number; height: number; data: Uint8Array}>)
		| null;
}): Promise<WanimAnimationSet> => {
	const opened = openWanim({file, key});
	const manifest = opened.manifest as
		| WanimManifest
		| WanimLayersManifest
		| WanimAnimationsManifest;
	const atlases = await Promise.all(
		manifest.atlases.map(async (atlas, index) => {
			const bytes = opened.readAtlas(index);
			if (atlas.format === 'webp') {
				if (decodeWebp === null) {
					throw new Error('This file has WebP atlases, pass a decoder');
				}

				return decodeWebp(bytes);
			}

			const png = PNG.sync.read(Buffer.from(bytes));
			return {
				width: png.width,
				height: png.height,
				data: new Uint8Array(png.data),
			};
		}),
	);

	// Versions 2 and 3 keep a transparent border of 1 pixel inside of the
	// rectangle of a sprite, which the packer adds again
	const border = manifest.version === 1 ? 0 : 1;
	const bitmaps: WanimLayerBitmap[] = (
		manifest.sprites as (WanimLayerSprite | number[])[]
	).map((sprite) => {
		const [atlasIndex, x, y, w, h] = sprite as WanimLayerSprite;
		const atlas = atlases[atlasIndex] as (typeof atlases)[number];
		const width = w - border * 2;
		const height = h - border * 2;
		const png = new PNG({width, height});
		for (let row = 0; row < height; row++) {
			const start = ((y + border + row) * atlas.width + x + border) * 4;
			png.data.set(
				atlas.data.subarray(start, start + width * 4),
				row * width * 4,
			);
		}

		return {
			width,
			height,
			png: new Uint8Array(PNG.sync.write(png, {deflateLevel: 1})),
		};
	});

	const toInput = (draws: WanimDraw[]): WanimLayerDrawInput[] =>
		draws.map(({sprite, matrix, alpha}) => ({
			bitmap: sprite,
			// The stored matrix maps the sprite with its border
			matrix: [
				matrix[0],
				matrix[1],
				matrix[2],
				matrix[3],
				matrix[0] * border + matrix[2] * border + matrix[4],
				matrix[1] * border + matrix[3] * border + matrix[5],
			],
			alpha,
		}));

	let animations: WanimAnimationInput[];
	if (manifest.version === WANIM_ANIMATIONS_VERSION) {
		const scene = opened.readScene();
		animations = manifest.animations.map((animation) => ({
			key: animation.key,
			loop: animation.loop,
			frames: (scene.frames[animation.key] as number[]).map((list) =>
				toInput(
					(scene.lists[list] as number[]).map(
						(draw) => scene.draws[draw] as WanimDraw,
					),
				),
			),
		}));
	} else if (manifest.version === WANIM_LAYERS_VERSION) {
		animations = [
			{
				key: WANIM_DEFAULT_ANIMATION_KEY,
				loop: true,
				frames: opened.readTimeline().map(toInput),
			},
		];
	} else {
		animations = [
			{
				key: WANIM_DEFAULT_ANIMATION_KEY,
				loop: true,
				frames: manifest.frames.map((sprite): WanimLayerDrawInput[] => {
					if (sprite === -1) {
						return [];
					}

					const [, , , , , dx, dy] = manifest.sprites[sprite] as number[];
					return [
						{
							bitmap: sprite,
							matrix: [1, 0, 0, 1, dx as number, dy as number],
							alpha: 1,
						},
					];
				}),
			},
		];
	}

	return {
		width: manifest.width,
		height: manifest.height,
		fps: manifest.fps,
		animations,
		bitmaps,
	};
};

// Gives the frames of a set other keys. The set must hold one animation.
export const rekeyAnimationSet = (
	set: WanimAnimationSet,
	ranges: WanimAnimationRange[] | null,
): WanimAnimationSet => {
	if (ranges === null) {
		return set;
	}

	if (set.animations.length !== 1) {
		throw new Error(
			'Only a file with a single animation can be split into animations',
		);
	}

	return {
		...set,
		animations: splitFrames(
			(set.animations[0] as WanimAnimationInput).frames,
			ranges,
		),
	};
};
