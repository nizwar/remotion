# wanim-studio

Create animations and export them as `.wanim` files. Requires Node.js 20 or newer.

## Setup

```bash
npm install
```

The first export downloads a headless Chrome.

## Commands

```bash
npm run dev                  # Preview in Remotion Studio
npm run list                 # List all animations
npm run export LoadingOrb    # Create out/LoadingOrb.wanim
```

To reduce the size, pass flags after `--`:

```bash
npm run export LoadingOrb -- --scale=0.5 --every-nth-frame=2
```

## Adding an animation

1. Create a component in `src/`, like `src/LoadingOrb.tsx`.
2. Register it in `src/Root.tsx` as a `<Composition>`. Its `id` is the name you pass to `npm run export`.

## Tips for sprites

- Do not set a background, so that the animation stays transparent.
- Keep it small: Frames are stored as pixels, and memory grows with size and frame count.
- For a seamless loop, derive motion from `frame / durationInFrames`.
