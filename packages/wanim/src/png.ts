import {PNG} from 'pngjs';

export const decodePng = (bytes: Uint8Array) =>
	PNG.sync.read(Buffer.from(bytes));

// The smallest rectangle with visible pixels, as a PNG, and where it was.
// `null` if every pixel is transparent.
export const trimPng = (png: PNG) => {
	let minX = png.width;
	let minY = png.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < png.height; y++) {
		for (let x = 0; x < png.width; x++) {
			if (png.data[(y * png.width + x) * 4 + 3] === 0) {
				continue;
			}

			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}

	if (maxX === -1) {
		return null;
	}

	const width = maxX - minX + 1;
	const height = maxY - minY + 1;
	const out = new PNG({width, height});
	PNG.bitblt(png, out, minX, minY, width, height, 0, 0);
	return {
		x: minX,
		y: minY,
		width,
		height,
		data: new Uint8Array(out.data),
		png: new Uint8Array(PNG.sync.write(out, {colorType: 6, deflateLevel: 6})),
		// Touching an edge means that the picture may have been cut off
		touchesEdge:
			minX === 0 ||
			minY === 0 ||
			maxX === png.width - 1 ||
			maxY === png.height - 1,
	};
};
