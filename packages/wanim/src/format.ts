// Version 1 stores one sprite per frame, version 2 a list of transformed
// sprites per frame (layers).
export const WANIM_VERSION = 1;
export const WANIM_LAYERS_VERSION = 2;
export const WANIM_MAGIC = new Uint8Array([
	0x89, 0x57, 0x41, 0x4e, 0x49, 0x4d, 0x0d, 0x0a,
]);
// Set if the file was encrypted with a key of its own, not the official key
export const WANIM_FLAG_CUSTOM_KEY = 1;
export const WANIM_HEADER_LENGTH = 40;
export const WANIM_TAG_LENGTH = 16;
export const WANIM_KEY_LENGTH = 32;
export const WANIM_SALT_LENGTH = 16;
export const WANIM_NONCE_PREFIX_LENGTH = 8;
export const WANIM_HKDF_INFO = 'wanim/v1/aes-256-gcm';

export type WanimAtlas = {
	// Relative to the start of the data section, which directly follows the
	// encrypted manifest. Length includes the 16 byte authentication tag.
	offset: number;
	length: number;
	width: number;
	height: number;
	format: 'png';
};

// [atlas, x, y, width, height, offsetX, offsetY]
export type WanimSprite = [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

export type WanimManifest = {
	version: 1;
	compositionId: string | null;
	width: number;
	height: number;
	fps: number;
	frameCount: number;
	// True if every frame covers the whole canvas with fully opaque pixels.
	// Players can then draw with blending disabled.
	opaque: boolean;
	// Sum of width * height * 4 of all atlases
	gpuBytes: number;
	atlases: WanimAtlas[];
	sprites: WanimSprite[];
	// One entry per frame: An index into `sprites`, or -1 for an empty frame.
	frames: number[];
};

// [atlas, x, y, width, height]
export type WanimLayerSprite = [number, number, number, number, number];

export type WanimTimeline = {
	// Relative to the start of the data section, like an atlas. The timeline
	// is the block after the last atlas.
	offset: number;
	length: number;
	// Number of draws in all frames
	draws: number;
};

export type WanimLayersManifest = {
	version: 2;
	compositionId: string | null;
	width: number;
	height: number;
	fps: number;
	frameCount: number;
	opaque: boolean;
	gpuBytes: number;
	atlases: WanimAtlas[];
	sprites: WanimLayerSprite[];
	timeline: WanimTimeline;
};

// One sprite drawn in one frame. The matrix maps a pixel of the sprite to a
// pixel of the canvas: x' = a * x + c * y + tx, y' = b * x + d * y + ty
export type WanimDraw = {
	sprite: number;
	matrix: [number, number, number, number, number, number];
	alpha: number;
};

// u32 sprite, then a, b, c, d, tx, ty and alpha as f32
export const WANIM_DRAW_BYTES = 32;
