import SwiftUI
import Wanim

struct Inspector: View {
	let model: DocumentModel

	var body: some View {
		VStack(spacing: 0) {
			BudgetFigure(session: model.session, isWaiting: isWaiting)
			HorizontalRule(color: Theme.rule)
			FileFactsPanel(session: model.session, isWaiting: isWaiting)
			HorizontalRule(color: Theme.rule)
			if let session = model.session {
				FrameFacts(session: session)
				HorizontalRule(color: Theme.rule)
				AtlasViewer(session: session)
					.id(ObjectIdentifier(session))
			} else {
				EmptyFrameFacts(isWaiting: isWaiting)
				HorizontalRule(color: Theme.rule)
				EmptyAtlasViewer(isWaiting: isWaiting)
			}
		}
		.background(Theme.surface)
	}

	private var isWaiting: Bool {
		if case .opening = model.phase {
			return true
		}

		return false
	}
}

private struct BudgetFigure: View {
	let session: Session?
	let isWaiting: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: Theme.unit / 2) {
			Text("GPU memory")
				.font(Theme.small)
				.foregroundStyle(Theme.muted)
			HStack(alignment: .firstTextBaseline, spacing: Theme.unit) {
				if let session {
					Text(Format.bytes(session.manifest.gpuBytes))
						.font(Theme.figure)
						.foregroundStyle(Theme.text)
				} else if isWaiting {
					ValueBar(width: 96, height: 24)
				} else {
					Text("—")
						.font(Theme.bodyFigure)
						.foregroundStyle(Theme.muted)
						.frame(height: 24)
				}

				Spacer(minLength: 0)
				Text("of \(Format.bytes(WanimAnimation.defaultGPUBudget))")
					.font(Theme.smallFigure)
					.foregroundStyle(Theme.muted)
			}
			GeometryReader { geometry in
				ZStack(alignment: .leading) {
					Theme.control.frame(height: 1)
					if let session {
						let budget = Double(WanimAnimation.defaultGPUBudget)
						let ratio = min(Double(session.manifest.gpuBytes) / budget, 1)
						(session.animation.preloads ? Theme.positive : Theme.warning)
							.frame(width: max(geometry.size.width * ratio, 1), height: 3)
					}
				}
				.frame(height: 3)
			}
			.frame(height: 3)
			.padding(.top, Theme.unit / 2)
			.accessibilityHidden(true)
		}
		.padding(Theme.unit * 1.5)
		.accessibilityElement(children: .combine)
	}
}

private struct Fact: Identifiable {
	let label: String
	let value: String?

	var id: String {
		label
	}
}

/// Two columns of label and figure, each figure on the right edge of its column.
private struct FactGrid: View {
	let facts: [Fact]
	var isWaiting = false

	var body: some View {
		Grid(horizontalSpacing: Theme.unit * 2, verticalSpacing: 0) {
			ForEach(Array(stride(from: 0, to: facts.count, by: 2)), id: \.self) { index in
				GridRow {
					cell(facts[index])
					if index + 1 < facts.count {
						cell(facts[index + 1])
					} else {
						Color.clear.frame(height: 1)
					}
				}
			}
		}
	}

	private func cell(_ fact: Fact) -> some View {
		HStack(spacing: Theme.unit / 2) {
			Text(fact.label)
				.font(Theme.small)
				.foregroundStyle(Theme.muted)
				.lineLimit(1)
				.fixedSize()
			Spacer(minLength: 0)
			if isWaiting {
				ValueBar(width: 40, height: 12)
			} else if let value = fact.value {
				Text(value)
					.font(Theme.bodyFigure)
					.foregroundStyle(Theme.text)
					.lineLimit(1)
			} else {
				Text("—")
					.font(Theme.bodyFigure)
					.foregroundStyle(Theme.muted)
			}
		}
		.frame(height: 22)
		.frame(maxWidth: .infinity)
		.accessibilityElement(children: .combine)
	}
}

