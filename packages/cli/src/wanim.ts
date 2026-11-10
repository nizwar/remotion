import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LicensingInternals} from '@remotion/licensing';
import type {ChromiumOptions, LogLevel} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';
import {BrowserSafeApis} from '@remotion/renderer/client';
import {parseWanimAnimations} from '@remotion/studio-shared';
import type {WanimAtlasFormat, WanimCompression} from '@remotion/wanim';
import {
	canUseWebp,
	decodeWebp,
	generateWanimKey,
	openWanim,
	packSvga,
	packWanim,
	packWanimLayers,
	readFramesAsAnimation,
	readWanimAsSet,
	readWanimHeader,
	rekeyAnimationSet,
	sampleWanimAnimations,
} from '@remotion/wanim';
import {NoReactInternals} from 'remotion/no-react';
import {defaultBrowserDownloadProgress} from './browser-download-bar';
import {chalk} from './chalk';
import {registerCleanupJob} from './cleanup-before-quit';
import {getRendererPortFromConfigFileAndCliFlag} from './config/preview-server';
import {convertEntryPointToServeUrl} from './convert-entry-point-to-serve-url';
import {findEntryPoint} from './entry-point';
import {getCliOptions} from './get-cli-options';
import {getCompositionWithDimensionOverride} from './get-composition-with-dimension-override';
import {getLicenseKey} from './get-license-key';
import {Log} from './log';
import {parsedCli, quietFlagProvided} from './parsed-cli';
import {createOverwriteableCliOutput} from './progress-bar';
import {bundleOnCliOrTakeServeUrl} from './setup-cache';
import {shouldUseNonOverlayingLogger} from './should-use-non-overlaying-logger';
import {getOutputLocation} from './user-passed-output-location';
import {renderWanimLayers} from './wanim-layers/render-layers';
import {packWanimSet, toWanimSet} from './wanim-pack';

// `frames` stores one picture per frame, `layers` moving parts as layers
export type WanimFormat = 'frames' | 'layers' | 'svga';

const toMegabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const formatFps = (fps: number) =>
	Number.isInteger(fps) ? String(fps) : fps.toFixed(2);

export const WANIM_COMMAND = 'wanim';
export const WANIM_RENDER_COMMAND = 'render';
export const WANIM_KEYGEN_COMMAND = 'keygen';
export const WANIM_INSPECT_COMMAND = 'inspect';
export const WANIM_CONVERT_COMMAND = 'convert';

// Above this, a player can no longer keep all atlases on the GPU of a phone
export const GPU_BUDGET_IN_BYTES = 256 * 1024 * 1024;

const {
	offthreadVideoCacheSizeInBytesOption,
	scaleOption,
	enableMultiprocessOnLinuxOption,
	glOption,
	delayRenderTimeoutInMillisecondsOption,
	headlessOption,
	overwriteOption,
	binariesDirectoryOption,
	publicPathOption,
	publicDirOption,
	chromeModeOption,
	offthreadVideoThreadsOption,
	mediaCacheSizeInBytesOption,
	preferredEffectBackendOption,
	darkModeOption,
	askAIOption,
	keyboardShortcutsOption,
	rspackOption,
	browserExecutableOption,
	userAgentOption,
	disableWebSecurityOption,
	ignoreCertificateErrorsOption,
	overrideHeightOption,
	overrideWidthOption,
	overrideFpsOption,
	overrideDurationOption,
	bundleCacheOption,
	concurrencyOption,
	everyNthFrameOption,
	sampleRateOption,
	isProductionOption,
} = BrowserSafeApis.options;

// Not a `REMOTION_` variable on purpose: Those get exposed to the bundle.
export const getWanimKey = (): string | null => {
	const keyFile = (parsedCli as unknown as Record<string, unknown>)['key-file'];
	if (typeof keyFile === 'string') {
		return readFileSync(keyFile, 'utf8');
	}

	return process.env.WANIM_KEY ?? null;
};

const flags = () => parsedCli as unknown as Record<string, unknown>;

export const parseWanimCompression = (value: unknown): WanimCompression => {
	const compression = value === undefined ? 'none' : value;
	if (
		compression !== 'none' &&
		compression !== 'balanced' &&
		compression !== 'small' &&
		compression !== 'lossy'
	) {
		throw new Error(
			`--compress must be "none", "balanced", "small" or "lossy", got ${value}`,
		);
	}

	return compression;
};

