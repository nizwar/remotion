// @types/pngjs pulls in a second version of @types/node
declare module 'pngjs' {
	export class PNG {
		constructor(options: {width: number; height: number});
		width: number;
		height: number;
		data: Uint8Array;
		static sync: {
			read(buffer: unknown): PNG;
			write(
				png: PNG,
				options?: {
					colorType?: number;
					deflateLevel?: number;
					filterType?: number;
				},
			): Uint8Array;
		};
		static bitblt(
			source: PNG,
			destination: PNG,
			sourceX: number,
			sourceY: number,
			width: number,
			height: number,
			destinationX: number,
			destinationY: number,
		): void;
	}
}
