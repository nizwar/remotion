// Runs inside of the render page, as `(${layersPageScript.toString()})()`, so
// it may not use anything from outside of its own body.
// - describe(frame): The DOM of the current frame as a list of nodes
// - isolate(targets): Shows only the given nodes, optionally moved
// - restore(): Undoes isolate()
export const layersPageScript = () => {
	type M = [number, number, number, number, number, number];
	type Target = {path: string; ownPaint: boolean; matrix: M | null};

	const RESOURCE = new Set([
		'defs',
		'mask',
		'clippath',
		'filter',
		'lineargradient',
		'radialgradient',
		'pattern',
		'marker',
		'symbol',
		'style',
		'script',
		'title',
		'desc',
		'metadata',
		'template',
		'noscript',
	]);
	const SVG_LEAF = new Set([
		'path',
		'rect',
		'circle',
		'ellipse',
		'line',
		'polyline',
		'polygon',
		'text',
		'image',
		'use',
		'foreignobject',
	]);
	// Content that can change without the DOM changing
	const VOLATILE = new Set(['canvas', 'video', 'iframe', 'object', 'embed']);
	const REPLACED = new Set([
		'img',
		'canvas',
		'video',
		'iframe',
		'object',
		'embed',
		'input',
		'textarea',
		'select',
		'svg',
	]);
	// Attributes that only move a leaf. They become part of its matrix, so that
	// a circle moving by its `cx` keeps one picture.
	const OFFSET_ATTRIBUTES: Record<string, [string, string]> = {
		circle: ['cx', 'cy'],
		ellipse: ['cx', 'cy'],
		rect: ['x', 'y'],
		image: ['x', 'y'],
		use: ['x', 'y'],
		foreignobject: ['x', 'y'],
	};
	const SVG_INHERITED = [
		'fill',
		'fill-opacity',
		'fill-rule',
		'stroke',
		'stroke-width',
		'stroke-opacity',
		'stroke-dasharray',
		'stroke-dashoffset',
		'stroke-linecap',
		'stroke-linejoin',
		'stroke-miterlimit',
		'color',
		'font-family',
		'font-size',
		'font-weight',
		'font-style',
		'letter-spacing',
		'word-spacing',
		'text-anchor',
		'dominant-baseline',
		'paint-order',
		'shape-rendering',
		'text-rendering',
		'image-rendering',
		'color-interpolation-filters',
		'clip-rule',
		'marker-start',
		'marker-mid',
		'marker-end',
		'direction',
		'writing-mode',
	];
	const HTML_LOOK = [
		'width',
		'height',
		'box-sizing',
		'padding',
		'background-color',
		'background-image',
		'background-size',
		'background-position',
		'background-repeat',
		'background-clip',
		'border-top',
		'border-right',
		'border-bottom',
		'border-left',
		'border-radius',
		'box-shadow',
		'outline',
		'color',
		'font-family',
		'font-size',
		'font-weight',
		'font-style',
		'line-height',
		'letter-spacing',
		'word-spacing',
		'text-align',
		'text-shadow',
		'text-decoration',
		'text-transform',
		'white-space',
		'display',
		'flex-direction',
		'justify-content',
		'align-items',
		'gap',
		'visibility',
		'object-fit',
		'object-position',
		'filter',
		'mask-image',
		'clip-path',
		'mix-blend-mode',
		'overflow',
		'-webkit-text-stroke',
		'-webkit-background-clip',
	];
	// Of the descendants, also where they are
	const HTML_DESCENDANT_LOOK = [
		...HTML_LOOK,
		'opacity',
		'transform',
		'transform-origin',
		'translate',
		'rotate',
		'scale',
		'left',
		'top',
		'right',
		'bottom',
		'position',
		'margin',
		'z-index',
	];

	const hash = (text: string) => {
		let h1 = 0xdeadbeef;
		let h2 = 0x41c6ce57;
		for (let i = 0; i < text.length; i++) {
			const ch = text.charCodeAt(i);
			h1 = Math.imul(h1 ^ ch, 2654435761);
			h2 = Math.imul(h2 ^ ch, 1597334677);
		}

		h1 =
			Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
			Math.imul(h2 ^ (h2 >>> 13), 3266489909);
		h2 =
			Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
			Math.imul(h1 ^ (h1 >>> 13), 3266489909);
		return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
	};

	const multiply = (x: M, y: M): M => [
		x[0] * y[0] + x[2] * y[1],
		x[1] * y[0] + x[3] * y[1],
		x[0] * y[2] + x[2] * y[3],
		x[1] * y[2] + x[3] * y[3],
		x[0] * y[4] + x[2] * y[5] + x[4],
		x[1] * y[4] + x[3] * y[5] + x[5],
	];
	const invert = (m: M): M => {
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

	const tagOf = (el: Element) => el.tagName.toLowerCase();
	const isSvg = (el: Element): el is SVGElement => el instanceof SVGElement;
	const toArray = (m: DOMMatrix): M => [m.a, m.b, m.c, m.d, m.e, m.f];

	// Adds the gradients, filters and masks that a subtree points to, so that a
	// changed gradient changes the look of everything that uses it
	const withReferences = (text: string) => {
		const seen = new Set<string>();
		let out = text;
		const queue = [text];
		while (queue.length > 0) {
			const current = queue.pop() as string;
			const ids = [
				...current.matchAll(/url\(\s*["']?#([^"')\s]+)["']?\s*\)/g),
				...current.matchAll(/href="#([^"]+)"/g),
			].map((match) => match[1] as string);
			for (const id of ids) {
				if (seen.has(id)) {
					continue;
				}

				seen.add(id);
				const ref = document.getElementById(id);
				if (ref) {
					out += `\n#${id}${ref.outerHTML}`;
					queue.push(ref.outerHTML);
				}
			}
		}

		return out;
	};

	const offsetOf = (el: Element): [number, number] => {
		const attributes = OFFSET_ATTRIBUTES[tagOf(el)];
		if (!attributes) {
			return [0, 0];
		}

		const read = (name: string) => {
			const value = el.getAttribute(name);
			return value === null ? 0 : Number(value);
		};

		const offset: [number, number] = [read(attributes[0]), read(attributes[1])];
		return offset.every(Number.isFinite) ? offset : [0, 0];
	};

	// The markup of an element, without what places it
	const withoutPlacement = (el: Element, offset: [number, number]) => {
		const clone = el.cloneNode(true) as Element;
		const attributes = OFFSET_ATTRIBUTES[tagOf(el)];
		if (attributes && (offset[0] !== 0 || offset[1] !== 0)) {
			clone.removeAttribute(attributes[0]);
			clone.removeAttribute(attributes[1]);
		}

		clone.removeAttribute('transform');
		clone.removeAttribute('opacity');
		const {style} = clone as HTMLElement;
		if (style) {
			for (const property of [
				'transform',
				'opacity',
				'transform-origin',
				'left',
				'top',
				'right',
				'bottom',
				'translate',
				'rotate',
				'scale',
				'will-change',
				'margin',
				'margin-left',
				'margin-top',
				'margin-right',
				'margin-bottom',
			]) {
				style.removeProperty(property);
			}
		}

		return clone.outerHTML;
	};

	const computed = (el: Element, properties: string[]) => {
		const style = getComputedStyle(el);
		return properties.map((p) => style.getPropertyValue(p)).join(';');
	};

	const hasTransformedAncestor = (el: Element) => {
		for (
			let e: Element | null = el;
			e && e !== document.documentElement;
			e = e.parentElement
		) {
			const style = getComputedStyle(e);
			if (
				style.transform !== 'none' ||
				style.translate !== 'none' ||
				style.rotate !== 'none' ||
				style.scale !== 'none' ||
				style.perspective !== 'none' ||
				(style as unknown as {zoom: string}).zoom !== '1'
			) {
				return true;
			}
		}

		return false;
	};

	// Maps the border box of an HTML element to viewport pixels. `affine` is
	// false for perspective.
	const htmlMatrix = (el: HTMLElement): {m: M; affine: boolean} => {
		const rect = el.getBoundingClientRect();
		if (!hasTransformedAncestor(el)) {
			return {m: [1, 0, 0, 1, rect.left, rect.top], affine: true};
		}

		if (REPLACED.has(tagOf(el))) {
			return {m: [1, 0, 0, 1, rect.left, rect.top], affine: false};
		}

		const style = getComputedStyle(el);
		const previousPosition = el.style.position;
		if (style.position === 'static') {
			el.style.position = 'relative';
		}

		const borderLeft = parseFloat(style.borderLeftWidth) || 0;
		const borderTop = parseFloat(style.borderTopWidth) || 0;
		const probe = (x: number, y: number) => {
			const point = document.createElement('div');
			point.style.cssText = `position:absolute;left:${x - borderLeft}px;top:${y - borderTop}px;width:0;height:0;margin:0;padding:0;border:0`;
			el.appendChild(point);
			const r = point.getBoundingClientRect();
			point.remove();
			return [r.left, r.top] as const;
		};

		const o = probe(0, 0);
		const px = probe(100, 0);
		const py = probe(0, 100);
		const pxy = probe(100, 100);
		el.style.position = previousPosition;
		const a = (px[0] - o[0]) / 100;
		const b = (px[1] - o[1]) / 100;
		const c = (py[0] - o[0]) / 100;
		const d = (py[1] - o[1]) / 100;
		const affine =
			Math.abs(o[0] + 100 * a + 100 * c - pxy[0]) < 0.05 &&
			Math.abs(o[1] + 100 * b + 100 * d - pxy[1]) < 0.05;
		return {m: [a, b, c, d, o[0], o[1]], affine};
	};

	const matrixOf = (el: Element): {m: M; affine: boolean} => {
		if (isSvg(el)) {
			const ctm = (el as SVGGraphicsElement).getScreenCTM?.();
			if (!ctm) {
				const rect = el.getBoundingClientRect();
				return {m: [1, 0, 0, 1, rect.left, rect.top], affine: false};
			}

			const offset = offsetOf(el);
			return {
				m: multiply(toArray(ctm), [1, 0, 0, 1, offset[0], offset[1]]),
				affine: true,
			};
		}

		return htmlMatrix(el as HTMLElement);
	};

	const hasOwnPaint = (el: Element, style: CSSStyleDeclaration) => {
		if (
			style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
			style.backgroundColor !== 'transparent'
		) {
			return true;
		}

		if (style.backgroundImage !== 'none' || style.boxShadow !== 'none') {
			return true;
		}

		if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) {
			return true;
		}

		for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
			const record = style as unknown as Record<string, string>;
			if (
				record[`border${side}Style`] !== 'none' &&
				parseFloat(record[`border${side}Width`] as string) > 0
			) {
				return true;
			}
		}

		for (const child of el.childNodes) {
			if (child.nodeType === 3 && (child.textContent ?? '').trim() !== '') {
				return true;
			}
		}

		return false;
	};

	const canvasElement = () => {
		const canvas = document.getElementById('remotion-canvas');
		if (!canvas) {
			throw new Error('The canvas of the composition is missing');
		}

		return canvas;
	};

	const covers = (rect: DOMRect, canvas: DOMRect) =>
		rect.left <= canvas.left + 0.5 &&
		rect.top <= canvas.top + 0.5 &&
		rect.right >= canvas.right - 0.5 &&
		rect.bottom >= canvas.bottom - 0.5;

	const describe = (frame: number) => {
		const root = canvasElement();
		const canvas = root.getBoundingClientRect();
		const nodes: unknown[] = [];
		const children: number[][] = [];

		const visit = (el: Element, path: string, parent: number) => {
			const tag = tagOf(el);
			if (RESOURCE.has(tag)) {
				return;
			}

			const style = getComputedStyle(el);
			if (style.display === 'none') {
				return;
			}

			const opacity = parseFloat(style.opacity);
			if (opacity === 0) {
				return;
			}

			const svg = isSvg(el);
			let kind: 'group' | 'leaf' | 'volatile';
			if (svg) {
				kind = SVG_LEAF.has(tag) ? 'leaf' : 'group';
			} else if (VOLATILE.has(tag)) {
				kind = 'volatile';
			} else if (tag === 'img' || el.children.length === 0) {
				kind = 'leaf';
			} else {
				kind = 'group';
			}

			// A hidden element draws nothing, but its children can be visible
			if (kind !== 'group' && style.visibility === 'hidden') {
				return;
			}

			const rect = el.getBoundingClientRect();
			const {m, affine} = matrixOf(el);
			// Scaled to nothing
			if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) {
				return;
			}

			const blocking: string[] = [];
			if (style.filter !== 'none') {
				blocking.push('filter');
			}

			if (
				(style.maskImage && style.maskImage !== 'none') ||
				((style as unknown as {webkitMaskImage?: string}).webkitMaskImage ??
					'none') !== 'none' ||
				(svg && style.mask && style.mask !== 'none')
			) {
				blocking.push('mask');
			}

			if (style.clipPath !== 'none') {
				blocking.push('clip-path');
			}

			if (!svg && style.backdropFilter && style.backdropFilter !== 'none') {
				blocking.push('backdrop-filter');
			}

			if (!svg && style.perspective !== 'none') {
				blocking.push('perspective');
			}

			if (!svg && style.transformStyle === 'preserve-3d') {
				blocking.push('3d');
			}

			const clips = svg
				? tag === 'svg' && style.overflow !== 'visible'
				: style.overflowX !== 'visible' || style.overflowY !== 'visible';
			// The player clips to the canvas anyway
			if (clips && !covers(rect, canvas)) {
				blocking.push('overflow');
			}

			const offset = svg ? offsetOf(el) : ([0, 0] as [number, number]);
			let signature = withReferences(withoutPlacement(el, offset));
			if (svg) {
				signature += computed(el, SVG_INHERITED);
			} else {
				signature += computed(el, HTML_LOOK);
				for (const descendant of el.querySelectorAll('*')) {
					if (!isSvg(descendant)) {
						signature += `|${computed(descendant, HTML_DESCENDANT_LOOK)}`;
					}
				}
			}

			if (kind === 'volatile' || !affine) {
				signature += `@${frame}`;
			}

			const ownPaint =
				!svg &&
				kind === 'group' &&
				style.visibility !== 'hidden' &&
				hasOwnPaint(el, style)
					? hash(
							computed(el, HTML_LOOK) +
								[...el.childNodes]
									.filter((n) => n.nodeType === 3)
									.map((n) => n.textContent)
									.join(''),
						)
					: null;

			const index = nodes.length;
			const childList: number[] = [];
			children.push(childList);
			nodes.push({
				path,
				kind,
				signature: hash(signature),
				matrix: [m[0], m[1], m[2], m[3], m[4] - canvas.left, m[5] - canvas.top],
				opacity,
				blocking,
				bounds: [
					rect.left - canvas.left,
					rect.top - canvas.top,
					rect.width,
					rect.height,
				],
				parent,
				children: childList,
				ownPaint,
				blend: style.mixBlendMode !== 'normal',
				zIndex: !svg && style.position !== 'static' && style.zIndex !== 'auto',
			});
			if (parent !== -1) {
				(children[parent] as number[]).push(index);
			}

			if (kind === 'group') {
				let i = 0;
				for (const child of el.children) {
					visit(child, `${path}/${i}`, index);
					i++;
				}
			}
		};

		let rootIndex = 0;
		for (const child of root.children) {
			visit(child, String(rootIndex), -1);
			rootIndex++;
		}

		return {
			canvas: [0, 0, canvas.width, canvas.height],
			nodes,
		};
	};

	const findByPath = (path: string) => {
		let el: Element | undefined = canvasElement();
		for (const part of path.split('/')) {
			el = el?.children[Number(part)];
		}

		return el ?? null;
	};

	const undo: (() => void)[] = [];
	const setStyle = (el: Element, property: string, value: string) => {
		const {style} = el as HTMLElement;
		const previous = style.getPropertyValue(property);
		const priority = style.getPropertyPriority(property);
		undo.push(() => style.setProperty(property, previous, priority));
		style.setProperty(property, value, 'important');
	};

	const restore = () => {
		while (undo.length > 0) {
			(undo.pop() as () => void)();
		}
	};

	// Shows only the targets, each optionally moved so that it maps to its
	// matrix. Returns the bounds of what is shown and the actual matrices.
	const isolate = (targets: Target[]) => {
		restore();
		const root = canvasElement();
		const canvas = root.getBoundingClientRect();
		setStyle(document.body, 'background', 'transparent');
		if (targets.length === 1 && (targets[0] as Target).path === '') {
			return {
				origin: [canvas.left, canvas.top],
				bounds: [0, 0, canvas.width, canvas.height],
				matrices: [[1, 0, 0, 1, 0, 0]],
			};
		}

		const els = targets.map((target) => ({
			...target,
			el: findByPath(target.path),
		}));
		if (els.some((t) => t.el === null)) {
			return null;
		}

		setStyle(root, 'visibility', 'hidden');
		const kept = new Set<Element>();
		for (const {el} of els) {
			for (let e: Element | null = el; e && e !== root; e = e.parentElement) {
				kept.add(e);
			}
		}

		// A moved node may leave the canvas
		for (let e: Element | null = root; e; e = e.parentElement) {
			setStyle(e, 'overflow', 'visible');
		}

		const outerSvgs = new Set<Element>();
		for (const {el} of els) {
			let outer: Element | null = null;
			for (
				let e: Element | null = (el as Element).parentElement;
				e && e !== root;
				e = e.parentElement
			) {
				if (isSvg(e) && tagOf(e) === 'svg') {
					setStyle(e, 'overflow', 'visible');
					outer = e;
				}
			}

			if (isSvg(el as Element) && tagOf(el as Element) === 'svg') {
				outer = outer ?? (el as Element);
			}

			if (outer) {
				outerSvgs.add(outer);
			} else {
				setStyle(el as Element, 'visibility', 'visible');
			}
		}

		// Inside of an SVG, hide with opacity: Hidden masks and gradients would
		// stop working
		const targetElements = new Set(els.map((t) => t.el as Element));
		const hideOthers = (parent: Element) => {
			for (const child of parent.children) {
				if (RESOURCE.has(tagOf(child)) || targetElements.has(child)) {
					continue;
				}

				if (kept.has(child)) {
					hideOthers(child);
					continue;
				}

				setStyle(child, 'opacity', '0');
			}
		};

		for (const svg of outerSvgs) {
			setStyle(svg, 'visibility', 'visible');
			if (!targetElements.has(svg)) {
				hideOthers(svg);
			}
		}

		for (const target of els) {
			const el = target.el as Element;
			if (target.ownPaint) {
				for (const child of el.children) {
					setStyle(child, 'visibility', 'hidden');
				}
			}

			setStyle(el, 'opacity', '1');
			if (target.matrix === null) {
				continue;
			}

			if (isSvg(el)) {
				const parent = el.parentElement;
				const parentMatrix =
					parent && isSvg(parent)
						? toArray(
								(
									parent as unknown as SVGGraphicsElement
								).getScreenCTM() as DOMMatrix,
							)
						: ([1, 0, 0, 1, 0, 0] as M);
				const offset = offsetOf(el);
				const wanted: M = [
					...(target.matrix.slice(0, 4) as [number, number, number, number]),
					target.matrix[4] + canvas.left,
					target.matrix[5] + canvas.top,
				];
				const own = multiply(multiply(invert(parentMatrix), wanted), [
					1,
					0,
					0,
					1,
					-offset[0],
					-offset[1],
				]);
				// A CSS transform wins over the attribute
				setStyle(el, 'transform-box', 'view-box');
				setStyle(el, 'transform-origin', '0 0');
				setStyle(el, 'translate', 'none');
				setStyle(el, 'rotate', 'none');
				setStyle(el, 'scale', 'none');
				setStyle(el, 'transform', `matrix(${own.join(',')})`);
			} else {
				setStyle(el, 'transform', 'none');
				setStyle(el, 'translate', 'none');
				setStyle(el, 'rotate', 'none');
				setStyle(el, 'scale', 'none');
				const base = htmlMatrix(el as HTMLElement).m;
				const wanted: M = [
					...(target.matrix.slice(0, 4) as [number, number, number, number]),
					target.matrix[4] + canvas.left,
					target.matrix[5] + canvas.top,
				];
				setStyle(el, 'transform-origin', '0 0');
				setStyle(
					el,
					'transform',
					`matrix(${multiply(invert(base), wanted).join(',')})`,
				);
			}
		}

		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		const include = (r: DOMRect) => {
			if (r.width === 0 && r.height === 0) {
				return;
			}

			minX = Math.min(minX, r.left);
			minY = Math.min(minY, r.top);
			maxX = Math.max(maxX, r.right);
			maxY = Math.max(maxY, r.bottom);
		};

		const matrices: M[] = [];
		for (const {el} of els) {
			include((el as Element).getBoundingClientRect());
			for (const descendant of (el as Element).querySelectorAll('*')) {
				if (!RESOURCE.has(tagOf(descendant))) {
					include(descendant.getBoundingClientRect());
				}
			}

			const {m} = matrixOf(el as Element);
			matrices.push([
				m[0],
				m[1],
				m[2],
				m[3],
				m[4] - canvas.left,
				m[5] - canvas.top,
			]);
		}

		if (minX === Infinity) {
			return {
				origin: [canvas.left, canvas.top],
				bounds: [0, 0, 0, 0],
				matrices,
			};
		}

		return {
			origin: [canvas.left, canvas.top],
			bounds: [minX - canvas.left, minY - canvas.top, maxX - minX, maxY - minY],
			matrices,
		};
	};

	(window as unknown as {remotion_layers: unknown}).remotion_layers = {
		describe,
		isolate,
		restore,
	};
};
