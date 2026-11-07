import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:wanim/wanim.dart';

import 'benchmark.dart';

const bool _autoBenchmark = bool.fromEnvironment('WANIM_AUTOBENCH');
const String _asset = String.fromEnvironment(
  'WANIM_ASSET',
  defaultValue: 'assets/demo.wanim',
);

void main() => runApp(const WanimExampleApp());

class WanimExampleApp extends StatelessWidget {
  const WanimExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'wanim',
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        brightness: Brightness.dark,
      ),
      home: _autoBenchmark
          ? const BenchmarkPage(autoStart: true)
          : const DemoPage(),
    );
  }
}

class DemoPage extends StatefulWidget {
  const DemoPage({super.key});

  @override
  State<DemoPage> createState() => _DemoPageState();
}

class _DemoPageState extends State<DemoPage> {
  final WanimController _controller = WanimController();
  WanimAnimation? _animation;
  Object? _error;
  bool _loop = true;
  BoxFit _fit = BoxFit.contain;
  int _finishedCount = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await rootBundle.load(_asset);
      final animation = await WanimAnimation.load(data.buffer.asUint8List());
      if (!mounted) {
        animation.dispose();
        return;
      }

      setState(() => _animation = animation);
    } on WanimException catch (error) {
      setState(() => _error = error);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    _animation?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final animation = _animation;
    return Scaffold(
      appBar: AppBar(
        title: const Text('wanim'),
        actions: [
          IconButton(
            tooltip: 'Benchmark',
            icon: const Icon(Icons.speed),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const BenchmarkPage()),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: _error != null
                  ? Center(child: Text('$_error'))
                  : animation == null
                  ? const Center(child: CircularProgressIndicator())
                  : ColoredBox(
                      color: const Color(0xff20232a),
                      child: SizedBox.expand(
                        child: WanimPlayer(
                          animation: animation,
                          controller: _controller,
                          loop: _loop,
                          fit: _fit,
                          onFinished: () => setState(() => _finishedCount++),
                        ),
                      ),
                    ),
            ),
            if (animation != null) _controls(animation),
          ],
        ),
      ),
    );
  }

  Widget _controls(WanimAnimation animation) {
    return Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${animation.width}x${animation.height}, '
            '${animation.frameCount} frames at ${animation.fps} fps, '
            '${animation.manifest.atlases.length} atlases, '
            'finished $_finishedCount times',
          ),
          ListenableBuilder(
            listenable: _controller,
            builder: (context, _) => Row(
              children: [
                IconButton.filled(
                  icon: Icon(
                    _controller.isPlaying ? Icons.pause : Icons.play_arrow,
                  ),
                  onPressed: _controller.isPlaying
                      ? _controller.pause
                      : _controller.play,
                ),
                Expanded(
                  child: Slider(
                    value: _controller.speed,
                    min: 0.25,
                    max: 4,
                    label: '${_controller.speed}x',
                    divisions: 15,
                    onChanged: (value) => _controller.speed = value,
                  ),
                ),
                Text('${_controller.speed}x'),
              ],
            ),
          ),
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              FilterChip(
                label: const Text('Loop'),
                selected: _loop,
                onSelected: (value) => setState(() => _loop = value),
              ),
              OutlinedButton(
                onPressed: () => _controller.seek(animation.duration ~/ 2),
                child: const Text('Seek to middle'),
              ),
              DropdownButton<BoxFit>(
                value: _fit,
                onChanged: (value) => setState(() => _fit = value!),
                items: [
                  for (final fit in BoxFit.values)
                    DropdownMenuItem(value: fit, child: Text(fit.name)),
                ],
              ),
            ],
          ),
        ],
      ),
    );
  }
}
