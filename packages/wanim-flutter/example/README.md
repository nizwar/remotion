# wanim example

A demo of the player with its controls, and a benchmark.

```bash
flutter run                       # The demo
flutter run --profile             # Then tap the benchmark button
```

To run the benchmark without touching the device, and read the results from the log:

```bash
flutter run --profile --dart-define=WANIM_AUTOBENCH=true
flutter run --profile --dart-define=WANIM_AUTOBENCH=true --no-enable-impeller
```

Each result is a line starting with `WANIM_BENCH`, and `WANIM_BENCH_DONE` ends the run.

`flutter test integration_test -d <device>` runs the conformance checks and pixel checks on a real device, through the native decryption and the real GPU backend.

`assets/demo.wanim` comes from `bun tool/make_demo.ts`.
