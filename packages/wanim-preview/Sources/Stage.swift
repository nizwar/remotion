import AppKit
import SwiftUI
import Wanim

struct StageBar: View {
	let session: Session?
	let stage: StageSettings

	var body: some View {
		HStack(spacing: Theme.unit * 2) {
			HStack(spacing: Theme.unit / 2) {
				RowLabel("Background")
					.padding(.trailing, Theme.unit / 2)
				ForEach(StageBackground.allCases) { background in
					LineChoice(label: background.rawValue, isOn: stage.background == background) {
						stage.background = background
					}
					.accessibilityLabel("\(background.rawValue) background")
				}
			}
			HStack(spacing: Theme.unit / 2) {
				RowLabel("Zoom")
					.padding(.trailing, Theme.unit / 2)
				ForEach(StageZoom.allCases) { zoom in
					LineChoice(label: zoom.label, isFigure: zoom != .fit, isOn: stage.zoom == zoom) {
						stage.zoom = zoom
					}
					.accessibilityLabel(zoom == .fit ? "Zoom to fit" : "Zoom \(zoom.label)")
				}
			}
			LineChoice(label: "Nearest neighbour", isOn: stage.isNearest) {
				stage.isNearest.toggle()
			}
			.help("Show canvas pixels without filtering")
			Spacer(minLength: 0)
			if session != nil {
				Text(String(format: "%.2fx", stage.scale))
					.font(Theme.smallFigure)
					.foregroundStyle(Theme.muted)
					.accessibilityLabel(String(format: "Drawn at %.2f times", stage.scale))
					.help("One canvas pixel covers this many display pixels")
			}
		}
		.padding(.horizontal, Theme.unit * 1.5)
		.frame(height: Theme.rowHeight)
		.disabled(session == nil)
	}
}

struct Stage: View {
	let session: Session
	let stage: StageSettings
	@Environment(\.displayScale) private var displayScale

	var body: some View {
		GeometryReader { geometry in
			let target = CGSize(
				width: geometry.size.width * displayScale,
				height: geometry.size.height * displayScale
			)
			let fit = WanimFit.scale(stage.scale)
			ZStack {
				Backdrop(session: session, stage: stage, target: target, displayScale: displayScale)
				MetalStage(
					session: session,
					fit: fit,
					filtering: stage.isNearest ? .nearest : .linear,
					offset: stage.pan
				) { delta in
					let delta = CGPoint(x: delta.x * displayScale, y: delta.y * displayScale)
					stage.pan = clamped(
						CGPoint(x: stage.pan.x + delta.x, y: stage.pan.y + delta.y),
						target: target
					)
				}
				if !session.isReady {
					Text(loadingLine)
						.font(Theme.body)
						.foregroundStyle(Theme.muted)
						.padding(Theme.unit)
						.background(Theme.ground)
				}
			}
			.onChange(of: target, initial: true) {
				updateFit(target)
			}
		}
		.background(Theme.ground)
		.clipped()
		.accessibilityElement()
		.accessibilityLabel("Stage")
		.accessibilityValue(session.url.lastPathComponent)
	}

	private var loadingLine: String {
		let count = session.animation.preloads ? session.manifest.atlases.count : 1
		return count == 1 ? "Decoding the atlas" : "Decoding \(count) atlases"
	}

	private func updateFit(_ target: CGSize) {
		let margin = Theme.unit * 2 * displayScale * 2
		let manifest = session.manifest
		let width = max(target.width - margin, 1) / Double(manifest.width)
		let height = max(target.height - margin, 1) / Double(manifest.height)
		stage.fitScale = min(width, height)
		stage.pan = clamped(stage.pan, target: target)
	}

	/// The canvas can be moved until its edge meets the edge of the stage, not further.
	private func clamped(_ pan: CGPoint, target: CGSize) -> CGPoint {
		let manifest = session.manifest
		let limitX = max(Double(manifest.width) * stage.scale - target.width, 0) / 2
		let limitY = max(Double(manifest.height) * stage.scale - target.height, 0) / 2
		return CGPoint(
			x: min(max(pan.x, -limitX), limitX).rounded(),
			y: min(max(pan.y, -limitY), limitY).rounded()
		)
	}
}

