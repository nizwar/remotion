import SwiftUI

/// One cell per frame. Held runs merge into one block, empty frames are hollow.
struct FrameMap: View {
	let model: DocumentModel
	static let height: CGFloat = 92

	var body: some View {
		Group {
			if let session = model.session {
				LoadedFrameMap(session: session)
					.id(ObjectIdentifier(session))
			} else {
				VStack(alignment: .leading, spacing: 0) {
					FrameMapHeader(legend: [], line: nil)
					FrameBaseline(isLoading: isOpening)
				}
			}
		}
		.padding(.horizontal, Theme.unit * 1.5)
		.frame(height: Self.height, alignment: .top)
		.background(Theme.surface)
	}

	private var isOpening: Bool {
		if case .opening = model.phase {
			return true
		}

		return false
	}
}

private struct FrameBaseline: View {
	let isLoading: Bool

	var body: some View {
		ZStack(alignment: .bottom) {
			if isLoading {
				Theme.raised
			} else {
				Theme.border.frame(height: 1)
			}
		}
		.frame(height: LoadedFrameMap.cellHeight)
		.accessibilityHidden(true)
	}
}

private enum LegendMark: Hashable {
	case frame
	case held
	case empty
	case atlasStep
}

private struct FrameMapHeader: View {
	let legend: [LegendMark]
	let line: String?

	var body: some View {
		HStack(spacing: Theme.unit * 2) {
			Text("Frame map")
				.font(Theme.small)
				.foregroundStyle(Theme.text)
			ForEach(legend, id: \.self) { mark in
				HStack(spacing: Theme.unit / 2 + 2) {
					swatch(mark)
					Text(label(mark))
						.font(Theme.small)
						.foregroundStyle(Theme.muted)
				}
			}
			Spacer(minLength: Theme.unit)
			if let line {
				Text(line)
					.font(Theme.smallFigure)
					.foregroundStyle(Theme.muted)
					.lineLimit(1)
			}
		}
		.frame(height: 26)
	}

	private func label(_ mark: LegendMark) -> String {
		switch mark {
		case .frame: "Frame"
		case .held: "Held"
		case .empty: "Empty"
		case .atlasStep: "New atlas"
		}
	}

	@ViewBuilder
	private func swatch(_ mark: LegendMark) -> some View {
		switch mark {
		case .frame:
			FrameMapTones.first.frame(width: 8, height: 10)
		case .held:
			FrameMapTones.first.frame(width: 16, height: 10)
				.overlay(alignment: .top) {
					FrameMapTones.heldEdge.frame(height: 1)
				}
		case .empty:
			Rectangle().strokeBorder(Theme.control, lineWidth: 1).frame(width: 8, height: 10)
		case .atlasStep:
			HStack(spacing: 0) {
				FrameMapTones.first.frame(width: 8, height: 10)
				FrameMapTones.second.frame(width: 8, height: 10)
			}
		}
	}
}

enum FrameMapTones {
	static let first = Color(hex: 0x2A2A2E)
	static let second = Color(hex: 0x46464C)
	static let heldEdge = Theme.muted
}

struct LoadedFrameMap: View {
	static let cellHeight: CGFloat = 36
	static let tickHeight: CGFloat = 18

	let session: Session
	@State private var hoveredFrame: Int?

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			FrameMapHeader(legend: legend, line: hoverLine)
			GeometryReader { geometry in
				let width = geometry.size.width
				ZStack(alignment: .topLeading) {
					FrameCells(runs: session.facts.runs, frameCount: frameCount)
						.equatable()
					if let hoveredFrame {
						Theme.muted
							.frame(width: 1, height: Self.cellHeight)
							.offset(x: center(of: hoveredFrame, width: width))
							.allowsHitTesting(false)
					}
					PlayheadLine(session: session, frameCount: frameCount, width: width)
				}
				.contentShape(Rectangle())
				.gesture(
					DragGesture(minimumDistance: 0)
						.onChanged { value in
							guard session.isReady else {
								return
							}

							session.beginScrub()
							session.seek(to: frame(at: value.location.x, width: width))
						}
						.onEnded { _ in
							session.endScrub()
						}
				)
				.onContinuousHover { phase in
					switch phase {
					case let .active(location):
						hoveredFrame = frame(at: location.x, width: width)
					case .ended:
						hoveredFrame = nil
					}
				}
			}
			.frame(height: Self.cellHeight + Self.tickHeight)
		}
	}

	private var frameCount: Int {
		session.manifest.frameCount
	}

	private var legend: [LegendMark] {
		let runs = session.facts.runs
		var marks: [LegendMark] = []
		if runs.contains(where: { !$0.isEmpty && $0.count == 1 }) {
			marks.append(.frame)
		}

		if session.facts.heldFrames > 0 {
			marks.append(.held)
		}

		if session.facts.emptyFrames > 0 {
			marks.append(.empty)
		}

		if session.manifest.atlases.count > 1 {
			marks.append(.atlasStep)
		}

		return marks
	}

	private var hoverLine: String? {
		guard let hoveredFrame else {
			return nil
		}

		let run = session.facts.runs[Int(session.facts.runOfFrame[hoveredFrame])]
		if run.isEmpty {
			return "Frame \(hoveredFrame), empty"
		}

		let held = run.count > 1 ? ", held for \(run.count) frames" : ""
		return "Frame \(hoveredFrame), sprite \(session.manifest.frames[hoveredFrame]), atlas \(run.atlas + 1)\(held)"
	}

	private func frame(at x: CGFloat, width: CGFloat) -> Int {
		guard width > 0 else {
			return 0
		}

		return min(max(Int(x / width * CGFloat(frameCount)), 0), frameCount - 1)
	}

	private func center(of frame: Int, width: CGFloat) -> CGFloat {
		(CGFloat(frame) + 0.5) * width / CGFloat(frameCount)
	}
}

