// The animations of a .wanim file, as text: `transition_in=0-29,idle=30-89:loop`.
// Each has a key, the first and the last frame of the composition, and `:loop`
// if it repeats.

export type WanimAnimationRangeInput = {
	key: string;
	from: number;
	to: number;
	loop: boolean;
};

const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

// `null` if the text is empty, which means one animation of all frames.
// Throws with a message for the user if the text cannot be read.
export const parseWanimAnimations = (
	value: unknown,
): WanimAnimationRangeInput[] | null => {
	if (value === undefined || value === null || String(value).trim() === '') {
		return null;
	}

	const keys = new Set<string>();
	return String(value)
		.split(',')
		.map((part) => {
			const match = part.trim().match(/^([^=:]+)=(\d+)-(\d+)(:loop)?$/);
			if (!match) {
				throw new Error(
					`Animations must look like "transition_in=0-29,idle=30-89:loop", got "${part.trim()}"`,
				);
			}

			const key = match[1] as string;
			const from = Number(match[2]);
			const to = Number(match[3]);
			if (!KEY_PATTERN.test(key)) {
				throw new Error(
					`An animation key must be 1 to 64 letters, digits, "_", "." or "-", got "${key}"`,
				);
			}

			if (keys.has(key)) {
				throw new Error(`The animation key "${key}" is used twice`);
			}

			if (to < from) {
				throw new Error(
					`The animation "${key}" ends on frame ${to}, before it starts on frame ${from}`,
				);
			}

			keys.add(key);
			return {key, from, to, loop: match[4] !== undefined};
		});
};
