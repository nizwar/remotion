import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'manifest.dart';

/// What a [WanimView] shows right now. Listeners are told when it changes,
/// which is the only way that playback reaches the render tree.
class WanimFrameState extends ChangeNotifier {
  int _spriteIndex = -1;
  WanimSprite? _sprite;
  int? _atlas;
  ui.Image? _image;

  /// Index of the sprite on screen, or `-1` if the frame is empty.
  int get spriteIndex => _spriteIndex;

  /// Atlas that the held texture belongs to.
  int? get atlas => _atlas;

  /// Takes ownership of [image], the texture of [atlas].
  void holdAtlas(int atlas, ui.Image image) {
    _image?.dispose();
    _atlas = atlas;
    _image = image;
  }

  /// Puts a sprite on screen.
  void show(int spriteIndex, WanimSprite? sprite) {
    _spriteIndex = spriteIndex;
    _sprite = sprite;
    notifyListeners();
  }

  /// Forgets the sprite and texture, for a new animation.
  void reset() {
    _image?.dispose();
    _image = null;
    _atlas = null;
    _spriteIndex = -1;
    _sprite = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _image?.dispose();
    _image = null;
    super.dispose();
  }
}

/// Draws a [WanimFrameState] without rebuilding any widget.
class WanimView extends LeafRenderObjectWidget {
  /// Creates a view of [frame].
  const WanimView({
    super.key,
    required this.frame,
    required this.canvasSize,
    required this.opaque,
    required this.fit,
    required this.devicePixelRatio,
  });

  /// The state to draw.
  final WanimFrameState frame;

  /// Size of the animation canvas.
  final Size canvasSize;

  /// Whether blending can be disabled.
  final bool opaque;

  /// How the canvas maps into the view.
  final BoxFit fit;

  /// Physical pixels per logical pixel.
  final double devicePixelRatio;

  @override
  RenderWanim createRenderObject(BuildContext context) => RenderWanim(
    frame: frame,
    canvasSize: canvasSize,
    opaque: opaque,
    fit: fit,
    devicePixelRatio: devicePixelRatio,
  );

  @override
  void updateRenderObject(BuildContext context, RenderWanim renderObject) {
    renderObject
      ..frame = frame
      ..canvasSize = canvasSize
      ..opaque = opaque
      ..fit = fit
      ..devicePixelRatio = devicePixelRatio;
  }
}

/// Draws one sprite per frame as a single textured quad.
class RenderWanim extends RenderBox {
  /// Creates the render object.
  RenderWanim({
    required this._frame,
    required this._canvasSize,
    required bool opaque,
    required this._fit,
    required this._devicePixelRatio,
  }) : _paint = ui.Paint()
         ..filterQuality = ui.FilterQuality.low
         ..blendMode = opaque ? ui.BlendMode.src : ui.BlendMode.srcOver;

  final ui.Paint _paint;

  // Mapping from the canvas to this box. Valid until layout or fit changes.
  bool _mappingValid = false;
  double _scaleX = 1;
  double _scaleY = 1;
  double _originX = 0;
  double _originY = 0;
  double _inset = 0;
  Rect? _clip;

  WanimFrameState _frame;

  /// The state to draw.
  set frame(WanimFrameState value) {
    if (identical(value, _frame)) {
      return;
    }

    if (attached) {
      _frame.removeListener(markNeedsPaint);
      value.addListener(markNeedsPaint);
    }

    _frame = value;
    markNeedsPaint();
  }

  Size _canvasSize;

  /// Size of the animation canvas.
  set canvasSize(Size value) {
    if (value == _canvasSize) {
      return;
    }

    _canvasSize = value;
    _mappingValid = false;
    markNeedsLayout();
  }

  /// Whether blending can be disabled.
  set opaque(bool value) {
    final mode = value ? ui.BlendMode.src : ui.BlendMode.srcOver;
    if (mode != _paint.blendMode) {
      _paint.blendMode = mode;
      markNeedsPaint();
    }
  }

