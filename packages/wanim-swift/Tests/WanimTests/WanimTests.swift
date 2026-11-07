import CryptoKit
import XCTest
@testable import Wanim

final class WanimTests: XCTestCase {
	private struct Expected: Decodable {
		let customKey: String
		let manifest: WanimManifest
		let atlasSha256: [String]
	}

	private func fixture(_ name: String) throws -> Data {
		let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures"))
		return try Data(contentsOf: url)
	}

	private func expected() throws -> Expected {
		try JSONDecoder().decode(Expected.self, from: fixture("expected.json"))
	}

	private func customKey() throws -> SymmetricKey {
		let hex = try Array(expected().customKey)
		return SymmetricKey(data: stride(from: 0, to: hex.count, by: 2).map {
			UInt8(String(hex[$0 ... $0 + 1]), radix: 16)!
		})
	}

	private func assertThrows(_ error: WanimError, _ block: () throws -> Void, line: UInt = #line) {
		XCTAssertThrowsError(try block(), line: line) {
			XCTAssertEqual($0 as? WanimError, error, line: line)
		}
	}

	func testOfficialFixtureMatchesExpected() throws {
		let expected = try expected()
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		XCTAssertFalse(animation.usesCustomKey)
		XCTAssertEqual(animation.manifest, expected.manifest)
		for (index, sha256) in expected.atlasSha256.enumerated() {
			let digest = try SHA256.hash(data: animation.atlasPNG(at: index))
			XCTAssertEqual(digest.map { String(format: "%02x", $0) }.joined(), sha256)
		}
	}

	func testCustomKeyFixtureMatchesExpected() throws {
		let expected = try expected()
		let animation = try WanimAnimation(data: fixture("sample-custom-key.wanim"), key: customKey())
		XCTAssertTrue(animation.usesCustomKey)
		XCTAssertEqual(animation.manifest, expected.manifest)
		for (index, sha256) in expected.atlasSha256.enumerated() {
			let digest = try SHA256.hash(data: animation.atlasPNG(at: index))
			XCTAssertEqual(digest.map { String(format: "%02x", $0) }.joined(), sha256)
		}
	}

	/// Compressed atlases are indexed PNGs, which must decode like any other.
	func testCompressedFixtureDrawsTheSamePicture() async throws {
		let plain = try WanimAnimation(data: fixture("sample.wanim"))
		let compressed = try WanimAnimation(data: fixture("sample-compressed.wanim"))
		XCTAssertEqual(compressed.manifest.frames, plain.manifest.frames)
		XCTAssertEqual(compressed.manifest.sprites, plain.manifest.sprites)
		let plainRenderer = try WanimRenderer(animation: plain)
		let compressedRenderer = try WanimRenderer(animation: compressed)
		plainRenderer.fit = .scale(1)
		compressedRenderer.fit = .scale(1)
		try await plainRenderer.prepare()
		try await compressedRenderer.prepare()
		for frame in 0 ..< plain.manifest.frameCount {
			let width = plain.manifest.width
			let height = plain.manifest.height
			let a = try plainRenderer.renderPixels(frame: frame, width: width, height: height)
			let b = try compressedRenderer.renderPixels(frame: frame, width: width, height: height)
			let largest = zip(a.bytes, b.bytes).map { abs(Int($0) - Int($1)) }.max() ?? 0
			XCTAssertLessThanOrEqual(largest, 8, "frame \(frame)")
		}
	}

	func testMissingAndWrongCustomKey() throws {
		let data = try fixture("sample-custom-key.wanim")
		assertThrows(.missingCustomKey) { _ = try WanimAnimation(data: data) }
		assertThrows(.wrongKeyOrTampered) {
			_ = try WanimAnimation(data: data, key: SymmetricKey(size: .bits256))
		}
	}

	func testOfficialFilesIgnoreAPassedKey() throws {
		XCTAssertNoThrow(try WanimAnimation(data: fixture("sample.wanim"), key: SymmetricKey(size: .bits256)))
	}

	func testHeaderChecks() throws {
		var version = try fixture("sample.wanim")
		version[8] = 2
		assertThrows(.unsupportedVersion(2)) { _ = try WanimAnimation(data: version) }

		var flags = try fixture("sample.wanim")
		flags[10] = 2
		assertThrows(.unsupportedFlags(2)) { _ = try WanimAnimation(data: flags) }

		var magic = try fixture("sample.wanim")
		magic[1] = 0
		XCTAssertThrowsError(try WanimAnimation(data: magic))
		XCTAssertThrowsError(try WanimAnimation(data: Data()))

		var salt = try fixture("sample.wanim")
		salt[20] ^= 1
		assertThrows(.wrongKeyOrTampered) { _ = try WanimAnimation(data: salt) }
	}

