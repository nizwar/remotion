// Regenerates assets/demo.wanim. Run from this folder: bun tool/make_demo.ts
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PNG} from '../../../wanim/node_modules/pngjs';
import {packWanim} from '../../../wanim/src/pack-wanim';

const size = 320;
const frameCount = 90;
const fps = 30;

// Soft orbiting spheres with straight alpha: Exercises blending and trimming,
// and fills more than one atlas, so that streaming can be tested as well
const draw = (frame: number) => {
	const png = new PNG({width: size, height: size});
	const t = (frame / frameCount) * Math.PI * 2;
	const orbs = [0, 1, 2, 3].map((index) => {
		const angle = t + (index * Math.PI) / 2;
		return {
			x: size / 2 + Math.cos(angle) * 90,
			y: size / 2 + Math.sin(angle) * 90,
			r: 42 + Math.sin(t * 2 + index) * 14,
			hue: (index / 4 + frame / frameCount) * Math.PI * 2,
		};
	});
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;
			for (const orb of orbs) {
				const distance = Math.hypot(x - orb.x, y - orb.y);
				const a = Math.min(1, Math.max(0, orb.r - distance));
				const shade = 1 - (distance / orb.r) * 0.5;
				const over = a * (1 - alpha);
				red += (0.5 + 0.5 * Math.cos(orb.hue)) * shade * over;
				green += (0.5 + 0.5 * Math.cos(orb.hue + 2.1)) * shade * over;
				blue += (0.5 + 0.5 * Math.cos(orb.hue + 4.2)) * shade * over;
				alpha += over;
			}

			const index = (y * size + x) * 4;
			png.data[index] = alpha ? (red / alpha) * 255 : 0;
			png.data[index + 1] = alpha ? (green / alpha) * 255 : 0;
			png.data[index + 2] = alpha ? (blue / alpha) * 255 : 0;
			png.data[index + 3] = alpha * 255;
		}
	}

	return PNG.sync.write(png);
};

const dir = mkdtempSync(path.join(tmpdir(), 'wanim-demo-'));
const framePaths = Array.from({length: frameCount}, (_, frame) => {
	const framePath = path.join(dir, `${frame}.png`);
	writeFileSync(framePath, draw(frame));
	return framePath;
});

const {file, manifest} = await packWanim({
	framePaths,
	fps,
	key: null,
	compositionId: 'demo',
	atlasSize: 2048,
	onProgress: null,
});
rmSync(dir, {recursive: true});
writeFileSync(path.join(import.meta.dir, '../assets/demo.wanim'), file);
console.log(
	`${file.length} bytes, ${manifest.atlases.length} atlases, ${manifest.gpuBytes} GPU bytes`,
);
