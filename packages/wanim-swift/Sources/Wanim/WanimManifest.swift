import Foundation

public struct WanimManifest: Decodable, Equatable, Sendable {
	public struct Atlas: Decodable, Equatable, Sendable {
		public let offset: Int
		public let length: Int
		public let width: Int
		public let height: Int
		public let format: String
	}

	public struct Sprite: Decodable, Equatable, Sendable {
		public let atlas: Int
		public let x: Int
		public let y: Int
		public let width: Int
		public let height: Int
		public let offsetX: Int
		public let offsetY: Int

		public init(from decoder: Decoder) throws {
			var values = try decoder.unkeyedContainer()
			atlas = try values.decode(Int.self)
			x = try values.decode(Int.self)
			y = try values.decode(Int.self)
			width = try values.decode(Int.self)
			height = try values.decode(Int.self)
			offsetX = try values.decode(Int.self)
			offsetY = try values.decode(Int.self)
		}
	}

	public let version: Int
	public let compositionId: String?
	public let width: Int
	public let height: Int
	public let fps: Double
	public let frameCount: Int
	public let opaque: Bool
	public let gpuBytes: Int
	public let atlases: [Atlas]
	public let sprites: [Sprite]
	public let frames: [Int]

	public var duration: TimeInterval {
		Double(frameCount) / fps
	}

	func validate() throws {
		guard width > 0, height > 0, fps > 0, frameCount == frames.count, frameCount > 0 else {
			throw WanimError.invalidFile("the manifest describes no playable frames")
		}

		guard version == 1 else {
			throw WanimError.unsupportedVersion(version)
		}

		guard atlases.allSatisfy({ $0.width > 0 && $0.height > 0 && $0.format == "png" }) else {
			throw WanimError.invalidFile("an atlas has an unknown format")
		}

		for sprite in sprites {
			guard atlases.indices.contains(sprite.atlas) else {
				throw WanimError.invalidFile("a sprite points to a missing atlas")
			}

			let atlas = atlases[sprite.atlas]
			guard sprite.x >= 0, sprite.y >= 0, sprite.width > 0, sprite.height > 0,
			      sprite.width <= atlas.width, sprite.height <= atlas.height,
			      sprite.x <= atlas.width - sprite.width,
			      sprite.y <= atlas.height - sprite.height
			else {
				throw WanimError.invalidFile("a sprite lies outside of its atlas")
			}
		}

		guard frames.allSatisfy({ $0 == -1 || sprites.indices.contains($0) }) else {
			throw WanimError.invalidFile("a frame points to a missing sprite")
		}
	}
}
