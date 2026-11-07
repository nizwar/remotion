import {PNG} from 'pngjs';

export type WanimCanvas = {
	width: number;
	height: number;
	// How a frame of another size gets onto the canvas. `contain` leaves
	// transparent bars, `cover` crops, `stretch` changes the aspect ratio.
	fit: 'contain' | 'cover' | 'stretch';
};

// Averages the source area below each target pixel. Happens on premultiplied
// values, otherwise transparent pixels would bleed dark edges into the result.
const stretch = (source: PNG, target: PNG) => {
	const ratioX = source.width / target.width;
	const ratioY = source.height / target.height;
	for (let y = 0; y < target.height; y++) {
		const top = y * ratioY;
		const bottom = (y + 1) * ratioY;
		for (let x = 0; x < target.width; x++) {
			const left = x * ratioX;
			const right = (x + 1) * ratioX;
			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;
			let area = 0;
			for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) {
				const weightY = Math.min(sy + 1, bottom) - Math.max(sy, top);
				for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
					const weight =
						weightY * (Math.min(sx + 1, right) - Math.max(sx, left));
					const from = (sy * source.width + sx) * 4;
					const pixelAlpha = (source.data[from + 3] as number) * weight;
					red += (source.data[from] as number) * pixelAlpha;
					green += (source.data[from + 1] as number) * pixelAlpha;
					blue += (source.data[from + 2] as number) * pixelAlpha;
					alpha += pixelAlpha;
					area += weight;
				}
			}

			if (alpha === 0) {
				continue;
			}

			const index = (y * target.width + x) * 4;
			target.data[index] = Math.round(red / alpha);
			target.data[index + 1] = Math.round(green / alpha);
			target.data[index + 2] = Math.round(blue / alpha);
			target.data[index + 3] = Math.round(alpha / area);
		}
	}
};

// Pads with transparency or crops, keeping the frame centered
const center = (source: PNG, target: PNG) => {
	const offsetX = Math.round((target.width - source.width) / 2);
	const offsetY = Math.round((target.height - source.height) / 2);
	const startX = Math.max(offsetX, 0);
	const endX = Math.min(offsetX + source.width, target.width);
	for (
		let y = Math.max(offsetY, 0);
		y < Math.min(offsetY + source.height, target.height);
		y++
	) {
		const from = ((y - offsetY) * source.width + (startX - offsetX)) * 4;
		target.data.set(
			source.data.subarray(from, from + (endX - startX) * 4),
			(y * target.width + startX) * 4,
		);
	}
};

export const fitFrame = (source: PNG, canvas: WanimCanvas): PNG => {
	if (source.width === canvas.width && source.height === canvas.height) {
		return source;
	}

	const target = new PNG({width: canvas.width, height: canvas.height});
	target.data.fill(0);
	if (canvas.fit === 'stretch') {
		stretch(source, target);
	} else {
		center(source, target);
	}

	return target;
};