/// What shows through the transparent pixels. Only the canvas gets it, so that its bounds are visible.
private struct Backdrop: View {
	let session: Session
	let stage: StageSettings
	let target: CGSize
	let displayScale: Double

	var body: some View {
		let background = stage.background
		let pixels = WanimRenderer.canvasRect(
			fit: .scale(stage.scale),
			manifest: session.manifest,
			target: target,
			offset: stage.pan
		)
		let canvasRect = CGRect(
			x: pixels.minX / displayScale,
			y: pixels.minY / displayScale,
			width: pixels.width / displayScale,
			height: pixels.height / displayScale
		)
		Canvas { context, size in
			let visible = canvasRect.intersection(CGRect(origin: .zero, size: size))
			guard !visible.isNull else {
				return
			}

			switch background {
			case .black:
				context.fill(Path(visible), with: .color(.black))
			case .white:
				context.fill(Path(visible), with: .color(.white))
			case .checker:
				context.fill(Path(visible), with: .color(Theme.checkerDark))
				let cell = Theme.unit
				var squares = Path()
				let firstColumn = Int(((visible.minX - canvasRect.minX) / cell).rounded(.down))
				let firstRow = Int(((visible.minY - canvasRect.minY) / cell).rounded(.down))
				let lastColumn = Int(((visible.maxX - canvasRect.minX) / cell).rounded(.up))
				let lastRow = Int(((visible.maxY - canvasRect.minY) / cell).rounded(.up))
				for row in firstRow ..< lastRow {
					for column in firstColumn ..< lastColumn where (row + column) % 2 == 0 {
						let square = CGRect(
							x: canvasRect.minX + CGFloat(column) * cell,
							y: canvasRect.minY + CGFloat(row) * cell,
							width: cell,
							height: cell
						)
						squares.addRect(square.intersection(visible))
					}
				}
				context.fill(squares, with: .color(Theme.checkerLight))
			}

			context.stroke(Path(canvasRect.insetBy(dx: -0.5, dy: -0.5)), with: .color(Theme.control), lineWidth: 1)
		}
		.accessibilityHidden(true)
	}
}

/// The only view that touches Metal. It depends on the fit, never on the frame.
private struct MetalStage: NSViewRepresentable {
	let session: Session
	let fit: WanimFit
	let filtering: WanimFiltering
	let offset: CGPoint
	let onPan: (CGPoint) -> Void

	func makeNSView(context _: Context) -> StageHost {
		let host = StageHost(animation: session.animation)
		session.attach(host.player)
		update(host)
		return host
	}

	func updateNSView(_ host: StageHost, context _: Context) {
		update(host)
	}

	private func update(_ host: StageHost) {
		host.player.fit = fit
		host.player.filtering = filtering
		host.player.contentOffset = offset
		host.onPan = onPan
	}
}

/// Takes the mouse and the scroll wheel, to move a canvas that is larger than the stage.
private final class StageHost: NSView {
	let player: WanimView
	var onPan: ((CGPoint) -> Void)?

	init(animation: WanimAnimation) {
		player = WanimView(animation: animation)
		super.init(frame: .zero)
		player.autoresizingMask = [.width, .height]
		addSubview(player)
	}

	@available(*, unavailable)
	required init?(coder _: NSCoder) {
		fatalError("init(coder:) is not supported")
	}

	override var mouseDownCanMoveWindow: Bool {
		false
	}

	override func hitTest(_ point: NSPoint) -> NSView? {
		frame.contains(point) ? self : nil
	}

	override func layout() {
		super.layout()
		player.frame = bounds
	}

	override func mouseDragged(with event: NSEvent) {
		onPan?(CGPoint(x: event.deltaX, y: event.deltaY))
	}

	override func scrollWheel(with event: NSEvent) {
		onPan?(CGPoint(x: event.scrollingDeltaX, y: event.scrollingDeltaY))
	}
}
