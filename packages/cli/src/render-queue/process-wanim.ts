import {mkdirSync, writeFileSync} from 'node:fs';
import {mkdtemp, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {LogLevel} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';
import {BrowserSafeApis} from '@remotion/renderer/client';
import type {JobProgressCallback, RenderJob} from '@remotion/studio-server';
import type {WanimOptions} from '@remotion/studio-shared';
import type {Matrix} from '@remotion/wanim';
import {
	packSvga,
	packWanim,
	packWanimLayers,
	sampleWanimFrames,
} from '@remotion/wanim';
import {NoReactInternals} from 'remotion/no-react';
import {convertEntryPointToServeUrl} from '../convert-entry-point-to-serve-url';
import {getCompositionWithDimensionOverride} from '../get-composition-with-dimension-override';
import {Log} from '../log';
import {parsedCli} from '../parsed-cli';
import {initialAggregateRenderProgress} from '../progress-types';
import {bundleOnCliOrTakeServeUrl} from '../setup-cache';
import {GPU_BUDGET_IN_BYTES, getWanimKey} from '../wanim';
import {renderWanimLayers} from '../wanim-layers/render-layers';
import {processVideoJob} from './process-video';
import type {StudioRenderJobFixedConfig} from './studio-render-job-fixed-config';

// Rendering takes most of the time, packing the rest
const RENDER_SHARE = 0.9;

const {
	askAIOption,
	keyboardShortcutsOption,
	browserExecutableOption,
	bundleCacheOption,
	sampleRateOption,
} = BrowserSafeApis.options;

const toMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

// Maps the captured canvas to the requested size
export const getWanimOutputTransform = ({
	capturedWidth,
	capturedHeight,
	width,
	height,
	fit,
}: {
	capturedWidth: number;
	capturedHeight: number;
	width: number;
	height: number;
	fit: WanimOptions['fit'];
}): Matrix => {
	const scaleX = width / capturedWidth;
	const scaleY = height / capturedHeight;
	if (fit === 'stretch') {
		return [scaleX, 0, 0, scaleY, 0, 0];
	}

	const uniform =
		fit === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
	return [
		uniform,
		0,
		0,
		uniform,
		Math.round((width - capturedWidth * uniform) / 2),
		Math.round((height - capturedHeight * uniform) / 2),
	];
};

const processFramesJob = async ({
	job,
	wanim,
	remotionRoot,
	entryPoint,
	onProgress,
	addCleanupCallback,
	logLevel,
	fixedConfig,
}: Parameters<typeof processWanimJob>[0]) => {
	if (job.type !== 'sequence') {
		throw new Error('Expected sequence job');
	}

	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'remotion-wanim-'));
	addCleanupCallback('Delete rendered frames', () =>
		RenderInternals.deleteDirectory(tempDir),
	);
	const framesDir = path.join(tempDir, 'frames');

	const latest: {progress: Parameters<JobProgressCallback>[0] | null} = {
		progress: null,
	};
	await processVideoJob({
		job: {
			...job,
			outName: framesDir,
			imageFormat: 'png',
			jpegQuality: null,
		} as RenderJob,
		remotionRoot,
		entryPoint,
		onProgress: (progress) => {
			latest.progress = progress;
			onProgress({...progress, value: progress.value * RENDER_SHARE});
		},
		addCleanupCallback,
		logLevel,
		fixedConfig,
	});

	// One file per frame from startFrame to endFrame, padded so that they sort
	const framePaths = (await readdir(framesDir))
		.filter((name) => name.endsWith('.png'))
		.sort()
		.map((name) => path.join(framesDir, name));
	const sampling = sampleWanimFrames({
		firstFrame: job.startFrame,
		lastFrame: job.endFrame,
		fps: wanim.fps,
		frameRate: wanim.frameRate,
		imageRate: wanim.imageRate,
	});

	const {file, manifest} = await packWanim({
		framePaths: sampling.imageFrames.map(
			(frame) => framePaths[frame - job.startFrame] as string,
		),
		fps: sampling.fps,
		key: getWanimKey(),
		compositionId: job.compositionId,
		atlasSize: null,
		canvas: {width: wanim.width, height: wanim.height, fit: wanim.fit},
		compression: wanim.compression,
		onProgress: (value) => {
			if (latest.progress) {
				onProgress({
					...latest.progress,
					message: `Packing atlases ${Math.round(value * 100)}%`,
					value: RENDER_SHARE + value * (1 - RENDER_SHARE),
				});
			}
		},
	});

	const output = path.resolve(remotionRoot, job.outName);
	mkdirSync(path.dirname(output), {recursive: true});
	writeFileSync(output, file);

	const summary = `${manifest.frameCount} frames, ${toMb(file.length)} MB on disk, ${toMb(manifest.gpuBytes)} MB on the GPU`;
	if (latest.progress) {
		onProgress({...latest.progress, message: summary, value: 1});
	}

	if (manifest.gpuBytes > GPU_BUDGET_IN_BYTES) {
		Log.warn(
			{indent: false, logLevel},
			'This animation is too large to be kept on the GPU of a phone. Consider a lower scale, a lower frame rate or the layers format.',
		);
	}
};