/// Follows playback by itself, so that the cells below are never drawn again.
private struct PlayheadLine: View {
	let session: Session
	let frameCount: Int
	let width: CGFloat

	var body: some View {
		let frame = session.playhead.frame
		Theme.accent
			.frame(width: 2, height: LoadedFrameMap.cellHeight + 6)
			.offset(x: ((CGFloat(frame) + 0.5) * width / CGFloat(frameCount) - 1).rounded(), y: -3)
			.allowsHitTesting(false)
			.accessibilityElement()
			.accessibilityLabel("Frame map")
			.accessibilityValue("Frame \(frame) of \(frameCount - 1)")
			.accessibilityAdjustableAction { direction in
				session.step(by: direction == .increment ? 1 : -1)
			}
	}
}

private struct FrameCells: View, Equatable {
	let runs: [FrameRun]
	let frameCount: Int

	nonisolated static func == (left: FrameCells, right: FrameCells) -> Bool {
		left.frameCount == right.frameCount && left.runs.count == right.runs.count
	}

	var body: some View {
		Canvas { context, size in
			let cellWidth = size.width / CGFloat(frameCount)
			let cellHeight = LoadedFrameMap.cellHeight
			let seam: CGFloat = cellWidth >= 4 ? 1 : 0
			var firstTone = Path()
			var secondTone = Path()
			var heldEdges = Path()
			var hollow = Path()
			var labels: [(text: String, x: CGFloat)] = []

			for run in runs {
				let start = (CGFloat(run.start) * cellWidth).rounded(.down)
				let end = (CGFloat(run.start + run.count) * cellWidth).rounded(.down)
				let width = max(end - start - seam, 1)
				let rect = CGRect(x: start, y: 0, width: width, height: cellHeight)
				if run.isEmpty {
					hollow.addRect(rect.insetBy(dx: 0.5, dy: 0.5))
					continue
				}

				if run.atlas % 2 == 0 {
					firstTone.addRect(rect)
				} else {
					secondTone.addRect(rect)
				}

				if run.count > 1 {
					heldEdges.addRect(CGRect(x: start, y: 0, width: width, height: 1))
					if width >= 40 {
						labels.append(("\(run.count)", start + width / 2))
					}
				}
			}

			context.fill(firstTone, with: .color(FrameMapTones.first))
			context.fill(secondTone, with: .color(FrameMapTones.second))
			context.stroke(hollow, with: .color(Theme.control), lineWidth: 1)
			context.fill(heldEdges, with: .color(FrameMapTones.heldEdge))
			for label in labels {
				let text = Text(verbatim: label.text).font(Theme.smallFigure).foregroundStyle(Theme.muted)
				context.draw(text, at: CGPoint(x: label.x, y: cellHeight / 2))
			}

			let step = Self.tickStep(frameCount: frameCount, width: size.width)
			for frame in stride(from: 0, to: frameCount, by: step) {
				let x = (CGFloat(frame) * cellWidth).rounded(.down)
				var tick = Path()
				tick.addRect(CGRect(x: x, y: cellHeight + 2, width: 1, height: 4))
				context.fill(tick, with: .color(Theme.control))
				let text = Text(verbatim: "\(frame)").font(Theme.smallFigure).foregroundStyle(Theme.muted)
				context.draw(text, at: CGPoint(x: x + 4, y: cellHeight + 2), anchor: .topLeading)
			}
		}
		.accessibilityHidden(true)
	}

	/// A round step that leaves room for the labels, about one every 90 points.
	private static func tickStep(frameCount: Int, width: CGFloat) -> Int {
		let target = Double(frameCount) / max(Double(width) / 90, 1)
		var magnitude = 1
		while true {
			for factor in [1, 2, 5] where magnitude * factor >= Int(target.rounded(.up)) {
				return magnitude * factor
			}

			magnitude *= 10
		}
	}
}
