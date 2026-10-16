#!/usr/bin/env bash
# Silicon Studio developer entry point.
#   ./scripts/silicon-studio.sh setup     install dependencies and compile (first time, or after pulling)
#   ./scripts/silicon-studio.sh desktop   launch the desktop app            [extra args go to the app, e.g. a folder]
#   ./scripts/silicon-studio.sh web       serve the browser build on http://localhost:${PORT:-9888}
#   ./scripts/silicon-studio.sh test      run the Silicon Studio extension self-checks
#   ./scripts/silicon-studio.sh dmg       build the macOS app and ../dist/Silicon-Studio-<version>-<arch>.dmg
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# Optional machine-local toolchain (Node matching .nvmrc, a working python3), e.g. ../.tools/env.sh
TOOLS_ENV="${SILICON_TOOLS_ENV:-$ROOT/../.tools/env.sh}"
if [[ -f "$TOOLS_ENV" ]]; then
	source "$TOOLS_ENV"
fi

want=$(cut -d. -f1 .nvmrc)
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)
if [[ "$have" != "$want" ]]; then
	echo "Silicon Studio needs Node $want.x (found: $have). Install it (e.g. 'brew install node@$want') and put it first on PATH." >&2
	exit 1
fi

for tool in yosys iverilog vvp verilator; do
	command -v "$tool" >/dev/null || echo "note: '$tool' is not installed; install with: brew install yosys icarus-verilog verilator (yosys falls back to the bundled WebAssembly build)" >&2
done

# Electron, compiled sources and built-in extensions are prepared by 'setup'; skip re-checking them on every launch.
skip_prelaunch() {
	if [[ -d out && -d .build/electron ]]; then
		export VSCODE_SKIP_PRELAUNCH=1
	fi
}

case "${1:-}" in
	setup)
		npm install
		npm run compile
		node build/lib/preLaunch.ts || echo "note: some optional built-in extensions could not be downloaded (GitHub rate limit?); Silicon Studio does not need them." >&2
		;;
	desktop)
		shift
		skip_prelaunch
		exec ./scripts/code.sh "$@"
		;;
	web)
		shift
		skip_prelaunch
		exec ./scripts/code-server.sh --host 127.0.0.1 --port "${PORT:-9888}" --without-connection-token --accept-server-license-terms "$@"
		;;
	test)
		npm run gulp compile-extension:silicon-studio
		cd extensions/silicon-studio && npm test
		;;
	dmg)
		arch=$(node -p process.arch)
		version=$(node -p "require('./package.json').version")
		npm run gulp "vscode-darwin-$arch-min"
		app="$ROOT/../VSCode-darwin-$arch/Silicon Studio.app"
		# Bundle OpenROAD (a self-contained binary) so place and route works out of the box.
		openroad=$(command -v openroad || echo "$ROOT/extensions/silicon-studio/tools/bin/openroad")
		if [[ -e "$openroad" ]]; then
			mkdir -p "$app/Contents/Resources/app/extensions/silicon-studio/tools/bin"
			cp -L "$openroad" "$app/Contents/Resources/app/extensions/silicon-studio/tools/bin/openroad"
		else
			echo "note: openroad not found; the app will look for it on PATH" >&2
		fi
		codesign --force --deep --sign - "$app"   # ad-hoc: runs on this Mac; distribution needs a Developer ID + notarization
		dist="$ROOT/../dist"
		stage="$dist/dmg-stage"
		rm -rf "$stage" && mkdir -p "$stage"
		ditto "$app" "$stage/Silicon Studio.app"
		ln -s /Applications "$stage/Applications"
		hdiutil create -volname "Silicon Studio" -srcfolder "$stage" -ov -format UDZO -fs HFS+ "$dist/Silicon-Studio-$version-$arch.dmg"
		rm -rf "$stage"
		;;
	*)
		sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
		exit 1
		;;
esac
