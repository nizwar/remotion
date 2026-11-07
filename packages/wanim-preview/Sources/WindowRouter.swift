import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

extension UTType {
	static let wanim = UTType(exportedAs: "dev.remotion.wanim")
}

@MainActor
@Observable
final class RecentFiles {
	static let shared = RecentFiles()
	private static let key = "recentFiles"
	private static let limit = 8

	private(set) var urls: [URL]

	private init() {
		let paths = UserDefaults.standard.stringArray(forKey: Self.key) ?? []
		urls = paths.map { URL(fileURLWithPath: $0) }
	}

	var existing: [URL] {
		urls.filter { FileManager.default.fileExists(atPath: $0.path) }
	}

	func add(_ url: URL) {
		urls.removeAll { $0.path == url.path }
		urls.insert(url, at: 0)
		urls = Array(urls.prefix(Self.limit))
		save()
		NSDocumentController.shared.noteNewRecentDocumentURL(url)
	}

	func clear() {
		urls = []
		save()
		NSDocumentController.shared.clearRecentDocuments(nil)
	}

	private func save() {
		UserDefaults.standard.set(urls.map(\.path), forKey: Self.key)
	}
}

/// Decides which window shows a file: The empty one if there is one, otherwise a new one.
@MainActor
final class WindowRouter {
	static let shared = WindowRouter()

	private let models = NSHashTable<DocumentModel>.weakObjects()
	private var openWindow: OpenWindowAction?
	private var waiting: [URL] = []

	func register(_ model: DocumentModel, openWindow: OpenWindowAction) {
		models.add(model)
		self.openWindow = openWindow
		let urls = waiting
		waiting = []
		open(urls)
	}

	func open(_ urls: [URL]) {
		for url in urls {
			if let empty = models.allObjects.first(where: { $0.isEmpty && $0.showURL != nil }) {
				empty.showURL?(url)
				// Claimed at once, so that the next file of this batch goes elsewhere
				empty.showURL = nil
			} else if let openWindow {
				openWindow(id: Scenes.document, value: url)
			} else {
				waiting.append(url)
			}
		}
	}

	func chooseFiles() {
		let panel = NSOpenPanel()
		panel.allowedContentTypes = [.wanim]
		panel.allowsMultipleSelection = true
		if panel.runModal() == .OK {
			open(panel.urls)
		}
	}
}

enum Scenes {
	static let document = "document"
}
