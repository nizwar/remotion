#!/usr/bin/env swift
// Draws the app icon into Resources/Assets.xcassets/AppIcon.appiconset. Run from packages/wanim-preview:
// swift scripts/make-icon.swift
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let folder = URL(fileURLWithPath: "Resources/Assets.xcassets/AppIcon.appiconset")
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ hex: UInt32) -> CGColor {
	CGColor(
		colorSpace: space,
		components: [
			CGFloat(hex >> 16 & 255) / 255,
			CGFloat(hex >> 8 & 255) / 255,
			CGFloat(hex & 255) / 255,
			1,
		]
	)!
}

func draw(pixels: Int) -> CGImage {
	let context = CGContext(
		data: nil,
		width: pixels,
		height: pixels,
		bitsPerComponent: 8,
		bytesPerRow: 0,
		space: space,
		bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
	)!
	// All numbers are on the 1024 grid of a macOS icon, whose plate is 824 wide
	context.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
	let plate = CGRect(x: 100, y: 100, width: 824, height: 824)
	context.addPath(CGPath(roundedRect: plate, cornerWidth: 185, cornerHeight: 185, transform: nil))
	context.setFillColor(color(0x171719))
	context.fillPath()

	let cell: CGFloat = 168
	let gap: CGFloat = 36
	let start = (1024 - cell * 3 - gap * 2) / 2
	for row in 0 ..< 3 {
		for column in 0 ..< 3 {
			let isLit = row == 1 && column == 2
			context.setFillColor(color(isLit ? 0xF2853A : 0x3A3A3E))
			let x = start + CGFloat(column) * (cell + gap)
			let y = start + CGFloat(row) * (cell + gap)
			let rect = CGRect(x: x, y: y, width: cell, height: cell)
			context.addPath(CGPath(roundedRect: rect, cornerWidth: 20, cornerHeight: 20, transform: nil))
			context.fillPath()
		}
	}

	return context.makeImage()!
}

var images: [[String: String]] = []
for points in [16, 32, 128, 256, 512] {
	for scale in [1, 2] {
		let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
		let url = folder.appendingPathComponent(name) as CFURL
		let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil)!
		CGImageDestinationAddImage(destination, draw(pixels: points * scale), nil)
		CGImageDestinationFinalize(destination)
		images.append([
			"filename": name,
			"idiom": "mac",
			"scale": "\(scale)x",
			"size": "\(points)x\(points)",
		])
	}
}

let contents: [String: Any] = ["images": images, "info": ["author": "xcode", "version": 1]]
let json = try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys])
try json.write(to: folder.appendingPathComponent("Contents.json"))
