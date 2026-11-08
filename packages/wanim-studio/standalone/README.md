# wanim-studio

Create animations and export them as `.wanim` files. Requires Node.js 20 or newer.

## Setup

```bash
npm install
```

The first render downloads a headless Chrome.

## Commands

```bash
npm run dev                  # Open Remotion Studio
npm run list                 # List all animations
npm run export LoadingOrb    # Create out/LoadingOrb.wanim
```

To reduce the size, pass flags after `--`:

```bash
npm run export LoadingOrb -- --scale=0.5 --frame-rate=15 --compress=balanced
```

Formats:

```bash
npm run export LoadingOrb -- --layers                       # version 2: moving parts are stored once
npm run export LoadingOrb out/LoadingOrb.svga               # SVGA, not encrypted
npm run export LoadingOrb -- --layers --frame-rate=24 --image-rate=12
```

`--frame-rate` keeps the duration with fewer frames. `--image-rate` lets changing parts get a new picture less often, while moves stay smooth. Version 2 files need players with version 2 support.

To export from the Studio, click Render and choose the Wanim tab.

## Adding an animation

1. Create a component in `src/`, like `src/LoadingOrb.tsx`.
2. Register it in `src/Root.tsx` as a `<Composition>`. Its `id` is the name you pass to `npm run export`.

## Tips for sprites

- Do not set a background, so that the animation stays transparent.
- Keep it small: Frames are stored as pixels, and memory grows with size and frame count.
- For a seamless loop, derive motion from `frame / durationInFrames`.
