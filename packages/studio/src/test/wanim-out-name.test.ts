import {expect, test} from 'bun:test';
import {validateOutnameGui} from '../components/RenderModal/out-name-checker';

const validate = (outName: string) =>
	validateOutnameGui({
		outName,
		codec: 'h264',
		audioCodec: 'aac',
		renderMode: 'wanim',
		stillImageFormat: null,
		separateAudioTo: null,
	});

test('accepts a .wanim output name', () => {
	expect(validate('out/sprite.wanim').valid).toBe(true);
});

test('rejects other extensions and folders', () => {
	expect(validate('out/sprite.mp4').valid).toBe(false);
	expect(validate('out/sprite').valid).toBe(false);
});
