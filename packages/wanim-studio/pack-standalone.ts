// Creates out/wanim-studio.zip, a copy of this project that only needs npm and
// not this monorepo. Build @remotion/wanim first, then run `bun run pack`.
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const version: string = JSON.parse(
	readFileSync('../wanim/package.json', 'utf8'),
).version;
const staging = path.resolve('out/standalone');
const root = path.join(staging, 'wanim-studio');
const zip = path.resolve('out/wanim-studio.zip');
rmSync(staging, {recursive: true, force: true});
rmSync(zip, {force: true});
mkdirSync(path.join(root, 'vendor'), {recursive: true});
mkdirSync(path.join(root, 'scripts'));

cpSync('src', path.join(root, 'src'), {recursive: true});
cpSync('remotion.config.ts', path.join(root, 'remotion.config.ts'));
cpSync('tsconfig.json', path.join(root, 'tsconfig.json'));
cpSync('.gitignore', path.join(root, '.gitignore'));
cpSync('standalone/README.md', path.join(root, 'README.md'));
cpSync('standalone/export.mjs', path.join(root, 'scripts/export.mjs'));

execFileSync(
	'npm',
	['pack', '../wanim', '--pack-destination', path.join(root, 'vendor')],
	{stdio: 'ignore'},
);

writeFileSync(
	path.join(root, 'package.json'),
	`${JSON.stringify(
		{
			name: 'wanim-studio',
			version: '1.0.0',
			private: true,
			type: 'module',
			scripts: {
				// Published versions stop if detecting the open browser fails
				dev: 'remotion studio --no-open',
				list: 'remotion compositions src/index.ts',
				export: 'node scripts/export.mjs',
			},
			dependencies: {
				'@remotion/bundler': version,
				'@remotion/cli': version,
				'@remotion/renderer': version,
				'@remotion/wanim': `file:vendor/remotion-wanim-${version}.tgz`,
				react: '19.3.1',
				'react-dom': '19.3.1',
				remotion: version,
			},
			devDependencies: {
				'@types/react': '19.3.0',
				typescript: '5.9.3',
			},
		},
		null,
		2,
	)}\n`,
);

execFileSync('zip', ['-qr', zip, 'wanim-studio'], {cwd: staging});
rmSync(staging, {recursive: true});
console.log(zip);
