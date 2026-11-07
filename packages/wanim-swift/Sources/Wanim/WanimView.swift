import Metal
import QuartzCore

#if os(macOS)
import AppKit
public typealias WanimPlatformView = NSView
#else
import UIKit
public typealias WanimPlatformView = UIView
#endif

/// Plays a `WanimAnimation` on the GPU.
public final class WanimView: WanimPlatformView {
	public var animation: WanimAnimation? {
		didSet { animationDidChange() }
	}

	public var loop = true
	public var speed = 1.0 {
		didSet { updateFrameRate() }
	}

	public var fit: WanimFit = .contain {
		didSet {
			guard fit != oldValue else {
				return
			}

			renderer?.fit = fit
			setNeedsFrameDraw()
		}
	}

	public var filtering: WanimFiltering = .linear {
		didSet {
			guard filtering != oldValue else {
				return
			}

			renderer?.filtering = filtering
			setNeedsFrameDraw()
		}
	}

	/// Moves the canvas inside of the view, in drawable pixels.
	public var contentOffset: CGPoint = .zero {
		didSet {
			guard contentOffset != oldValue else {
				return
			}

			renderer?.offset = contentOffset
			setNeedsFrameDraw()
		}
	}

	public private(set) var currentFrame = 0
	public private(set) var isPlaying = false
	/// True once `onReady` was called: The atlases that must be preloaded are on the GPU.
	public private(set) var isReady = false

	public var onReady: (() -> Void)?
	public var onFinished: (() -> Void)?
	public var onError: ((Error) -> Void)?
	public var onFrameChange: ((Int) -> Void)?

	private var renderer: WanimRenderer?
	private let inFlight = DispatchSemaphore(value: 3)
	private var displayLink: CADisplayLink?
	private var elapsed: TimeInterval = 0
	private var lastTimestamp: CFTimeInterval?
	private var drawnSprite: Int?
	private var drawnAtlas: Int?
	private var awaitedAtlas: Int?
	private var needsFrameDraw = true
	private var isInBackground = false

	private var metalLayer: CAMetalLayer {
		layer as! CAMetalLayer
	}

	public convenience init(animation: WanimAnimation) {
		self.init(frame: .zero)
		self.animation = animation
		animationDidChange()
	}

	override public init(frame: CGRect) {
		super.init(frame: frame)
		setUp()
	}

	@available(*, unavailable)
	public required init?(coder _: NSCoder) {
		fatalError("init(coder:) is not supported")
	}

	deinit {
		displayLink?.invalidate()
		NotificationCenter.default.removeObserver(self)
	}

	public func play() {
		if !loop, let manifest = animation?.manifest, currentFrame == manifest.frameCount - 1 {
			seek(toFrame: 0)
		}

		lastTimestamp = nil
		isPlaying = true
		updateDisplayLink()
	}

	public func pause() {
		isPlaying = false
		updateDisplayLink()
	}

	public func seek(toFrame frame: Int) {
		guard let manifest = animation?.manifest else {
			return
		}

		let clamped = min(max(frame, 0), manifest.frameCount - 1)
		// The nudge keeps floor(elapsed * fps) on this frame despite rounding
		elapsed = (Double(clamped) + 0.001) / manifest.fps
		lastTimestamp = nil
		show(frame: clamped)
	}

	/// Drops every atlas except the one on screen, to answer memory pressure.
	public func releaseCaches() {
		animation?.textures.trim(keeping: drawnAtlas)
	}

	private func setUp() {
		#if os(macOS)
		wantsLayer = true
		layerContentsRedrawPolicy = .never
		#else
		isOpaque = false
		backgroundColor = .clear
		let center = NotificationCenter.default
		center.addObserver(
			self,
			selector: #selector(didEnterBackground),
			name: UIApplication.didEnterBackgroundNotification,
			object: nil
		)
		center.addObserver(
			self,
			selector: #selector(willEnterForeground),
			name: UIApplication.willEnterForegroundNotification,
			object: nil
		)
		center.addObserver(
			self,
			selector: #selector(didReceiveMemoryWarning),
			name: UIApplication.didReceiveMemoryWarningNotification,
			object: nil
		)
		#endif

		let layer = metalLayer
		layer.device = WanimGPU.shared?.device
		layer.pixelFormat = .bgra8Unorm
		layer.framebufferOnly = true
		layer.isOpaque = false
		#if os(macOS)
		// Without this, the sRGB bytes of the atlas are not matched to a wide gamut display
		layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
		#endif
	}

