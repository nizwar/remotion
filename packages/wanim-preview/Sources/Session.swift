import CoreGraphics
import Foundation
import ImageIO
import Observation
import Wanim

enum Format {
	static func bytes(_ count: Int) -> String {
		if count >= 1024 * 1024 {
			let megabytes = Double(count) / 1024 / 1024
			return megabytes >= 100 && megabytes == megabytes.rounded()
				? String(format: "%.0f MB", megabytes)
				: String(format: "%.1f MB", megabytes)
		}

		if count >= 1024 {
			return String(format: "%.1f KB", Double(count) / 1024)
		}

		return "\(count) B"
	}

	static func time(_ seconds: Double) -> String {
		let hundredths = Int((seconds * 100).rounded(.down))
		return String(format: "%02d:%02d.%02d", hundredths / 6000, hundredths / 100 % 60, hundredths % 100)
	}

	static func number(_ value: Double) -> String {
		value == value.rounded() ? String(format: "%.0f", value) : String(format: "%g", value)
	}
}

/// A run of frames that show the same picture. `sprite` is -1 for an empty run.
struct FrameRun: Equatable, Sendable {
	let start: Int
	var count: Int
	let sprite: Int
	let atlas: Int

	var isEmpty: Bool {
		sprite < 0
	}
}

/// What the file says about itself, computed once.
struct FileFacts: Sendable {
	let runs: [FrameRun]
	let runOfFrame: [Int32]
	let uniqueRectangles: Int
	let heldFrames: Int
	let emptyFrames: Int

	init(manifest: WanimManifest) {
		var runs: [FrameRun] = []
		var runOfFrame: [Int32] = []
		runOfFrame.reserveCapacity(manifest.frames.count)
		for (frame, sprite) in manifest.frames.enumerated() {
			let isSamePicture = runs.last.map { last in
				if last.sprite == sprite {
					return true
				}

				return last.sprite >= 0 && sprite >= 0 && manifest.sprites[last.sprite] == manifest.sprites[sprite]
			} ?? false

			if isSamePicture {
				runs[runs.count - 1].count += 1
			} else {
				let atlas = sprite >= 0 ? manifest.sprites[sprite].atlas : -1
				runs.append(FrameRun(start: frame, count: 1, sprite: sprite, atlas: atlas))
			}

			runOfFrame.append(Int32(runs.count - 1))
		}

		struct Rectangle: Hashable {
			let atlas, x, y, width, height: Int
		}

		self.runs = runs
		self.runOfFrame = runOfFrame
		uniqueRectangles = Set(manifest.sprites.map {
			Rectangle(atlas: $0.atlas, x: $0.x, y: $0.y, width: $0.width, height: $0.height)
		}).count
		heldFrames = runs.reduce(0) { $0 + ($1.isEmpty ? 0 : $1.count - 1) }
		emptyFrames = manifest.frames.filter { $0 < 0 }.count
	}
}

/// Read only by the views that follow playback, so that nothing else redraws per frame.
@MainActor
@Observable
final class Playhead {
	private(set) var frame = 0
	private(set) var atlas = 0

	func move(to frame: Int, atlas: Int?) {
		self.frame = frame
		if let atlas, atlas != self.atlas {
			self.atlas = atlas
		}
	}
}

@MainActor
@Observable
final class Session {
	let url: URL
	let animation: WanimAnimation
	let facts: FileFacts
	let playhead = Playhead()

	private(set) var isReady = false
	private(set) var isPlaying = false
	private(set) var isLooping = true
	private(set) var speed = 1.0
	/// Keeps the atlas viewer on one page. If `nil`, it follows the frame.
	var pinnedAtlas: Int?
	var notice: String?

	private(set) var atlasImages: [Int: CGImage] = [:]
	private(set) var atlasFailures: Set<Int> = []

	@ObservationIgnored private weak var view: WanimView?
	@ObservationIgnored private var isScrubbing = false
	@ObservationIgnored private var resumesAfterScrub = false
	@ObservationIgnored private var imageOrder: [Int] = []
	@ObservationIgnored private var loadingImages: Set<Int> = []
	@ObservationIgnored var onFailure: ((Error) -> Void)?

	init(url: URL, animation: WanimAnimation) {
		self.url = url
		self.animation = animation
		facts = FileFacts(manifest: animation.manifest)
		playhead.move(to: 0, atlas: firstAtlas)
	}

	var manifest: WanimManifest {
		animation.manifest
	}

	private var firstAtlas: Int? {
		facts.runs.first { !$0.isEmpty }?.atlas
	}

	var isOpaque: Bool {
		manifest.opaque
	}

