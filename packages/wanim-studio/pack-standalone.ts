// Creates out/wanim-studio.zip, a copy of this project that only needs npm and
// not this monorepo. Run `bunx turbo run make` in the root first.
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

cpSync('src', path.join(root, 'src'), {recursive: true});
cpSync('remotion.config.ts', path.join(root, 'remotion.config.ts'));
cpSync('tsconfig.json', path.join(root, 'tsconfig.json'));
cpSync('.gitignore', path.join(root, '.gitignore'));
cpSync('standalone/README.md', path.join(root, 'README.md'));

// These differ from the published version: This fork is ahead of it, and only
// here the Studio has its Wanim tab and the CLI has `remotion wanim`. The other
// dependencies are identical, so they come from npm.
const forkedPackages = [
	'bundler',
	'cli',
	'codemods',
	'core',
	'media',
	'media-utils',
	'paths',
	'player',
	'renderer',
	'studio',
	'studio-protocol',
	'studio-server',
	'studio-shared',
	'wanim',
	'web-renderer',
];

const vendored: Record<string, string> = {};
for (const folder of forkedPackages) {
	const cwd = path.resolve('..', folder);
	const {name} = JSON.parse(
		readFileSync(path.join(cwd, 'package.json'), 'utf8'),
	);
	execFileSync(
		'bun',
		['pm', 'pack', '--destination', path.join(root, 'vendor')],
		{cwd, stdio: 'ignore'},
	);
	const file = `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
	vendored[name] = `file:vendor/${file}`;
}

writeFileSync(
	path.join(root, 'package.json'),
	`${JSON.stringify(
		{
			name: 'wanim-studio',
			version: '1.0.0',
			private: true,
			scripts: {
				dev: 'remotion studio',
				list: 'remotion compositions src/index.ts',
				export: 'remotion wanim render src/index.ts',
			},
			dependencies: {
				'@remotion/cli': vendored['@remotion/cli'],
				react: '19.3.1',
				'react-dom': '19.3.1',
				remotion: vendored.remotion,
			},
			devDependencies: {
				'@types/react': '19.3.0',
				typescript: '5.9.3',
			},
			overrides: vendored,
		},
		null,
		2,
	)}\n`,
);

execFileSync('zip', ['-qr', zip, 'wanim-studio'], {cwd: staging});
rmSync(staging, {recursive: true});
console.log(zip);
