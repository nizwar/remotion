import {expect, test} from 'bun:test';
import type {WanimFormat} from '@remotion/studio-shared';
import {validateOutnameGui} from '../components/RenderModal/out-name-checker';

const validate = (outName: string, wanimFormat: WanimFormat = 'frames') =>
	validateOutnameGui({
		outName,
		codec: 'h264',
		audioCodec: 'aac',
		renderMode: 'wanim',
		stillImageFormat: null,
		separateAudioTo: null,
		wanimFormat,
	});

test('accepts a .wanim output name', () => {
	expect(validate('out/sprite.wanim').valid).toBe(true);
});

test('rejects other extensions and folders', () => {
	expect(validate('out/sprite.mp4').valid).toBe(false);
	expect(validate('out/sprite').valid).toBe(false);
});

test('layers are .wanim files too, SVGA needs .svga', () => {
	expect(validate('out/sprite.wanim', 'layers').valid).toBe(true);
	expect(validate('out/sprite.svga', 'svga').valid).toBe(true);
	expect(validate('out/sprite.wanim', 'svga').valid).toBe(false);
	expect(validate('out/sprite.svga', 'frames').valid).toBe(false);
});
