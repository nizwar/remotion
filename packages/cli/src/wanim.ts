import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LicensingInternals} from '@remotion/licensing';
import type {ChromiumOptions, LogLevel} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';
import {BrowserSafeApis} from '@remotion/renderer/client';
import {
	generateWanimKey,
	openWanim,
	packWanim,
	readWanimHeader,
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

export const WANIM_COMMAND = 'wanim';
export const WANIM_RENDER_COMMAND = 'render';
export const WANIM_KEYGEN_COMMAND = 'keygen';
export const WANIM_INSPECT_COMMAND = 'inspect';

// Above this, a player can no longer keep all atlases on the GPU of a phone
const GPU_BUDGET_IN_BYTES = 256 * 1024 * 1024;

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
const getKey = (): string | null => {
	const keyFile = (parsedCli as unknown as Record<string, unknown>)['key-file'];
	if (typeof keyFile === 'string') {
		return readFileSync(keyFile, 'utf8');
	}

	return process.env.WANIM_KEY ?? null;
};

const requireKey = (): string => {
	const key = getKey();
	if (key === null) {
		throw new Error(
			`No key provided. Set the WANIM_KEY environment variable or pass --key-file. Create a key using \`remotion ${WANIM_COMMAND} ${WANIM_KEYGEN_COMMAND}\`.`,
		);
	}

	return key;
};

const renderWanim = async (
	remotionRoot: string,
	args: string[],
	logLevel: LogLevel,
) => {
	const key = requireKey();
	const licenseKey = getLicenseKey();
	const atlasSizeFlag = (parsedCli as unknown as Record<string, unknown>)[
		'atlas-size'
	];
	const atlasSize = atlasSizeFlag === undefined ? null : Number(atlasSizeFlag);
	if (atlasSize !== null && !Number.isInteger(atlasSize)) {
		throw new Error(`--atlas-size must be a number, got ${atlasSizeFlag}`);
	}

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
	if (path.extname(outName) !== '.wanim') {
		throw new Error(`The output must end in .wanim, got ${outName}`);
	}

	const absoluteOutputFile = path.resolve(process.cwd(), outName);
	const overwrite = overwriteOption.getValue(commandLine, true).value;
	if (existsSync(absoluteOutputFile) && !overwrite) {
		throw new Error(
			`File at ${absoluteOutputFile} already exists. Use --overwrite to overwrite it.`,
		);
	}

	const outputDir = await mkdtemp(path.join(os.tmpdir(), 'remotion-wanim-'));
	registerCleanupJob('Delete rendered frames', () =>
		RenderInternals.deleteDirectory(outputDir),
	);

	const progress = createOverwriteableCliOutput({
		quiet,
		cancelSignal: null,
		updatesDontOverwrite: shouldUseNonOverlayingLogger({logLevel}),
		indent: false,
		logLevel,
	});

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
		everyNthFrame,
		envVariables,
		frameRange,
		frames: null,
		outputFramesInSequence: false,
		concurrency: RenderInternals.resolveConcurrency(
			concurrencyOption.getValue(commandLine).value,
		),
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
		sampleRate: sampleRateOption.getValue(commandLine, config.defaultSampleRate)
			.value,
		onBrowserLog: null,
		onFrameBuffer: null,
		onFrame: null,
		remotionSharedMemory: null,
		logLevel,
		serializedResolvedPropsWithCustomSchema:
			NoReactInternals.serializeJSONWithSpecialTypes({
				indent: undefined,
				staticBase: null,
				data: config.props,
			}).serializedString,
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

	const framePaths = (await readdir(outputDir))
		.filter((name) => name.endsWith('.png'))
		.sort()
		.map((name) => path.join(outputDir, name));

	const {file: wanim, manifest} = await packWanim({
		framePaths,
		fps: config.fps / everyNthFrame,
		key,
		compositionId,
		atlasSize,
		onProgress: (value) => {
			progress.update(`Packing atlases ${Math.round(value * 100)}%`, false);
		},
	});

	mkdirSync(path.dirname(absoluteOutputFile), {recursive: true});
	writeFileSync(absoluteOutputFile, wanim);
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
	Log.info(
		{indent: false, logLevel},
		chalk.gray(
			`${manifest.frameCount} frames, ${manifest.sprites.length} sprites, ${manifest.atlases.length} atlases, ${(wanim.length / 1024 / 1024).toFixed(1)} MB on disk, ${(manifest.gpuBytes / 1024 / 1024).toFixed(1)} MB on the GPU`,
		),
	);
	if (manifest.gpuBytes > GPU_BUDGET_IN_BYTES) {
		Log.warn(
			{indent: false, logLevel},
			'This animation is too large to be kept on the GPU of a phone, so players have to stream atlases and may drop frames. Consider a lower --scale or --every-nth-frame=2.',
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
	const key = getKey();
	if (key === null) {
		Log.info(
			{indent: false, logLevel},
			`.wanim version ${header.version}, contents are encrypted. Pass a key to see them.`,
		);
		return;
	}

	const {manifest} = openWanim({file, key});
	Log.info({indent: false, logLevel}, JSON.stringify(manifest, null, 2));
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
	Log.info({indent: false, logLevel});
	Log.info(
		{indent: false, logLevel},
		`remotion ${WANIM_COMMAND} ${WANIM_KEYGEN_COMMAND}`,
	);
	Log.info({indent: false, logLevel}, chalk.gray('Print a new random key.'));
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

	if (subcommand === WANIM_INSPECT_COMMAND) {
		inspectWanim(subcommandArgs[0], logLevel);
		return;
	}

	printWanimHelp(logLevel);
};
