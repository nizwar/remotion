export type {WanimCompression} from './compress-atlas';
export {generateWanimKey} from './crypto';
export type {WanimCanvas} from './fit-frame';
export {readWanimAsSet, rekeyAnimationSet, splitFrames} from './convert-wanim';
export type {WanimAnimationRange} from './convert-wanim';
export {WANIM_DEFAULT_ANIMATION_KEY} from './format';
export type {
	WanimAnimationEntry,
	WanimAnimationsManifest,
	WanimAtlas,
	WanimDraw,
	WanimLayerSprite,
	WanimLayersManifest,
	WanimManifest,
	WanimScene,
	WanimSceneData,
	WanimSprite,
	WanimTimeline,
} from './format';
export {readFramesAsAnimation} from './frames-to-set';
export {openWanim, readWanimHeader} from './open-wanim';
export type {WanimHeader} from './open-wanim';
export {packWanimAnimations} from './pack-animations';
export type {
	PackWanimAnimationsOptions,
	PackWanimAnimationsResult,
	WanimAnimationInput,
	WanimAnimationSet,
	WanimAtlasFormat,
} from './pack-animations';
export {packWanimLayers} from './pack-layers';
export type {
	PackWanimLayersOptions,
	WanimLayerBitmap,
	WanimLayerDrawInput,
	WanimLayeredAnimation,
} from './pack-layers';
export {packSvga} from './pack-svga';
export {packWanim} from './pack-wanim';
export type {PackWanimOptions, PackWanimResult} from './pack-wanim';
export {sampleWanimFrames} from './sample-frames';
export type {WanimFrameSampling} from './sample-frames';

import {invertMatrix, multiplyMatrix, planLayers} from './plan-layers';
import {decodePng, trimPng} from './png';

// For the renderer of the CLI, not a public API
export const WanimInternals = {
	planLayers,
	multiplyMatrix,
	invertMatrix,
	decodePng,
	trimPng,
};
export type {
	CaptureRequest,
	FrameDescription,
	LayerNode,
	LayerPlan,
	LayerUnit,
	Matrix,
} from './plan-layers';