// Version 3 is what new files are. 1 and 2 are for players that are older.
export const parseWanimVersion = (value: unknown): 1 | 2 | 3 => {
	if (value === undefined) {
		return 3;
	}

	const version = Number(value);
	if (version !== 1 && version !== 2 && version !== 3) {
		throw new Error(`--wanim-version must be 1, 2 or 3, got ${value}`);
	}

	return version;
};

// WebP atlases are smaller, but need a package that may not be installed
export const resolveWanimAtlasFormat = async (
	value: unknown,
	logLevel: LogLevel,
): Promise<WanimAtlasFormat> => {
	if (value !== undefined && value !== 'png' && value !== 'webp') {
		throw new Error(`--atlas-format must be "png" or "webp", got ${value}`);
	}

	if (value === 'png') {
		return 'png';
	}

	if (await canUseWebp()) {
		return 'webp';
	}

	if (value === 'webp') {
		throw new Error(
			'WebP atlases need the "sharp" package. Install it, or pass --atlas-format=png.',
		);
	}

	Log.warn(
		{indent: false, logLevel},
		'The "sharp" package is not installed, so the atlases are PNG instead of the smaller WebP.',
	);
	return 'png';
};

const renderWanim = async (
	remotionRoot: string,
	args: string[],
	logLevel: LogLevel,
) => {
	const key = getWanimKey();
	const licenseKey = getLicenseKey();
	const atlasSizeFlag = (parsedCli as unknown as Record<string, unknown>)[
		'atlas-size'
	];
	const atlasSize = atlasSizeFlag === undefined ? null : Number(atlasSizeFlag);
	if (atlasSize !== null && !Number.isInteger(atlasSize)) {
		throw new Error(`--atlas-size must be a number, got ${atlasSizeFlag}`);
	}

	const compression = parseWanimCompression(flags().compress);
	const wanimVersion = parseWanimVersion(flags()['wanim-version']);
	const animationRanges = parseWanimAnimations(flags().animations);

	const cliFlags = parsedCli as unknown as Record<string, unknown>;
	const readRate = (name: string) => {
		const value = cliFlags[name];
		if (value === undefined) {
			return null;
		}

		const rate = Number(value);
		if (!(rate > 0)) {
			throw new Error(`--${name} must be a positive number, got ${value}`);
		}

		return rate;
	};

	const frameRateFlag = readRate('frame-rate');
	const imageRate = readRate('image-rate');

	const {file, remainingArgs} = findEntryPoint({
		args,
		remotionRoot,
		logLevel,
		allowDirectory: true,
	});
	if (!file) {
		throw new Error(
			`No entry point specified. Usage: remotion ${WANIM_COMMAND} ${WANIM_RENDER_COMMAND} [entry-point] [composition-id] [out-name]`,
		);
	}

	const {frameRange, selectedFrames, inputProps, envVariables} = getCliOptions({
		isStill: false,
		logLevel,
		indent: false,
	});
	if (selectedFrames !== null) {
		throw new Error(
			'A .wanim file plays at a constant frame rate, so comma-separated `--frames` are not supported.',
		);
	}

	const commandLine = {commandLine: parsedCli};
	const everyNthFrame = everyNthFrameOption.getValue(commandLine).value;
	const browserExecutable = browserExecutableOption.getValue(commandLine).value;
	const chromeMode = chromeModeOption.getValue(commandLine).value;
	const scale = scaleOption.getValue(commandLine).value;
	const binariesDirectory = binariesDirectoryOption.getValue(commandLine).value;
	const offthreadVideoCacheSizeInBytes =
		offthreadVideoCacheSizeInBytesOption.getValue(commandLine).value;
	const offthreadVideoThreads =
		offthreadVideoThreadsOption.getValue(commandLine).value;
	const mediaCacheSizeInBytes =
		mediaCacheSizeInBytesOption.getValue(commandLine).value;
	const preferredEffectBackend =
		preferredEffectBackendOption.getValue(commandLine).value;
	const timeoutInMilliseconds =
		delayRenderTimeoutInMillisecondsOption.getValue(commandLine).value;
	const port = getRendererPortFromConfigFileAndCliFlag();
	const quiet = quietFlagProvided();

	const chromiumOptions: Required<ChromiumOptions> = {
		disableWebSecurity: disableWebSecurityOption.getValue(commandLine).value,
		enableMultiProcessOnLinux:
			enableMultiprocessOnLinuxOption.getValue(commandLine).value,
		gl: glOption.getValue(commandLine).value,
		headless: headlessOption.getValue(commandLine).value,
		ignoreCertificateErrors:
			ignoreCertificateErrorsOption.getValue(commandLine).value,
		userAgent: userAgentOption.getValue(commandLine).value,
		darkMode: darkModeOption.getValue(commandLine).value,
	};

	const onBrowserDownload = defaultBrowserDownloadProgress({
		indent: false,
		logLevel,
		quiet,
		onProgress: () => undefined,
	});

	await RenderInternals.internalEnsureBrowser({
		browserExecutable,
		indent: false,
		logLevel,
		onBrowserDownload,
		chromeMode,
	});

	const browserInstance = RenderInternals.internalOpenBrowser({
		browser: 'chrome',
		browserExecutable,
		chromiumOptions,
		forceDeviceScaleFactor: scale,
		indent: false,
		viewport: null,
		logLevel,
		onBrowserDownload,
		chromeMode,
	});

	const {urlOrBundle, cleanup: cleanupBundle} = await bundleOnCliOrTakeServeUrl(
		{
			fullPath: convertEntryPointToServeUrl(file),
			remotionRoot,
			publicDir: publicDirOption.getValue(commandLine).value,
			onProgress: () => undefined,
			indentOutput: false,
			logLevel,
			onDirectoryCreated: (dir) => {
				registerCleanupJob(`Delete ${dir}`, () =>
					RenderInternals.deleteDirectory(dir),
				);
			},
			quietProgress: false,
			quietFlag: quiet,
			outDir: null,
			gitSource: null,
			bufferStateDelayInMilliseconds: null,
			maxTimelineTracks: null,
			publicPath: publicPathOption.getValue(commandLine).value,
			audioLatencyHint: null,
			askAIEnabled: askAIOption.getValue(commandLine).value,
			keyboardShortcutsEnabled:
				keyboardShortcutsOption.getValue(commandLine).value,
			rspack: rspackOption.getValue(commandLine).value,
			shouldCache: bundleCacheOption.getValue(commandLine).value,
			bundlerOverride: null,
			rspackOverride: null,
			webpackOverride: null,
		},
	);
	registerCleanupJob('Cleanup bundle', () => cleanupBundle());

	const puppeteerInstance = await browserInstance;
	registerCleanupJob('Closing browser instance', () =>
		puppeteerInstance.close({silent: false}),
	);

	const server = await RenderInternals.prepareServer({
		offthreadVideoThreads:
			offthreadVideoThreads ??
			RenderInternals.DEFAULT_RENDER_FRAMES_OFFTHREAD_VIDEO_THREADS,
		indent: false,
		port,
		remotionRoot,
		logLevel,
		webpackConfigOrServeUrl: urlOrBundle,
		offthreadVideoCacheSizeInBytes,
		binariesDirectory,
		forceIPv4: false,
		sampleRate: sampleRateOption.getValue(commandLine).value,
	});
	registerCleanupJob('Close server', () => server.closeServer(false));

	const serializedInputPropsWithCustomSchema =
		NoReactInternals.serializeJSONWithSpecialTypes({
			indent: undefined,
			staticBase: null,
			data: inputProps,
		}).serializedString;

	const {compositionId, config, argsAfterComposition} =
		await getCompositionWithDimensionOverride({
			height: overrideHeightOption.getValue(commandLine).value,
			width: overrideWidthOption.getValue(commandLine).value,
			fps: overrideFpsOption.getValue(commandLine).value,
			durationInFrames: overrideDurationOption.getValue(commandLine).value,
			args: remainingArgs,
			compositionIdFromUi: null,
			browserExecutable,
			chromiumOptions,
			envVariables,
			indent: false,
			serializedInputPropsWithCustomSchema,
			port,
			puppeteerInstance,
			serveUrlOrWebpackUrl: urlOrBundle,
			timeoutInMilliseconds,
			logLevel,
			server,
			offthreadVideoCacheSizeInBytes,
			offthreadVideoThreads,
			binariesDirectory,
			onBrowserDownload,
			chromeMode,
			mediaCacheSizeInBytes,
			preferredEffectBackend,
		});

	const outName = getOutputLocation({
		compositionId,
		defaultExtension: 'wanim',
		args: argsAfterComposition,
		type: 'asset',
		outputLocationFromUi: null,
		compositionDefaultOutName: config.defaultOutName,
	});
	const extension = path.extname(outName);
	if (extension !== '.wanim' && extension !== '.svga') {
		throw new Error(`The output must end in .wanim or .svga, got ${outName}`);
	}

	const format: WanimFormat =
		extension === '.svga' ? 'svga' : cliFlags.layers ? 'layers' : 'frames';
	if (format === 'svga' && animationRanges !== null) {
		throw new Error('An SVGA file holds one animation, remove --animations.');
	}

	if (wanimVersion !== 3 && format !== 'svga') {
		if (animationRanges !== null) {
			throw new Error('--animations needs a version 3 file.');
		}

		if (compression === 'lossy' || cliFlags['atlas-format'] === 'webp') {
			throw new Error('WebP atlases need a version 3 file.');
		}

		if ((wanimVersion === 2) !== (format === 'layers')) {
			throw new Error(
				'Version 1 files store frames and version 2 files store layers: Pass --layers with --wanim-version=2 only.',
			);
		}
	}

	const atlasFormat =
		wanimVersion === 3 && format !== 'svga'
			? await resolveWanimAtlasFormat(cliFlags['atlas-format'], logLevel)
			: 'png';

	const absoluteOutputFile = path.resolve(process.cwd(), outName);
	const overwrite = overwriteOption.getValue(commandLine, true).value;
	if (existsSync(absoluteOutputFile) && !overwrite) {
		throw new Error(
			`File at ${absoluteOutputFile} already exists. Use --overwrite to overwrite it.`,
		);
	}

	const progress = createOverwriteableCliOutput({
		quiet,
		cancelSignal: null,
		updatesDontOverwrite: shouldUseNonOverlayingLogger({logLevel}),
		indent: false,
		logLevel,
	});

	const [firstFrame, lastFrame] = RenderInternals.getRealFrameRange(
		config.durationInFrames,
		frameRange,
	);
	// --every-nth-frame is the older way to lower the frame rate
	const sampling = sampleWanimAnimations({
		firstFrame,
		lastFrame,
		fps: config.fps,
		frameRate:
			frameRateFlag ?? (everyNthFrame > 1 ? config.fps / everyNthFrame : null),
		imageRate,
		animations: animationRanges,
	});
	const concurrency = RenderInternals.resolveConcurrency(
		concurrencyOption.getValue(commandLine).value,
	);
	const serializedResolvedPropsWithCustomSchema =
		NoReactInternals.serializeJSONWithSpecialTypes({
			indent: undefined,
			staticBase: null,
			data: config.props,
		}).serializedString;

	let output: Uint8Array;
	let summary: string;
	let gpuBytes: number | null = null;
	if (format === 'frames') {
		const outputDir = await mkdtemp(path.join(os.tmpdir(), 'remotion-wanim-'));
		registerCleanupJob('Delete rendered frames', () =>
			RenderInternals.deleteDirectory(outputDir),
		);
		// Frames that show the same image are rendered once
		const uniqueFrames = [...new Set(sampling.imageFrames)].sort(
			(a, b) => a - b,
		);
		await RenderInternals.internalRenderFrames({
			imageFormat: 'png',
			serializedInputPropsWithCustomSchema,
			onFrameUpdate: (rendered) => {
				progress.update(`Rendered ${rendered} frames`, false);
			},
			onStart: () => undefined,
			onDownload: () => undefined,
			cancelSignal: undefined,
			outputDir,
			webpackBundleOrServeUrl: urlOrBundle,
			everyNthFrame: 1,
			envVariables,
			frameRange: null,
			frames: uniqueFrames,
			outputFramesInSequence: false,
			concurrency,
			puppeteerInstance,
			jpegQuality: RenderInternals.DEFAULT_JPEG_QUALITY,
			timeoutInMilliseconds,
			chromiumOptions,
			scale,
			browserExecutable,
			port,
			composition: config,
			server,
			indent: false,
			// A .wanim file has no audio track
			muted: true,
			sampleRate: sampleRateOption.getValue(
				commandLine,
				config.defaultSampleRate,
			).value,
			onBrowserLog: null,
			onFrameBuffer: null,
			onFrame: null,
			remotionSharedMemory: null,
			logLevel,
			serializedResolvedPropsWithCustomSchema,
			offthreadVideoCacheSizeInBytes,
			offthreadVideoThreads,
			parallelEncodingEnabled: false,
			binariesDirectory,
			compositionStart: 0,
			forSeamlessAacConcatenation: false,
			onBrowserDownload,
			onArtifact: null,
			chromeMode,
			imageSequencePattern: null,
			mediaCacheSizeInBytes,
			preferredEffectBackend,
			onLog: RenderInternals.defaultOnLog,
		});

		// File names are padded, so they sort like the frames
		const files = (await readdir(outputDir))
			.filter((name) => name.endsWith('.png'))
			.sort()
			.map((name) => path.join(outputDir, name));
		const fileOf = new Map(
			uniqueFrames.map((frame, index) => [frame, files[index] as string]),
		);
		const framePaths = sampling.imageFrames.map(
			(frame) => fileOf.get(frame) as string,
		);
		if (wanimVersion === 3) {
			const animation = await readFramesAsAnimation({
				framePaths,
				fps: sampling.fps,
				canvas: null,
				onProgress: (value) => {
					progress.update(`Reading frames ${Math.round(value * 100)}%`, false);
				},
			});
			const packed = await packWanimSet({
				set: toWanimSet(animation, sampling.animations),
				key,
				compositionId,
				atlasSize,
				compression,
				atlasFormat,
				onProgress: (value) => {
					progress.update(`Packing atlases ${Math.round(value * 100)}%`, false);
				},
			});
			output = packed.file;
			gpuBytes = packed.manifest.gpuBytes;
			({summary} = packed);
		} else {
			const {file: wanim, manifest} = await packWanim({
				framePaths,
				fps: sampling.fps,
				key,
				compositionId,
				atlasSize,
				canvas: null,
				compression,
				onProgress: (value) => {
					progress.update(`Packing atlases ${Math.round(value * 100)}%`, false);
				},
			});
			output = wanim;
			gpuBytes = manifest.gpuBytes;
			summary = `${manifest.frameCount} frames at ${formatFps(manifest.fps)} fps, ${manifest.sprites.length} sprites, ${manifest.atlases.length} atlases, ${toMegabytes(wanim.length)} MB on disk, ${toMegabytes(manifest.gpuBytes)} MB on the GPU`;
		}
	} else {
		const animation = await renderWanimLayers({
			puppeteerInstance,
			server,
			composition: config,
			serializedInputPropsWithCustomSchema,
			serializedResolvedPropsWithCustomSchema,
			envVariables,
			scale,
			concurrency,
			timeoutInMilliseconds,
			chromiumOptions,
			mediaCacheSizeInBytes,
			preferredEffectBackend,
			frames: sampling.frames,
			imageFrames: sampling.imageFrames,
			fps: sampling.fps,
			outputTransform: [1, 0, 0, 1, 0, 0],
			outputWidth: Math.round(config.width * scale),
			outputHeight: Math.round(config.height * scale),
			logLevel,
			onProgress: ({stage, done, total}) => {
				progress.update(
					stage === 'describing'
						? `Reading frames ${done}/${total}`
						: `Capturing layers ${done}/${total}`,
					false,
				);
			},
			isCancelled: () => false,
		});
		if (format === 'layers' && wanimVersion === 3) {
			const packed = await packWanimSet({
				set: toWanimSet(animation, sampling.animations),
				key,
				compositionId,
				atlasSize,
				compression,
				atlasFormat,
				onProgress: (value) => {
					progress.update(`Packing atlases ${Math.round(value * 100)}%`, false);
				},
			});
			output = packed.file;
			gpuBytes = packed.manifest.gpuBytes;
			({summary} = packed);
		} else if (format === 'layers') {
			const {file: wanim, manifest} = packWanimLayers({
				animation,
				key,
				compositionId,
				atlasSize,
				compression,
				onProgress: (value) => {
					progress.update(`Packing atlases ${Math.round(value * 100)}%`, false);
				},
			});
			output = wanim;
			gpuBytes = manifest.gpuBytes;
			summary = `${manifest.frameCount} frames at ${formatFps(manifest.fps)} fps, ${manifest.sprites.length} layer pictures, ${(manifest.timeline.draws / manifest.frameCount).toFixed(1)} draws per frame, ${toMegabytes(wanim.length)} MB on disk, ${toMegabytes(manifest.gpuBytes)} MB on the GPU`;
		} else {
			if (key !== null) {
				Log.warn(
					{indent: false, logLevel},
					'SVGA files cannot be encrypted, the key is not used.',
				);
			}

			const svga = packSvga({animation, compression});
			output = svga.file;
			summary = `${animation.frames.length} frames at ${svga.fps} fps, ${svga.images} images, ${svga.sprites} sprites, ${toMegabytes(svga.file.length)} MB on disk`;
			if (svga.fps !== sampling.fps) {
				Log.warn(
					{indent: false, logLevel},
					`SVGA only supports whole frame rates, so this file plays at ${svga.fps} instead of ${formatFps(sampling.fps)} fps.`,
				);
			}
		}
	}

	mkdirSync(path.dirname(absoluteOutputFile), {recursive: true});
	writeFileSync(absoluteOutputFile, output);
	progress.update('', true);

	if (licenseKey !== null) {
		try {
			await LicensingInternals.internalRegisterUsageEvent({
				event: 'cloud-render',
				host: null,
				succeeded: true,
				licenseKey: licenseKey === 'free-license' ? null : licenseKey,
				isProduction: isProductionOption.getValue(commandLine).value ?? true,
				isStill: false,
			});
		} catch (err) {
			Log.error({indent: false, logLevel}, 'Failed to send usage event');
			Log.error({indent: true, logLevel}, err);
		}
	}

	Log.info(
		{indent: false, logLevel},
		chalk.blue(`+ ${path.relative(process.cwd(), absoluteOutputFile)}`),
	);
	Log.info({indent: false, logLevel}, chalk.gray(summary));
	if (gpuBytes !== null && gpuBytes > GPU_BUDGET_IN_BYTES) {
		Log.warn(
			{indent: false, logLevel},
			'This animation is too large to be kept on the GPU of a phone, so players have to stream atlases and may drop frames. Consider a lower --scale, a lower --frame-rate or --layers.',
		);
	}
};

