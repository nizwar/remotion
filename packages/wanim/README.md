# @remotion/wanim

Pack rendered frames into encrypted `.wanim` sprite animations

## Installation

```bash
npm install @remotion/wanim --save-exact
```

When installing a Remotion package, make sure to align the version of all `remotion` and `@remotion/*` packages to the same version.
Remove the `^` character from the version number to use the exact version.

## Players

The players for Swift, Kotlin and Flutter and the Wanim Preview app live in the private repository `WBlue-Indonesia/WAnim`, not in this monorepo. It is a submodule of `WLive-Native`, checked out at `~/Documents/Works/WBlue/WLive/native_version/wanim`.

`SPEC.md` and `fixtures/` here are the source of truth. After changing the format, run `bun run sync-sdks`, then run the tests of each player.

## Usage

```bash
npx remotion wanim render src/index.ts MyComp out/my-comp.wanim
```

- [`SPEC.md`](./SPEC.md) describes the binary format.
- [`prompts/`](./prompts) contains the original briefs of the players.
- [`fixtures/`](./fixtures) contains sample files which every player must be able to open.
