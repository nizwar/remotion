import Metal

final class WanimGPU: @unchecked Sendable {
	static let shared = try? WanimGPU()

	let device: MTLDevice
	let drawQueue: MTLCommandQueue
	let uploadQueue: MTLCommandQueue
	let linearSampler: MTLSamplerState
	let nearestSampler: MTLSamplerState

	private let library: MTLLibrary
	private let lock = NSLock()
	private var pipelines: [String: MTLRenderPipelineState] = [:]

	private init() throws {
		guard let device = MTLCreateSystemDefaultDevice(),
		      let drawQueue = device.makeCommandQueue(),
		      let uploadQueue = device.makeCommandQueue()
		else {
			throw WanimError.metalUnavailable
		}

		self.device = device
		self.drawQueue = drawQueue
		self.uploadQueue = uploadQueue
		library = try device.makeLibrary(source: Self.shaders, options: nil)
		linearSampler = try Self.makeSampler(device, filter: .linear)
		nearestSampler = try Self.makeSampler(device, filter: .nearest)
	}

	var maxTextureSize: Int {
		device.supportsFamily(.apple3) ? 16384 : 8192
	}

	func pipeline(format: MTLPixelFormat, blending: Bool) throws -> MTLRenderPipelineState {
		lock.lock()
		defer { lock.unlock() }
		let id = "\(format.rawValue)-\(blending)"
		if let pipeline = pipelines[id] {
			return pipeline
		}

		let descriptor = MTLRenderPipelineDescriptor()
		descriptor.vertexFunction = library.makeFunction(name: "wanim_vertex")
		descriptor.fragmentFunction = library.makeFunction(name: "wanim_fragment")
		let attachment = descriptor.colorAttachments[0]!
		attachment.pixelFormat = format
		attachment.isBlendingEnabled = blending
		attachment.sourceRGBBlendFactor = .one
		attachment.destinationRGBBlendFactor = .oneMinusSourceAlpha
		attachment.sourceAlphaBlendFactor = .one
		attachment.destinationAlphaBlendFactor = .oneMinusSourceAlpha
		let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
		pipelines[id] = pipeline
		return pipeline
	}

	private static func makeSampler(
		_ device: MTLDevice,
		filter: MTLSamplerMinMagFilter
	) throws -> MTLSamplerState {
		let descriptor = MTLSamplerDescriptor()
		descriptor.minFilter = filter
		descriptor.magFilter = filter
		descriptor.sAddressMode = .clampToEdge
		descriptor.tAddressMode = .clampToEdge
		guard let sampler = device.makeSamplerState(descriptor: descriptor) else {
			throw WanimError.metalUnavailable
		}

		return sampler
	}

	private static let shaders = """
	#include <metal_stdlib>
	using namespace metal;

	struct Quad {
		float4 destination;
		float4 source;
	};

	struct Vertex {
		float4 position [[position]];
		float2 uv;
	};

	vertex Vertex wanim_vertex(uint id [[vertex_id]], constant Quad &quad [[buffer(0)]]) {
		float2 corner = float2(id & 1, id >> 1);
		float2 point = quad.destination.xy + corner * quad.destination.zw;
		Vertex out;
		out.position = float4(point.x * 2 - 1, 1 - point.y * 2, 0, 1);
		out.uv = quad.source.xy + corner * quad.source.zw;
		return out;
	}

	fragment float4 wanim_fragment(
		Vertex in [[stage_in]],
		texture2d<float> atlas [[texture(0)]],
		sampler atlasSampler [[sampler(0)]]
	) {
		return atlas.sample(atlasSampler, in.uv);
	}
	"""
}
