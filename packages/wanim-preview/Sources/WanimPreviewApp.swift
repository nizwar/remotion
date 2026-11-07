import AppKit
import SwiftUI

@main
struct WanimPreviewApp: App {
	@NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

	var body: some Scene {
		WindowGroup(id: Scenes.document, for: URL.self) { $url in
			DocumentWindow(url: $url)
		}
		.defaultSize(width: 1280, height: 800)
		.windowResizability(.contentMinSize)
		.windowStyle(.hiddenTitleBar)
		.commands {
			AppCommands()
		}
	}
}

final class AppDelegate: NSObject, NSApplicationDelegate {
	func application(_: NSApplication, open urls: [URL]) {
		MainActor.assumeIsolated {
			WindowRouter.shared.open(urls)
		}
	}

	func applicationDidFinishLaunching(_: Notification) {
		NSApp.appearance = NSAppearance(named: .darkAqua)
	}
}

extension FocusedValues {
	@Entry var document: DocumentModel?
}

struct AppCommands: Commands {
	@FocusedValue(\.document) private var model

	var body: some Commands {
		CommandGroup(replacing: .newItem) {
			FileItems(model: model)
		}
		CommandGroup(before: .toolbar) {
			ViewItems(model: model)
			Divider()
		}
		CommandMenu("Playback") {
			PlaybackItems(model: model)
		}
	}
}

private struct FileItems: View {
	let model: DocumentModel?
	@Environment(\.openWindow) private var openWindow

	var body: some View {
		Button("New Window") {
			openWindow(id: Scenes.document)
		}
		.keyboardShortcut("n")

		Button("Open…") {
			WindowRouter.shared.chooseFiles()
		}
		.keyboardShortcut("o")

		Menu("Open Recent") {
			ForEach(RecentFiles.shared.existing, id: \.self) { url in
				Button(url.lastPathComponent) {
					WindowRouter.shared.open([url])
				}
			}
			Divider()
			Button("Clear Menu") {
				RecentFiles.shared.clear()
			}
			.disabled(RecentFiles.shared.urls.isEmpty)
		}

		Divider()

		Button("Export Frame as PNG…") {
			model?.exportFrame()
		}
		.keyboardShortcut("e")
		.disabled(model?.acceptsPlaybackCommands != true)
	}
}

private struct ViewItems: View {
	let model: DocumentModel?

	var body: some View {
		let isDisabled = model?.session == nil
		Button("Zoom to Fit") {
			model?.stage.zoom = .fit
		}
		.keyboardShortcut("1")
		.disabled(isDisabled)

		Button("Zoom 1x") {
			model?.stage.zoom = .one
		}
		.keyboardShortcut("2")
		.disabled(isDisabled)

		Button("Zoom 2x") {
			model?.stage.zoom = .two
		}
		.keyboardShortcut("3")
		.disabled(isDisabled)

		Button("Zoom 4x") {
			model?.stage.zoom = .four
		}
		.keyboardShortcut("4")
		.disabled(isDisabled)

		Toggle("Nearest Neighbour", isOn: Binding(
			get: { model?.stage.isNearest ?? false },
			set: { model?.stage.isNearest = $0 }
		))
		.keyboardShortcut("n", modifiers: [.command, .option])
		.disabled(isDisabled)

		Menu("Background") {
			ForEach(StageBackground.allCases) { background in
				Toggle(background.rawValue, isOn: Binding(
					get: { model?.stage.background == background },
					set: { _ in model?.stage.background = background }
				))
			}
		}
		.disabled(isDisabled)
	}
}

private struct PlaybackItems: View {
	let model: DocumentModel?

	var body: some View {
		let session = model?.acceptsPlaybackCommands == true ? model?.session : nil
		let isDisabled = session == nil
		Button(session?.isPlaying == true ? "Pause" : "Play") {
			session?.togglePlaying()
		}
		.keyboardShortcut(.space, modifiers: [])
		.disabled(isDisabled)

		Divider()

		Button("Step Back") {
			session?.step(by: -1)
		}
		.keyboardShortcut(.leftArrow, modifiers: [])
		.disabled(isDisabled)

		Button("Step Forward") {
			session?.step(by: 1)
		}
		.keyboardShortcut(.rightArrow, modifiers: [])
		.disabled(isDisabled)

		Button("Back 10 Frames") {
			session?.step(by: -10)
		}
		.keyboardShortcut(.leftArrow, modifiers: .shift)
		.disabled(isDisabled)

		Button("Forward 10 Frames") {
			session?.step(by: 10)
		}
		.keyboardShortcut(.rightArrow, modifiers: .shift)
		.disabled(isDisabled)

		Button("First Frame") {
			session?.seek(to: 0)
		}
		.keyboardShortcut(.home, modifiers: [])
		.disabled(isDisabled)

		Button("Last Frame") {
			if let session {
				session.seek(to: session.manifest.frameCount - 1)
			}
		}
		.keyboardShortcut(.end, modifiers: [])
		.disabled(isDisabled)

		Divider()

		Toggle("Loop", isOn: Binding(
			get: { session?.isLooping ?? true },
			set: { _ in session?.toggleLooping() }
		))
		.keyboardShortcut("l", modifiers: [])
		.disabled(isDisabled)

		Menu("Speed") {
			ForEach(Transport.speeds, id: \.self) { speed in
				Toggle("\(Format.number(speed))x", isOn: Binding(
					get: { session?.speed == speed },
					set: { _ in session?.setSpeed(speed) }
				))
			}
		}
		.disabled(isDisabled)
	}
}