  BoxFit _fit;

  /// How the canvas maps into the view.
  set fit(BoxFit value) {
    if (value == _fit) {
      return;
    }

    _fit = value;
    _mappingValid = false;
    markNeedsPaint();
  }

  double _devicePixelRatio;

  /// Physical pixels per logical pixel.
  set devicePixelRatio(double value) {
    if (value == _devicePixelRatio) {
      return;
    }

    _devicePixelRatio = value;
    _mappingValid = false;
    markNeedsPaint();
  }

  @override
  void attach(PipelineOwner owner) {
    super.attach(owner);
    _frame.addListener(markNeedsPaint);
  }

  @override
  void detach() {
    _frame.removeListener(markNeedsPaint);
    super.detach();
  }

  Size _sizeFor(BoxConstraints constraints) =>
      constraints.constrainSizeAndAttemptToPreserveAspectRatio(_canvasSize);

  @override
  double computeMinIntrinsicWidth(double height) =>
      _sizeFor(BoxConstraints.tightForFinite(height: height)).width;

  @override
  double computeMaxIntrinsicWidth(double height) =>
      _sizeFor(BoxConstraints.tightForFinite(height: height)).width;

  @override
  double computeMinIntrinsicHeight(double width) =>
      _sizeFor(BoxConstraints.tightForFinite(width: width)).height;

  @override
  double computeMaxIntrinsicHeight(double width) =>
      _sizeFor(BoxConstraints.tightForFinite(width: width)).height;

  @override
  Size computeDryLayout(BoxConstraints constraints) => _sizeFor(constraints);

  @override
  void performLayout() {
    size = _sizeFor(constraints);
    _mappingValid = false;
  }

  @override
  bool hitTestSelf(Offset position) => true;

  void _updateMapping() {
    _mappingValid = true;
    final fitted = applyBoxFit(_fit, _canvasSize, size);
    final source = Alignment.center.inscribe(
      fitted.source,
      Offset.zero & _canvasSize,
    );
    final destination = Alignment.center.inscribe(
      fitted.destination,
      Offset.zero & size,
    );
    _scaleX = destination.width / source.width;
    _scaleY = destination.height / source.height;
    _originX = destination.left - source.left * _scaleX;
    _originY = destination.top - source.top * _scaleY;
    _clip = source.size == _canvasSize ? null : destination;

    // Compared in physical pixels: A sprite at logical size 1 on a screen with
    // a ratio of 3 is still magnified
    final samplesAtOne =
        _scaleX * _devicePixelRatio == 1 && _scaleY * _devicePixelRatio == 1;
    _inset = samplesAtOne ? 0 : 0.5;
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    final sprite = _frame._sprite;
    final image = _frame._image;
    if (sprite == null || image == null || size.isEmpty) {
      return;
    }

    if (!_mappingValid) {
      _updateMapping();
    }

    final insetX = sprite.width > 1 ? _inset : 0.0;
    final insetY = sprite.height > 1 ? _inset : 0.0;
    final src = Rect.fromLTRB(
      sprite.x + insetX,
      sprite.y + insetY,
      sprite.x + sprite.width - insetX,
      sprite.y + sprite.height - insetY,
    );
    final left = offset.dx + _originX + sprite.dx * _scaleX;
    final top = offset.dy + _originY + sprite.dy * _scaleY;
    final dst = Rect.fromLTWH(
      left,
      top,
      sprite.width * _scaleX,
      sprite.height * _scaleY,
    );

    final canvas = context.canvas;
    final clip = _clip;
    if (clip == null) {
      canvas.drawImageRect(image, src, dst, _paint);
    } else {
      canvas
        ..save()
        ..clipRect(clip.shift(offset))
        ..drawImageRect(image, src, dst, _paint)
        ..restore();
    }
  }
}
