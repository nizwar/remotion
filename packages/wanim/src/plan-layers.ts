// Decides which parts of a composition become layers: A part that keeps its
// look while it moves, turns or fades is captured once and drawn with a matrix
// in every frame. A part that changes its look is captured once per look.

export type Matrix = [number, number, number, number, number, number];

// A node of the DOM of one frame, as the page describes it
export type LayerNode = {
	// Indices of the element children, from the canvas of the composition
	path: string;
	kind: 'group' | 'leaf' | 'volatile';
	// Hash of everything that decides the look of the node, apart from its own
	// position, transform and opacity
	signature: string;
	// Maps the node to viewport pixels
	matrix: Matrix;
	opacity: number;
	// Effects that keep the node from being split into its children
	blocking: string[];
	// Bounds in viewport pixels, relative to the canvas
	bounds: [number, number, number, number];
	parent: number;
	children: number[];
	// Signature of the background and border of an HTML element with children
	ownPaint: string | null;
	blend: boolean;
	zIndex: boolean;
};

export type FrameDescription = {
	canvas: [number, number, number, number];
	nodes: LayerNode[];
};

export type LayerUnit = {
	key: string;
	matrix: Matrix;
	alpha: number;
};

export type CaptureRequest = {
	key: string;
	// `''` for the whole canvas
	path: string;
	ownPaint: boolean;
	// The source frame to show while capturing
	frame: number;
	// Viewport matrix of the node in that frame
	matrix: Matrix;
	// If not null, the node is turned or scaled differently over time and is
	// captured upright at this size instead of where it is
	uprightScale: number | null;
};

export type LayerPlan = {
	frames: LayerUnit[][];
	captures: CaptureRequest[];
};

export const ROOT_PATH = '';

// Costs in pixels: Each draw and each bitmap costs as much as this many pixels
const DRAW_COST = 64;
const BITMAP_COST = 4096;

type Rect = [number, number, number, number];

export const multiplyMatrix = (x: Matrix, y: Matrix): Matrix => [
	x[0] * y[0] + x[2] * y[1],
	x[1] * y[0] + x[3] * y[1],
	x[0] * y[2] + x[2] * y[3],
	x[1] * y[2] + x[3] * y[3],
	x[0] * y[4] + x[2] * y[5] + x[4],
	x[1] * y[4] + x[3] * y[5] + x[5],
];

export const invertMatrix = (m: Matrix): Matrix => {
	const det = m[0] * m[3] - m[1] * m[2];
	return [
		m[3] / det,
		-m[1] / det,
		-m[2] / det,
		m[0] / det,
		(m[2] * m[5] - m[3] * m[4]) / det,
		(m[1] * m[4] - m[0] * m[5]) / det,
	];
};

// `count` 4 compares rotation, scale and skew, 6 also the position
const sameMatrix = (a: Matrix, b: Matrix, count: number) => {
	for (let i = 0; i < count; i++) {
		if (Math.abs(a[i] - b[i]) > 1e-4) {
			return false;
		}
	}

	return true;
};

const union = (a: Rect | null, b: Rect | null): Rect | null => {
	if (a === null) {
		return b;
	}

	if (b === null) {
		return a;
	}

	const x = Math.min(a[0], b[0]);
	const y = Math.min(a[1], b[1]);
	return [
		x,
		y,
		Math.max(a[0] + a[2], b[0] + b[2]) - x,
		Math.max(a[1] + a[3], b[1] + b[3]) - y,
	];
};

const overlaps = (a: Rect, b: Rect) =>
	a[0] < b[0] + b[2] &&
	b[0] < a[0] + a[2] &&
	a[1] < b[1] + b[3] &&
	b[1] < a[1] + a[3];

const visibleArea = (rect: Rect | null, canvas: Rect) => {
	if (rect === null) {
		return 0;
	}

	const width = Math.min(rect[0] + rect[2], canvas[2]) - Math.max(rect[0], 0);
	const height = Math.min(rect[1] + rect[3], canvas[3]) - Math.max(rect[1], 0);
	return Math.max(0, width) * Math.max(0, height);
};

type PathInfo = {
	frames: number;
	// Largest visible area of each look, in output pixels
	looks: Map<string, number>;
	children: string[];
	splittable: boolean;
	leaf: boolean;
	ownPaint: Map<string, number>;
	ownPaintFrames: number;
};

