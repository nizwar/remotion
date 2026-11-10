// An animation keeps its duration at a lower frame rate: It shows fewer
// frames, each for longer.

import type {WanimAnimationRange} from './convert-wanim';

const EPSILON = 1e-6;

export type WanimFrameSampling = {
	// The playback speed of the file
	fps: number;
	// The source frame of each frame of the file
	frames: number[];
	// The source frame whose look each frame shows. Equal to `frames`, unless
	// pictures change less often than the animation moves.
	imageFrames: number[];
};

export const sampleWanimFrames = ({
	firstFrame,
	lastFrame,
	fps,
	frameRate,
	imageRate,
}: {
	// Range of source frames, both included
	firstFrame: number;
	lastFrame: number;
	// Frame rate of the composition
	fps: number;
	// Frames per second of the file. `null` keeps every frame.
	frameRate: number | null;
	// How many times per second a part may change its look. `null` lets it
	// change in every frame.
	imageRate: number | null;
}): WanimFrameSampling => {
	if (frameRate !== null && !(frameRate > 0)) {
		throw new TypeError(`The frame rate must be positive, got ${frameRate}`);
	}

	if (imageRate !== null && !(imageRate > 0)) {
		throw new TypeError(`The image rate must be positive, got ${imageRate}`);
	}

	const sourceCount = lastFrame - firstFrame + 1;
	const rate = frameRate === null ? fps : Math.min(frameRate, fps);
	const count = Math.max(1, Math.round((sourceCount * rate) / fps));
	const sourceFrameAt = (seconds: number) =>
		firstFrame + Math.min(sourceCount - 1, Math.floor(seconds * fps + EPSILON));

	const frames: number[] = [];
	const imageFrames: number[] = [];
	for (let index = 0; index < count; index++) {
		const seconds = index / rate;
		frames.push(sourceFrameAt(seconds));
		imageFrames.push(
			imageRate === null || imageRate >= rate
				? sourceFrameAt(seconds)
				: sourceFrameAt(Math.floor(seconds * imageRate + EPSILON) / imageRate),
		);
	}

	return {fps: rate, frames, imageFrames};
};

// Samples each animation on its own, so that each starts on its first frame
// and keeps its duration. The ranges that are returned count the frames of
// the file, not those of the composition.
export const sampleWanimAnimations = ({
	firstFrame,
	lastFrame,
	fps,
	frameRate,
	imageRate,
	animations,
}: {
	firstFrame: number;
	lastFrame: number;
	fps: number;
	frameRate: number | null;
	imageRate: number | null;
	// Ranges of source frames. `null` for one animation of all frames.
	animations: WanimAnimationRange[] | null;
}): WanimFrameSampling & {animations: WanimAnimationRange[] | null} => {
	if (animations === null) {
		return {
			...sampleWanimFrames({firstFrame, lastFrame, fps, frameRate, imageRate}),
			animations: null,
		};
	}

	if (animations.length === 0) {
		throw new Error('At least one animation is needed');
	}

	const frames: number[] = [];
	const imageFrames: number[] = [];
	const ranges: WanimAnimationRange[] = [];
	let rate = fps;
	for (const {key, from, to, loop} of animations) {
		if (
			!Number.isInteger(from) ||
			!Number.isInteger(to) ||
			from < firstFrame ||
			to < from ||
			to > lastFrame
		) {
			throw new RangeError(
				`The animation "${key}" spans the frames ${from}-${to}, but the frames ${firstFrame}-${lastFrame} are rendered`,
			);
		}

		const sampled = sampleWanimFrames({
			firstFrame: from,
			lastFrame: to,
			fps,
			frameRate,
			imageRate,
		});
		rate = sampled.fps;
		ranges.push({
			key,
			from: frames.length,
			to: frames.length + sampled.frames.length - 1,
			loop,
		});
		frames.push(...sampled.frames);
		imageFrames.push(...sampled.imageFrames);
	}

	return {fps: rate, frames, imageFrames, animations: ranges};
};
