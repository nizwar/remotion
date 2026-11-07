import AppKit
import SwiftUI
import Wanim

struct DocumentWindow: View {
	@Binding var url: URL?
	@State private var model = DocumentModel()
	@State private var isDropTargeted = false
	@Environment(\.openWindow) private var openWindow

	var body: some View {
		VStack(spacing: 0) {
			TopBar(model: model)
			HorizontalRule()
			HStack(spacing: 0) {
				VStack(spacing: 0) {
					StageBar(session: model.session, stage: model.stage)
					HorizontalRule()
					StageArea(model: model)
						.overlay {
							if isDropTargeted {
								Rectangle().strokeBorder(Theme.accent, lineWidth: 1)
							}
						}
				}
				VerticalRule()
				Inspector(model: model)
					.frame(width: 300)
			}
			HorizontalRule()
			Transport(session: model.session)
			HorizontalRule(color: Theme.rule)
			FrameMap(model: model)
		}
		.background(Theme.ground)
		.ignoresSafeArea(.container, edges: .top)
		.frame(minWidth: 960, minHeight: 620)
		.preferredColorScheme(.dark)
		.background(WindowConfigurator(onClose: model.windowWillClose))
		.navigationTitle(model.url?.lastPathComponent ?? "Wanim Preview")
		.focusedSceneValue(\.document, model)
		.task(id: url) {
			await model.load(url)
		}
		.onAppear {
			model.showURL = { url = $0 }
			WindowRouter.shared.register(model, openWindow: openWindow)
		}
		// Without this, SwiftUI creates a blank window for each file opened from the Finder
		.handlesExternalEvents(preferring: ["*"], allowing: ["*"])
		.dropDestination(for: URL.self) { urls, _ in
			guard let first = urls.first else {
				return false
			}

			url = first
			WindowRouter.shared.open(Array(urls.dropFirst()))
			return true
		} isTargeted: {
			isDropTargeted = $0
		}
		.sheet(isPresented: $model.isKeyPromptShown, onDismiss: model.keyPromptDidClose) {
			KeyPrompt(model: model)
		}
	}
}

/// Makes the title bar part of the top bar, so that the window controls sit centered in it.
private struct WindowConfigurator: NSViewRepresentable {
	let onClose: () -> Void

	final class Probe: NSView {
		var onClose: (() -> Void)?

		override func viewDidMoveToWindow() {
			super.viewDidMoveToWindow()
			guard let window else {
				return
			}

			window.titlebarAppearsTransparent = true
			window.titleVisibility = .hidden
			window.backgroundColor = NSColor(Theme.ground)
			if window.toolbar == nil {
				window.toolbar = NSToolbar(identifier: "stage")
				window.toolbarStyle = .unifiedCompact
			}

			NotificationCenter.default.addObserver(
				self,
				selector: #selector(windowWillClose),
				name: NSWindow.willCloseNotification,
				object: window
			)
		}

		@objc private func windowWillClose() {
			onClose?()
		}
	}

	func makeNSView(context _: Context) -> Probe {
		let probe = Probe()
		probe.onClose = onClose
		return probe
	}

	func updateNSView(_: Probe, context _: Context) {}
}

struct TopBar: View {
	let model: DocumentModel

	var body: some View {
		HStack(spacing: Theme.unit * 1.5) {
			SpriteMark()
			Text(name)
				.font(Theme.title)
				.foregroundStyle(Theme.text)
				.lineLimit(1)
				.truncationMode(.middle)
			status
				.layoutPriority(1)
			Spacer(minLength: Theme.unit)
			Button("Open") {
				WindowRouter.shared.chooseFiles()
			}
			.buttonStyle(ControlStyle())
			.quietFocus()
			.help("Open a .wanim file")
			Button("Export frame as PNG") {
				model.exportFrame()
			}
			.buttonStyle(ControlStyle())
			.quietFocus()
			.disabled(model.session?.isReady != true)
			.help(model.session?.isReady == true ? "Save the current frame at canvas size" : "Open a file to export a frame")
		}
		.padding(.leading, 84)
		.padding(.trailing, Theme.unit * 1.5)
		.frame(height: 48)
		.background(Theme.ground)
	}

	private var name: String {
		model.url?.lastPathComponent ?? "Wanim Preview"
	}

	@ViewBuilder
	private var status: some View {
		switch model.phase {
		case .empty:
			Text("No file open").font(Theme.body).foregroundStyle(Theme.muted)
		case .opening:
			Text("Opening").font(Theme.body).foregroundStyle(Theme.muted)
		case .needsKey:
			Text("Needs its own key").font(Theme.body).foregroundStyle(Theme.warning)
		case .failed:
			Text("Not opened").font(Theme.body).foregroundStyle(Theme.muted)
		case let .open(session):
			SessionStatus(session: session)
		}
	}
}

private struct SessionStatus: View {
	let session: Session

	var body: some View {
		let verdict = Text(session.budgetLine)
			.font(Theme.body)
			.foregroundStyle(session.animation.preloads ? Theme.positive : Theme.warning)
			.lineLimit(1)
			.fixedSize()
		let detail = [
			session.animation.usesCustomKey ? "Custom key" : "Official key",
			session.isOpaque ? "Opaque" : "Transparent",
		].joined(separator: " · ")
		ViewThatFits(in: .horizontal) {
			HStack(spacing: Theme.unit * 1.5) {
				verdict
				Text(session.notice ?? detail)
					.font(Theme.body)
					.foregroundStyle(Theme.muted)
					.lineLimit(1)
					.fixedSize()
			}
			verdict
		}
	}
}