// Layers and SVGA need the page itself, not only screenshots of frames
const processLayersJob = async ({
	job,
	wanim,
	remotionRoot,
	entryPoint,
	onProgress,
	addCleanupCallback,
	logLevel,
	fixedConfig,
}: Parameters<typeof processWanimJob>[0]) => {
	if (job.type !== 'sequence') {
		throw new Error('Expected sequence job');
	}

	const report = (message: string, value: number) =>
		onProgress({...initialAggregateRenderProgress(), message, value});
	let cancelled = false;
	job.cancelToken.cancelSignal(() => {
		cancelled = true;
	});

	const browserExecutable = browserExecutableOption.getValue({
		commandLine: parsedCli,
	}).value;
	report('Opening the browser', 0);
	await RenderInternals.internalEnsureBrowser({
		browserExecutable,
		indent: true,
		logLevel,
		onBrowserDownload: () => ({
			version: null,
			onProgress: () => undefined,
		}),
		chromeMode: job.chromeMode,
	});
	const puppeteerInstance = await RenderInternals.internalOpenBrowser({
		browser: 'chrome',
		browserExecutable,
		chromiumOptions: job.chromiumOptions,
		forceDeviceScaleFactor: job.scale,
		indent: true,
		viewport: null,
		logLevel,
		onBrowserDownload: () => ({
			version: null,
			onProgress: () => undefined,
		}),
		chromeMode: job.chromeMode,
	});
	try {
		report('Bundling', 0.02);
		const {urlOrBundle, cleanup: cleanupBundle} =
			await bundleOnCliOrTakeServeUrl({
				fullPath: convertEntryPointToServeUrl(entryPoint),
				remotionRoot,
				publicDir: fixedConfig.publicDir,
				onProgress: () => undefined,
				indentOutput: true,
				logLevel,
				onDirectoryCreated: (dir) => {
					addCleanupCallback(`Delete ${dir}`, () =>
						RenderInternals.deleteDirectory(dir),
					);
				},
				quietProgress: true,
				quietFlag: true,
				outDir: null,
				gitSource: null,
				bufferStateDelayInMilliseconds: null,
				maxTimelineTracks: null,
				publicPath: null,
				audioLatencyHint: null,
				askAIEnabled: askAIOption.getValue({commandLine: parsedCli}).value,
				keyboardShortcutsEnabled: keyboardShortcutsOption.getValue({
					commandLine: parsedCli,
				}).value,
				rspack: fixedConfig.rspack,
				shouldCache: bundleCacheOption.getValue({commandLine: parsedCli}).value,
				bundlerOverride: fixedConfig.bundlerOverride,
				rspackOverride: fixedConfig.rspackOverride,
				webpackOverride: fixedConfig.webpackOverride,
			});
		addCleanupCallback('Cleanup bundle', () => cleanupBundle());

		const server = await RenderInternals.prepareServer({
			offthreadVideoThreads:
				job.offthreadVideoThreads ??
				RenderInternals.DEFAULT_RENDER_FRAMES_OFFTHREAD_VIDEO_THREADS,
			indent: true,
			port: fixedConfig.rendererPort,
			remotionRoot,
			logLevel,
			webpackConfigOrServeUrl: urlOrBundle,
			offthreadVideoCacheSizeInBytes: job.offthreadVideoCacheSizeInBytes,
			binariesDirectory: job.binariesDirectory,
			forceIPv4: false,
			sampleRate: sampleRateOption.getValue({commandLine: parsedCli}).value,
		});
		try {
			const {config} = await getCompositionWithDimensionOverride({
				height: null,
				width: null,
				fps: null,
				durationInFrames: null,
				args: [],
				compositionIdFromUi: job.compositionId,
				browserExecutable,
				chromiumOptions: job.chromiumOptions,
				envVariables: job.envVariables,
				indent: true,
				serializedInputPropsWithCustomSchema:
					job.serializedInputPropsWithCustomSchema,
				port: fixedConfig.rendererPort,
				puppeteerInstance,
				serveUrlOrWebpackUrl: urlOrBundle,
				timeoutInMilliseconds: job.delayRenderTimeout,
				logLevel,
				server,
				offthreadVideoCacheSizeInBytes: job.offthreadVideoCacheSizeInBytes,
				offthreadVideoThreads: job.offthreadVideoThreads,
				binariesDirectory: job.binariesDirectory,
				onBrowserDownload: () => ({
					version: null,
					onProgress: () => undefined,
				}),
				chromeMode: job.chromeMode,
				mediaCacheSizeInBytes: job.mediaCacheSizeInBytes,
				preferredEffectBackend: job.preferredEffectBackend,
			});

			const sampling = sampleWanimFrames({
				firstFrame: job.startFrame,
				lastFrame: job.endFrame,
				fps: config.fps,
				frameRate: wanim.frameRate,
				imageRate: wanim.imageRate,
			});
			const capturedWidth = config.width * job.scale;
			const capturedHeight = config.height * job.scale;
			const animation = await renderWanimLayers({
				puppeteerInstance,
				server,
				composition: config,
				serializedInputPropsWithCustomSchema:
					job.serializedInputPropsWithCustomSchema,
				serializedResolvedPropsWithCustomSchema:
					NoReactInternals.serializeJSONWithSpecialTypes({
						indent: undefined,
						staticBase: null,
						data: config.props,
					}).serializedString,
				envVariables: job.envVariables,
				scale: job.scale,
				concurrency: RenderInternals.resolveConcurrency(job.concurrency),
				timeoutInMilliseconds: job.delayRenderTimeout,
				chromiumOptions: job.chromiumOptions,
				mediaCacheSizeInBytes: job.mediaCacheSizeInBytes,
				preferredEffectBackend: job.preferredEffectBackend,
				frames: sampling.frames,
				imageFrames: sampling.imageFrames,
				fps: sampling.fps,
				outputTransform: getWanimOutputTransform({
					capturedWidth,
					capturedHeight,
					width: wanim.width,
					height: wanim.height,
					fit: wanim.fit,
				}),
				outputWidth: wanim.width,
				outputHeight: wanim.height,
				logLevel,
				onProgress: ({stage, done, total}) => {
					report(
						stage === 'describing'
							? `Reading frames ${done}/${total}`
							: `Capturing layers ${done}/${total}`,
						stage === 'describing'
							? 0.05 + (done / total) * 0.35
							: 0.4 + (done / total) * 0.5,
					);
				},
				isCancelled: () => cancelled,
			});

			report('Packing', RENDER_SHARE);
			let file: Uint8Array;
			let summary: string;
			if (wanim.format === 'layers') {
				const packed = packWanimLayers({
					animation,
					key: getWanimKey(),
					compositionId: job.compositionId,
					atlasSize: null,
					compression: wanim.compression,
					onProgress: null,
				});
				file = packed.file;
				summary = `${packed.manifest.frameCount} frames, ${packed.manifest.sprites.length} layer pictures, ${toMb(file.length)} MB on disk, ${toMb(packed.manifest.gpuBytes)} MB on the GPU`;
				if (packed.manifest.gpuBytes > GPU_BUDGET_IN_BYTES) {
					Log.warn(
						{indent: false, logLevel},
						'This animation is too large to be kept on the GPU of a phone. Consider a lower scale or a lower image rate.',
					);
				}
			} else {
				const svga = packSvga({animation, compression: wanim.compression});
				file = svga.file;
				summary = `${animation.frames.length} frames at ${svga.fps} fps, ${svga.images} images, ${toMb(file.length)} MB on disk`;
			}

			const output = path.resolve(remotionRoot, job.outName);
			mkdirSync(path.dirname(output), {recursive: true});
			writeFileSync(output, file);
			report(summary, 1);
		} finally {
			await server.closeServer(false);
		}
	} finally {
		await puppeteerInstance.close({silent: true});
	}
};

export const processWanimJob = async (options: {
	job: RenderJob;
	wanim: WanimOptions;
	remotionRoot: string;
	entryPoint: string;
	onProgress: JobProgressCallback;
	addCleanupCallback: (label: string, cb: () => void) => void;
	logLevel: LogLevel;
	fixedConfig: StudioRenderJobFixedConfig;
}) => {
	if (options.wanim.format === 'frames') {
		await processFramesJob(options);
		return;
	}

	await processLayersJob(options);
};
