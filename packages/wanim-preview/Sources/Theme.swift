import SwiftUI

enum Theme {
	static let ground = Color(hex: 0x171719)
	static let surface = Color(hex: 0x131217)
	static let raised = Color(hex: 0x212023)
	static let border = Color(hex: 0x222224)
	static let rule = Color(hex: 0x1B1A1F)
	static let control = Color(hex: 0x3A3A3E)
	static let text = Color.white
	static let muted = Color(hex: 0x8A8C92)
	static let positive = Color(hex: 0x44A282)
	static let negative = Color(hex: 0xE5566F)
	static let warning = Color(hex: 0xD9A441)
	static let accent = Color(hex: 0xF2853A)
	static let checkerLight = Color(hex: 0x2C2C30)
	static let checkerDark = Color(hex: 0x1F1F22)

	/// Every gap and padding is a multiple of this.
	static let unit: CGFloat = 8
	static let cardRadius: CGFloat = 6
	static let controlHeight: CGFloat = 28
	static let barHeight: CGFloat = 40
	static let rowHeight: CGFloat = 32

	static let body = Font.system(size: 13)
	static let small = Font.system(size: 12)
	static let title = Font.system(size: 16, weight: .semibold)
	static let bodyFigure = Font.system(size: 13, design: .monospaced)
	static let smallFigure = Font.system(size: 12, design: .monospaced)
	static let figure = Font.system(size: 20, design: .monospaced)
}

extension Color {
	init(hex: UInt32) {
		self.init(
			.sRGB,
			red: Double(hex >> 16 & 255) / 255,
			green: Double(hex >> 8 & 255) / 255,
			blue: Double(hex & 255) / 255
		)
	}
}

struct HorizontalRule: View {
	var color = Theme.border

	var body: some View {
		color.frame(height: 1)
	}
}

struct VerticalRule: View {
	var body: some View {
		Theme.border.frame(width: 1)
	}
}

/// A sprite grid with one lit cell, the mark of the product.
struct SpriteMark: View {
	var size: CGFloat = 16

	var body: some View {
		Canvas { context, canvas in
			let gap = canvas.width / 8
			let cell = (canvas.width - gap * 2) / 3
			for row in 0 ..< 3 {
				for column in 0 ..< 3 {
					let rect = CGRect(
						x: CGFloat(column) * (cell + gap),
						y: CGFloat(row) * (cell + gap),
						width: cell,
						height: cell
					)
					let isLit = row == 1 && column == 2
					context.fill(Path(rect), with: .color(isLit ? Theme.accent : Theme.control))
				}
			}
		}
		.frame(width: size, height: size)
		.accessibilityHidden(true)
	}
}

/// Replaces the system ring with a 1px neutral outline, in keyboard navigation only.
struct QuietFocus: ViewModifier {
	var radius = Theme.cardRadius
	var inset: CGFloat = 0
	@FocusState private var isFocused: Bool

	func body(content: Content) -> some View {
		content
			.focusable(interactions: .activate)
			.focusEffectDisabled()
			.focused($isFocused)
			.overlay {
				if isFocused {
					RoundedRectangle(cornerRadius: radius)
						.strokeBorder(Theme.muted, lineWidth: 1)
						.padding(.vertical, inset)
						.allowsHitTesting(false)
				}
			}
	}
}

extension View {
	func quietFocus(radius: CGFloat = Theme.cardRadius, inset: CGFloat = 0) -> some View {
		modifier(QuietFocus(radius: radius, inset: inset))
	}
}

enum ControlKind {
	case text
	case icon
	case outline
}

/// Hover brightens, focus draws a neutral outline, and disabled stays legible.
struct ControlStyle: ButtonStyle {
	var kind = ControlKind.outline

	func makeBody(configuration: Configuration) -> some View {
		ControlBody(configuration: configuration, kind: kind)
	}

	private struct ControlBody: View {
		let configuration: Configuration
		let kind: ControlKind
		@Environment(\.isEnabled) private var isEnabled
		@State private var isHovered = false

		var body: some View {
			configuration.label
				.font(Theme.body)
				.foregroundStyle(foreground)
				.padding(.horizontal, kind == .icon ? 0 : Theme.unit * 1.5)
				.frame(minWidth: kind == .icon ? Theme.controlHeight : nil, minHeight: Theme.controlHeight)
				.background(fill, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
				.overlay {
					RoundedRectangle(cornerRadius: Theme.cardRadius)
						.strokeBorder(outline, lineWidth: 1)
				}
				.contentShape(Rectangle())
				.onHover { isHovered = $0 }
		}

		private var foreground: Color {
			guard isEnabled else {
				return Theme.muted.opacity(0.55)
			}

			return kind == .outline || isHovered ? Theme.text : Theme.muted
		}

		private var fill: Color {
			guard isEnabled else {
				return .clear
			}

			return configuration.isPressed || isHovered ? Theme.raised : .clear
		}

		private var outline: Color {
			kind == .outline && isEnabled ? Theme.control : .clear
		}
	}
}

/// The one way of showing a selection: A 1px accent line as wide as the label, on the edge of its row.
struct LineChoiceStyle: ButtonStyle {
	let isOn: Bool
	var height = Theme.rowHeight

	func makeBody(configuration: Configuration) -> some View {
		LineBody(configuration: configuration, isOn: isOn, height: height)
	}

	private struct LineBody: View {
		let configuration: Configuration
		let isOn: Bool
		let height: CGFloat
		@Environment(\.isEnabled) private var isEnabled
		@State private var isHovered = false

		var body: some View {
			configuration.label
				.foregroundStyle(foreground)
				.frame(height: height)
				.overlay(alignment: .bottom) {
					if isOn, isEnabled {
						Theme.accent.frame(height: 1)
					}
				}
				.padding(.horizontal, Theme.unit * 0.75)
				.contentShape(Rectangle())
				.onHover { isHovered = $0 }
		}

		private var foreground: Color {
			guard isEnabled else {
				return Theme.muted.opacity(0.55)
			}

			return isOn || isHovered || configuration.isPressed ? Theme.text : Theme.muted
		}
	}
}

struct LineChoice: View {
	let label: String
	var isFigure = false
	let isOn: Bool
	var height = Theme.rowHeight
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			Text(label).font(isFigure ? Theme.smallFigure : Theme.small)
		}
		.buttonStyle(LineChoiceStyle(isOn: isOn, height: height))
		.quietFocus(radius: 4, inset: 4)
		.accessibilityAddTraits(isOn ? .isSelected : [])
	}
}

/// Names a row of choices, and dims with them.
struct RowLabel: View {
	let text: String
	@Environment(\.isEnabled) private var isEnabled

	init(_ text: String) {
		self.text = text
	}

	var body: some View {
		Text(text)
			.font(Theme.small)
			.foregroundStyle(isEnabled ? Theme.muted : Theme.muted.opacity(0.55))
	}
}

/// Stands in for a value that is on its way, at the size of that value.
struct ValueBar: View {
	var width: CGFloat = 48
	var height: CGFloat = 13

	var body: some View {
		Theme.raised.frame(width: width, height: height)
	}
}
