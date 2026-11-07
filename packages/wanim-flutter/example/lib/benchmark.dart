import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';
import 'package:cryptography_flutter/cryptography_flutter.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
// ignore: implementation_imports
import 'package:wanim/src/crypto.dart';
import 'package:wanim/wanim.dart';

const Duration _warmUp = Duration(seconds: 2);
const Duration _measured = Duration(seconds: 8);

/// Measures decryption and frame times. Results go to the log and the screen.
class BenchmarkPage extends StatefulWidget {
  const BenchmarkPage({super.key, this.autoStart = false});

  final bool autoStart;

  @override
  State<BenchmarkPage> createState() => _BenchmarkPageState();
}

class _BenchmarkPageState extends State<BenchmarkPage> {
  final List<String> _lines = [];
  WanimAnimation? _animation;
  List<WanimController> _controllers = [];
  bool _running = false;

  void _report(Map<String, Object?> result) {
    final line = jsonEncode(result);
    debugPrint('WANIM_BENCH $line');
    if (mounted) {
      setState(() => _lines.add(line));
    }
  }

  @override
  void initState() {
    super.initState();
    if (widget.autoStart) {
      unawaited(_run());
    }
  }

  @override
  void dispose() {
    _disposePlayers();
    super.dispose();
  }

  void _disposePlayers() {
    for (final controller in _controllers) {
      controller.dispose();
    }
    _controllers = [];
    _animation?.dispose();
    _animation = null;
  }

  Future<void> _run() async {
    setState(() => _running = true);
    final file = (await rootBundle.load('assets/demo.wanim')).buffer
        .asUint8List();
    await _benchmarkLoad(file);
    await _benchmarkCrypto();
    for (final players in [1, 4, 16, 36]) {
      await _benchmarkFrames(file, players: players, streaming: false);
    }
    await _benchmarkFrames(file, players: 1, streaming: true);
    debugPrint('WANIM_BENCH_DONE');
    if (mounted) {
      setState(() => _running = false);
    }
  }

  Future<void> _benchmarkLoad(Uint8List file) async {
    final gaps = _GapMonitor()..start();
    final clock = Stopwatch()..start();
    final animation = await WanimAnimation.load(file);
    clock.stop();
    gaps.stop();
    _report({
      'test': 'load',
      'fileBytes': file.length,
      'gpuBytes': animation.manifest.gpuBytes,
      'ms': clock.elapsedMilliseconds,
      'maxUiGapMs': gaps.maxGapMs,
    });
    animation.dispose();
  }

  Future<void> _benchmarkCrypto() async {
    for (final size in [
      64 << 10,
      256 << 10,
      512 << 10,
      1 << 20,
      4 << 20,
      16 << 20,
    ]) {
      final input = await compute(_encryptRandom, size);
      final block = WanimBlock(
        fileKey: input.key,
        nonce: input.nonce,
        aad: input.aad,
        block: input.block,
      );
      for (final (name, decrypt) in [
        ('platform', decryptWithPlatform),
        ('background', decryptInBackground),
      ]) {
        final times = <int>[];
        var maxGap = 0.0;
        var correct = true;
        for (var i = 0; i < 3; i++) {
          final gaps = _GapMonitor()..start();
          final clock = Stopwatch()..start();
          final clearText = await decrypt(block);
          clock.stop();
          // Lets the monitor see a stall that ends with the call
          await Future<void>.delayed(const Duration(milliseconds: 5));
          gaps.stop();
          times.add(clock.elapsedMilliseconds);
          maxGap = max(maxGap, gaps.maxGapMs);
          correct &=
              clearText != null &&
              clearText.length == size &&
              clearText[size ~/ 2] == input.probe;
        }
        times.sort();
        _report({
          'test': 'decrypt',
          'path': name,
          'pluginPresent': FlutterCryptography.isPluginPresent,
          'bytes': size,
          'medianMs': times[1],
          'maxUiGapMs': maxGap,
          'correct': correct,
        });
      }
    }
  }

