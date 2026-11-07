import Foundation

public enum WanimError: Error, Equatable, LocalizedError {
	case invalidFile(String)
	case unsupportedVersion(Int)
	case unsupportedFlags(Int)
	case missingCustomKey
	case wrongKeyOrTampered
	case metalUnavailable
	case atlasTooLarge(Int)
	case atlasDecodingFailed(Int)

	public var errorDescription: String? {
		switch self {
		case let .invalidFile(reason):
			return "This is not a valid .wanim file: \(reason)."
		case let .unsupportedVersion(version):
			return "This file uses .wanim version \(version), which this player does not support."
		case let .unsupportedFlags(flags):
			return "This file uses unknown .wanim flags (\(flags))."
		case .missingCustomKey:
			return "This file is encrypted with its own key."
		case .wrongKeyOrTampered:
			return "The key is wrong or the file was modified."
		case .metalUnavailable:
			return "Metal is not available on this device."
		case let .atlasTooLarge(size):
			return "An atlas of \(size) pixels is larger than this GPU supports."
		case let .atlasDecodingFailed(index):
			return "Atlas \(index) could not be decoded."
		}
	}
}