const inspectWanim = (filePath: string | undefined, logLevel: LogLevel) => {
	if (!filePath) {
		throw new Error(
			`No file specified. Usage: remotion ${WANIM_COMMAND} ${WANIM_INSPECT_COMMAND} <file.wanim>`,
		);
	}

	const file = new Uint8Array(readFileSync(filePath));
	const header = readWanimHeader(file);
	const key = getWanimKey();
	if (header.customKey && key === null) {
		Log.info(
			{indent: false, logLevel},
			`.wanim version ${header.version}, encrypted with a key of its own. Pass that key to see the contents.`,
		);
		return;
	}

	const {manifest} = openWanim({file, key});
	Log.info({indent: false, logLevel}, JSON.stringify(manifest, null, 2));
};

// Packs a file of any version again as version 3: Smaller, with less memory
// on the GPU, and optionally split into animations with keys
const convertWanim = async (args: string[], logLevel: LogLevel) => {
	const [input, outName] = args;
	if (!input || !outName) {
		throw new Error(
			`Usage: remotion ${WANIM_COMMAND} ${WANIM_CONVERT_COMMAND} <input.wanim> <output.wanim> [--animations=...]`,
		);
	}

	if (path.extname(outName) !== '.wanim') {
		throw new Error(`The output must end in .wanim, got ${outName}`);
	}

	const absoluteOutputFile = path.resolve(process.cwd(), outName);
	if (existsSync(absoluteOutputFile) && !flags().overwrite) {
		throw new Error(
			`File at ${absoluteOutputFile} already exists. Use --overwrite to overwrite it.`,
		);
	}

	const key = getWanimKey();
	const file = new Uint8Array(readFileSync(input));
	const compression = parseWanimCompression(flags().compress);
	const atlasFormat = await resolveWanimAtlasFormat(
		flags()['atlas-format'],
		logLevel,
	);
	const atlasSizeFlag = flags()['atlas-size'];
	const atlasSize = atlasSizeFlag === undefined ? null : Number(atlasSizeFlag);
	if (atlasSize !== null && !Number.isInteger(atlasSize)) {
		throw new Error(`--atlas-size must be a number, got ${atlasSizeFlag}`);
	}

	const before = openWanim({file, key}).manifest;
	const set = rekeyAnimationSet(
		await readWanimAsSet({file, key, decodeWebp}),
		parseWanimAnimations(flags().animations),
	);
	const packed = await packWanimSet({
		set,
		key,
		compositionId: before.compositionId,
		atlasSize,
		compression,
		atlasFormat,
		onProgress: null,
	});
	mkdirSync(path.dirname(absoluteOutputFile), {recursive: true});
	writeFileSync(absoluteOutputFile, packed.file);
	Log.info(
		{indent: false, logLevel},
		chalk.blue(`+ ${path.relative(process.cwd(), absoluteOutputFile)}`),
	);
	Log.info({indent: false, logLevel}, chalk.gray(packed.summary));
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			`Was version ${before.version}: ${toMegabytes(file.length)} MB on disk, ${toMegabytes(before.gpuBytes)} MB on the GPU`,
		),
	);
};