  Future<void> _benchmarkFrames(
    Uint8List file, {
    required int players,
    required bool streaming,
  }) async {
    final animation = await WanimAnimation.load(
      file,
      gpuBudgetBytes: streaming ? 0 : 192 << 20,
    );
    // Twice the speed and shifted starts: Every vsync of a 60 Hz display gets
    // new sprites, which is the worst case for the raster thread
    final controllers = [
      for (var i = 0; i < players; i++) WanimController(speed: 2),
    ];
    for (var i = 0; i < players; i++) {
      controllers[i].seek(animation.duration * (i / players));
    }

    if (!mounted) {
      return;
    }

    setState(() {
      _animation = animation;
      _controllers = controllers;
    });
    await Future<void>.delayed(_warmUp);

    final timings = <ui.FrameTiming>[];
    void collect(List<ui.FrameTiming> batch) => timings.addAll(batch);
    SchedulerBinding.instance.addTimingsCallback(collect);
    await Future<void>.delayed(_measured);
    // Timings arrive in batches
    await Future<void>.delayed(const Duration(milliseconds: 500));
    SchedulerBinding.instance.removeTimingsCallback(collect);

    List<double> sorted(Duration Function(ui.FrameTiming) read) =>
        timings.map((t) => read(t).inMicroseconds / 1000).toList()..sort();
    Map<String, double> summary(List<double> values) => values.isEmpty
        ? const {}
        : {
            'mean': _round(values.reduce((a, b) => a + b) / values.length),
            'p50': _round(values[values.length ~/ 2]),
            'p90': _round(values[(values.length * 0.9).floor()]),
            'p99': _round(values[(values.length * 0.99).floor()]),
            'max': _round(values.last),
          };
    final ui.Display? display = mounted ? View.of(context).display : null;
    final budgetMs = 1000 / (display?.refreshRate ?? 60);
    final raster = sorted((t) => t.rasterDuration);
    _report({
      'test': 'frames',
      'players': players,
      'streaming': streaming,
      'frames': timings.length,
      'refreshHz': _round(display?.refreshRate ?? 0),
      'uiMs': summary(sorted((t) => t.buildDuration)),
      'rasterMs': summary(raster),
      'rasterOverBudget': raster.where((ms) => ms > budgetMs).length,
    });

    if (mounted) {
      setState(_disposePlayers);
    }
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }

  @override
  Widget build(BuildContext context) {
    final animation = _animation;
    final columns = sqrt(_controllers.length).ceil();
    return Scaffold(
      appBar: AppBar(title: const Text('Benchmark')),
      body: Column(
        children: [
          Expanded(
            child: animation == null
                ? Center(
                    child: FilledButton(
                      onPressed: _running ? null : _run,
                      child: Text(_running ? 'Running' : 'Start'),
                    ),
                  )
                : GridView.count(
                    crossAxisCount: columns,
                    physics: const NeverScrollableScrollPhysics(),
                    children: [
                      for (final controller in _controllers)
                        WanimPlayer(
                          animation: animation,
                          controller: controller,
                        ),
                    ],
                  ),
          ),
          SizedBox(
            height: 160,
            child: ListView(
              padding: const EdgeInsets.all(8),
              children: [
                for (final line in _lines.reversed)
                  Text(line, style: const TextStyle(fontSize: 10)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

double _round(double value) => (value * 100).round() / 100;

/// Finds the longest time during which the UI isolate ran no timer.
class _GapMonitor {
  final Stopwatch _clock = Stopwatch();
  Timer? _timer;
  int _last = 0;
  int _maxGap = 0;

  double get maxGapMs => _maxGap / 1000;

  void start() {
    _clock.start();
    _timer = Timer.periodic(const Duration(milliseconds: 1), (_) {
      final now = _clock.elapsedMicroseconds;
      _maxGap = max(_maxGap, now - _last);
      _last = now;
    });
  }

  void stop() {
    _timer?.cancel();
  }
}

class _EncryptedInput {
  _EncryptedInput(this.key, this.nonce, this.aad, this.block, this.probe);

  final Uint8List key;
  final Uint8List nonce;
  final Uint8List aad;
  final Uint8List block;
  final int probe;
}

Future<_EncryptedInput> _encryptRandom(int size) async {
  final random = Random(size);
  Uint8List bytes(int length) =>
      Uint8List.fromList(List.generate(length, (_) => random.nextInt(256)));
  final key = bytes(32);
  final nonce = bytes(12);
  final aad = bytes(44);
  final clearText = bytes(size);
  final box = await DartAesGcm.with256bits().encrypt(
    clearText,
    secretKey: SecretKey(key),
    nonce: nonce,
    aad: aad,
  );
  return _EncryptedInput(
    key,
    nonce,
    aad,
    Uint8List.fromList([...box.cipherText, ...box.mac.bytes]),
    clearText[size ~/ 2],
  );
}
