#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "Build requires Linux x86_64." >&2
  exit 1
fi
fnpack_bin="${FNPACK_BIN:-fnpack}"
command -v "$fnpack_bin" >/dev/null || { echo "fnpack is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 24 is required." >&2; exit 1; }
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo "Node.js 24 is required." >&2; exit 1; }

mkdir -p "$root/dist"
stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-fnos-stage.XXXXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
cp -a "$root/fnos/." "$stage/"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/cmd/"*
mkdir -p "$stage/app/runtime"
cp "$root/package.json" "$root/package-lock.json" "$stage/app/runtime/"
cp "$root/scripts/patch-dsh.mjs" "$stage/app/patch-dsh.mjs"
chmod 0644 "$stage/app/patch-dsh.mjs" "$stage/app/runtime/package.json" "$stage/app/runtime/package-lock.json"
npm ci --omit=dev --prefix "$stage/app/runtime" --cache "${DSH_NPM_CACHE:-$stage/.npm-cache}"
node "$root/scripts/patch-dsh.mjs" "$stage/app/runtime"
rm -rf -- "$stage/.npm-cache"
cd "$root/dist"
"$fnpack_bin" build --directory "$stage"