	func testTamperingInEachBlockIsDetected() throws {
		let data = try fixture("sample.wanim")
		let manifest = try WanimAnimation(data: data).manifest
		let manifestLength = Int(data[12]) | Int(data[13]) << 8
		var inManifest = data
		inManifest[40 + manifestLength / 2] ^= 1
		assertThrows(.wrongKeyOrTampered) { _ = try WanimAnimation(data: inManifest) }

		for (index, atlas) in manifest.atlases.enumerated() {
			var tampered = data
			tampered[40 + manifestLength + atlas.offset + atlas.length / 2] ^= 1
			let animation = try WanimAnimation(data: tampered)
			assertThrows(.wrongKeyOrTampered) { _ = try animation.atlasPNG(at: index) }
		}
	}

	func testTruncatedFile() throws {
		let data = try fixture("sample.wanim")
		XCTAssertThrowsError(try WanimAnimation(data: data.prefix(data.count - 1)))
		XCTAssertThrowsError(try WanimAnimation(data: data.prefix(60)))
	}

	func testSlicedDataOpens() throws {
		let data = Data([1, 2, 3]) + (try fixture("sample.wanim"))
		XCTAssertNoThrow(try WanimAnimation(data: data.dropFirst(3)))
	}

	/// What the GPU draws at 1:1 must equal the sprite's pixels, for every frame.
	func testGPUDrawsEveryFrameExactly() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let manifest = animation.manifest
		let renderer = try WanimRenderer(animation: animation)
		renderer.fit = .scale(1)
		try await renderer.prepare()
		let atlases = try manifest.atlases.indices.map { try animation.decodeAtlas(at: $0) }