const printWanimHelp = (logLevel: LogLevel) => {
	Log.info({indent: false, logLevel}, chalk.blue(`remotion ${WANIM_COMMAND}`));
	Log.info({indent: false, logLevel});
	Log.info({indent: false, logLevel}, 'Available commands:');
	Log.info({indent: false, logLevel});
	Log.info(
		{indent: false, logLevel},
		`remotion ${WANIM_COMMAND} ${WANIM_RENDER_COMMAND} [entry-point] [composition-id] [out-name]`,
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray('Render a composition to an encrypted sprite animation.'),
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			'--layers stores moving parts once. An .svga output name writes an unencrypted SVGA file instead.',
		),
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			'--animations="transition_in=0-29,idle=30-89:loop" puts several animations into the file, which the app plays by key. They share their pictures.',
		),
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			'--atlas-format=png|webp and --compress=none|balanced|small|lossy set how the pictures are stored. --wanim-version=1|2 writes a file for older players.',
		),
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			'--frame-rate=<fps> keeps the duration with fewer frames. --image-rate=<fps> lets changing parts get a new picture less often.',
		),
	);
	Log.info({indent: false, logLevel});
	Log.info(
		{indent: false, logLevel},
		`remotion ${WANIM_COMMAND} ${WANIM_KEYGEN_COMMAND}`,
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			'Print a random key, for files that should not use the official key.',
		),
	);
	Log.info({indent: false, logLevel});
	Log.info(
		{indent: false, logLevel},
		`remotion ${WANIM_COMMAND} ${WANIM_CONVERT_COMMAND} <input.wanim> <output.wanim>`,
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			'Pack a file of any version again as version 3, without rendering. --animations splits its frames into animations.',
		),
	);
	Log.info({indent: false, logLevel});
	Log.info(
		{indent: false, logLevel},
		`remotion ${WANIM_COMMAND} ${WANIM_INSPECT_COMMAND} <file.wanim>`,
	);
	Log.info(
		{indent: false, logLevel},
		chalk.gray('Print the manifest of a .wanim file.'),
	);
};

export const wanimCommand = async (
	remotionRoot: string,
	args: string[],
	logLevel: LogLevel,
) => {
	const [subcommand, ...subcommandArgs] = args;
	if (subcommand === WANIM_RENDER_COMMAND) {
		await renderWanim(remotionRoot, subcommandArgs, logLevel);
		return;
	}

	if (subcommand === WANIM_KEYGEN_COMMAND) {
		// Bypasses the log level, so it can be used in `$(...)`
		process.stdout.write(`${generateWanimKey()}\n`);
		return;
	}

	if (subcommand === WANIM_CONVERT_COMMAND) {
		await convertWanim(subcommandArgs, logLevel);
		return;
	}

	if (subcommand === WANIM_INSPECT_COMMAND) {
		inspectWanim(subcommandArgs[0], logLevel);
		return;
	}

	printWanimHelp(logLevel);
};