	private func animationDidChange() {
		elapsed = 0
		currentFrame = 0
		lastTimestamp = nil
		drawnSprite = nil
		drawnAtlas = nil
		awaitedAtlas = nil
		isReady = false
		guard let animation else {
			renderer = nil
			clearLayer()
			return
		}

		do {
			let renderer = try WanimRenderer(animation: animation)
			renderer.fit = fit
			renderer.filtering = filtering
			renderer.offset = contentOffset
			self.renderer = renderer
			updateFrameRate()
			Task { @MainActor [weak self] in
				do {
					try await renderer.prepare()
					guard let self, self.renderer === renderer else {
						return
					}

					self.isReady = true
					self.setNeedsFrameDraw()
					self.onReady?()
				} catch {
					guard let self, self.renderer === renderer else {
						return
					}

					self.onError?(error)
				}
			}
		} catch {
			renderer = nil
			onError?(error)
		}
	}

	private var isVisibleOnScreen: Bool {
		#if os(macOS)
		guard let window, !isHiddenOrHasHiddenAncestor else {
			return false
		}

		return window.occlusionState.contains(.visible)
		#else
		return window != nil && !isHidden && !isInBackground
		#endif
	}

	private func updateDisplayLink() {
		let shouldRun = isPlaying && isVisibleOnScreen
		guard shouldRun != (displayLink != nil) else {
			return
		}

		displayLink?.invalidate()
		displayLink = nil
		lastTimestamp = nil
		guard shouldRun else {
			return
		}

		let proxy = DisplayLinkProxy(view: self)
		#if os(macOS)
		let link = displayLink(target: proxy, selector: #selector(DisplayLinkProxy.tick(_:)))
		#else
		let link = CADisplayLink(target: proxy, selector: #selector(DisplayLinkProxy.tick(_:)))
		#endif
		link.add(to: .main, forMode: .common)
		displayLink = link
		updateFrameRate()
	}

	private func updateFrameRate() {
		guard let manifest = animation?.manifest else {
			return
		}

		let rate = Float(manifest.fps * max(speed, 0.01))
		displayLink?.preferredFrameRateRange = CAFrameRateRange(
			minimum: min(rate, 30),
			maximum: max(rate, 30),
			preferred: rate
		)
	}

	fileprivate func tick(_ link: CADisplayLink) {
		guard let manifest = animation?.manifest, isReady else {
			return
		}

		let now = link.targetTimestamp
		defer { lastTimestamp = now }
		guard let last = lastTimestamp else {
			return
		}

		elapsed += (now - last) * max(speed, 0)
		var frame = Int(elapsed * manifest.fps)
		if frame >= manifest.frameCount {
			if loop {
				elapsed = elapsed.truncatingRemainder(dividingBy: manifest.duration)
				frame = Int(elapsed * manifest.fps) % manifest.frameCount
			} else {
				show(frame: manifest.frameCount - 1)
				pause()
				onFinished?()
				return
			}
		}

		show(frame: frame)
	}

	private func show(frame: Int) {
		if frame != currentFrame {
			currentFrame = frame
			onFrameChange?(frame)
		}

		draw()
	}

	private func setNeedsFrameDraw() {
		needsFrameDraw = true
		draw()
	}

	private func draw() {
		guard let renderer, let gpu = WanimGPU.shared, let animation, isReady, isVisibleOnScreen else {
			return
		}

		let manifest = animation.manifest
		let sprite = manifest.frames[currentFrame]
		guard needsFrameDraw || sprite != drawnSprite else {
			return
		}

		updateDrawableSize()
		let size = metalLayer.drawableSize
		guard size.width > 0, size.height > 0 else {
			return
		}

		if sprite >= 0 {
			let atlas = manifest.sprites[sprite].atlas
			guard animation.textures.texture(at: atlas) != nil else {
				// Holds the last frame, and draws this one as soon as its atlas arrives
				waitFor(atlas: atlas)
				return
			}
		}

		// When all frames are in flight, the completion of the oldest one draws this frame
		guard inFlight.wait(timeout: .now()) == .success else {
			return
		}

		guard let drawable = metalLayer.nextDrawable(),
		      let commands = gpu.drawQueue.makeCommandBuffer()
		else {
			inFlight.signal()
			return
		}

		do {
			let didDraw = try renderer.encode(
				frame: currentFrame,
				target: drawable.texture,
				clearColor: MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0),
				commands: commands
			)
			guard didDraw else {
				inFlight.signal()
				return
			}
		} catch {
			inFlight.signal()
			onError?(error)
			return
		}

		let semaphore = inFlight
		commands.addCompletedHandler { [weak self] _ in
			semaphore.signal()
			DispatchQueue.main.async { self?.draw() }
		}
		commands.present(drawable)
		commands.commit()
		needsFrameDraw = false
		drawnSprite = sprite
		if sprite >= 0 {
			prefetch(after: manifest.sprites[sprite].atlas)
		}
	}

	private func waitFor(atlas: Int) {
		guard awaitedAtlas != atlas, let animation else {
			return
		}

		awaitedAtlas = atlas
		animation.textures.request(atlas) { [weak self] result in
			DispatchQueue.main.async {
				guard let self, self.animation === animation else {
					return
				}

				self.awaitedAtlas = nil
				switch result {
				case .success:
					self.draw()
				case let .failure(error):
					self.pause()
					self.onError?(error)
				}
			}
		}
	}

	private func prefetch(after atlas: Int) {
		guard atlas != drawnAtlas, let animation else {
			return
		}

		drawnAtlas = atlas
		animation.textures.request((atlas + 1) % animation.manifest.atlases.count)
	}

	private func clearLayer() {
		guard let gpu = WanimGPU.shared, metalLayer.drawableSize.width > 0,
		      let drawable = metalLayer.nextDrawable(),
		      let commands = gpu.drawQueue.makeCommandBuffer()
		else {
			return
		}

		let pass = MTLRenderPassDescriptor()
		pass.colorAttachments[0].texture = drawable.texture
		pass.colorAttachments[0].loadAction = .clear
		pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
		pass.colorAttachments[0].storeAction = .store
		commands.makeRenderCommandEncoder(descriptor: pass)?.endEncoding()
		commands.present(drawable)
		commands.commit()
	}

	private func updateDrawableSize() {
		#if os(macOS)
		let scale = window?.backingScaleFactor ?? 2
		#else
		let scale = window?.screen.scale ?? 2
		#endif
		metalLayer.contentsScale = scale
		let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
		if metalLayer.drawableSize != size {
			metalLayer.drawableSize = size
			needsFrameDraw = true
		}

		// An opaque layer would paint the letterbox bars black instead of showing the host view
		if let manifest = animation?.manifest {
			let canvas = WanimRenderer.canvasRect(fit: fit, manifest: manifest, target: size, offset: contentOffset)
			let coversLayer = canvas.insetBy(dx: -0.5, dy: -0.5).contains(CGRect(origin: .zero, size: size))
			let isOpaque = manifest.opaque && coversLayer
			if metalLayer.isOpaque != isOpaque {
				metalLayer.isOpaque = isOpaque
			}
		}
	}

	#if os(macOS)
	override public func makeBackingLayer() -> CALayer {
		CAMetalLayer()
	}

	override public func viewWillMove(toWindow newWindow: NSWindow?) {
		super.viewWillMove(toWindow: newWindow)
		let center = NotificationCenter.default
		center.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: window)
		if let newWindow {
			center.addObserver(
				self,
				selector: #selector(occlusionDidChange),
				name: NSWindow.didChangeOcclusionStateNotification,
				object: newWindow
			)
		}
	}

