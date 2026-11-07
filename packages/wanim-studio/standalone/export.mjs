// Usage: npm run export <composition-id> [-- --scale=0.5 --every-nth-frame=2 --frames=0-59 --atlas-size=2048]
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {bundle} from '@remotion/bundler';
import {renderFrames, selectComposition} from '@remotion/renderer';
import {packWanim} from '@remotion/wanim';

const {values, positionals} = parseArgs({
	allowPositionals: true,
	options: {
		scale: {type: 'string', default: '1'},
		'every-nth-frame': {type: 'string', default: '1'},
		frames: {type: 'string'},
		'atlas-size': {type: 'string'},
	},
});

const id = positionals[0];
if (!id) {
	console.error('Usage: npm run export <composition-id>');
	process.exit(1);
}

const everyNthFrame = Number(values['every-nth-frame']);
const range = values.frames?.split('-').map(Number) ?? null;
const frameRange = range?.length === 1 ? range[0] : range;

const serveUrl = await bundle({entryPoint: path.resolve('src/index.ts')});
const composition = await selectComposition({serveUrl, id, inputProps: {}});
const outputDir = mkdtempSync(path.join(os.tmpdir(), 'wanim-'));

try {
	await renderFrames({
		composition,
		serveUrl,
		inputProps: {},
		outputDir,
		imageFormat: 'png',
		scale: Number(values.scale),
		everyNthFrame,
		frameRange,
		muted: true,
		onStart: () => undefined,
		onFrameUpdate: (rendered) => {
			process.stdout.write(`\rRendered ${rendered} frames`);
		},
	});
	process.stdout.write('\n');

	const {file, manifest} = await packWanim({
		framePaths: readdirSync(outputDir)
			.filter((name) => name.endsWith('.png'))
			.sort()
			.map((name) => path.join(outputDir, name)),
		fps: composition.fps / everyNthFrame,
		key: process.env.WANIM_KEY ?? null,
		compositionId: id,
		atlasSize: values['atlas-size'] ? Number(values['atlas-size']) : null,
		onProgress: null,
	});

	const output = path.join('out', `${id}.wanim`);
	mkdirSync('out', {recursive: true});
	writeFileSync(output, file);
	const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
	console.log(
		`${output}: ${manifest.frameCount} frames, ${mb(file.length)} MB on disk, ${mb(manifest.gpuBytes)} MB on the GPU`,
	);
} finally {
	rmSync(outputDir, {recursive: true, force: true});
}
