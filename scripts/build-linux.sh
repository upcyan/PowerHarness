#!/usr/bin/env bash
set -euo pipefail

# Build the dsh-fnos FPK.
#
#   bash scripts/build-linux.sh [--bump patch|minor|major] [--set X.Y.Z]
#
# Without a version flag the manifest version is used as-is. With one, the
# staged manifest gets the new version and fnos/manifest is only updated after
# a successful pack, so a failed build never advances the recorded version.
# The previous bare `bash scripts/build-linux.sh` behaviour is unchanged.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bump_kind=''
set_version=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bump)
      [[ $# -ge 2 ]] || { echo "--bump needs patch|minor|major" >&2; exit 2; }
      bump_kind="$2"; shift 2 ;;
    --bump=*)
      bump_kind="${1#*=}"; shift ;;
    --set)
      [[ $# -ge 2 ]] || { echo "--set needs X.Y.Z" >&2; exit 2; }
      set_version="$2"; shift 2 ;;
    --set=*)
      set_version="${1#*=}"; shift ;;
    -h|--help)
      sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -n "$bump_kind" && -n "$set_version" ]]; then
  echo "--bump and --set are mutually exclusive" >&2; exit 2
fi

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo "Build requires Linux x86_64." >&2
  exit 1
fi
fnpack_bin="${FNPACK_BIN:-fnpack}"
command -v "$fnpack_bin" >/dev/null || { echo "fnpack is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js 24 is required." >&2; exit 1; }
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo "Node.js 24 is required." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }

version_py="$root/scripts/version.py"
current_version="$(python3 "$version_py" show)"
if [[ -n "$set_version" ]]; then
  target_version="$set_version"
elif [[ -n "$bump_kind" ]]; then
  target_version="$(python3 "$version_py" bump "$bump_kind")"
else
  target_version="$current_version"
fi

mkdir -p "$root/dist"
stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-fnos-stage.XXXXXXXX")"
stage="$(realpath -- "$stage")"
stage_parent="$(realpath -- "${TMPDIR:-/tmp}")"
cleanup_stage() {
  local resolved
  resolved="$(realpath -m -- "${stage:?}")" || return 1
  [[ "$resolved" == "$stage_parent"/dsh-fnos-stage.* && "$resolved" != "$stage_parent" ]] || { echo "refusing unsafe stage cleanup" >&2; return 1; }
  rm -rf -- "$resolved"
}
trap cleanup_stage EXIT
cp -a "$root/fnos/." "$stage/"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/cmd/"*
mkdir -p "$stage/app/runtime"
cp "$root/package.json" "$root/package-lock.json" "$stage/app/runtime/"
cp "$root/scripts/patch-dsh.mjs" "$stage/app/patch-dsh.mjs"
# patch-dsh.mjs resolves legacy-compat.js next to itself (path.dirname(runtime)),
# so the shim must be staged alongside it — otherwise the frontend compatibility
# injection silently skips and frozen-browser users keep hitting missing APIs.
cp "$root/scripts/legacy-compat.js" "$stage/app/legacy-compat.js"
chmod 0644 "$stage/app/patch-dsh.mjs" "$stage/app/legacy-compat.js" "$stage/app/runtime/package.json" "$stage/app/runtime/package-lock.json"

# Stamp the staged manifest before packing; fnpack reads the version from here.
python3 "$version_py" set "$target_version" --manifest "$stage/manifest" >/dev/null

# The AI context files ship inside the package so that an assistant working on an
# installed NAS can read the architecture, the debugging guide and the change
# history. Fail loudly if one went missing: a package without them silently loses
# the only in-band explanation of why this code looks the way it does.
for required in app/AI-CONTEXT.md app/CHANGELOG-AI.md; do
  [[ -s "$stage/$required" ]] || { echo "required AI context file missing or empty: fnos/$required" >&2; exit 1; }
done
# The changelog must mention the version being shipped, or the record is stale.
grep -q "^## \[$target_version\]" "$stage/app/CHANGELOG-AI.md" \
  || { echo "CHANGELOG-AI.md has no entry for version $target_version" >&2; exit 1; }

# Bundle the plugins this deployment uses, so a fresh install starts with the
# same set instead of needing a link: target or a private repository. The
# source profile is read only; --plugins-from overrides it for a build machine
# that has no live profile.
if [[ -n "${DSH_BUNDLE_PLUGINS_FROM:-}" ]]; then
  python3 "$root/scripts/bundle-plugins.py" "$DSH_BUNDLE_PLUGINS_FROM" "$stage/app/plugins-bundled"
elif [[ -d "${HOME:-/nonexistent}/.dsh/profiles/web/node_modules" ]]; then
  python3 "$root/scripts/bundle-plugins.py" "${HOME}/.dsh/profiles/web" "$stage/app/plugins-bundled"
else
  echo "note: no plugin source profile found; building without bundled plugins" >&2
  echo "      set DSH_BUNDLE_PLUGINS_FROM=<profile dir> to include them" >&2
fi

npm ci --omit=dev --prefix "$stage/app/runtime" --cache "${DSH_NPM_CACHE:-$stage/.npm-cache}"
node "$root/scripts/patch-dsh.mjs" "$stage/app/runtime"
# Generate from the installed staged runtime, never copy a stale source declaration.
node "$root/scripts/generate-adapter.cjs" "$stage/app"
cache_target="$(realpath -m -- "${stage:?}/.npm-cache")"
[[ "$cache_target" == "$stage/.npm-cache" ]] || { echo "unsafe staging cache path" >&2; exit 1; }
rm -rf -- "$cache_target"
cd "$root/dist"
"$fnpack_bin" build --directory "$stage"

# Only advance the recorded version once the package exists, so an aborted
# build leaves fnos/manifest untouched.
if [[ "$target_version" != "$current_version" ]]; then
  python3 "$version_py" set "$target_version" >/dev/null
  echo "version: $current_version -> $target_version"
else
  echo "version: $current_version (unchanged)"
fi
