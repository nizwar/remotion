import CoreGraphics
import Metal

public enum WanimFit: Equatable, Sendable {
	case contain
	case cover
	case fill
	/// A fixed size, centered: 1 draws one canvas pixel on one target pixel.
	case scale(Double)
}

public enum WanimFiltering: Equatable, Sendable {
	case linear
	case nearest
}

/// Draws one frame into a texture. Used by `WanimView`, and for offscreen rendering.
/// Set `fit`, `filtering` and `offset` from one thread at a time.
public final class WanimRenderer: @unchecked Sendable {
	private struct Quad {
		var destination: SIMD4<Float>
		var source: SIMD4<Float>
	}

	public let animation: WanimAnimation
	public var fit: WanimFit = .contain
	public var filtering: WanimFiltering = .linear
	/// Moves the canvas inside of the target, in target pixels.
	public var offset: CGPoint = .zero

	private let gpu: WanimGPU

	public init(animation: WanimAnimation) throws {
		guard let gpu = WanimGPU.shared else {
			throw WanimError.metalUnavailable
		}

		self.animation = animation
		self.gpu = gpu
	}

	/// Loads the atlases. Without this, frames appear as atlases become ready.
	public func prepare() async throws {
		try await animation.textures.prepare()
	}

	/// Loads the atlas of one frame, which `renderPixels` needs when the animation streams.
	public func prepare(frame: Int) async throws {
		let sprite = animation.manifest.frames[frame]
		guard sprite >= 0 else {
			return
		}

		let atlas = animation.manifest.sprites[sprite].atlas
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			animation.textures.request(atlas) { continuation.resume(with: $0) }
		}
	}

	/// Returns false if the atlas of this frame is not on the GPU yet.
	@discardableResult
	func encode(
		frame: Int,
		target: MTLTexture,
		clearColor: MTLClearColor,
		commands: MTLCommandBuffer
	) throws -> Bool {
		let manifest = animation.manifest
		let spriteIndex = manifest.frames[frame]
		var sprite: WanimManifest.Sprite?
		var texture: MTLTexture?
		if spriteIndex >= 0 {
			sprite = manifest.sprites[spriteIndex]
			texture = animation.textures.texture(at: manifest.sprites[spriteIndex].atlas)
			if texture == nil {
				animation.textures.request(manifest.sprites[spriteIndex].atlas)
				return false
			}
		}

		let pass = MTLRenderPassDescriptor()
		pass.colorAttachments[0].texture = target
		pass.colorAttachments[0].loadAction = .clear
		pass.colorAttachments[0].clearColor = clearColor
		pass.colorAttachments[0].storeAction = .store
		guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else {
			throw WanimError.metalUnavailable
		}

		defer { encoder.endEncoding() }
		guard let sprite, let texture else {
			return true
		}

		let targetSize = CGSize(width: target.width, height: target.height)
		let layout = Self.layout(fit: fit, manifest: manifest, target: targetSize, offset: offset)
		var quad = Self.quad(
			sprite: sprite,
			atlas: texture,
			layout: layout,
			target: targetSize,
			filtering: filtering
		)
		encoder.setRenderPipelineState(
			try gpu.pipeline(format: target.pixelFormat, blending: !manifest.opaque)
		)
		encoder.setVertexBytes(&quad, length: MemoryLayout<Quad>.stride, index: 0)
		encoder.setFragmentTexture(texture, index: 0)
		encoder.setFragmentSamplerState(
			filtering == .linear ? gpu.linearSampler : gpu.nearestSampler,
			index: 0
		)
		encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
		return true
	}

	/// Renders a frame offscreen and returns premultiplied RGBA8 pixels.
	public func renderPixels(frame: Int, width: Int, height: Int) throws -> WanimPixels {
		let descriptor = MTLTextureDescriptor.texture2DDescriptor(
			pixelFormat: .rgba8Unorm,
			width: width,
			height: height,
			mipmapped: false
		)
		descriptor.usage = .renderTarget
		descriptor.storageMode = .shared
		guard let target = gpu.device.makeTexture(descriptor: descriptor),
		      let commands = gpu.drawQueue.makeCommandBuffer()
		else {
			throw WanimError.metalUnavailable
		}

		guard try encode(
			frame: frame,
			target: target,
			clearColor: MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0),
			commands: commands
		) else {
			throw WanimError.atlasDecodingFailed(frame)
		}

		commands.commit()
		commands.waitUntilCompleted()
		var bytes = Data(count: width * height * 4)
		bytes.withUnsafeMutableBytes {
			target.getBytes(
				$0.baseAddress!,
				bytesPerRow: width * 4,
				from: MTLRegionMake2D(0, 0, width, height),
				mipmapLevel: 0
			)
		}
		return WanimPixels(width: width, height: height, bytes: bytes)
	}

	/// Where the canvas lands in a target of this size, in target pixels.
	public static func canvasRect(
		fit: WanimFit,
		manifest: WanimManifest,
		target: CGSize,
		offset: CGPoint = .zero
	) -> CGRect {
		let layout = layout(fit: fit, manifest: manifest, target: target, offset: offset)
		return CGRect(
			x: layout.originX,
			y: layout.originY,
			width: Double(manifest.width) * layout.scaleX,
			height: Double(manifest.height) * layout.scaleY
		)
	}

	static func layout(
		fit: WanimFit,
		manifest: WanimManifest,
		target: CGSize,
		offset: CGPoint
	) -> (scaleX: Double, scaleY: Double, originX: Double, originY: Double) {
		let width = Double(manifest.width)
		let height = Double(manifest.height)
		let ratioX = target.width / width
		let ratioY = target.height / height
		let scaleX: Double
		let scaleY: Double
		var originX: Double
		var originY: Double
		switch fit {
		case .contain:
			scaleX = min(ratioX, ratioY)
			scaleY = scaleX
		case .cover:
			scaleX = max(ratioX, ratioY)
			scaleY = scaleX
		case .fill:
			scaleX = ratioX
			scaleY = ratioY
		case let .scale(scale):
			scaleX = scale
			scaleY = scale
		}

		originX = (target.width - width * scaleX) / 2 + offset.x
		originY = (target.height - height * scaleY) / 2 + offset.y
		if case .scale = fit {
			// A half pixel origin would blur a 1:1 drawing
			originX.round(.down)
			originY.round(.down)
		}

		return (scaleX, scaleY, originX, originY)
	}

	private static func quad(
		sprite: WanimManifest.Sprite,
		atlas: MTLTexture,
		layout: (scaleX: Double, scaleY: Double, originX: Double, originY: Double),
		target: CGSize,
		filtering: WanimFiltering
	) -> Quad {
		let atlasWidth = Double(atlas.width)
		let atlasHeight = Double(atlas.height)
		// Keeps linear sampling inside of the sprite when it is not drawn 1:1.
		// Nearest sampling stays inside by itself, and an inset would make edge texels narrower.
		let isExact = layout.scaleX == 1 && layout.scaleY == 1
		let inset = isExact || filtering == .nearest ? 0.0 : 0.5
		let width = Double(sprite.width)
		let height = Double(sprite.height)
		return Quad(
			destination: SIMD4<Float>(
				Float((layout.originX + Double(sprite.offsetX) * layout.scaleX) / target.width),
				Float((layout.originY + Double(sprite.offsetY) * layout.scaleY) / target.height),
				Float(width * layout.scaleX / target.width),
				Float(height * layout.scaleY / target.height)
			),
			source: SIMD4<Float>(
				Float((Double(sprite.x) + inset) / atlasWidth),
				Float((Double(sprite.y) + inset) / atlasHeight),
				Float((width - inset * 2) / atlasWidth),
				Float((height - inset * 2) / atlasHeight)
			)
		)
	}
}
