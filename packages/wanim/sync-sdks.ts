// Copies the format spec and the fixtures to the players in the WAnim repository.
// Run after a change to the format, then run the tests of each player.
import {cpSync, existsSync, readdirSync} from 'node:fs';
import path from 'node:path';

const sdkRoot =
	process.env.WANIM_SDK_DIR ??
	path.join(
		process.env.HOME as string,
		'Documents/Works/WBlue/WLive/native_version/wanim',
	);

if (!existsSync(sdkRoot)) {
	throw new Error(
		`The WAnim repository is not at ${sdkRoot}. Set WANIM_SDK_DIR to its location.`,
	);
}

const fixtureFolders = [
	'fixtures',
	'wanim-swift/Tests/WanimTests/Fixtures',
	'wanim-kotlin/wanim/src/test/resources/wanim',
	'wanim-flutter/test/fixtures',
];

for (const folder of fixtureFolders) {
	const target = path.join(sdkRoot, folder);
	if (!existsSync(target)) {
		console.log(`Skipped ${folder}, it does not exist`);
		continue;
	}

	for (const file of readdirSync('fixtures')) {
		if (
			file.endsWith('.wanim') ||
			file.startsWith('expected') ||
			file.startsWith('layers-frame-')
		) {
			cpSync(path.join('fixtures', file), path.join(target, file));
		}
	}
}

cpSync('SPEC.md', path.join(sdkRoot, 'SPEC.md'));
console.log(`Synced ${sdkRoot}. Now run the tests of each player.`);
