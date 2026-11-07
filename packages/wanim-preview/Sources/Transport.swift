import SwiftUI

struct Transport: View {
	static let speeds = [0.25, 0.5, 1, 1.5, 2]

	let session: Session?

	var body: some View {
		HStack(spacing: Theme.unit / 2) {
			Button {
				session?.togglePlaying()
			} label: {
				Image(systemName: isPlaying ? "pause.fill" : "play.fill")
					.font(.system(size: 13))
					.frame(width: 16)
			}
			.buttonStyle(ControlStyle(kind: .icon))
			.quietFocus()
			.foregroundStyle(Theme.text)
			.accessibilityLabel(isPlaying ? "Pause" : "Play")
			.help("Play or pause (Space)")

			Button {
				session?.step(by: -1)
			} label: {
				Image(systemName: "backward.frame")
					.font(.system(size: 13))
			}
			.buttonStyle(ControlStyle(kind: .icon))
			.quietFocus()
			.accessibilityLabel("Step back")
			.help("Step back (Left), 10 frames with Shift")

			Button {
				session?.step(by: 1)
			} label: {
				Image(systemName: "forward.frame")
					.font(.system(size: 13))
			}
			.buttonStyle(ControlStyle(kind: .icon))
			.quietFocus()
			.accessibilityLabel("Step forward")
			.help("Step forward (Right), 10 frames with Shift")

			LineChoice(label: "Loop", isOn: session?.isLooping ?? false, height: Theme.barHeight) {
				session?.toggleLooping()
			}
			.padding(.leading, Theme.unit)
			.help("Loop (L)")

			RowLabel("Speed")
				.padding(.leading, Theme.unit * 2)
				.padding(.trailing, Theme.unit / 2)
			ForEach(Self.speeds, id: \.self) { speed in
				LineChoice(
					label: "\(Format.number(speed))x",
					isFigure: true,
					isOn: session?.speed == speed,
					height: Theme.barHeight
				) {
					session?.setSpeed(speed)
				}
				.accessibilityLabel("Speed \(Format.number(speed)) times")
			}

			Spacer(minLength: Theme.unit)

			if let session {
				PlayheadReadout(session: session)
			} else {
				Text("—")
					.font(Theme.bodyFigure)
					.foregroundStyle(Theme.muted)
			}
		}
		.padding(.horizontal, Theme.unit * 1.5)
		.frame(height: Theme.barHeight)
		.background(Theme.surface)
		.disabled(session?.isReady != true)
	}

	private var isPlaying: Bool {
		session?.isPlaying ?? false
	}
}

private struct PlayheadReadout: View {
	let session: Session

	var body: some View {
		let manifest = session.manifest
		let frame = session.playhead.frame
		HStack(spacing: Theme.unit * 2) {
			figure(Format.time(Double(frame) / manifest.fps), of: Format.time(manifest.duration))
			figure("\(frame)", of: "\(manifest.frameCount - 1)", width: digits(manifest.frameCount - 1))
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Frame \(frame) of \(manifest.frameCount - 1)")
	}

	private func digits(_ value: Int) -> Int {
		String(value).count
	}

	private func figure(_ value: String, of total: String, width: Int = 0) -> some View {
		HStack(spacing: 0) {
			Text(String(repeating: " ", count: max(width - value.count, 0)) + value)
				.foregroundStyle(Theme.text)
			Text(" / \(total)")
				.foregroundStyle(Theme.muted)
		}
		.font(Theme.bodyFigure)
	}
}
