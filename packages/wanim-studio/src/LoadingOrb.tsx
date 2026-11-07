import React from 'react';
import {useCurrentFrame, useVideoConfig} from 'remotion';

const DOTS = 3;

// Everything is a function of one full turn, so the last frame leads back into
// the first one. No background, so that the sprite stays transparent.
export const LoadingOrb: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames, width, height} = useVideoConfig();
	const turn = (frame / durationInFrames) * Math.PI * 2;
	const center = width / 2;

	return (
		<svg viewBox={`0 0 ${width} ${height}`} width={width} height={height}>
			<defs>
				<radialGradient id="core">
					<stop offset="0%" stopColor="#fff6c9" />
					<stop offset="60%" stopColor="#ffb02e" />
					<stop offset="100%" stopColor="#ff5a1f" stopOpacity={0} />
				</radialGradient>
			</defs>
			<circle
				cx={center}
				cy={center}
				r={46 + Math.sin(turn * 2) * 8}
				fill="url(#core)"
			/>
			<circle
				cx={center}
				cy={center}
				r={92}
				fill="none"
				stroke="#ffb02e"
				strokeOpacity={0.35}
				strokeWidth={3}
			/>
			{new Array(DOTS).fill(true).map((_, index) => {
				const angle = turn + (index / DOTS) * Math.PI * 2;
				return (
					<circle
						// eslint-disable-next-line react/no-array-index-key
						key={index}
						cx={center + Math.cos(angle) * 92}
						cy={center + Math.sin(angle) * 92}
						r={12 + Math.sin(angle * 2) * 3}
						fill="#ff7a1f"
					/>
				);
			})}
		</svg>
	);
};
