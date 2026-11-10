import type {
	WanimAnimationRange,
	WanimAnimationSet,
	WanimAtlasFormat,
	WanimCompression,
	WanimLayeredAnimation,
} from '@remotion/wanim';
import {packWanimAnimations, splitFrames} from '@remotion/wanim';

const toMegabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const formatFps = (fps: number) =>
	Number.isInteger(fps) ? String(fps) : fps.toFixed(2);

// Packs a version 3 file and says what is in it
export const packWanimSet = async ({
	set,
	key,
	compositionId,
	atlasSize,
	compression,
	atlasFormat,
	onProgress,
}: {
	set: WanimAnimationSet;
	key: string | null;
	compositionId: string | null;
	atlasSize: number | null;
	compression: WanimCompression;
	atlasFormat: WanimAtlasFormat;
	onProgress: ((progress: number) => void) | null;
}) => {
	if (compression === 'lossy' && atlasFormat !== 'webp') {
		throw new Error('--compress=lossy needs WebP atlases');
	}

	const {file, manifest} = await packWanimAnimations({
		set,
		key,
		compositionId,
		atlasSize,
		compression,
		atlasFormat,
		onProgress,
	});
	const animations =
		manifest.animations.length === 1
			? `${manifest.frameCount} frames`
			: `${manifest.animations.length} animations (${manifest.animations
					.map((a) => `${a.key}: ${a.frameCount}${a.loop ? ', loops' : ''}`)
					.join('; ')})`;
	return {
		file,
		manifest,
		summary: `${animations} at ${formatFps(manifest.fps)} fps, ${manifest.sprites.length} pictures on ${manifest.atlases.length} ${atlasFormat === 'webp' ? 'WebP' : 'PNG'} atlases, ${manifest.scene.draws} different draws, ${toMegabytes(file.length)} MB on disk, ${toMegabytes(manifest.gpuBytes)} MB on the GPU`,
	};
};

// The frames of a render, as the animations of a version 3 file. `ranges`
// count the frames of the file.
export const toWanimSet = (
	animation: WanimLayeredAnimation,
	ranges: WanimAnimationRange[] | null,
): WanimAnimationSet => ({
	width: animation.width,
	height: animation.height,
	fps: animation.fps,
	bitmaps: animation.bitmaps,
	animations: splitFrames(animation.frames, ranges),
});