private struct FileFactsPanel: View {
	let session: Session?
	let isWaiting: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: Theme.unit / 2) {
			PanelTitle("File")
			FactGrid(facts: facts, isWaiting: isWaiting)
		}
		.padding(.horizontal, Theme.unit * 1.5)
		.padding(.vertical, Theme.unit)
	}

	private var facts: [Fact] {
		let manifest = session?.manifest
		return [
			Fact(label: "Canvas", value: manifest.map { "\($0.width)x\($0.height)" }),
			Fact(label: "Frame rate", value: manifest.map { "\(Format.number($0.fps)) fps" }),
			Fact(label: "Frames", value: manifest.map { "\($0.frameCount)" }),
			Fact(label: "Duration", value: manifest.map { String(format: "%.2f s", $0.duration) }),
			Fact(label: "File size", value: session.map { Format.bytes($0.animation.fileSize) }),
			Fact(label: "Atlases", value: manifest.map { "\($0.atlases.count)" }),
			Fact(label: "Sprites", value: manifest.map { "\($0.sprites.count)" }),
			Fact(label: "Unique rects", value: session.map { "\($0.facts.uniqueRectangles)" }),
			Fact(label: "Held frames", value: session.map { "\($0.facts.heldFrames)" }),
			Fact(label: "Empty frames", value: session.map { "\($0.facts.emptyFrames)" }),
		]
	}
}

private struct PanelTitle: View {
	let title: String
	var trailing: String?

	init(_ title: String, trailing: String? = nil) {
		self.title = title
		self.trailing = trailing
	}

	var body: some View {
		HStack(spacing: Theme.unit) {
			Text(title)
				.font(Theme.small)
				.foregroundStyle(Theme.text)
			Spacer(minLength: 0)
			if let trailing {
				Text(trailing)
					.font(Theme.small)
					.foregroundStyle(Theme.muted)
			}
		}
		.frame(height: 18)
	}
}

private struct FrameFacts: View {
	let session: Session

	var body: some View {
		let frame = session.playhead.frame
		let spriteIndex = session.manifest.frames[frame]
		let sprite = spriteIndex >= 0 ? session.manifest.sprites[spriteIndex] : nil
		let run = session.facts.runs[Int(session.facts.runOfFrame[frame])]
		VStack(alignment: .leading, spacing: Theme.unit / 2) {
			PanelTitle("Frame \(frame)", trailing: trailing(frame: frame, run: run))
			FactGrid(facts: [
				Fact(label: "Sprite", value: sprite == nil ? nil : "\(spriteIndex)"),
				Fact(label: "Atlas", value: sprite.map { "\($0.atlas + 1)" }),
				Fact(label: "x", value: sprite.map { "\($0.x)" }),
				Fact(label: "y", value: sprite.map { "\($0.y)" }),
				Fact(label: "w", value: sprite.map { "\($0.width)" }),
				Fact(label: "h", value: sprite.map { "\($0.height)" }),
				Fact(label: "dx", value: sprite.map { "\($0.offsetX)" }),
				Fact(label: "dy", value: sprite.map { "\($0.offsetY)" }),
			])
		}
		.padding(.horizontal, Theme.unit * 1.5)
		.padding(.vertical, Theme.unit)
	}

	private func trailing(frame: Int, run: FrameRun) -> String? {
		if run.isEmpty {
			return "Empty frame"
		}

		return run.count > 1 ? "Held, \(frame - run.start + 1) of \(run.count)" : nil
	}
}

private struct EmptyFrameFacts: View {
	let isWaiting: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: Theme.unit / 2) {
			PanelTitle("Frame")
			FactGrid(
				facts: ["Sprite", "Atlas", "x", "y", "w", "h", "dx", "dy"].map { Fact(label: $0, value: nil) },
				isWaiting: isWaiting
			)
		}
		.padding(.horizontal, Theme.unit * 1.5)
		.padding(.vertical, Theme.unit)
	}
}

private struct EmptyAtlasViewer: View {
	let isWaiting: Bool

