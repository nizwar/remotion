import React from 'react';
import {Composition} from 'remotion';
import {LoadingOrb} from './LoadingOrb';

export const Root: React.FC = () => {
	return (
		<Composition
			id="LoadingOrb"
			component={LoadingOrb}
			durationInFrames={60}
			fps={30}
			width={256}
			height={256}
		/>
	);
};
