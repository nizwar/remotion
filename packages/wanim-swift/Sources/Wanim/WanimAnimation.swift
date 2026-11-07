import CoreGraphics
import CryptoKit
import Foundation
import ImageIO

/// An opened `.wanim` file. Atlases stay encrypted until they are needed.
public final class WanimAnimation: @unchecked Sendable {
	private static let magic: [UInt8] = [0x89, 0x57, 0x41, 0x4E, 0x49, 0x4D, 0x0D, 0x0A]
	private static let headerLength = 40
	private static let tagLength = 16
	private static let customKeyFlag = 1

	public let manifest: WanimManifest
	public let usesCustomKey: Bool
	public let fileSize: Int

	private let data: Data
	private let header: Data
	private let noncePrefix: Data
	private let fileKey: SymmetricKey
	private let dataStart: Int

	private(set) var textures: WanimTextureStore!

	/// GPU memory this animation may keep. A file that fits is preloaded, others stream.
	public var gpuBudget: Int {
		get { textures.budget }
		set { textures.budget = newValue }
	}

	/// True if all atlases are decoded up front, false if they stream during playback.
	public var preloads: Bool {
		textures.keepsEverything
	}

	public static let defaultGPUBudget = WanimTextureStore.defaultBudget

	/// Parses a key written as 64 hexadecimal characters.
	public static func key(hex: String) -> SymmetricKey? {
		let digits = Array(hex.utf8)
		guard digits.count == 64 else {
			return nil
		}

		var bytes = [UInt8]()
		bytes.reserveCapacity(32)
		for index in stride(from: 0, to: 64, by: 2) {
			guard let high = Character(UnicodeScalar(digits[index])).hexDigitValue,
			      let low = Character(UnicodeScalar(digits[index + 1])).hexDigitValue
			else {
				return nil
			}

			bytes.append(UInt8(high << 4 | low))
		}

		return SymmetricKey(data: bytes)
	}

	/// Opens a file. Pass a `key` only for files that use a custom key.
	public convenience init(contentsOf url: URL, key: SymmetricKey? = nil) async throws {
		let data = try await Task.detached(priority: .userInitiated) {
			try Data(contentsOf: url, options: .alwaysMapped)
		}.value
		try self.init(data: data, key: key)
	}

	public init(data source: Data, key: SymmetricKey? = nil) throws {
		let data = source.startIndex == 0 ? source : Data(source)
		guard data.count >= Self.headerLength, data.prefix(8).elementsEqual(Self.magic) else {
			throw WanimError.invalidFile("the header is missing")
		}

		let version = Self.readInteger(data, at: 8, length: 2)
		guard version == 1 else {
			throw WanimError.unsupportedVersion(version)
		}

		let flags = Self.readInteger(data, at: 10, length: 2)
		guard flags & ~Self.customKeyFlag == 0 else {
			throw WanimError.unsupportedFlags(flags)
		}

		let usesCustomKey = flags & Self.customKeyFlag != 0
		if usesCustomKey, key == nil {
			throw WanimError.missingCustomKey
		}

		let manifestLength = Self.readInteger(data, at: 12, length: 4)
		let dataStart = Self.headerLength + manifestLength
		guard manifestLength >= Self.tagLength, dataStart <= data.count else {
			throw WanimError.invalidFile("the file is truncated")
		}

		let header = data.subdata(in: 0 ..< Self.headerLength)
		let noncePrefix = data.subdata(in: 32 ..< 40)
		let masterKey = usesCustomKey ? key! : OfficialKey.value
		let fileKey = HKDF<SHA256>.deriveKey(
			inputKeyMaterial: masterKey,
			salt: data.subdata(in: 16 ..< 32),
			info: Data("wanim/v1/aes-256-gcm".utf8),
			outputByteCount: 32
		)

		let manifestBytes = try Self.decrypt(
			block: data[Self.headerLength ..< dataStart],
			index: 0,
			fileKey: fileKey,
			header: header,
			noncePrefix: noncePrefix
		)

		let manifest: WanimManifest
		do {
			manifest = try JSONDecoder().decode(WanimManifest.self, from: manifestBytes)
		} catch {
			throw WanimError.invalidFile("the manifest cannot be read")
		}

		try manifest.validate()
		for atlas in manifest.atlases {
			guard atlas.offset >= 0, atlas.length >= Self.tagLength,
			      atlas.offset <= data.count - dataStart,
			      atlas.length <= data.count - dataStart - atlas.offset
			else {
				throw WanimError.invalidFile("the file is truncated")
			}
		}

		self.manifest = manifest
		self.usesCustomKey = usesCustomKey
		self.fileSize = data.count
		self.data = data
		self.header = header
		self.noncePrefix = noncePrefix
		self.fileKey = fileKey
		self.dataStart = dataStart
		textures = WanimTextureStore(animation: self)
	}

	/// Decrypts one atlas and returns its PNG file.
	public func atlasPNG(at index: Int) throws -> Data {
		let atlas = manifest.atlases[index]
		let start = dataStart + atlas.offset
		return try Self.decrypt(
			block: data[start ..< start + atlas.length],
			index: UInt32(index + 1),
			fileKey: fileKey,
			header: header,
			noncePrefix: noncePrefix
		)
	}

	/// Decrypts and decodes one atlas into premultiplied RGBA8 pixels.
	public func decodeAtlas(at index: Int) throws -> WanimPixels {
		let atlas = manifest.atlases[index]
		let png = try atlasPNG(at: index)
		let options = [kCGImageSourceShouldCache: false] as CFDictionary
		guard let source = CGImageSourceCreateWithData(png as CFData, options),
		      let image = CGImageSourceCreateImageAtIndex(source, 0, options),
		      image.width == atlas.width, image.height == atlas.height,
		      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
		else {
			throw WanimError.atlasDecodingFailed(index)
		}

		let bytesPerRow = atlas.width * 4
		var pixels = Data(count: bytesPerRow * atlas.height)
		let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
			guard let context = CGContext(
				data: buffer.baseAddress,
				width: atlas.width,
				height: atlas.height,
				bitsPerComponent: 8,
				bytesPerRow: bytesPerRow,
				space: colorSpace,
				bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
			) else {
				return false
			}

			context.setBlendMode(.copy)
			context.interpolationQuality = .none
			context.draw(image, in: CGRect(x: 0, y: 0, width: atlas.width, height: atlas.height))
			return true
		}

		guard drawn else {
			throw WanimError.atlasDecodingFailed(index)
		}

		return WanimPixels(width: atlas.width, height: atlas.height, bytes: pixels)
	}

	private static func readInteger(_ data: Data, at offset: Int, length: Int) -> Int {
		(0 ..< length).reversed().reduce(0) { value, index in
			value << 8 | Int(data[offset + index])
		}
	}

	private static func decrypt(
		block: Data,
		index: UInt32,
		fileKey: SymmetricKey,
		header: Data,
		noncePrefix: Data
	) throws -> Data {
		let indexBytes = withUnsafeBytes(of: index.littleEndian) { Data($0) }
		do {
			let box = try AES.GCM.SealedBox(
				nonce: AES.GCM.Nonce(data: noncePrefix + indexBytes),
				ciphertext: block.dropLast(tagLength),
				tag: block.suffix(tagLength)
			)
			return try AES.GCM.open(box, using: fileKey, authenticating: header + indexBytes)
		} catch {
			throw WanimError.wrongKeyOrTampered
		}
	}
}

/// Premultiplied RGBA8 pixels, ready to upload.
public struct WanimPixels: Sendable {
	public let width: Int
	public let height: Int
	public let bytes: Data
}