const newInfo = (leaf: boolean): PathInfo => ({
	frames: 0,
	looks: new Map(),
	children: [],
	splittable: true,
	leaf,
	ownPaint: new Map(),
	ownPaintFrames: 0,
});

export const planLayers = ({
	descriptions,
	outputFrames,
	imageFrames,
	scale,
}: {
	// Every source frame in `outputFrames` and `imageFrames`
	descriptions: Map<number, FrameDescription>;
	// The source frame of each frame of the animation
	outputFrames: number[];
	// The source frame whose look each frame shows. Parts that change their
	// look then change it less often, while moving as smoothly as before.
	imageFrames: number[];
	scale: number;
}): LayerPlan => {
	const describe = (frame: number) => {
		const description = descriptions.get(frame);
		if (!description) {
			throw new Error(`Frame ${frame} was not described`);
		}

		return description;
	};

	const info = new Map<string, PathInfo>();
	const root = newInfo(false);
	info.set(ROOT_PATH, root);
	const rootLooks = new Map<number, string>();
	const pixels = (rect: Rect | null, canvas: Rect) =>
		Math.max(1, visibleArea(rect, canvas) * scale * scale);

	for (const frame of new Set([...outputFrames, ...imageFrames])) {
		const {nodes, canvas} = describe(frame);
		// What a node draws, from its leaves. The element of a group can be far
		// larger than what is in it.
		const content: (Rect | null)[] = new Array(nodes.length).fill(null);
		for (let index = nodes.length - 1; index >= 0; index--) {
			const node = nodes[index] as LayerNode;
			let rect: Rect | null =
				node.kind !== 'group' ||
				node.ownPaint !== null ||
				node.blocking.includes('filter')
					? node.bounds
					: null;
			for (const child of node.children) {
				rect = union(rect, content[child] as Rect | null);
			}

			content[index] = rect;
		}

		let rootBounds: Rect | null = null;
		let rootLook = '';
		for (const [index, node] of nodes.entries()) {
			let pathInfo = info.get(node.path);
			if (!pathInfo) {
				pathInfo = newInfo(node.kind !== 'group');
				info.set(node.path, pathInfo);
			}

			pathInfo.frames++;
			if (node.kind !== 'group') {
				pathInfo.leaf = true;
			}

			pathInfo.looks.set(
				node.signature,
				Math.max(
					pathInfo.looks.get(node.signature) ?? 0,
					pixels(content[index] as Rect | null, canvas),
				),
			);
			if (node.ownPaint !== null) {
				pathInfo.ownPaint.set(
					node.ownPaint,
					Math.max(
						pathInfo.ownPaint.get(node.ownPaint) ?? 0,
						pixels(node.bounds, canvas),
					),
				);
				pathInfo.ownPaintFrames++;
			}

			const children = node.children.map((child) => nodes[child] as LayerNode);
			for (const child of children) {
				if (!pathInfo.children.includes(child.path)) {
					pathInfo.children.push(child.path);
				}
			}

			if (
				node.blocking.length > 0 ||
				children.some((child) => child.blend || child.zIndex)
			) {
				pathInfo.splittable = false;
			}

			// The opacity of a group can only move to its children if they do
			// not overlap
			if (node.opacity < 1 && pathInfo.splittable) {
				if (node.ownPaint !== null) {
					pathInfo.splittable = false;
				}

				for (let a = 0; a < children.length && pathInfo.splittable; a++) {
					for (let b = a + 1; b < children.length; b++) {
						const rectA = content[node.children[a] as number];
						const rectB = content[node.children[b] as number];
						if (rectA && rectB && overlaps(rectA, rectB)) {
							pathInfo.splittable = false;
							break;
						}
					}
				}
			}

			if (node.parent === -1) {
				if (!root.children.includes(node.path)) {
					root.children.push(node.path);
				}

				if (node.blend || node.zIndex) {
					root.splittable = false;
				}

				rootBounds = union(rootBounds, content[index] as Rect | null);
				rootLook += `${node.signature}:${node.matrix.map((v) => v.toFixed(3)).join(',')}:${node.opacity.toFixed(4)};`;
			}
		}

		rootLooks.set(frame, rootLook);
		root.looks.set(
			rootLook,
			Math.max(root.looks.get(rootLook) ?? 0, pixels(rootBounds, canvas)),
		);
	}

	root.frames = outputFrames.length;

	// Captures a node as one picture, or splits it into its children: Whatever
	// needs fewer pixels and draws
	const bake = new Map<string, boolean>();
	const cost = (path: string): number => {
		const pathInfo = info.get(path) as PathInfo;
		let bakeCost = DRAW_COST * pathInfo.frames;
		for (const area of pathInfo.looks.values()) {
			bakeCost += area + BITMAP_COST;
		}

		if (pathInfo.leaf || !pathInfo.splittable) {
			bake.set(path, true);
			return bakeCost;
		}

		let splitCost = DRAW_COST * pathInfo.ownPaintFrames;
		for (const area of pathInfo.ownPaint.values()) {
			splitCost += area + BITMAP_COST;
		}

		for (const child of pathInfo.children) {
			splitCost += cost(child);
		}

		bake.set(path, bakeCost <= splitCost);
		return Math.min(bakeCost, splitCost);
	};

	cost(ROOT_PATH);

	const changes = (path: string) => (info.get(path) as PathInfo).looks.size > 1;

	type Use = {
		// Where it is drawn
		matrix: Matrix;
		// Where it is in the frame that it is captured from
		captureMatrix: Matrix;
		path: string;
		ownPaint: boolean;
		frame: number;
	};
	const uses = new Map<string, Use[]>();
	const use = (key: string, value: Use) => {
		const list = uses.get(key);
		if (list) {
			list.push(value);
		} else {
			uses.set(key, [value]);
		}
	};

	const frames = outputFrames.map((sourceFrame, index): LayerUnit[] => {
		const imageFrame = imageFrames[index] as number;
		if (bake.get(ROOT_PATH)) {
			const key = `root:${rootLooks.get(imageFrame)}`;
			const matrix: Matrix = [1, 0, 0, 1, 0, 0];
			use(key, {
				matrix,
				captureMatrix: matrix,
				path: ROOT_PATH,
				ownPaint: false,
				frame: imageFrame,
			});
			return [{key, matrix, alpha: 1}];
		}

		const {nodes} = describe(sourceFrame);
		const imageNodes = new Map(
			describe(imageFrame).nodes.map((node) => [node.path, node]),
		);
		const units: LayerUnit[] = [];
		const visit = (node: LayerNode, alpha: number) => {
			if (bake.get(node.path)) {
				// A part that changes its look shows the look of the image frame
				const imageNode = changes(node.path)
					? imageNodes.get(node.path)
					: undefined;
				const key = `node:${(imageNode ?? node).signature}`;
				use(key, {
					matrix: node.matrix,
					captureMatrix: (imageNode ?? node).matrix,
					path: node.path,
					ownPaint: false,
					frame: imageNode ? imageFrame : sourceFrame,
				});
				units.push({key, matrix: node.matrix, alpha: alpha * node.opacity});
				return;
			}

			if (node.ownPaint !== null) {
				const key = `own:${node.ownPaint}`;
				use(key, {
					matrix: node.matrix,
					captureMatrix: node.matrix,
					path: node.path,
					ownPaint: true,
					frame: sourceFrame,
				});
				units.push({key, matrix: node.matrix, alpha: alpha * node.opacity});
			}

			for (const child of node.children) {
				visit(nodes[child] as LayerNode, alpha * node.opacity);
			}
		};

		for (const node of nodes) {
			if (node.parent === -1) {
				visit(node, 1);
			}
		}

		return units;
	});

	// A picture that only moves is captured where it is. One that turns or
	// scales is captured upright, at the largest size that it is shown at.
	const captures: CaptureRequest[] = [];
	for (const [key, list] of uses) {
		const first = list[0] as Use;
		const upright = !list.every((u) =>
			sameMatrix(u.matrix, first.captureMatrix, 4),
		);
		captures.push({
			key,
			path: first.path,
			ownPaint: first.ownPaint,
			frame: first.frame,
			matrix: first.captureMatrix,
			uprightScale: upright
				? Math.max(
						...list.map((u) =>
							Math.max(
								Math.hypot(u.matrix[0], u.matrix[1]),
								Math.hypot(u.matrix[2], u.matrix[3]),
							),
						),
					)
				: null,
		});
	}

	return {frames, captures};
};
