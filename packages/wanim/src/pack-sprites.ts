// Places sprites on atlas pages. Pages are filled in the given order, so that
// sprites that are first used together share a page. On a page, sprites are
// sorted by height and put on shelves (first-fit decreasing height), and the
// width of the page is the one that needs the fewest pixels.

type Size = {width: number; height: number};
type Place = {page: number; x: number; y: number};

const shelves = ({
	sizes,
	order,
	pageWidth,
	padding,
}: {
	sizes: Size[];
	// Indices into `sizes`, highest first
	order: number[];
	pageWidth: number;
	padding: number;
}) => {
	const rows: {y: number; height: number; x: number}[] = [];
	const places = new Map<number, {x: number; y: number}>();
	let width = 0;
	for (const index of order) {
		const size = sizes[index] as Size;
		let row = rows.find((r) => r.x + size.width + padding <= pageWidth);
		if (!row) {
			const above = rows[rows.length - 1];
			row = {
				y: above ? above.y + above.height + padding : padding,
				height: size.height,
				x: padding,
			};
			rows.push(row);
		}

		places.set(index, {x: row.x, y: row.y});
		row.x += size.width + padding;
		width = Math.max(width, row.x);
	}

	const last = rows[rows.length - 1];
	return {places, width, height: last ? last.y + last.height + padding : 0};
};

export const packSprites = ({
	sizes,
	pageSize,
	padding,
}: {
	sizes: Size[];
	pageSize: number;
	padding: number;
}): {pages: Size[]; places: Place[]} => {
	for (const {width, height} of sizes) {
		if (width + padding * 2 > pageSize || height + padding * 2 > pageSize) {
			throw new Error(
				`A picture of ${width}x${height}px does not fit into an atlas of ${pageSize}px. Render with a lower scale.`,
			);
		}
	}

	const byHeight = (indices: number[]) =>
		[...indices].sort((a, b) => {
			const sizeA = sizes[a] as Size;
			const sizeB = sizes[b] as Size;
			return sizeB.height - sizeA.height || sizeB.width - sizeA.width || a - b;
		});
	const range = (first: number, end: number) =>
		Array.from({length: end - first}, (_, i) => first + i);
	const fits = (first: number, end: number) =>
		shelves({
			sizes,
			order: byHeight(range(first, end)),
			pageWidth: pageSize,
			padding,
		}).height <= pageSize;

	const pages: Size[] = [];
	const places: Place[] = new Array(sizes.length);
	let from = 0;
	while (from < sizes.length) {
		// The longest run of sprites that fits on one page
		let to = sizes.length;
		if (!fits(from, to)) {
			let low = from + 1;
			let high = to - 1;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				if (fits(from, middle)) {
					low = middle;
				} else {
					high = middle - 1;
				}
			}

			to = low;
		}

		const order = byHeight(range(from, to));
		const widest = order.reduce(
			(max, index) => Math.max(max, (sizes[index] as Size).width),
			0,
		);
		const area = order.reduce(
			(sum, index) =>
				sum +
				((sizes[index] as Size).width + padding) *
					((sizes[index] as Size).height + padding),
			0,
		);
		const candidates = new Set([pageSize]);
		for (let factor = 1; factor <= 4; factor += 0.05) {
			candidates.add(
				Math.min(
					pageSize,
					Math.max(widest + padding * 2, Math.ceil(Math.sqrt(area) * factor)),
				),
			);
		}

		let best: ReturnType<typeof shelves> | null = null;
		for (const pageWidth of [...candidates].sort((a, b) => a - b)) {
			const result = shelves({sizes, order, pageWidth, padding});
			if (
				result.height <= pageSize &&
				(best === null ||
					result.width * result.height < best.width * best.height)
			) {
				best = result;
			}
		}

		if (best === null) {
			throw new Error('Could not place the sprites on an atlas');
		}

		for (const [index, place] of best.places) {
			places[index] = {page: pages.length, x: place.x, y: place.y};
		}

		pages.push({width: best.width, height: best.height});
		from = to;
	}

	return {pages, places};
};
