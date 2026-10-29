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

# ---------------------------------------------------------------------------
# npm HOME / cache isolation.
#
# npm derives its cache as ${HOME}/.npm. The build must never depend on a HOME
# the build user cannot write:
#   - unset HOME           -> npm falls back to /home/<user>/.npm, which may not
#                             exist (npm then fails at mkdir 'EACCES /home/dsh_fnos');
#   - HOME=/root           -> npm probes /root/.npm, owned root:root 0700, and
#                             fails at mkdir '_cacache/tmp' for the same reason.
# Both failure modes look like a cache-ownership bug but are really just a bad
# HOME. A private HOME under the build tmpdir plus an explicit cache removes
# the guesswork, and keeps every byte of npm state off /root.
export DSH_NPM_HOME="${DSH_NPM_HOME:-${TMPDIR:-/tmp}/dsh-fnos-npm-home}"
export DSH_NPM_CACHE="${DSH_NPM_CACHE:-${TMPDIR:-/tmp}/dsh-fnos-npm-cache}"
mkdir -p "$DSH_NPM_HOME" "$DSH_NPM_CACHE"
export HOME="$DSH_NPM_HOME"
export npm_config_cache="$DSH_NPM_CACHE"

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
command -v cc >/dev/null || { echo "A C compiler with static libc is required for the CLI subreaper." >&2; exit 1; }

python3 "$root/scripts/check-deployment-entrypoints.py"

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
# Local source backups must never ship: they carry stale copies of app code
# (including pre-fix versions of supervisor.js/gateway.js) in the installed
# tree, where they are dead weight at best and a supply of outdated copies at
# worst. Remove them from the stage instead of relying on the repo .gitignore,
# which cannot affect what `cp` copies.
find "$stage" -type f -name '*.bak' -delete
find "$stage" -type f -name '*.bak-*' -delete
find "$stage" -type d -name '__pycache__' -prune -exec rm -rf -- {} +
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/cmd/"*
# Always rebuild the native child-subreaper; never ship a stale local binary.
# Static libc avoids introducing a build-host glibc version dependency on NAS.
bash "$root/scripts/build-cli-supervisor.sh" "$stage/app"
mkdir -p "$stage/app/runtime"
# BEGIN WRAPPER LICENSE STAGING
for notice in LICENSE LICENSING.md; do
  [[ -s "$root/$notice" ]] || { echo "required wrapper license missing or empty: $notice" >&2; exit 1; }
done
cp "$root/LICENSE" "$stage/app/LICENSE.PowerHarness"
cp "$root/LICENSING.md" "$stage/app/LICENSING.md"
chmod 0644 "$stage/app/LICENSE.PowerHarness" "$stage/app/LICENSING.md"
# END WRAPPER LICENSE STAGING
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
# Missing local working notes use reviewed public inputs; malformed existing notes fail.
python3 "$root/scripts/build-context.py" "$root" "$root/fnos/app" "$stage/app" --version "$target_version"
for required in app/AI-CONTEXT.md app/CHANGELOG-AI.md; do
  [[ -s "$stage/$required" ]] || { echo "required AI context file missing or empty: fnos/$required" >&2; exit 1; }
done
# These working notes name companion repositories (some private) and quote
# build-machine paths. Generalize the staged copies: the working copy keeps the
# precise names, the shipped copy does not. Only staged files are touched.
python3 "$root/scripts/sanitize-ai-context.py" \
  "$stage/app/AI-CONTEXT.md" "$stage/app/CHANGELOG-AI.md"
python3 "$root/scripts/sanitize-ai-context.py" --check \
  "$stage/app/AI-CONTEXT.md" "$stage/app/CHANGELOG-AI.md" \
  || { echo "AI context files still carry private identifiers after sanitizing" >&2; exit 1; }
# The changelog must mention the version being shipped, or the record is stale.
grep -q "^## \[$target_version\]" "$stage/app/CHANGELOG-AI.md" \
  || { echo "CHANGELOG-AI.md has no entry for version $target_version" >&2; exit 1; }

# Bundle the plugins this deployment uses, so a fresh install starts with the
# same set instead of needing a link: target or a private repository. The
# source profile is read only; --plugins-from overrides it for a build machine
# that has no live profile.
if [[ -n "${DSH_BUNDLE_PLUGINS_FROM:-}" ]]; then
  python3 "$root/scripts/bundle-plugins.py" "$DSH_BUNDLE_PLUGINS_FROM" "$stage/app/plugins-bundled" --require-licenses
elif [[ -d "${HOME:-/nonexistent}/.dsh/profiles/web/node_modules" ]]; then
  python3 "$root/scripts/bundle-plugins.py" "${HOME}/.dsh/profiles/web" "$stage/app/plugins-bundled" --require-licenses
elif [[ "${DSH_ALLOW_EMPTY_BUNDLED_PLUGINS:-0}" == 1 ]]; then
  echo "warning: explicitly building without recovery plugins" >&2
else
  echo "error: plugin recovery source missing; set DSH_BUNDLE_PLUGINS_FROM=<profile dir>" >&2
  echo "       use DSH_ALLOW_EMPTY_BUNDLED_PLUGINS=1 only for an intentional empty package" >&2
  exit 1
fi

python3 "$root/scripts/generate-install-wizard.py" "$stage"

npm ci --omit=dev --prefix "$stage/app/runtime" --cache "${DSH_NPM_CACHE:-$stage/.npm-cache}"
# npm ci only warns about advisories: it is NOT a release security gate.
# Network errors, vulnerabilities or SDK contract failures abort before fnpack,
# preserving the prior artifact and manifest instead of emitting an unsafe FPK.
npm audit --omit=dev --audit-level="${DSH_NPM_AUDIT_LEVEL:-low}" --prefix "$stage/app/runtime" --cache "${DSH_NPM_CACHE:-$stage/.npm-cache}"
node "$root/scripts/verify-mcp-runtime.mjs" "$stage/app/runtime"
node "$root/scripts/patch-dsh.mjs" "$stage/app/runtime"
# Data-only platform catalogue and read-only post-patch gate share the UI inspector.
node "$root/scripts/export-platform-patches.mjs" "$stage/app/platform-patches.json"
node "$root/scripts/platform-patch-status.mjs" "$stage/app/runtime" "$stage/app/platform-patches.json" > "$stage/platform-patch-status.json"
# Generate from the installed staged runtime, never copy a stale source declaration.
node "$root/scripts/generate-adapter.cjs" "$stage/app"
# Preserve exact-version upstream notices only in this private staging tree.
python3 "$root/scripts/stage-runtime-notices.py" --staging-root "$stage" --runtime "$stage/app/runtime"
# Inventory the installed payload, not the build host or a prior candidate.
python3 "$root/scripts/audit-runtime-licenses.py" --runtime "$stage/app/runtime" --out "$stage/app/third-party/runtime"
cp "$stage/app/third-party/runtime/runtime-licenses.json" "$root/dist/runtime-licenses.json"
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
