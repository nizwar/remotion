import type {WanimFormat, WanimOptions} from '@remotion/studio-shared';
import {parseWanimAnimations} from '@remotion/studio-shared';
import React, {useCallback, useMemo, useState} from 'react';
import {FAIL_COLOR, LIGHT_TEXT} from '../../helpers/colors';
import {Checkmark} from '../../icons/Checkmark';
import {Checkbox} from '../Checkbox';
import type {ComboboxValue} from '../NewComposition/ComboBox';
import {Combobox} from '../NewComposition/ComboBox';
import {RemotionInput} from '../NewComposition/RemInput';
import {SegmentedControl} from '../SegmentedControl';
import {label, optionRow, rightRow} from './layout';

// An atlas is at most 4096 pixels, and keeps a gutter around each frame
const MAX_SIZE = 4092;
const MAX_RENDER_SCALE = 16;

export type WanimSize = {
	width: number;
	height: number;
	locked: boolean;
	fit: WanimOptions['fit'];
	mode: 'scale' | 'resolution';
};

type SavedWanimSettings = {
	size: WanimSize;
	compression: WanimOptions['compression'];
	// Missing in settings saved by older versions
	format?: WanimFormat;
	frameRate?: number | null;
	imageRate?: number | null;
	animations?: string;
	legacy?: boolean;
};

// Frame rates to choose from, if they are lower than the composition's
const FRAME_RATES = [60, 50, 30, 25, 24, 20, 15, 12, 10, 8, 6, 5];

const getStorageKey = (compositionId: string) =>
	`remotion.wanim.${compositionId}`;

export const loadWanimSettings = (
	compositionId: string,
): SavedWanimSettings | null => {
	try {
		const saved = localStorage.getItem(getStorageKey(compositionId));
		if (saved === null) {
			return null;
		}

		const parsed = JSON.parse(saved) as SavedWanimSettings;
		const {size} = parsed;
		return size.width >= 1 &&
			size.width <= MAX_SIZE &&
			size.height >= 1 &&
			size.height <= MAX_SIZE
			? parsed
			: null;
	} catch {
		return null;
	}
};

export const saveWanimSettings = (
	compositionId: string,
	settings: SavedWanimSettings,
) => {
	try {
		localStorage.setItem(
			getStorageKey(compositionId),
			JSON.stringify(settings),
		);
	} catch {
		// localStorage might not be available
	}
};

export const getInitialWanimSize = ({
	retry,
	saved,
	scale,
	compositionWidth,
	compositionHeight,
}: {
	retry: WanimOptions | null;
	saved: WanimSize | null;
	scale: number;
	compositionWidth: number;
	compositionHeight: number;
}): WanimSize => {
	if (retry) {
		const sameRatio =
			Math.abs(
				retry.height - (retry.width * compositionHeight) / compositionWidth,
			) <= 1;
		return {
			width: retry.width,
			height: retry.height,
			locked: sameRatio,
			fit: sameRatio ? 'contain' : retry.fit,
			mode: sameRatio ? 'scale' : 'resolution',
		};
	}

	if (saved) {
		return saved;
	}

	return {
		width: Math.min(Math.round(compositionWidth * scale), MAX_SIZE),
		height: Math.min(Math.round(compositionHeight * scale), MAX_SIZE),
		locked: true,
		fit: 'contain',
		mode: 'scale',
	};
};

// Chrome scales, because it stays sharp. What differs from the requested size
// after that gets padded, cropped or stretched while packing.
export const getWanimRenderScale = ({
	size,
	compositionWidth,
	compositionHeight,
}: {
	size: WanimSize;
	compositionWidth: number;
	compositionHeight: number;
}) => {
	const ratioX = size.width / compositionWidth;
	const ratioY = size.height / compositionHeight;
	const scale =
		!size.locked && size.fit === 'contain'
			? Math.min(ratioX, ratioY)
			: Math.max(ratioX, ratioY);
	return Math.min(scale, MAX_RENDER_SCALE);
};

const inputStyle: React.CSSProperties = {width: 110};

const hintStyle: React.CSSProperties = {
	fontSize: 13,
	color: LIGHT_TEXT,
	fontFamily: 'sans-serif',
	paddingRight: 16,
	textAlign: 'right',
	marginBottom: 14,
};

const errorHintStyle: React.CSSProperties = {...hintStyle, color: FAIL_COLOR};

const animationsInputStyle: React.CSSProperties = {width: 260};

