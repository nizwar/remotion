import type {WanimOptions} from '@remotion/studio-shared';
import React, {useCallback, useMemo, useState} from 'react';
import {LIGHT_TEXT} from '../../helpers/colors';
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
};

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

export const WanimSizeSetting: React.FC<{
	readonly size: WanimSize;
	readonly setSize: (size: WanimSize) => void;
	readonly compression: WanimOptions['compression'];
	readonly setCompression: (value: WanimOptions['compression']) => void;
	readonly compositionWidth: number;
	readonly compositionHeight: number;
}> = ({
	size,
	setSize,
	compression,
	setCompression,
	compositionWidth,
	compositionHeight,
}) => {
	const {mode} = size;

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
		];
		return levels.map((level) => ({
			...level,
			selected: compression === level.key,
			onClick: () => setCompression(level.key),
		}));
	}, [compression, setCompression]);

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
				: '256 colors per atlas, gradients may show bands';

	return (
		<>
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
				<div style={label}>Compression</div>
				<div style={rightRow}>
					<SegmentedControl items={compressionItems} needsWrapping={false} />
				</div>
			</div>
			<div style={hintStyle}>{compressionHint}</div>
		</>
	);
};
