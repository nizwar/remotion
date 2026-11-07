import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'animation.dart';
import 'exception.dart';
import 'render_wanim.dart';

// Keeps a position computed as frame / fps inside of that frame, despite
// rounding
const double _frameEpsilon = 1e-9;

/// Controls the playback of one [WanimPlayer].
///
/// Listeners are told about [play], [pause], [seek], [speed] changes and the
/// end of playback, not about each frame.
class WanimController extends ChangeNotifier {
  /// Creates a controller. If [autoplay] is `false`, playback waits for [play].
  WanimController({bool autoplay = true, double speed = 1})
    : _playing = autoplay,
      _speed = _checkedSpeed(speed);

  bool _playing;
  bool _finished = false;
  double _speed;
  double _seconds = 0;
  bool _attached = false;

  static double _checkedSpeed(double speed) {
    if (!(speed > 0) || speed.isInfinite) {
      throw ArgumentError.value(speed, 'speed', 'Must be positive');
    }

    return speed;
  }

  /// Whether playback is running or waiting to run. Stays `true` while the
  /// player is off screen or the app is in the background.
  bool get isPlaying => _playing;

  /// Whether an animation that does not loop reached its end.
  bool get isFinished => _finished;

  /// The position within the animation.
  Duration get position => Duration(
    microseconds: (_seconds * Duration.microsecondsPerSecond).round(),
  );

  /// Playback rate: `2` plays twice as fast. Must be positive.
  double get speed => _speed;

  set speed(double value) {
    _speed = _checkedSpeed(value);
    notifyListeners();
  }

  /// Starts or resumes playback. Starts over after the end was reached.
  void play() {
    if (_finished) {
      _finished = false;
      _seconds = 0;
    }

    _playing = true;
    notifyListeners();
  }

  /// Holds the current frame.
  void pause() {
    _playing = false;
    notifyListeners();
  }

  /// Jumps to [position]. Playback continues from there if it is running.
  void seek(Duration position) {
    _finished = false;
    _seconds = math.max(
      0,
      position.inMicroseconds / Duration.microsecondsPerSecond,
    );
    notifyListeners();
  }

  void _restart() {
    _seconds = 0;
    if (_finished) {
      _finished = false;
      _playing = true;
    }
  }

  void _finish(double seconds) {
    _seconds = seconds;
    _finished = true;
    _playing = false;
    notifyListeners();
  }
}

/// Plays a [WanimAnimation].
///
/// The widget sizes itself like an image: To the canvas of the animation within
/// its constraints, keeping the aspect ratio. The canvas maps into that size
/// according to [fit].
class WanimPlayer extends StatefulWidget {
  /// Creates a player.
  const WanimPlayer({
    super.key,
    required this.animation,
    this.controller,
    this.loop = true,
    this.fit = BoxFit.contain,
    this.onFinished,
    this.onError,
  });

  /// The animation to play. It stays owned by the caller.
  final WanimAnimation animation;

  /// Controls playback. Attach it to one player at a time. If `null`, the
  /// animation plays right away.
  final WanimController? controller;

  /// Whether to start over at the end.
  final bool loop;

  /// How the canvas maps into the size of the widget.
  final BoxFit fit;

  /// Called when an animation that does not loop reached its end.
  final VoidCallback? onFinished;

  /// Called if an atlas that is streamed during playback cannot be used. The
  /// last frame stays on screen. If `null`, the error goes to
  /// [FlutterError.reportError].
  final ValueChanged<WanimException>? onError;

  @override
  State<WanimPlayer> createState() => _WanimPlayerState();
}

