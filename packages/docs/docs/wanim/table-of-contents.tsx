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
				<TOCItem link="/docs/wanim/pack-wanim-layers">
					<strong>
						<code>packWanimLayers()</code>
					</strong>
					<div>Pack layers into a .wanim file of version 2</div>
				</TOCItem>
				<TOCItem link="/docs/wanim/pack-wanim-animations">
					<strong>
						<code>packWanimAnimations()</code>
					</strong>
					<div>Pack animations with keys into a .wanim file of version 3</div>
				</TOCItem>
				<TOCItem link="/docs/wanim/read-wanim-as-set">
					<strong>
						<code>readWanimAsSet()</code>
					</strong>
					<div>Read a .wanim file of any version to pack it again</div>
				</TOCItem>
				<TOCItem link="/docs/wanim/pack-svga">
					<strong>
						<code>packSvga()</code>
					</strong>
					<div>Write layers into an SVGA file</div>
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
				<TOCItem link="/docs/wanim/sample-wanim-frames">
					<strong>
						<code>sampleWanimFrames()</code>
					</strong>
					<div>Pick frames for a lower frame rate</div>
				</TOCItem>
			</Grid>
		</div>
	);
};