/// The centre of the window, in whichever state the file is.
struct StageArea: View {
	let model: DocumentModel

	var body: some View {
		switch model.phase {
		case .empty:
			EmptyStage()
		case let .opening(url):
			StageMessage(title: "Opening \(url.lastPathComponent)", detail: "Reading the manifest.", kind: .progress)
		case let .needsKey(url):
			StageMessage(
				title: "This file has its own key",
				detail: "\(url.lastPathComponent) was not packed with the official key.",
				kind: .notice
			) {
				Button("Enter key") {
					model.promptForKey()
				}
				.buttonStyle(ControlStyle())
				.quietFocus()
				OpenAnotherButton()
			}
		case let .failed(url, problem):
			StageMessage(title: problem.title, detail: problem.detail, path: url.path, kind: .failure) {
				if problem.canEnterKey {
					Button("Enter key") {
						model.promptForKey()
					}
					.buttonStyle(ControlStyle())
					.quietFocus()
				}
				OpenAnotherButton()
			}
		case let .open(session):
			Stage(session: session, stage: model.stage)
				.id(ObjectIdentifier(session))
		}
	}
}

private struct OpenAnotherButton: View {
	var body: some View {
		Button("Open another file") {
			WindowRouter.shared.chooseFiles()
		}
		.buttonStyle(ControlStyle())
		.quietFocus()
	}
}

struct StageMessage<Actions: View>: View {
	enum Kind {
		case progress
		case notice
		case failure
	}

	let title: String
	let detail: String
	var path: String?
	let kind: Kind
	@ViewBuilder var actions: Actions

	var body: some View {
		VStack(alignment: .leading, spacing: Theme.unit) {
			HStack(spacing: Theme.unit) {
				if kind == .failure {
					Image(systemName: "exclamationmark.triangle")
						.font(.system(size: 14))
						.foregroundStyle(Theme.negative)
						.accessibilityHidden(true)
				}

				Text(title)
					.font(Theme.title)
					.foregroundStyle(Theme.text)
			}
			Text(detail)
				.font(Theme.body)
				.foregroundStyle(Theme.muted)
				.fixedSize(horizontal: false, vertical: true)
			if let path {
				Text(path)
					.font(Theme.smallFigure)
					.foregroundStyle(Theme.muted)
					.lineLimit(1)
					.truncationMode(.middle)
			}
			HStack(spacing: Theme.unit) {
				actions
			}
			.padding(.top, Theme.unit)
		}
		.frame(maxWidth: 440, alignment: .leading)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.ground)
		.accessibilityElement(children: .contain)
	}
}

extension StageMessage where Actions == EmptyView {
	init(title: String, detail: String, kind: Kind) {
		self.init(title: title, detail: detail, path: nil, kind: kind) {
			EmptyView()
		}
	}
}

/// The first action sits where the animation will appear.
private struct EmptyStage: View {
	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			SpriteMark(size: 40)
				.padding(.bottom, Theme.unit * 2)
			Text("Open a .wanim file")
				.font(Theme.title)
				.foregroundStyle(Theme.text)
			Text("Or drop one anywhere in this window.")
				.font(Theme.body)
				.foregroundStyle(Theme.muted)
				.padding(.top, Theme.unit / 2)
			Button("Open") {
				WindowRouter.shared.chooseFiles()
			}
			.buttonStyle(ControlStyle())
			.quietFocus()
			.padding(.top, Theme.unit * 2)

			let recent = Array(RecentFiles.shared.existing.prefix(5))
			if !recent.isEmpty {
				Text("Recent files")
					.font(Theme.small)
					.foregroundStyle(Theme.muted)
					.padding(.top, Theme.unit * 4)
					.padding(.bottom, Theme.unit / 2)
				HorizontalRule()
				ForEach(recent, id: \.self) { url in
					RecentRow(url: url)
					HorizontalRule(color: Theme.rule)
				}
			}
		}
		.frame(width: 440, alignment: .leading)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.ground)
	}
}

private struct RecentRow: View {
	let url: URL
	@State private var isHovered = false

	var body: some View {
		Button {
			WindowRouter.shared.open([url])
		} label: {
			HStack(spacing: Theme.unit) {
				Text(url.lastPathComponent)
					.font(Theme.body)
					.foregroundStyle(Theme.text)
					.lineLimit(1)
					.truncationMode(.middle)
					.layoutPriority(1)
				Text(folder)
					.font(Theme.small)
					.foregroundStyle(Theme.muted)
					.lineLimit(1)
					.truncationMode(.head)
				Spacer(minLength: Theme.unit)
				Text(size)
					.font(Theme.smallFigure)
					.foregroundStyle(Theme.muted)
					.fixedSize()
			}
			.frame(height: Theme.rowHeight)
			.padding(.horizontal, Theme.unit)
			.background(isHovered ? Theme.raised : .clear)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.padding(.horizontal, -Theme.unit)
		.onHover { isHovered = $0 }
		.accessibilityLabel("Open \(url.lastPathComponent)")
	}

	private var folder: String {
		let path = url.deletingLastPathComponent().path
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
	}

	private var size: String {
		let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
		return bytes.map(Format.bytes) ?? "—"
	}
}
