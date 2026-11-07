import SwiftUI
import Wanim

struct KeyPrompt: View {
	let model: DocumentModel
	@State private var text = ""
	@FocusState private var isFieldFocused: Bool

	private var digits: String {
		text.filter { !$0.isWhitespace }
	}

	private var isComplete: Bool {
		WanimAnimation.key(hex: digits) != nil
	}

	private var hasForeignCharacters: Bool {
		digits.contains { !$0.isHexDigit }
	}

	var body: some View {
		VStack(alignment: .leading, spacing: Theme.unit) {
			Text("This file has its own key")
				.font(Theme.title)
				.foregroundStyle(Theme.text)
			Text("Enter the 64 hexadecimal characters of its key. The key stays in memory and is gone when this window closes.")
				.font(Theme.body)
				.foregroundStyle(Theme.muted)
				.fixedSize(horizontal: false, vertical: true)

			HStack {
				Text("Key")
					.font(Theme.small)
					.foregroundStyle(Theme.text)
				Spacer()
				Text(verbatim: "\(digits.count) / 64")
					.font(Theme.smallFigure)
					.foregroundStyle(Theme.muted)
					.accessibilityLabel("\(digits.count) of 64 characters")
			}
			.padding(.top, Theme.unit)

			TextField("", text: $text, axis: .vertical)
				.textFieldStyle(.plain)
				.font(Theme.bodyFigure)
				.foregroundStyle(Theme.text)
				.lineLimit(2, reservesSpace: true)
				.focused($isFieldFocused)
				.autocorrectionDisabled()
				.padding(Theme.unit)
				.background(Theme.ground, in: RoundedRectangle(cornerRadius: Theme.cardRadius))
				.overlay {
					RoundedRectangle(cornerRadius: Theme.cardRadius)
						.strokeBorder(isFieldFocused ? Theme.muted : Theme.control, lineWidth: 1)
				}
				.accessibilityLabel("Key, 64 hexadecimal characters")
				.onSubmit(submit)

			Text(message ?? " ")
				.font(Theme.small)
				.foregroundStyle(messageColor)

			HStack(spacing: Theme.unit) {
				Spacer()
				Button("Cancel") {
					model.isKeyPromptShown = false
				}
				.buttonStyle(ControlStyle())
				.quietFocus()
				.keyboardShortcut(.cancelAction)
				Button("Open") {
					submit()
				}
				.buttonStyle(ControlStyle())
				.quietFocus()
				.keyboardShortcut(.defaultAction)
				.disabled(!isComplete || model.isCheckingKey)
			}
		}
		.padding(Theme.unit * 3)
		.frame(width: 560)
		.background(Theme.surface)
		.presentationBackground(Theme.surface)
		.preferredColorScheme(.dark)
		.onAppear {
			isFieldFocused = true
		}
		.onChange(of: text) {
			model.keyPromptError = nil
		}
	}

	private var message: String? {
		if hasForeignCharacters {
			return "A key has only the characters 0-9 and a-f."
		}

		return model.keyPromptError
	}

	private var messageColor: Color {
		hasForeignCharacters ? Theme.warning : Theme.negative
	}

	private func submit() {
		guard isComplete else {
			return
		}

		Task {
			await model.submitKey(digits)
		}
	}
}
