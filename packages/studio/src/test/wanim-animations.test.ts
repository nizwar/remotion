import {expect, test} from 'bun:test';
import {parseWanimAnimations} from '@remotion/studio-shared';

test('no text means one animation of all frames', () => {
	expect(parseWanimAnimations('')).toBe(null);
	expect(parseWanimAnimations('  ')).toBe(null);
	expect(parseWanimAnimations(undefined)).toBe(null);
});

test('animations are read with their range and loop', () => {
	expect(
		parseWanimAnimations('transition_in=0-29, idle=30-89:loop,out.1=90-90'),
	).toEqual([
		{key: 'transition_in', from: 0, to: 29, loop: false},
		{key: 'idle', from: 30, to: 89, loop: true},
		{key: 'out.1', from: 90, to: 90, loop: false},
	]);
});

test('text that is not a list of animations is rejected', () => {
	expect(() => parseWanimAnimations('idle')).toThrow('must look like');
	expect(() => parseWanimAnimations('idle=5')).toThrow('must look like');
	expect(() => parseWanimAnimations('idle=0-5:once')).toThrow('must look like');
	expect(() => parseWanimAnimations('a=0-5,a=6-9')).toThrow('used twice');
	expect(() => parseWanimAnimations('a b=0-5')).toThrow('animation key');
	expect(() => parseWanimAnimations('a=9-5')).toThrow('before it starts');
});
