import type {StillImageFormat, VideoImageFormat} from '@remotion/renderer';
import type {WanimOptions} from '@remotion/studio-shared';
import React from 'react';
import {VERTICAL_SCROLLBAR_CLASSNAME} from '../Menu/is-menu-item';
import type {SegmentedControlItem} from '../SegmentedControl';
import {SegmentedControl} from '../SegmentedControl';
import {JpegQualitySetting} from './JpegQualitySetting';
import {label, optionRow, rightRow} from './layout';
import type {RenderType} from './RenderModalAdvanced';
import {RenderModalHr} from './RenderModalHr';
import {ScaleSetting} from './ScaleSetting';
import type {WanimSize} from './WanimSizeSetting';
import {WanimSizeSetting} from './WanimSizeSetting';

const container: React.CSSProperties = {
	flex: 1,
	overflowY: 'auto',
};

export const RenderModalPicture: React.FC<{
	readonly renderMode: RenderType;
	readonly scale: number;
	readonly setScale: React.Dispatch<React.SetStateAction<number>>;
	readonly imageFormatOptions: SegmentedControlItem[];
	readonly videoImageFormat: VideoImageFormat;
	readonly usesSharedMemoryCapture: boolean;
	readonly stillImageFormat: StillImageFormat;
	readonly setJpegQuality: React.Dispatch<React.SetStateAction<number>>;
	readonly jpegQuality: number;
	readonly compositionWidth: number;
	readonly compositionHeight: number;
	readonly wanimSize: WanimSize;
	readonly setWanimSize: (size: WanimSize) => void;
	readonly wanimCompression: WanimOptions['compression'];
	readonly setWanimCompression: (value: WanimOptions['compression']) => void;
}> = ({
	renderMode,
	scale,
	setScale,
	imageFormatOptions,
	videoImageFormat,
	usesSharedMemoryCapture,
	setJpegQuality,
	jpegQuality,
	stillImageFormat,
	compositionWidth,
	compositionHeight,
	wanimSize,
	setWanimSize,
	wanimCompression,
	setWanimCompression,
}) => {
	return (
		<div style={container} className={VERTICAL_SCROLLBAR_CLASSNAME}>
			{renderMode === 'video' && !usesSharedMemoryCapture ? (
				<div style={optionRow}>
					<div style={label}>Image Format</div>
					<div style={rightRow}>
						<SegmentedControl
							items={imageFormatOptions}
							needsWrapping={false}
						/>
					</div>
				</div>
			) : null}
			{renderMode === 'video' &&
			!usesSharedMemoryCapture &&
			videoImageFormat === 'jpeg' ? (
				<JpegQualitySetting
					jpegQuality={jpegQuality}
					setJpegQuality={setJpegQuality}
				/>
			) : null}
			{renderMode === 'still' && stillImageFormat === 'jpeg' ? (
				<JpegQualitySetting
					jpegQuality={jpegQuality}
					setJpegQuality={setJpegQuality}
				/>
			) : null}
			{renderMode === 'video' && !usesSharedMemoryCapture ? (
				<RenderModalHr />
			) : null}
			{renderMode === 'wanim' ? (
				<WanimSizeSetting
					size={wanimSize}
					setSize={setWanimSize}
					compression={wanimCompression}
					setCompression={setWanimCompression}
					compositionWidth={compositionWidth}
					compositionHeight={compositionHeight}
				/>
			) : (
				<ScaleSetting
					scale={scale}
					setScale={setScale}
					compositionWidth={compositionWidth}
					compositionHeight={compositionHeight}
				/>
			)}
		</div>
	);
};