		for frame in 0 ..< manifest.frameCount {
			let result = try renderer.renderPixels(frame: frame, width: manifest.width, height: manifest.height)
			var expected = [UInt8](repeating: 0, count: manifest.width * manifest.height * 4)
			if manifest.frames[frame] >= 0 {
				let sprite = manifest.sprites[manifest.frames[frame]]
				let atlas = atlases[sprite.atlas]
				for row in 0 ..< sprite.height {
					for column in 0 ..< sprite.width * 4 {
						let source = (sprite.y + row) * atlas.width * 4 + sprite.x * 4 + column
						let target = (sprite.offsetY + row) * manifest.width * 4 + sprite.offsetX * 4 + column
						expected[target] = atlas.bytes[source]
					}
				}
			}

			XCTAssertEqual(Array(result.bytes), expected, "frame \(frame)")
		}
	}

	func testGPUFitKeepsTheCanvasCentered() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let renderer = try WanimRenderer(animation: animation)
		try await renderer.prepare()
		// A 128x128 target letterboxes the 64x48 canvas to 128x96
		let result = try renderer.renderPixels(frame: 7, width: 128, height: 128)
		let alpha = { (x: Int, y: Int) in result.bytes[(y * 128 + x) * 4 + 3] }
		XCTAssertEqual(alpha(32, 10), 0)
		XCTAssertEqual(alpha(32, 16 + 70), 255)
		XCTAssertEqual(alpha(4, 16 + 70), 0)
	}

	func testEmptyFrameDrawsNothing() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let renderer = try WanimRenderer(animation: animation)
		try await renderer.prepare()
		let last = animation.manifest.frameCount - 1
		XCTAssertEqual(animation.manifest.frames[last], -1)
		let result = try renderer.renderPixels(frame: last, width: 64, height: 48)
		XCTAssertTrue(result.bytes.allSatisfy { $0 == 0 })
	}

	/// Pinned against the fixture's generator, so this does not depend on the decoder under test.
	func testAtlasDecodesPremultipliedAndUpright() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let renderer = try WanimRenderer(animation: animation)
		renderer.fit = .scale(1)
		try await renderer.prepare()
		let result = try renderer.renderPixels(frame: 0, width: 64, height: 48)
		let pixel = { (x: Int, y: Int) in Array(result.bytes[(y * 64 + x) * 4 ..< (y * 64 + x) * 4 + 4]) }
		// The source pixel is 255, 40, 40 at alpha 128
		XCTAssertEqual(pixel(4, 8), [128, 20, 20, 128])
		XCTAssertEqual(pixel(19, 23), [128, 20, 20, 128])
		XCTAssertEqual(pixel(3, 8), [0, 0, 0, 0])
		XCTAssertEqual(pixel(4, 7), [0, 0, 0, 0])
		XCTAssertEqual(pixel(20, 23), [0, 0, 0, 0])
	}

	func testNearestScalingKeepsEveryTexelTheSameSize() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let renderer = try WanimRenderer(animation: animation)
		try await renderer.prepare()
		renderer.fit = .scale(1)
		let exact = try renderer.renderPixels(frame: 5, width: 64, height: 48)
		renderer.fit = .scale(3)
		renderer.filtering = .nearest
		let scaled = try renderer.renderPixels(frame: 5, width: 192, height: 144)
		for y in 0 ..< 144 {
			for x in 0 ..< 192 {
				let source = ((y / 3) * 64 + x / 3) * 4
				let target = (y * 192 + x) * 4
				XCTAssertEqual(scaled.bytes[target + 3], exact.bytes[source + 3], "\(x), \(y)")
			}
		}
	}

	func testScaledCanvasStaysOnWholePixels() throws {
		let manifest = try WanimAnimation(data: fixture("sample.wanim")).manifest
		let rect = WanimRenderer.canvasRect(
			fit: .scale(1),
			manifest: manifest,
			target: CGSize(width: 101, height: 101),
			offset: CGPoint(x: 0.5, y: 0)
		)
		XCTAssertEqual(rect, CGRect(x: 19, y: 26, width: 64, height: 48))
	}

	func testOffsetMovesTheCanvas() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let renderer = try WanimRenderer(animation: animation)
		try await renderer.prepare()
		renderer.fit = .scale(1)
		renderer.offset = CGPoint(x: 2, y: 3)
		let result = try renderer.renderPixels(frame: 0, width: 64, height: 48)
		XCTAssertEqual(result.bytes[(11 * 64 + 6) * 4 + 3], 128)
		XCTAssertEqual(result.bytes[(10 * 64 + 6) * 4 + 3], 0)
	}

	func testPrepareOneFrameWhenStreaming() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		animation.gpuBudget = 1
		XCTAssertFalse(animation.preloads)
		let renderer = try WanimRenderer(animation: animation)
		renderer.fit = .scale(1)
		try await renderer.prepare(frame: 7)
		let result = try renderer.renderPixels(frame: 7, width: 64, height: 48)
		XCTAssertEqual(result.bytes[(30 * 64 + 8) * 4 + 3], 255)
		try await renderer.prepare(frame: 11)
	}

	func testManifestValuesThatWouldOverflowAreRejected() throws {
		let json = """
		{"version":1,"width":4,"height":4,"fps":30,"frameCount":1,"opaque":false,"gpuBytes":64,
		"atlases":[{"offset":0,"length":32,"width":4,"height":4,"format":"png"}],
		"sprites":[[0,9223372036854775807,0,1,1,0,0]],"frames":[0]}
		"""
		let manifest = try JSONDecoder().decode(WanimManifest.self, from: Data(json.utf8))
		XCTAssertThrowsError(try manifest.validate())
	}

	func testUnknownAtlasFormatAndManifestVersionAreRejected() throws {
		let template = """
		{"version":VERSION,"width":4,"height":4,"fps":30,"frameCount":1,"opaque":false,"gpuBytes":64,
		"atlases":[{"offset":0,"length":32,"width":4,"height":4,"format":"FORMAT"}],
		"sprites":[],"frames":[-1]}
		"""
		let decode = { (version: String, format: String) throws -> WanimManifest in
			let json = template.replacingOccurrences(of: "VERSION", with: version)
				.replacingOccurrences(of: "FORMAT", with: format)
			return try JSONDecoder().decode(WanimManifest.self, from: Data(json.utf8))
		}
		XCTAssertNoThrow(try decode("1", "png").validate())
		XCTAssertThrowsError(try decode("1", "webp").validate())
		assertThrows(.unsupportedVersion(2)) { try decode("2", "png").validate() }
	}

	func testKeyFromHex() throws {
		let hex = try expected().customKey
		let key = try XCTUnwrap(WanimAnimation.key(hex: hex))
		XCTAssertNoThrow(try WanimAnimation(data: fixture("sample-custom-key.wanim"), key: key))
		XCTAssertNotNil(WanimAnimation.key(hex: hex.uppercased()))
		XCTAssertNil(WanimAnimation.key(hex: String(hex.dropLast())))
		XCTAssertNil(WanimAnimation.key(hex: String(hex.dropLast()) + "g"))
		XCTAssertNil(WanimAnimation.key(hex: ""))
	}

	@MainActor
	func testViewKeepsPlaybackStateWithoutAWindow() throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let view = WanimView(animation: animation)
		var reported: [Int] = []
		view.onFrameChange = { reported.append($0) }
		view.seek(toFrame: 5)
		view.seek(toFrame: 5)
		view.seek(toFrame: 999)
		view.seek(toFrame: -3)
		XCTAssertEqual(reported, [5, 11, 0])
		view.play()
		XCTAssertTrue(view.isPlaying)
		view.pause()
		XCTAssertFalse(view.isPlaying)
		view.animation = nil
		XCTAssertEqual(view.currentFrame, 0)
		view.seek(toFrame: 3)
		XCTAssertEqual(view.currentFrame, 0)
	}

	@MainActor
	func testViewReportsReady() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		let view = WanimView(animation: animation)
		XCTAssertFalse(view.isReady)
		let ready = expectation(description: "ready")
		view.onReady = { ready.fulfill() }
		await fulfillment(of: [ready], timeout: 5)
		XCTAssertTrue(view.isReady)
		view.releaseCaches()
	}

	func testStreamingEvictsOldAtlases() async throws {
		let animation = try WanimAnimation(data: fixture("sample.wanim"))
		animation.textures.budget = 1
		XCTAssertFalse(animation.textures.keepsEverything)
		try await animation.textures.prepare()
		XCTAssertNotNil(animation.textures.texture(at: 0))
		XCTAssertNil(animation.textures.texture(at: 1))
		animation.textures.trim(keeping: nil)
		XCTAssertNil(animation.textures.texture(at: 0))
	}
}
