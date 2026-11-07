import AppKit
import CryptoKit
import Observation
import UniformTypeIdentifiers
import Wanim

struct OpenProblem {
	let title: String
	let detail: String
	/// A wrong key can be corrected, a damaged file cannot.
	var canEnterKey = false
}

enum StageBackground: String, CaseIterable, Identifiable {
	case checker = "Checker"
	case black = "Black"
	case white = "White"

	var id: Self {
		self
	}
}

enum StageZoom: Hashable, CaseIterable, Identifiable {
	case fit
	case one
	case two
	case four

	var id: Self {
		self
	}

	var label: String {
		switch self {
		case .fit: "Fit"
		case .one: "1x"
		case .two: "2x"
		case .four: "4x"
		}
	}

	var scale: Double? {
		switch self {
		case .fit: nil
		case .one: 1
		case .two: 2
		case .four: 4
		}
	}
}

@MainActor
@Observable
final class StageSettings {
	var background = StageBackground.checker
	var zoom = StageZoom.fit {
		didSet { pan = .zero }
	}

	var isNearest = false
	/// In drawable pixels.
	var pan = CGPoint.zero
	var fitScale = 1.0

	var scale: Double {
		zoom.scale ?? fitScale
	}
}

@MainActor
@Observable
final class DocumentModel {
	enum Phase {
		case empty
		case opening(URL)
		case needsKey(URL)
		case failed(URL, OpenProblem)
		case open(Session)
	}

	private(set) var phase = Phase.empty
	let stage = StageSettings()

	var isKeyPromptShown = false
	var keyPromptError: String?
	private(set) var isCheckingKey = false
	private(set) var isSavePanelShown = false

	/// Writes to the URL of the scene, which is what reopens after a relaunch.
	@ObservationIgnored var showURL: ((URL) -> Void)?
	@ObservationIgnored private var loadedURL: URL?

	var session: Session? {
		if case let .open(session) = phase {
			return session
		}

		return nil
	}

	var url: URL? {
		switch phase {
		case .empty: nil
		case let .opening(url), let .needsKey(url), let .failed(url, _): url
		case let .open(session): session.url
		}
	}

	var isEmpty: Bool {
		if case .empty = phase {
			return true
		}

		return false
	}

	/// Commands that take plain keys must not swallow typing in a sheet or a panel.
	var acceptsPlaybackCommands: Bool {
		session?.isReady == true && !isKeyPromptShown && !isSavePanelShown
	}

	/// SwiftUI may keep the state of a closed window for a while, but not its textures.
	func windowWillClose() {
		showURL = nil
		loadedURL = nil
		phase = .empty
	}

	func load(_ url: URL?) async {
		guard url != loadedURL else {
			return
		}

		loadedURL = url
		guard let url else {
			phase = .empty
			return
		}

		phase = .opening(url)
		do {
			try await open(url, key: nil)
		} catch WanimError.missingCustomKey {
			phase = .needsKey(url)
			keyPromptError = nil
			isKeyPromptShown = true
		} catch {
			guard url == loadedURL else {
				return
			}

			phase = .failed(url, problem(for: error, withKey: false))
		}
	}

	private func open(_ url: URL, key: SymmetricKey?) async throws {
		let animation = try await WanimAnimation(contentsOf: url, key: key)
		guard url == loadedURL else {
			return
		}

		let session = Session(url: url, animation: animation)
		session.onFailure = { [weak self] error in
			self?.phase = .failed(url, self?.problem(for: error, withKey: key != nil) ?? OpenProblem(title: "", detail: ""))
		}
		stage.pan = .zero
		phase = .open(session)
		RecentFiles.shared.add(url)
	}

	func submitKey(_ hex: String) async {
		guard let url, let key = WanimAnimation.key(hex: hex) else {
			return
		}

		isCheckingKey = true
		defer { isCheckingKey = false }
		do {
			try await open(url, key: key)
			isKeyPromptShown = false
			keyPromptError = nil
		} catch WanimError.wrongKeyOrTampered {
			keyPromptError = "This key does not open the file."
		} catch {
			isKeyPromptShown = false
			phase = .failed(url, problem(for: error, withKey: true))
		}
	}

	/// The sheet also closes by itself on Escape, so this is not tied to the Cancel button.
	func keyPromptDidClose() {
		if let url, keyPromptError != nil {
			phase = .failed(url, problem(for: WanimError.wrongKeyOrTampered, withKey: true))
		}
		keyPromptError = nil
	}

	func promptForKey() {
		guard let url else {
			return
		}

		phase = .needsKey(url)
		keyPromptError = nil
		isKeyPromptShown = true
	}

	private func problem(for error: Error, withKey: Bool) -> OpenProblem {
		switch error as? WanimError {
		case let .invalidFile(reason):
			let sentence = reason.prefix(1).uppercased() + reason.dropFirst()
			return OpenProblem(title: "This is not a valid .wanim file", detail: "\(sentence).")
		case let .unsupportedVersion(version):
			return OpenProblem(
				title: "This file uses format version \(version)",
				detail: "Wanim Preview reads version 1. Open it with a newer player."
			)
		case let .unsupportedFlags(flags):
			return OpenProblem(
				title: "This file uses unknown flags",
				detail: "Flags \(flags) are not part of format version 1."
			)
		case .wrongKeyOrTampered:
			return withKey
				? OpenProblem(
					title: "This key does not open the file",
					detail: "The key is wrong, or the file was modified after it was packed.",
					canEnterKey: true
				)
				: OpenProblem(
					title: "This file was modified",
					detail: "Its contents no longer match what was packed."
				)
		case .metalUnavailable:
			return OpenProblem(title: "Metal is not available", detail: "This Mac cannot draw the animation.")
		case let .atlasTooLarge(size):
			return OpenProblem(title: "An atlas is too large", detail: "This GPU cannot hold \(size) pixels.")
		case let .atlasDecodingFailed(index):
			return OpenProblem(title: "Atlas \(index + 1) cannot be decoded", detail: "It is not a readable PNG.")
		default:
			return OpenProblem(title: "This file cannot be read", detail: error.localizedDescription)
		}
	}

	func exportFrame() {
		guard let session, let window = NSApp.keyWindow else {
			return
		}

		let frame = session.playhead.frame
		let panel = NSSavePanel()
		panel.allowedContentTypes = [.png]
		panel.canCreateDirectories = true
		panel.nameFieldStringValue = "\(session.url.deletingPathExtension().lastPathComponent)-frame-\(frame).png"
		isSavePanelShown = true
		panel.beginSheetModal(for: window) { [weak self] response in
			MainActor.assumeIsolated {
				self?.isSavePanelShown = false
				guard response == .OK, let target = panel.url else {
					return
				}

				Task { @MainActor in
					do {
						try await session.exportPNG(frame: frame, to: target)
						session.notice = "Saved frame \(frame)"
					} catch {
						session.notice = "Could not save frame \(frame)"
					}

					try? await Task.sleep(for: .seconds(4))
					session.notice = nil
				}
			}
		}
	}
}
