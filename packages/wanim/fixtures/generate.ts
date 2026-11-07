// Regenerates sample.wanim, sample-custom-key.wanim and expected.json. Run from packages/wanim:
// bun fixtures/generate.ts
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {openWanim} from '../src/open-wanim';
import {packWanim} from '../src/pack-wanim';

const customKey =
	'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const width = 64;
const height = 48;

// A half transparent square that moves, a growing bar, a held frame and a gap
const draw = (frame: number) => {
	const png = new PNG({width, height});
	png.data.fill(0);
	const rect = (
		x: number,
		y: number,
		w: number,
		h: number,
		rgba: [number, number, number, number],
	) => {
		for (let py = y; py < y + h; py++) {
			for (let px = x; px < x + w; px++) {
				png.data.set(rgba, (py * width + px) * 4);
			}
		}
	};

	if (frame < 4) {
		rect(4 + frame * 8, 8, 16, 16, [255, 40, 40, 128]);
	} else if (frame < 8) {
		rect(8, 30, 10 + (frame - 4) * 12, 10, [40, 120, 255, 255]);
	} else if (frame < 10) {
		rect(8, 30, 46, 10, [40, 120, 255, 255]);
	}

	return PNG.sync.write(png);
};

const dir = mkdtempSync(path.join(tmpdir(), 'wanim-fixture-'));
const framePaths = Array.from({length: 12}, (_, frame) => {
	const framePath = path.join(dir, `${frame}.png`);
	writeFileSync(framePath, draw(frame));
	return framePath;
});

const pack = (key: string | null) =>
	packWanim({
		framePaths,
		fps: 12,
		key,
		compositionId: 'sample',
		atlasSize: 52,
		onProgress: null,
	});

const {file} = await pack(null);
const {file: customKeyFile} = await pack(customKey);
rmSync(dir, {recursive: true});

const {manifest, readAtlas} = openWanim({file, key: null});
writeFileSync(path.join(import.meta.dir, 'sample.wanim'), file);
writeFileSync(
	path.join(import.meta.dir, 'sample-custom-key.wanim'),
	customKeyFile,
);
writeFileSync(
	path.join(import.meta.dir, 'expected.json'),
	`${JSON.stringify(
		{
			customKey,
			manifest,
			atlasSha256: manifest.atlases.map((_, index) =>
				createHash('sha256').update(readAtlas(index)).digest('hex'),
			),
		},
		null,
		'\t',
	)}\n`,
);
