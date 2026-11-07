import Foundation
import Metal

/// Keeps the atlases of one animation on the GPU, shared by all of its views.
/// Decoding and uploading run in the background, so `texture(at:)` never blocks.
final class WanimTextureStore: @unchecked Sendable {
	static let defaultBudget = 192 * 1024 * 1024

	private unowned let animation: WanimAnimation
	private let lock = NSLock()
	private let decodeQueue = DispatchQueue(label: "wanim.decode", qos: .userInitiated)
	private var textures: [Int: MTLTexture] = [:]
	private var recent: [Int] = []
	private var pending: Set<Int> = []
	private var waiters: [Int: [@Sendable (Result<Void, Error>) -> Void]] = [:]
	private var storedBudget = WanimTextureStore.defaultBudget

	var budget: Int {
		get {
			lock.lock()
			defer { lock.unlock() }
			return storedBudget
		}
		set {
			lock.lock()
			defer { lock.unlock() }
			storedBudget = newValue
		}
	}

	init(animation: WanimAnimation) {
		self.animation = animation
	}

	var keepsEverything: Bool {
		animation.manifest.gpuBytes <= budget
	}

	func texture(at index: Int) -> MTLTexture? {
		lock.lock()
		defer { lock.unlock() }
		guard let texture = textures[index] else {
			return nil
		}

		touch(index)
		return texture
	}

	func request(_ index: Int, completion: (@Sendable (Result<Void, Error>) -> Void)? = nil) {
		lock.lock()
		if textures[index] != nil {
			lock.unlock()
			completion?(.success(()))
			return
		}

		if let completion {
			waiters[index, default: []].append(completion)
		}

		guard pending.insert(index).inserted else {
			lock.unlock()
			return
		}

		lock.unlock()
		let animation = animation
		decodeQueue.async { [self] in
			do {
				let texture = try upload(try animation.decodeAtlas(at: index), index: index)
				finish(index, texture: texture, result: .success(()))
			} catch {
				finish(index, texture: nil, result: .failure(error))
			}
		}
	}

	/// Loads every atlas if the animation fits the budget, otherwise the first.
	func prepare() async throws {
		let count = animation.manifest.atlases.count
		for index in 0 ..< (keepsEverything ? count : min(count, 1)) {
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
				request(index) { continuation.resume(with: $0) }
			}
		}
	}

	func trim(keeping index: Int?) {
		lock.lock()
		defer { lock.unlock() }
		textures = textures.filter { $0.key == index }
		recent = recent.filter { $0 == index }
	}

	private func upload(_ pixels: WanimPixels, index: Int) throws -> MTLTexture {
		guard let gpu = WanimGPU.shared else {
			throw WanimError.metalUnavailable
		}

		guard max(pixels.width, pixels.height) <= gpu.maxTextureSize else {
			throw WanimError.atlasTooLarge(max(pixels.width, pixels.height))
		}

		let descriptor = MTLTextureDescriptor.texture2DDescriptor(
			pixelFormat: .rgba8Unorm,
			width: pixels.width,
			height: pixels.height,
			mipmapped: false
		)
		descriptor.storageMode = .private
		descriptor.usage = .shaderRead
		let bytesPerRow = pixels.width * 4
		guard let texture = gpu.device.makeTexture(descriptor: descriptor),
		      let staging = pixels.bytes.withUnsafeBytes({
		      	gpu.device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared)
		      }),
		      let commands = gpu.uploadQueue.makeCommandBuffer(),
		      let blit = commands.makeBlitCommandEncoder()
		else {
			throw WanimError.metalUnavailable
		}

		blit.copy(
			from: staging,
			sourceOffset: 0,
			sourceBytesPerRow: bytesPerRow,
			sourceBytesPerImage: bytesPerRow * pixels.height,
			sourceSize: MTLSize(width: pixels.width, height: pixels.height, depth: 1),
			to: texture,
			destinationSlice: 0,
			destinationLevel: 0,
			destinationOrigin: MTLOrigin(x: 0, y: 0, z: 0)
		)
		blit.endEncoding()
		commands.commit()
		commands.waitUntilCompleted()
		if let error = commands.error {
			throw error
		}

		return texture
	}

	private func finish(_ index: Int, texture: MTLTexture?, result: Result<Void, Error>) {
		lock.lock()
		pending.remove(index)
		if let texture {
			textures[index] = texture
			touch(index)
			evict(protecting: index)
		}

		let callbacks = waiters.removeValue(forKey: index) ?? []
		lock.unlock()
		callbacks.forEach { $0(result) }
	}

	private func touch(_ index: Int) {
		recent.removeAll { $0 == index }
		recent.append(index)
	}

	private func evict(protecting index: Int) {
		func usedBytes() -> Int {
			textures.keys.reduce(0) {
				let atlas = animation.manifest.atlases[$1]
				return $0 + atlas.width * atlas.height * 4
			}
		}

		// The two most recent atlases are the one on screen and the one coming up
		while usedBytes() > storedBudget, recent.count > 2 {
			let oldest = recent.removeFirst()
			if oldest != index {
				textures[oldest] = nil
			}
		}
	}
}
