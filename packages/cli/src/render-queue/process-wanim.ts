import {mkdirSync, writeFileSync} from 'node:fs';
import {mkdtemp, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {LogLevel} from '@remotion/renderer';
import {RenderInternals} from '@remotion/renderer';
import type {JobProgressCallback, RenderJob} from '@remotion/studio-server';
import {packWanim} from '@remotion/wanim';
import {Log} from '../log';
import {GPU_BUDGET_IN_BYTES, getWanimKey} from '../wanim';
import {processVideoJob} from './process-video';
import type {StudioRenderJobFixedConfig} from './studio-render-job-fixed-config';

// Rendering takes most of the time, packing the rest
const RENDER_SHARE = 0.9;

export const processWanimJob = async ({
	job,
	wanimFps,
	remotionRoot,
	entryPoint,
	onProgress,
	addCleanupCallback,
	logLevel,
	fixedConfig,
}: {
	job: RenderJob;
	wanimFps: number;
	remotionRoot: string;
	entryPoint: string;
	onProgress: JobProgressCallback;
	addCleanupCallback: (label: string, cb: () => void) => void;
	logLevel: LogLevel;
	fixedConfig: StudioRenderJobFixedConfig;
}) => {
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

	const framePaths = (await readdir(framesDir))
		.filter((name) => name.endsWith('.png'))
		.sort()
		.map((name) => path.join(framesDir, name));

	const {file, manifest} = await packWanim({
		framePaths,
		fps: wanimFps,
		key: getWanimKey(),
		compositionId: job.compositionId,
		atlasSize: null,
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

	const toMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
	const summary = `${manifest.frameCount} frames, ${toMb(file.length)} MB on disk, ${toMb(manifest.gpuBytes)} MB on the GPU`;
	if (latest.progress) {
		onProgress({...latest.progress, message: summary, value: 1});
	}

	if (manifest.gpuBytes > GPU_BUDGET_IN_BYTES) {
		Log.warn(
			{indent: false, logLevel},
			'This animation is too large to be kept on the GPU of a phone. Consider a lower scale.',
		);
	}
};
