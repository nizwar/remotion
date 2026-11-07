import React from 'react';
import {Grid} from '../../components/TableOfContents/Grid';
import {TOCItem} from '../../components/TableOfContents/TOCItem';

export const TableOfContents: React.FC = () => {
	return (
		<div>
			<Grid>
				<TOCItem link="/docs/wanim/pack-wanim">
					<strong>
						<code>packWanim()</code>
					</strong>
					<div>Pack PNG frames into a .wanim file</div>
				</TOCItem>
				<TOCItem link="/docs/wanim/open-wanim">
					<strong>
						<code>openWanim()</code>
					</strong>
					<div>Read the manifest and atlases of a .wanim file</div>
				</TOCItem>
				<TOCItem link="/docs/wanim/generate-wanim-key">
					<strong>
						<code>generateWanimKey()</code>
					</strong>
					<div>Create a random key</div>
				</TOCItem>
			</Grid>
		</div>
	);
};
