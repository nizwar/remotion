import {createHash} from 'node:crypto';
import type {
	ChromiumOptions,
	HeadlessBrowser,
	LogLevel,
	RemotionServer,
} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';
import type {
	CaptureRequest,
	FrameDescription,
	Matrix,
	WanimLayerBitmap,
	WanimLayerDrawInput,
	WanimLayeredAnimation,
} from '@remotion/wanim';
import {WanimInternals} from '@remotion/wanim';
import type {VideoConfig} from 'remotion/no-react';
import {layersPageScript} from './page-script';

type Page = Awaited<ReturnType<typeof RenderInternals.makePage>>;

type Isolated = {
	origin: [number, number];
	bounds: [number, number, number, number];
	matrices: Matrix[];
} | null;

export type LayersProgress = {
	stage: 'describing' | 'capturing';
	done: number;
	total: number;
};

// Largest side of a picture of a part that is captured upright
const MAX_UPRIGHT_SIDE = 2048;

const {multiplyMatrix, invertMatrix, planLayers, decodePng, trimPng} =
	WanimInternals;

const sameMatrix = (a: Matrix, b: Matrix) =>
	a.every((value, i) => Math.abs(value - (b[i] as number)) < 0.01);

// Renders a composition into parts that are drawn with a matrix in each frame
export const renderWanimLayers = async ({
	puppeteerInstance,
	server,
	composition,
	serializedInputPropsWithCustomSchema,
	serializedResolvedPropsWithCustomSchema,
	envVariables,
	scale,
	concurrency,
	timeoutInMilliseconds,
	chromiumOptions,
	mediaCacheSizeInBytes,
	preferredEffectBackend,
	frames,
	imageFrames,
	fps,
	outputTransform,
	outputWidth,
	outputHeight,
	logLevel,
	onProgress,
	isCancelled,
}: {
	puppeteerInstance: HeadlessBrowser;
	server: RemotionServer;
	composition: VideoConfig;
	serializedInputPropsWithCustomSchema: string;
	serializedResolvedPropsWithCustomSchema: string;
	envVariables: Record<string, string>;
	// Pixels per CSS pixel of the captured pictures
	scale: number;
	concurrency: number;
	timeoutInMilliseconds: number;
	chromiumOptions: ChromiumOptions;
	mediaCacheSizeInBytes: number | null;
	preferredEffectBackend: Parameters<
		typeof RenderInternals.makePage
	>[0]['preferredEffectBackend'];
	// The source frame of each frame of the animation
	frames: number[];
	// The source frame whose look each frame shows
	imageFrames: number[];
	fps: number;
	// Maps captured pixels to the pixels of the animation
	outputTransform: Matrix;
	outputWidth: number;
	outputHeight: number;
	logLevel: LogLevel;
	onProgress: (progress: LayersProgress) => void;
	isCancelled: () => boolean;
}): Promise<WanimLayeredAnimation> => {
	const sourceFrames = [...new Set([...frames, ...imageFrames])].sort(
		(a, b) => a - b,
	);
	const pageCount = Math.max(1, Math.min(concurrency, sourceFrames.length));
	const browserReplacer = RenderInternals.handleBrowserCrash(
		puppeteerInstance,
		logLevel,
		false,
	);
	const pages: Page[] = [];
	const throwIfCancelled = () => {
		if (isCancelled()) {
			throw new Error('The render was cancelled');
		}
	};

	try {
		for (let index = 0; index < pageCount; index++) {
			const page = await RenderInternals.makePage({
				context: server.sourceMap,
				initialFrame: sourceFrames[
					Math.floor((index * sourceFrames.length) / pageCount)
				] as number,
				browserReplacer,
				logLevel,
				indent: false,
				pagesArray: [],
				onBrowserLog: null,
				scale,
				timeoutInMilliseconds,
				composition,
				proxyPort: server.offthreadPort,
				serveUrl: server.serveUrl,
				muted: true,
				envVariables,
				serializedInputPropsWithCustomSchema,
				imageFormat: 'png',
				serializedResolvedPropsWithCustomSchema,
				pageIndex: index,
				isMainTab: index === 0,
				mediaCacheSizeInBytes,
				preferredEffectBackend,
				onLog: RenderInternals.defaultOnLog,
				darkMode: chromiumOptions.darkMode ?? false,
				sampleRate: 48000,
			});
			await page.evaluate(`(${layersPageScript.toString()})()`);
			await page._client().send('Emulation.setDefaultBackgroundColorOverride', {
				color: {r: 0, g: 0, b: 0, a: 0},
			});
			pages.push(page);
		}

		const seek = (page: Page, frame: number) =>
			RenderInternals.seekToFrame({
				frame,
				page,
				composition: composition.id,
				timeoutInMilliseconds,
				logLevel,
				indent: false,
				attempt: 0,
			});

		// 1. Describe every frame. Each page takes a range of frames, so that
		// it mostly seeks forward.
		const descriptions = new Map<number, FrameDescription>();
		let described = 0;
		await Promise.all(
			pages.map(async (page, index) => {
				const start = Math.floor((index * sourceFrames.length) / pageCount);
				const end = Math.floor(((index + 1) * sourceFrames.length) / pageCount);
				for (const frame of sourceFrames.slice(start, end)) {
					throwIfCancelled();
					await seek(page, frame);
					descriptions.set(
						frame,
						(await page.evaluate(
							`window.remotion_layers.describe(${frame})`,
						)) as FrameDescription,
					);
					described++;
					onProgress({
						stage: 'describing',
						done: described,
						total: sourceFrames.length,
					});
				}
			}),
		);

		const plan = planLayers({
			descriptions,
			outputFrames: frames,
			imageFrames,
			scale,
		});

		// 2. Capture each part once
		const capturesByFrame = new Map<number, CaptureRequest[]>();
		for (const capture of plan.captures) {
			const list = capturesByFrame.get(capture.frame);
			if (list) {
				list.push(capture);
			} else {
				capturesByFrame.set(capture.frame, [capture]);
			}
		}

		type Captured = {
			bitmap: number;
			// Maps a pixel of the bitmap to the matrix space of the node
			toNode: Matrix;
		};
		const captured = new Map<string, Captured | null>();
		const bitmaps: WanimLayerBitmap[] = [];
		const bitmapByPixels = new Map<string, number>();
		const queue = [...capturesByFrame.entries()].sort((a, b) => a[0] - b[0]);
		let capturedCount = 0;

		const isolate = async (
			page: Page,
			capture: CaptureRequest,
			matrix: Matrix | null,
		) =>
			(await page.evaluate(
				`window.remotion_layers.isolate(${JSON.stringify([
					{path: capture.path, ownPaint: capture.ownPaint, matrix},
				])})`,
			)) as Isolated;

		const screenshot = async (page: Page, clip: number[]) => {
			const client = page._client();
			await client.send('Target.activateTarget', {
				targetId: page.target()._targetId,
			});
			const {value} = await client.send('Page.captureScreenshot', {
				format: 'png',
				clip: {
					x: clip[0] as number,
					y: clip[1] as number,
					width: clip[2] as number,
					height: clip[3] as number,
					scale: 1,
				},
				captureBeyondViewport: true,
				fromSurface: true,
			});
			return decodePng(new Uint8Array(Buffer.from(value.data, 'base64')));
		};

		const captureOne = async (page: Page, capture: CaptureRequest) => {
			const isRoot = capture.path === '';
			// Moves keep the pixel grid
			const step = 1 / scale;
			let matrix: Matrix | null = null;
			let result = await isolate(page, capture, null);
			if (result === null) {
				return null;
			}

			if (capture.uprightScale !== null) {
				let size = capture.uprightScale;
				for (let attempt = 0; attempt < 2; attempt++) {
					result = await isolate(page, capture, [size, 0, 0, size, 0, 0]);
					if (result === null) {
						return null;
					}

					const largest = Math.max(result.bounds[2], result.bounds[3]) * scale;
					if (largest <= MAX_UPRIGHT_SIDE) {
						break;
					}

					size *= MAX_UPRIGHT_SIDE / largest;
				}

				matrix = [size, 0, 0, size, 0, 0];
			}

			let margin = 4 + 0.1 * Math.max(result.bounds[2], result.bounds[3]);
			for (let attempt = 0; attempt < 3; attempt++) {
				if (!isRoot) {
					// Room around the part, so that effects like shadows fit
					const base = matrix ?? (result.matrices[0] as Matrix);
					const shiftX =
						result.bounds[0] < margin
							? Math.ceil((margin - result.bounds[0]) / step) * step
							: 0;
					const shiftY =
						result.bounds[1] < margin
							? Math.ceil((margin - result.bounds[1]) / step) * step
							: 0;
					if (shiftX !== 0 || shiftY !== 0 || matrix !== null) {
						matrix = [
							base[0],
							base[1],
							base[2],
							base[3],
							base[4] + shiftX,
							base[5] + shiftY,
						];
						result = await isolate(page, capture, matrix);
						if (result === null) {
							return null;
						}
					}
				}

				const [bx, by, bw, bh] = result.bounds;
				const clip = isRoot
					? [result.origin[0], result.origin[1], bw, bh]
					: [
							result.origin[0] + Math.max(0, Math.floor(bx - margin)),
							result.origin[1] + Math.max(0, Math.floor(by - margin)),
							Math.ceil(bw + margin * 2) + 2,
							Math.ceil(bh + margin * 2) + 2,
						];
				if ((clip[2] as number) <= 0 || (clip[3] as number) <= 0) {
					return null;
				}

				const trimmed = trimPng(await screenshot(page, clip));
				if (trimmed === null) {
					return null;
				}

				if (!isRoot && trimmed.touchesEdge && attempt < 2) {
					margin *= 3;
					continue;
				}

				const actual = result.matrices[0] as Matrix;
				if (matrix !== null && !sameMatrix(actual, matrix)) {
					RenderInternals.Log.verbose(
						{indent: false, logLevel},
						`Could not move ${capture.path} for capturing, capturing it where it is`,
					);
				}

				// Bitmap pixel -> CSS pixel of the capture -> node space
				const toCss: Matrix = [
					1 / scale,
					0,
					0,
					1 / scale,
					(clip[0] as number) - result.origin[0] + trimmed.x / scale,
					(clip[1] as number) - result.origin[1] + trimmed.y / scale,
				];
				const pixels = createHash('sha1')
					.update(`${trimmed.width}x${trimmed.height}`)
					.update(trimmed.data)
					.digest('base64');
				let bitmap = bitmapByPixels.get(pixels);
				if (bitmap === undefined) {
					bitmap = bitmaps.length;
					bitmapByPixels.set(pixels, bitmap);
					bitmaps.push({
						width: trimmed.width,
						height: trimmed.height,
						png: trimmed.png,
					});
				}

				return {bitmap, toNode: multiplyMatrix(invertMatrix(actual), toCss)};
			}

			return null;
		};

		await Promise.all(
			pages.map(async (page) => {
				for (;;) {
					const next = queue.shift();
					if (!next) {
						return;
					}

					const [frame, list] = next;
					throwIfCancelled();
					await seek(page, frame);
					for (const capture of list) {
						captured.set(capture.key, await captureOne(page, capture));
						capturedCount++;
						onProgress({
							stage: 'capturing',
							done: capturedCount,
							total: plan.captures.length,
						});
					}

					await page.evaluate('window.remotion_layers.restore()');
				}
			}),
		);

		const toOutput = multiplyMatrix(outputTransform, [
			scale,
			0,
			0,
			scale,
			0,
			0,
		]);
		const drawFrames = plan.frames.map((units) =>
			units.flatMap((unit): WanimLayerDrawInput[] => {
				const part = captured.get(unit.key);
				if (!part) {
					return [];
				}

				return [
					{
						bitmap: part.bitmap,
						matrix: multiplyMatrix(
							toOutput,
							multiplyMatrix(unit.matrix, part.toNode),
						),
						alpha: unit.alpha,
					},
				];
			}),
		);

		return {
			width: outputWidth,
			height: outputHeight,
			fps,
			frames: drawFrames,
			bitmaps,
		};
	} finally {
		await Promise.all(pages.map((page) => page.close().catch(() => undefined)));
	}
};
