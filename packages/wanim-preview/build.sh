#!/bin/bash
# Builds "build/Wanim Preview.app", signed ad hoc so that it runs on this Mac.
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p build
xcodegen generate --quiet
xcodebuild \
	-project "Wanim Preview.xcodeproj" \
	-scheme "Wanim Preview" \
	-configuration "${CONFIGURATION:-Release}" \
	-derivedDataPath build/DerivedData \
	-destination "platform=macOS,arch=$(uname -m)" \
	build > build/xcodebuild.log 2>&1 || {
	grep -E "^/.*error: " build/xcodebuild.log | sort -u
	echo "The build failed, see build/xcodebuild.log" >&2
	exit 1
}

product="build/DerivedData/Build/Products/${CONFIGURATION:-Release}/Wanim Preview.app"
test -d "$product"
rm -rf "build/Wanim Preview.app"
cp -R "$product" "build/Wanim Preview.app"
codesign --force --deep --sign - "build/Wanim Preview.app"
echo "Built $(pwd)/build/Wanim Preview.app"
