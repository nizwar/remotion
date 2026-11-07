# @remotion/wanim

Pack rendered frames into encrypted `.wanim` sprite animations

## Installation

```bash
npm install @remotion/wanim --save-exact
```

When installing a Remotion package, make sure to align the version of all `remotion` and `@remotion/*` packages to the same version.
Remove the `^` character from the version number to use the exact version.

## Usage

```bash
export WANIM_KEY=$(npx remotion wanim keygen)
npx remotion wanim render src/index.ts MyComp out/my-comp.wanim
```

- [`SPEC.md`](./SPEC.md) describes the binary format.
- [`prompts/`](./prompts) contains the briefs for building Kotlin, Swift and Flutter players.
- [`fixtures/`](./fixtures) contains a sample file which every player must be able to open.

See the [documentation](https://www.remotion.dev/docs/wanim) for more information.
