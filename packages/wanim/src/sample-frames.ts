// An animation keeps its duration at a lower frame rate: It shows fewer
// frames, each for longer.

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