	override public func viewDidMoveToWindow() {
		super.viewDidMoveToWindow()
		updateDisplayLink()
		setNeedsFrameDraw()
	}

	override public func viewDidHide() {
		super.viewDidHide()
		updateDisplayLink()
	}

	override public func viewDidUnhide() {
		super.viewDidUnhide()
		updateDisplayLink()
		setNeedsFrameDraw()
	}

	@objc private func occlusionDidChange() {
		updateDisplayLink()
		setNeedsFrameDraw()
	}

	override public func viewDidChangeBackingProperties() {
		super.viewDidChangeBackingProperties()
		setNeedsFrameDraw()
	}

	override public func setFrameSize(_ newSize: NSSize) {
		super.setFrameSize(newSize)
		setNeedsFrameDraw()
	}
	#else
	override public class var layerClass: AnyClass {
		CAMetalLayer.self
	}

	override public func didMoveToWindow() {
		super.didMoveToWindow()
		updateDisplayLink()
		setNeedsFrameDraw()
	}

	override public func layoutSubviews() {
		super.layoutSubviews()
		setNeedsFrameDraw()
	}

	@objc private func didEnterBackground() {
		isInBackground = true
		updateDisplayLink()
	}

	@objc private func willEnterForeground() {
		isInBackground = false
		updateDisplayLink()
		setNeedsFrameDraw()
	}

	@objc private func didReceiveMemoryWarning() {
		releaseCaches()
	}
	#endif
}

/// A display link keeps its target alive, so it must not point at the view.
private final class DisplayLinkProxy: NSObject {
	private weak var view: WanimView?

	init(view: WanimView) {
		self.view = view
	}

	@objc func tick(_ link: CADisplayLink) {
		view?.tick(link)
	}
}
