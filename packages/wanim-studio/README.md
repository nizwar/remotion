# wanim-studio

A place to create animations and export them as `.wanim` files.

## Commands

Run these from this folder:

```bash
bun run dev                   # Preview in Remotion Studio
bun run list                  # List all animations
bun run export LoadingOrb     # Create out/LoadingOrb.wanim
```

Build the monorepo first using `bunx turbo run make` in the root.

## Sharing with others

`bun run pack` creates `out/wanim-studio.zip`, which only needs Node.js and npm, not this monorepo.

## Adding an animation

1. Create a component in `src/`, like `src/LoadingOrb.tsx`.
2. Register it in `src/Root.tsx` as a `<Composition>`. Its `id` is the name you pass to `bun run export`.

## Tips for sprites

- Do not set a background, so that the animation stays transparent.
- Keep it small: Frames are stored as pixels, and memory grows with size and frame count.
- For a seamless loop, derive motion from `frame / durationInFrames`.
- Add flags to reduce the size, for example `bun run export LoadingOrb --every-nth-frame=2`.