	var body: some View {
		VStack(alignment: .leading, spacing: Theme.unit) {
			PanelTitle("Atlas")
			(isWaiting ? Theme.raised : Theme.ground)
				.clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius))
				.overlay {
					RoundedRectangle(cornerRadius: Theme.cardRadius)
						.strokeBorder(Theme.border, lineWidth: 1)
				}
		}
		.padding(Theme.unit * 1.5)
		.frame(maxHeight: .infinity)
	}
}

struct AtlasViewer: View {
	let session: Session

	var body: some View {
		let page = session.pinnedAtlas ?? session.playhead.atlas
		VStack(alignment: .leading, spacing: 0) {
			HStack(spacing: Theme.unit) {
				Text("Atlas")
					.font(Theme.small)
					.foregroundStyle(Theme.text)
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: 0) {
						ForEach(session.manifest.atlases.indices, id: \.self) { index in
							LineChoice(label: "\(index + 1)", isFigure: true, isOn: index == page) {
								session.pinnedAtlas = index == session.playhead.atlas ? nil : index
							}
							.accessibilityLabel("Atlas page \(index + 1)")
						}
					}
				}
				Spacer(minLength: 0)
				if !session.manifest.atlases.isEmpty {
					let atlas = session.manifest.atlases[page]
					Text(verbatim: "\(atlas.width)x\(atlas.height)")
						.font(Theme.smallFigure)
						.foregroundStyle(Theme.muted)
						.fixedSize()
				}
			}
			.padding(.horizontal, Theme.unit * 1.5)
			.frame(height: Theme.rowHeight)
			HorizontalRule(color: Theme.rule)
			AtlasPage(session: session, page: page)
				.padding(Theme.unit * 1.5)
		}
		.frame(maxHeight: .infinity)
	}
}

private struct AtlasPage: View {
	let session: Session
	let page: Int

	var body: some View {
		let manifest = session.manifest
		GeometryReader { geometry in
			if manifest.atlases.isEmpty {
				sentence("This file has no atlases.", size: geometry.size)
			} else if session.atlasFailures.contains(page) {
				sentence("Atlas \(page + 1) cannot be read.", size: geometry.size)
			} else {
				let atlas = manifest.atlases[page]
				let scale = min(
					geometry.size.width / CGFloat(atlas.width),
					geometry.size.height / CGFloat(atlas.height)
				)
				let width = CGFloat(atlas.width) * scale
				let height = CGFloat(atlas.height) * scale
				ZStack(alignment: .topLeading) {
					Theme.raised
					if let image = session.atlasImages[page] {
						Image(decorative: image, scale: 1)
							.resizable()
							.interpolation(scale > 1 ? .none : .medium)
					}

					SpriteOutline(session: session, page: page, scale: scale)
				}
				.frame(width: width, height: height)
				.frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
				.accessibilityElement()
				.accessibilityLabel("Atlas page \(page + 1)")
			}
		}
		.task(id: page) {
			if !manifest.atlases.isEmpty {
				session.loadAtlasImage(page)
			}
		}
	}

	private func sentence(_ text: String, size: CGSize) -> some View {
		Text(text)
			.font(Theme.body)
			.foregroundStyle(Theme.muted)
			.frame(width: size.width, height: size.height)
	}
}

/// The one view of the atlas that changes per frame.
private struct SpriteOutline: View {
	let session: Session
	let page: Int
	let scale: CGFloat

	var body: some View {
		let spriteIndex = session.manifest.frames[session.playhead.frame]
		if spriteIndex >= 0 {
			let sprite = session.manifest.sprites[spriteIndex]
			if sprite.atlas == page {
				Rectangle()
					.strokeBorder(Theme.accent, lineWidth: 1)
					.frame(
						width: max((CGFloat(sprite.width) * scale).rounded(), 3),
						height: max((CGFloat(sprite.height) * scale).rounded(), 3)
					)
					.offset(x: (CGFloat(sprite.x) * scale).rounded(), y: (CGFloat(sprite.y) * scale).rounded())
					.allowsHitTesting(false)
			}
		}
	}
}
