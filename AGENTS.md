## Setup commands

```bash
# Install dependencies (uses Bun)
bun install

# Build all packages
bunx turbo run make

# Run tests and linting
bunx turbo run lint test

# Clean build artifacts
bun run clean

# Build a specific package
bunx turbo run make --filter='<package-name>'
```

Use `bunx` (not `npx`) to run package binaries.

The current Remotion version can be found in `packages/core/src/version.ts`. The next version should increment the patch version by 1.

## Coding style

- Keep things in one function unless they are composable or reusable.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.

## Internal API optionality

When adding or reviewing TypeScript parameters, React props, or type/interface members, make new internal inputs preferably nullable (`T | null`), not optional (`?:`). Public exported APIs are exempt when requiring the input would be breaking.

## Wanim players

`packages/wanim` and the Wanim tab of the Studio export `.wanim` files. The players that open them are not in this monorepo: They live in the private repository `WBlue-Indonesia/WAnim`, a submodule of `WLive-Native`, checked out at `~/Documents/Works/WBlue/WLive/native_version/wanim`.

When a change touches the file format, the manifest, `packages/wanim/SPEC.md`, `packages/wanim/fixtures` or the official key:

1. Update the players in the same task. A file that a player cannot open is a bug.
2. Run `bun run sync-sdks` in `packages/wanim`, which copies the spec and fixtures to them.
3. Run the tests of each player, as listed in the README of that repository.

Changing the official key makes all existing files unreadable.

When updating Remotion from upstream, check that `packages/wanim`, the Wanim tab and `remotion wanim` still work, then rebuild the standalone zip with `bun run pack` in `packages/wanim-studio`.

## Key services

- **Remotion Studio** (dev testbed): `cd packages/example && bun run dev` — starts at `http://localhost:3000`. This is the main dev UI for previewing video compositions.
- **Player testbed**: `cd packages/player-example && bun run dev` — for testing `@remotion/player` changes.
- **Docs site**: `cd packages/docs && bun run start` — Docusaurus dev server.

## Rendering test videos

From `packages/example`:

- `bunx remotion compositions` — list available compositions.
- `bunx remotion render <comp-id> --output ../../out/video.mp4` — render a video.
- `bunx remotion still <comp-id> --output ../../out/still.png` — render a still image.