class _WanimPlayerState extends State<WanimPlayer>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final Ticker _ticker = createTicker(_onTick);
  final WanimFrameState _frame = WanimFrameState();
  WanimController? _ownController;
  bool _tickerEnabled = true;
  bool _appResumed = true;

  // The position is always derived from the clock of the ticker relative to
  // this anchor, so that timing does not depend on the display rate
  double _anchorSeconds = 0;
  Duration _anchorElapsed = Duration.zero;
  bool _needsAnchor = false;

  int _shownFrame = -1;
  int? _awaitedAtlas;

  WanimController get _controller =>
      widget.controller ?? (_ownController ??= WanimController());

  double get _totalSeconds =>
      widget.animation.frameCount / widget.animation.fps;

  @override
  void initState() {
    super.initState();
    final state = WidgetsBinding.instance.lifecycleState;
    _appResumed = state == null || _isOnScreen(state);
    WidgetsBinding.instance.addObserver(this);
    _attachController(_controller);
    _showCurrentFrame();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _tickerEnabled = TickerMode.valuesOf(context).enabled;
    _updateTicker();
  }

  @override
  void didUpdateWidget(WanimPlayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      final old = oldWidget.controller ?? _ownController;
      if (old != null) {
        _detachController(old);
      }

      _attachController(_controller);
      _needsAnchor = true;
      _showCurrentFrame();
    }

    if (!identical(oldWidget.animation, widget.animation)) {
      _controller._restart();
      _frame.reset();
      _shownFrame = -1;
      _awaitedAtlas = null;
      _needsAnchor = true;
      _showCurrentFrame();
    }

    if (oldWidget.loop != widget.loop) {
      _needsAnchor = true;
    }

    _updateTicker();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _detachController(widget.controller ?? _ownController!);
    _ownController?.dispose();
    _ticker.dispose();
    _frame.dispose();
    super.dispose();
  }

  void _attachController(WanimController controller) {
    assert(
      !controller._attached,
      'A WanimController can only control one WanimPlayer at a time.',
    );
    controller._attached = true;
    controller.addListener(_onControllerChanged);
  }

  void _detachController(WanimController controller) {
    controller._attached = false;
    controller.removeListener(_onControllerChanged);
  }

  void _onControllerChanged() {
    _needsAnchor = true;
    _showCurrentFrame();
    _updateTicker();
  }

  // A desktop window that lost focus is `inactive` but stays visible. On phones,
  // `inactive` means that the app is on its way out or covered by the system.
  bool _isOnScreen(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      return true;
    }

    final isDesktop = switch (defaultTargetPlatform) {
      TargetPlatform.macOS ||
      TargetPlatform.windows ||
      TargetPlatform.linux => true,
      _ => false,
    };
    return isDesktop && state == AppLifecycleState.inactive;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _appResumed = _isOnScreen(state);
    _updateTicker();
  }

  @override
  void didHaveMemoryPressure() {
    widget.animation.shrinkCache(_frame.atlas);
  }

  void _updateTicker() {
    final shouldRun = _controller.isPlaying && _tickerEnabled && _appResumed;
    if (shouldRun && !_ticker.isActive) {
      _anchorSeconds = _controller._seconds;
      _anchorElapsed = Duration.zero;
      _needsAnchor = false;
      unawaited(_ticker.start());
    } else if (!shouldRun && _ticker.isActive) {
      _ticker.stop();
    }
  }

  void _onTick(Duration elapsed) {
    final controller = _controller;
    if (_needsAnchor) {
      _needsAnchor = false;
      _anchorSeconds = controller._seconds;
      _anchorElapsed = elapsed;
    }

    final seconds =
        _anchorSeconds +
        (elapsed - _anchorElapsed).inMicroseconds /
            Duration.microsecondsPerSecond *
            controller._speed;
    final total = _totalSeconds;
    if (seconds >= total && !widget.loop) {
      controller._finish(total);
      widget.onFinished?.call();
      return;
    }

    controller._seconds = seconds % total;
    _showCurrentFrame();
  }

  void _showCurrentFrame() {
    final animation = widget.animation;
    final manifest = animation.manifest;
    final count = manifest.frameCount;
    final position = (_controller._seconds * manifest.fps + _frameEpsilon)
        .floor();
    final frame = widget.loop && !_controller._finished
        ? position % count
        : math.min(position, count - 1);
    if (frame == _shownFrame) {
      return;
    }

    final spriteIndex = manifest.frames[frame];
    if (spriteIndex == _frame.spriteIndex) {
      _shownFrame = frame;
      return;
    }

    if (spriteIndex < 0) {
      _shownFrame = frame;
      _frame.show(-1, null);
      return;
    }

    final sprite = manifest.sprites[spriteIndex];
    if (sprite.atlas != _frame.atlas) {
      final image = animation.atlasImage(sprite.atlas);
      if (image == null) {
        _awaitAtlas(sprite.atlas);
        return;
      }

      _frame.holdAtlas(sprite.atlas, image);
      animation.prefetchAfter(sprite.atlas, loop: widget.loop);
    }

    _shownFrame = frame;
    _frame.show(spriteIndex, sprite);
  }

  // The last frame stays on screen until the atlas is there
  void _awaitAtlas(int atlas) {
    final animation = widget.animation;
    if (_awaitedAtlas == atlas || animation.isDisposed) {
      return;
    }

    _awaitedAtlas = atlas;
    unawaited(
      animation.prepareAtlas(atlas).then((_) {
        if (!mounted ||
            _awaitedAtlas != atlas ||
            !identical(animation, widget.animation)) {
          return;
        }

        final error = animation.atlasError(atlas);
        if (error == null) {
          _awaitedAtlas = null;
          _showCurrentFrame();
        } else {
          _reportError(error);
        }
      }),
    );
  }

  void _reportError(WanimException error) {
    final onError = widget.onError;
    if (onError != null) {
      onError(error);
      return;
    }

    FlutterError.reportError(
      FlutterErrorDetails(
        exception: error,
        library: 'wanim',
        context: ErrorDescription('while streaming an atlas'),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final animation = widget.animation;
    return RepaintBoundary(
      child: WanimView(
        frame: _frame,
        canvasSize: Size(
          animation.width.toDouble(),
          animation.height.toDouble(),
        ),
        opaque: animation.opaque,
        fit: widget.fit,
        devicePixelRatio:
            MediaQuery.maybeDevicePixelRatioOf(context) ??
            View.maybeOf(context)?.devicePixelRatio ??
            1,
      ),
    );
  }
}
