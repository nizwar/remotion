// swift-tools-version:5.9
import PackageDescription

let package = Package(
	name: "Wanim",
	platforms: [.iOS(.v15), .macOS(.v14)],
	products: [
		.library(name: "Wanim", targets: ["Wanim"]),
	],
	targets: [
		.target(name: "Wanim"),
		.testTarget(
			name: "WanimTests",
			dependencies: ["Wanim"],
			resources: [.copy("Fixtures")]
		),
	]
)