	var budgetLine: String {
		let budget = Format.bytes(WanimAnimation.defaultGPUBudget)
		let used = Format.bytes(manifest.gpuBytes)
		return animation.preloads
			? "Preloads: \(used) of the \(budget) budget"
			: "Streams: \(used) exceeds the \(budget) budget"
	}

	func attach(_ view: WanimView) {
		self.view = view
		view.loop = isLooping
		view.speed = speed
		view.onFrameChange = { [weak self] frame in
			self?.frameDidChange(frame)
		}
		view.onFinished = { [weak self] in
			self?.isPlaying = false
		}
		view.onError = { [weak self] error in
			self?.isPlaying = false
			self?.onFailure?(error)
		}
		view.onReady = { [weak self, weak view] in
			self?.isReady = true
			self?.isPlaying = true
			view?.play()
		}
	}

	private func frameDidChange(_ frame: Int) {
		let sprite = manifest.frames[frame]
		playhead.move(to: frame, atlas: sprite >= 0 ? manifest.sprites[sprite].atlas : nil)
	}

	func togglePlaying() {
		guard let view, isReady else {
			return
		}

		if view.isPlaying {
			view.pause()
		} else {
			view.play()
		}

		isPlaying = view.isPlaying
	}

	func step(by frames: Int) {
		seek(to: playhead.frame + frames)
	}

	/// Moves to a frame and stays there.
	func seek(to frame: Int) {
		guard let view, isReady else {
			return
		}

		view.pause()
		isPlaying = false
		view.seek(toFrame: frame)
	}

	func beginScrub() {
		guard !isScrubbing else {
			return
		}

		isScrubbing = true
		resumesAfterScrub = isPlaying
	}

	func endScrub() {
		isScrubbing = false
		if resumesAfterScrub {
			resumesAfterScrub = false
			view?.play()
			isPlaying = view?.isPlaying ?? false
		}
	}

	func toggleLooping() {
		isLooping.toggle()
		view?.loop = isLooping
	}

	func setSpeed(_ speed: Double) {
		self.speed = speed
		view?.speed = speed
	}

	/// Keeps a few pages only: A file that streams can hold many more than fit in memory.
	func loadAtlasImage(_ index: Int) {
		guard atlasImages[index] == nil, !atlasFailures.contains(index), loadingImages.insert(index).inserted else {
			return
		}

		let animation = animation
		Task.detached(priority: .utility) {
			let image = try? Self.thumbnail(animation: animation, index: index)
			await self.finishLoadingImage(index, image: image.map(AtlasImage.init))
		}
	}

	private func finishLoadingImage(_ index: Int, image: AtlasImage?) {
		loadingImages.remove(index)
		guard let image else {
			atlasFailures.insert(index)
			return
		}

		atlasImages[index] = image.image
		imageOrder.append(index)
		if imageOrder.count > 6 {
			atlasImages[imageOrder.removeFirst()] = nil
		}
	}

	private nonisolated static func thumbnail(animation: WanimAnimation, index: Int) throws -> CGImage {
		let png = try animation.atlasPNG(at: index)
		let options: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceThumbnailMaxPixelSize: 1024,
			kCGImageSourceCreateThumbnailWithTransform: true,
		]
		guard let source = CGImageSourceCreateWithData(png as CFData, nil),
		      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
		else {
			throw WanimError.atlasDecodingFailed(index)
		}

		return image
	}

	/// Renders the current frame on the GPU, at the size of the canvas.
	func exportPNG(frame: Int, to url: URL) async throws {
		let animation = animation
		try await Task.detached(priority: .userInitiated) {
			let renderer = try WanimRenderer(animation: animation)
			renderer.fit = .scale(1)
			try await renderer.prepare(frame: frame)
			let manifest = animation.manifest
			let pixels = try renderer.renderPixels(frame: frame, width: manifest.width, height: manifest.height)
			guard let provider = CGDataProvider(data: pixels.bytes as CFData),
			      let space = CGColorSpace(name: CGColorSpace.sRGB),
			      let image = CGImage(
			      	width: pixels.width,
			      	height: pixels.height,
			      	bitsPerComponent: 8,
			      	bitsPerPixel: 32,
			      	bytesPerRow: pixels.width * 4,
			      	space: space,
			      	bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
			      	provider: provider,
			      	decode: nil,
			      	shouldInterpolate: false,
			      	intent: .defaultIntent
			      ),
			      let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
			else {
				throw CocoaError(.fileWriteUnknown)
			}

			CGImageDestinationAddImage(destination, image, nil)
			guard CGImageDestinationFinalize(destination) else {
				throw CocoaError(.fileWriteUnknown)
			}
		}.value
	}
}

/// CGImage is immutable, but not marked as sendable.
private struct AtlasImage: @unchecked Sendable {
	let image: CGImage
}
