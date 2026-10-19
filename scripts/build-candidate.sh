#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Dedicated build machines only; never invoke a platform installer or live supervisor.
output="${FNOS_CANDIDATE_OUTPUT:?Set an absolute, empty candidate output directory}"
[[ "$output" = /* && "$output" != / && ! -L "$output" ]] || exit 2
[[ ! -e "$output" ]] || { echo "Candidate output exists; refuse overwrite" >&2; exit 2; }
mkdir -m 700 -p "$output"
exec 9>"$root/.candidate-build.lock"
flock -n 9 || { echo "Another candidate build is running" >&2; exit 3; }
source_revision="$(git -C "$root" rev-parse HEAD)"
python3 "$root/scripts/check-deployment-entrypoints.py"
# Use a copied source tree so the recorded source version never changes on build.
stage="$output/source"
mkdir -m 700 "$stage"
for item in fnos scripts package.json package-lock.json LICENSE LICENSING.md; do cp -a "$root/$item" "$stage/$item"; done
# Publicly reproducible candidates use public context, never raw working notes.
python3 - "$stage" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve(strict=True)
app = root / "fnos" / "app"
if app.is_symlink() or app.resolve(strict=True) != app:
    raise SystemExit("candidate app staging path is not canonical")
for name in ("AI-CONTEXT.md", "CHANGELOG-AI.md"):
    target = app / name
    if target.is_symlink():
        raise SystemExit("private context staging copy must not be linked")
    if target.exists():
        if not target.is_file() or target.parent != app:
            raise SystemExit("unsafe private context staging copy")
        target.unlink()  # Only freshly copied files under this unique candidate stage.
PY
export HOME="$output/home" NPM_CONFIG_CACHE="$output/npm-cache"
mkdir -m 700 "$HOME"
plugins_bundled=false
if [[ -n "${FNOS_CANDIDATE_PLUGINS_FROM:-}" ]]; then
  [[ -d "$FNOS_CANDIDATE_PLUGINS_FROM/node_modules" ]] || { echo "Plugin source missing" >&2; exit 2; }
  export DSH_BUNDLE_PLUGINS_FROM="$FNOS_CANDIDATE_PLUGINS_FROM"
  unset DSH_ALLOW_EMPTY_BUNDLED_PLUGINS
  plugins_bundled=true
else
  export DSH_ALLOW_EMPTY_BUNDLED_PLUGINS=1
  unset DSH_BUNDLE_PLUGINS_FROM
fi
unset FNOS_DATA_DIR FNOS_APP_DIR DSH_HOME NODE_OPTIONS
node --test "$root/tests/version.test.cjs" "$root/tests/port-owner.test.cjs" > "$output/prebuild-tests.log" 2>&1
python3 "$root/scripts/check-deployment-entrypoints.py"
build_args=()
if [[ -n "${FNOS_CANDIDATE_VERSION:-}" ]]; then
  python3 "$stage/scripts/version.py" set "$FNOS_CANDIDATE_VERSION" --manifest "$stage/fnos/manifest" >/dev/null
fi
bash "$stage/scripts/build-linux.sh" "${build_args[@]}" > "$output/build.log" 2>&1
cp -a "$stage/dist" "$output/artifacts"
(cd "$stage"; LC_ALL=C find fnos scripts -type f -print0 | sort -z | xargs -0 sha256sum; sha256sum package.json package-lock.json LICENSE LICENSING.md) > "$output/source-SHA256SUMS"
(cd "$output/artifacts"; sha256sum *.fpk) > "$output/SHA256SUMS"
source_manifest_sha256="$(sha256sum "$output/source-SHA256SUMS" | cut -d " " -f1)"
printf '{"sourceRevision":"%s","sourceRevisionRole":"base-commit","sourceManifestSha256":"%s","privateWorkingNotesIncluded":false,"channel":"candidate","deployed":false,"published":false,"pluginsBundled":%s,"distributable":false,"licenseClearance":"not-assessed"}\n' "$source_revision" "$source_manifest_sha256" "$plugins_bundled" > "$output/candidate.json"
echo "Candidate generated only; no deployment, release, manifest commit or live service action"
