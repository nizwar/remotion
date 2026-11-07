import SwiftUI

/// Controls a `WanimPlayer` and reports what it shows.
@MainActor
public final class WanimPlayerController: ObservableObject {
	@Published public private(set) var currentFrame = 0

	weak var view: WanimView? {
		didSet { view?.onFrameChange = { [weak self] in self?.currentFrame = $0 } }
	}

	public init() {}

	public func seek(toFrame frame: Int) {
		view?.seek(toFrame: frame)
		currentFrame = view?.currentFrame ?? frame
	}
}

public struct WanimPlayer {
	private let animation: WanimAnimation
	private let loop: Bool
	private let fit: WanimFit
	private let speed: Double
	private let filtering: WanimFiltering
	private let controller: WanimPlayerController?
	private let onFinished: (() -> Void)?
	private let onError: ((Error) -> Void)?
	@Binding private var isPlaying: Bool

	public init(
		_ animation: WanimAnimation,
		loop: Bool = true,
		isPlaying: Binding<Bool> = .constant(true),
		fit: WanimFit = .contain,
		speed: Double = 1,
		filtering: WanimFiltering = .linear,
		controller: WanimPlayerController? = nil,
		onFinished: (() -> Void)? = nil,
		onError: ((Error) -> Void)? = nil
	) {
		self.animation = animation
		self.loop = loop
		_isPlaying = isPlaying
		self.fit = fit
		self.speed = speed
		self.filtering = filtering
		self.controller = controller
		self.onFinished = onFinished
		self.onError = onError
	}

	/// Remembers the last request, so that a finished animation is not restarted by a redraw.
	public final class Coordinator {
		fileprivate var requestedPlaying: Bool?
	}

	public func makeCoordinator() -> Coordinator {
		Coordinator()
	}

	@MainActor
	private func makeView(_ coordinator: Coordinator) -> WanimView {
		let view = WanimView(animation: animation)
		update(view, coordinator)
		return view
	}

	@MainActor
	private func update(_ view: WanimView, _ coordinator: Coordinator) {
		if view.animation !== animation {
			view.animation = animation
		}

		view.loop = loop
		view.speed = speed
		if view.fit != fit {
			view.fit = fit
		}

		view.filtering = filtering
		view.onError = onError
		view.onFinished = {
			isPlaying = false
			onFinished?()
		}
		controller?.view = view
		if isPlaying != coordinator.requestedPlaying {
			coordinator.requestedPlaying = isPlaying
			isPlaying ? view.play() : view.pause()
		}
	}
}

#if os(macOS)
extension WanimPlayer: NSViewRepresentable {
	public func makeNSView(context: Context) -> WanimView {
		makeView(context.coordinator)
	}

	public func updateNSView(_ view: WanimView, context: Context) {
		update(view, context.coordinator)
	}
}
#else
extension WanimPlayer: UIViewRepresentable {
	public func makeUIView(context: Context) -> WanimView {
		makeView(context.coordinator)
	}

	public func updateUIView(_ view: WanimView, context: Context) {
		update(view, context.coordinator)
	}
}
#endif