const NumberField: React.FC<{
	readonly name: string;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly onChange: (value: number) => void;
}> = ({name, value, min, max, onChange}) => {
	const [draft, setDraft] = useState<string | null>(null);
	const parsed = draft === null ? value : Number(draft.replace(',', '.'));
	const valid = Number.isFinite(parsed) && parsed >= min && parsed <= max;

	const onInput: React.ChangeEventHandler<HTMLInputElement> = useCallback(
		(event) => {
			setDraft(event.target.value);
			const next = Number(event.target.value.replace(',', '.'));
			if (event.target.value !== '' && next >= min && next <= max) {
				onChange(next);
			}
		},
		[max, min, onChange],
	);

	return (
		<div style={optionRow}>
			<div style={label}>{name}</div>
			<div style={rightRow}>
				<RemotionInput
					aria-label={name}
					type="text"
					inputMode="decimal"
					status={valid ? 'ok' : 'error'}
					rightAlign
					style={inputStyle}
					value={draft ?? String(value)}
					onChange={onInput}
					onBlur={() => setDraft(null)}
				/>
			</div>
		</div>
	);
};

const formatLabel = (fps: number) =>
	Number.isInteger(fps) ? String(fps) : fps.toFixed(2);

export const WanimSizeSetting: React.FC<{
	readonly size: WanimSize;
	readonly setSize: (size: WanimSize) => void;
	readonly compression: WanimOptions['compression'];
	readonly setCompression: (value: WanimOptions['compression']) => void;
	readonly format: WanimFormat;
	readonly setFormat: (value: WanimFormat) => void;
	readonly frameRate: number | null;
	readonly setFrameRate: (value: number | null) => void;
	readonly imageRate: number | null;
	readonly setImageRate: (value: number | null) => void;
	readonly animations: string;
	readonly setAnimations: (value: string) => void;
	readonly legacy: boolean;
	readonly setLegacy: (value: boolean) => void;
	readonly compositionWidth: number;
	readonly compositionHeight: number;
	readonly compositionFps: number;
}> = ({
	size,
	setSize,
	compression,
	setCompression,
	format,
	setFormat,
	frameRate,
	setFrameRate,
	imageRate,
	setImageRate,
	animations,
	setAnimations,
	legacy,
	setLegacy,
	compositionWidth,
	compositionHeight,
	compositionFps,
}) => {
	const {mode} = size;
	// Only version 3 files hold several animations and lossy pictures
	const isVersion3 = format !== 'svga' && !legacy;

	const animationsHint = useMemo((): {text: string; error: boolean} => {
		try {
			const parsed = parseWanimAnimations(animations);
			if (parsed === null) {
				return {
					text: 'One animation of all frames. To get several that the app plays by key: transition_in=0-29,idle=30-89:loop',
					error: false,
				};
			}

			return {
				text: parsed
					.map(
						(a) =>
							`${a.key}: frames ${a.from}-${a.to}${a.loop ? ', loops' : ''}`,
					)
					.join(' · '),
				error: false,
			};
		} catch (err) {
			return {text: (err as Error).message, error: true};
		}
	}, [animations]);

	const onAnimations: React.ChangeEventHandler<HTMLInputElement> = useCallback(
		(event) => setAnimations(event.target.value),
		[setAnimations],
	);

	const onLegacy: React.ChangeEventHandler<HTMLInputElement> = useCallback(
		(event) => {
			setLegacy(event.target.checked);
			if (event.target.checked && compression === 'lossy') {
				setCompression('balanced');
			}
		},
		[compression, setCompression, setLegacy],
	);

	const formatItems = useMemo((): ComboboxValue[] => {
		const formats: {id: WanimFormat; label: string}[] = [
			{id: 'frames', label: 'Frames (.wanim)'},
			{id: 'layers', label: 'Layers (.wanim)'},
			{id: 'svga', label: 'SVGA (.svga)'},
		];
		return formats.map(
			(item): ComboboxValue => ({
				type: 'item',
				id: item.id,
				value: item.id,
				label: item.label,
				leftItem: format === item.id ? <Checkmark /> : null,
				keyHint: null,
				quickSwitcherLabel: null,
				subMenu: null,
				onClick: () => {
					setFormat(item.id);
					if (item.id === 'svga' && compression === 'lossy') {
						setCompression('balanced');
					}
				},
			}),
		);
	}, [compression, format, setCompression, setFormat]);

	const formatHint =
		format === 'frames'
			? 'One picture per frame.'
			: format === 'layers'
				? 'Moving parts are stored once and moved by the player.'
				: 'Layers in the open SVGA format. Not encrypted, plays in any SVGA player.';

	// The playback rate, which is the composition's or lower
	const effectiveFrameRate =
		frameRate === null ? compositionFps : Math.min(frameRate, compositionFps);

	const rateItems = useCallback(
		({
			selected,
			below,
			sameLabel,
			onSelect,
		}: {
			selected: number | null;
			below: number;
			sameLabel: string;
			onSelect: (value: number | null) => void;
		}): ComboboxValue[] => {
			const rates: (number | null)[] = [
				null,
				...FRAME_RATES.filter((rate) => rate < below),
			];
			return rates.map(
				(rate): ComboboxValue => ({
					type: 'item',
					id: String(rate),
					value: String(rate),
					label: rate === null ? sameLabel : `${rate} fps`,
					leftItem: selected === rate ? <Checkmark /> : null,
					keyHint: null,
					quickSwitcherLabel: null,
					subMenu: null,
					onClick: () => onSelect(rate),
				}),
			);
		},
		[],
	);

	const frameRateItems = useMemo(
		() =>
			rateItems({
				selected: frameRate,
				below: compositionFps,
				sameLabel: `${formatLabel(compositionFps)} fps (composition)`,
				onSelect: (rate) => {
					setFrameRate(rate);
					// Pictures cannot change more often than frames
					if (rate !== null && imageRate !== null && imageRate >= rate) {
						setImageRate(null);
					}
				},
			}),
		[
			compositionFps,
			frameRate,
			imageRate,
			rateItems,
			setFrameRate,
			setImageRate,
		],
	);

	const imageRateItems = useMemo(
		() =>
			rateItems({
				selected: imageRate,
				below: effectiveFrameRate,
				sameLabel: 'Every frame',
				onSelect: setImageRate,
			}),
		[effectiveFrameRate, imageRate, rateItems, setImageRate],
	);

	const frameRateHint =
		frameRate === null
			? 'Every frame of the composition'
			: `Same duration with ${Math.round((effectiveFrameRate / compositionFps) * 100)}% of the frames`;
	const imageRateHint =
		imageRate === null
			? format === 'frames'
				? 'Each frame gets its own picture'
				: 'Changing parts get a new picture in every frame'
			: format === 'frames'
				? `A new picture ${imageRate} times per second, held in between`
				: `Moves stay smooth, changing parts get a new picture ${imageRate} times per second`;

	const fromScale = useCallback(
		(scale: number) => {
			setSize({
				...size,
				width: Math.max(1, Math.round(compositionWidth * scale)),
				height: Math.max(1, Math.round(compositionHeight * scale)),
			});
		},
		[compositionHeight, compositionWidth, setSize, size],
	);

	const onWidth = useCallback(
		(width: number) => {
			const rounded = Math.round(width);
			setSize({
				...size,
				width: rounded,
				height: size.locked
					? Math.max(
							1,
							Math.round((rounded * compositionHeight) / compositionWidth),
						)
					: size.height,
			});
		},
		[compositionHeight, compositionWidth, setSize, size],
	);

	const onHeight = useCallback(
		(height: number) => {
			const rounded = Math.round(height);
			setSize({
				...size,
				height: rounded,
				width: size.locked
					? Math.max(
							1,
							Math.round((rounded * compositionWidth) / compositionHeight),
						)
					: size.width,
			});
		},
		[compositionHeight, compositionWidth, setSize, size],
	);

	const onLock: React.ChangeEventHandler<HTMLInputElement> = useCallback(
		(event) => {
			const locked = event.target.checked;
			setSize({
				...size,
				locked,
				height: locked
					? Math.max(
							1,
							Math.round((size.width * compositionHeight) / compositionWidth),
						)
					: size.height,
			});
		},
		[compositionHeight, compositionWidth, setSize, size],
	);

	const modeItems = useMemo((): ComboboxValue[] => {
		const modes: {id: WanimSize['mode']; label: string}[] = [
			{id: 'scale', label: 'Scale'},
			{id: 'resolution', label: 'Resolution'},
		];
		return modes.map(
			(item): ComboboxValue => ({
				type: 'item',
				id: item.id,
				value: item.id,
				label: item.label,
				leftItem: mode === item.id ? <Checkmark /> : null,
				keyHint: null,
				quickSwitcherLabel: null,
				subMenu: null,
				onClick: () => {
					setSize({
						...size,
						mode: item.id,
						locked: item.id === 'scale' ? true : size.locked,
						height:
							item.id === 'scale'
								? Math.max(
										1,
										Math.round(
											(size.width * compositionHeight) / compositionWidth,
										),
									)
								: size.height,
					});
				},
			}),
		);
	}, [compositionHeight, compositionWidth, mode, setSize, size]);

	const fitItems = useMemo(() => {
		const fits: {key: WanimOptions['fit']; label: string}[] = [
			{key: 'contain', label: 'Contain'},
			{key: 'cover', label: 'Cover'},
			{key: 'stretch', label: 'Stretch'},
		];
		return fits.map((fit) => ({
			...fit,
			selected: size.fit === fit.key,
			onClick: () => setSize({...size, fit: fit.key}),
		}));
	}, [setSize, size]);

	const compressionItems = useMemo(() => {
		const levels: {key: WanimOptions['compression']; label: string}[] = [
			{key: 'none', label: 'Off'},
			{key: 'balanced', label: 'Balanced'},
			{key: 'small', label: 'Small'},
			...(isVersion3 ? [{key: 'lossy' as const, label: 'Lossy'}] : []),
		];
		return levels.map((level) => ({
			...level,
			selected: compression === level.key,
			onClick: () => setCompression(level.key),
		}));
	}, [compression, isVersion3, setCompression]);

	const fitHint =
		size.fit === 'contain'
			? 'Keeps the whole picture, with transparent bars'
			: size.fit === 'cover'
				? 'Fills the size and crops the rest'
				: 'Fills the size and distorts the picture';

	const compressionHint =
		compression === 'none'
			? 'Lossless'
			: compression === 'balanced'
				? 'Fewer color shades, barely visible'
				: compression === 'small'
					? '256 colors per atlas, gradients may show bands'
					: 'Like a photo at high quality. Smallest for painted pictures, larger for flat colors';

	return (
		<>
			<div style={optionRow}>
				<div style={label}>Format</div>
				<div style={rightRow}>
					<Combobox
						values={formatItems}
						selectedId={format}
						aria-label="Format"
					/>
				</div>
			</div>
			<div style={hintStyle}>{formatHint}</div>
			{format === 'svga' ? null : (
				<>
					<div style={optionRow}>
						<div style={label}>For older players</div>
						<div style={rightRow}>
							<Checkbox
								checked={legacy}
								onChange={onLegacy}
								name="wanim-legacy"
							/>
						</div>
					</div>
					<div style={hintStyle}>
						{legacy
							? `Version ${format === 'layers' ? 2 : 1}: One animation, larger file`
							: 'Version 3: Needs a player with version 3 support'}
					</div>
				</>
			)}
			{isVersion3 ? (
				<>
					<div style={optionRow}>
						<div style={label}>Animations</div>
						<div style={rightRow}>
							<RemotionInput
								aria-label="Animations"
								type="text"
								status={animationsHint.error ? 'error' : 'ok'}
								rightAlign={false}
								style={animationsInputStyle}
								placeholder="transition_in=0-29,idle=30-89:loop"
								value={animations}
								onChange={onAnimations}
							/>
						</div>
					</div>
					<div style={animationsHint.error ? errorHintStyle : hintStyle}>
						{animationsHint.text}
					</div>
				</>
			) : null}
			<div style={optionRow}>
				<div style={label}>Size</div>
				<div style={rightRow}>
					<Combobox values={modeItems} selectedId={mode} aria-label="Size" />
				</div>
			</div>
			{mode === 'scale' ? (
				<>
					<NumberField
						name="Scale"
						value={Number((size.width / compositionWidth).toFixed(3))}
						min={1 / compositionWidth}
						max={MAX_SIZE / Math.max(compositionWidth, compositionHeight)}
						onChange={fromScale}
					/>
					<div style={hintStyle}>
						Output: {size.width}×{size.height}
					</div>
				</>
			) : (
				<>
					<NumberField
						name="Width"
						value={size.width}
						min={1}
						max={MAX_SIZE}
						onChange={onWidth}
					/>
					<NumberField
						name="Height"
						value={size.height}
						min={1}
						max={MAX_SIZE}
						onChange={onHeight}
					/>
					<div style={optionRow}>
						<div style={label}>Lock aspect ratio</div>
						<div style={rightRow}>
							<Checkbox
								checked={size.locked}
								onChange={onLock}
								name="lock-aspect-ratio"
							/>
						</div>
					</div>
					{size.locked ? null : (
						<>
							<div style={optionRow}>
								<div style={label}>Fit</div>
								<div style={rightRow}>
									<SegmentedControl items={fitItems} needsWrapping={false} />
								</div>
							</div>
							<div style={hintStyle}>{fitHint}</div>
						</>
					)}
				</>
			)}
			<div style={optionRow}>
				<div style={label}>Frame rate</div>
				<div style={rightRow}>
					<Combobox
						values={frameRateItems}
						selectedId={String(frameRate)}
						aria-label="Frame rate"
					/>
				</div>
			</div>
			<div style={hintStyle}>{frameRateHint}</div>
			<div style={optionRow}>
				<div style={label}>Image rate</div>
				<div style={rightRow}>
					<Combobox
						values={imageRateItems}
						selectedId={String(imageRate)}
						aria-label="Image rate"
					/>
				</div>
			</div>
			<div style={hintStyle}>{imageRateHint}</div>
			<div style={optionRow}>
				<div style={label}>Compression</div>
				<div style={rightRow}>
					<SegmentedControl items={compressionItems} needsWrapping={false} />
				</div>
			</div>
			<div style={hintStyle}>{compressionHint}</div>
		</>
	);
};
