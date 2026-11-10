# wanim-studio

A place to create animations and export them as `.wanim` files.

## Commands

Run these from this folder:

```bash
bun run dev                   # Preview in Remotion Studio
bun run list                  # List all animations
bun run export LoadingOrb     # Create out/LoadingOrb.wanim
```

Add `--compress=balanced` or `--compress=small` for a smaller file.

Formats:

```bash
bun run export LoadingOrb --layers               # moving parts are stored once
bun run export LoadingOrb out/LoadingOrb.svga    # SVGA, not encrypted
bun run export LoadingOrb --layers --frame-rate=24 --image-rate=12
bun run export Badge --animations="transition_in=0-29,idle=30-89:loop"   # several animations, played by key
```

`--frame-rate` keeps the duration with fewer frames. `--image-rate` lets changing parts get a new picture less often, while moves stay smooth. Files are version 3, `--wanim-version=1` or `--wanim-version=2 --layers` write a file for older players.

You can also export from the Studio: Click Render and choose the Wanim tab.

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
- Add flags to reduce the size, for example `bun run export LoadingOrb --frame-rate=15`.
- With `--layers`, prefer moving things with `transform`, `cx`/`cy` or `x`/`y` over redrawing them: Moved parts are stored once.
