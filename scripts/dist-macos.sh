#!/bin/sh
# Builds Mesa.app and an unsigned DMG into release/.
#
#   cargo install cargo-bundle   # once
#   scripts/dist-macos.sh
#
# Apple Silicon only, like the Electron build before it. The DMG is unsigned
# and un-notarised; see the install note in the README.
set -eu
cd "$(dirname "$0")/.."
cargo bundle --release -p mesa
app="target/release/bundle/osx/Mesa.app"
mkdir -p release
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
rm -f "release/Mesa-$version-arm64.dmg"
hdiutil create -volname Mesa -srcfolder "$app" -ov -format UDZO "release/Mesa-$version-arm64.dmg"
echo "release/Mesa-$version-arm64.dmg"
