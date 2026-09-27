#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="${1:-$root/dist/dsh-fnos.fpk}"
stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-fnos-smoke.XXXXXXXX")"
pid=''
cleanup() {
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf -- "$stage"
}
trap cleanup EXIT

mkdir -p "$stage/app" "$stage/data" "$stage/etc"
tar -xOf "$package" app.tgz | tar -xzf - -C "$stage/app"
cd "$stage/app/runtime"
node -e 'const {createRequire}=require("node:module"); const r=createRequire(process.cwd()+"/node_modules/@deepseek-ai/dsh/package.json"); for(const name of ["node-pty", "koffi", "sharp"]) { r(name); console.log(`${name}: OK`) }'
pnpm_bin="$stage/app/runtime/node_modules/.bin/pnpm"
[[ -x "$pnpm_bin" ]] || { echo "Bundled pnpm is missing or not executable" >&2; exit 1; }
pnpm_version="$("$pnpm_bin" --version)"
[[ "$pnpm_version" == 10.34.5 ]] || { echo "Unexpected pnpm version: $pnpm_version" >&2; exit 1; }
pnpm_store="$(PNPM_HOME="$stage/data/pnpm-home" npm_config_store_dir="$stage/data/pnpm-store" "$pnpm_bin" store path)"
[[ "$pnpm_store" == "$stage/data/pnpm-store"* ]] || { echo "pnpm store escaped application data: $pnpm_store" >&2; exit 1; }
echo "private pnpm $pnpm_version: OK"

FNOS_APP_DIR="$stage/app" FNOS_DATA_DIR="$stage/data" FNOS_CONFIG_DIR="$stage/etc" \
  GUIDE_SOCKET="$stage/app/guide.sock" FNOS_PORT=3080 FNOS_NAS_IPV4=127.0.0.1 \
  node "$stage/app/supervisor.js" > "$stage/supervisor.log" 2>&1 &
pid=$!

for ((i=0; i<100; i++)); do
  if [[ -f "$stage/data/state.json" ]]; then
    mode="$(node -p "JSON.parse(require('node:fs').readFileSync('$stage/data/state.json')).mode")"
    if [[ "$mode" == ready && -S "$stage/app/guide.sock" ]]; then
      status="$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' --max-time 3 https://127.0.0.1:3080/ || true)"
      if [[ "$status" == 401 || "$status" == 403 ]]; then
        curl --silent --show-error --unix-socket "$stage/app/guide.sock" \
          -H 'Host: 127.0.0.1:5666' -H 'X-Trim-IsAdmin: true' \
          -D "$stage/guide.headers" -o "$stage/guide.html" http://127.0.0.1/app/dsh-fnos
        grep -q '应用设置' "$stage/guide.html" || { cat "$stage/guide.headers" "$stage/guide.html"; exit 1; }
        ticket="$(sed -n 's/.*<iframe[^>]*src="\([^"]*\)".*/\1/p' "$stage/guide.html")"
        [[ "$ticket" == https://127.0.0.1:3080/_fnos/start?ticket=* ]] || { cat "$stage/guide.headers" "$stage/guide.html"; exit 1; }
        curl --insecure --silent --show-error --location --max-redirs 5 \
          -H 'Sec-Fetch-Site: cross-site' -H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: iframe' \
          -c "$stage/cookies" -b "$stage/cookies" -D "$stage/flow.headers" \
          -o "$stage/page.html" "$ticket"
        if ! grep -qi '<html' "$stage/page.html"; then
          cat "$stage/flow.headers" "$stage/page.html"
          exit 1
        fi
        curl --silent --show-error --unix-socket "$stage/app/guide.sock" \
          -H 'Host: remote.fnnas.example' -H 'X-Trim-IsAdmin: true' \
          -o "$stage/remote-guide.html" http://localhost/app/dsh-fnos
        remote_ticket="$(sed -n 's/.*<iframe[^>]*src="\([^"]*\)".*/\1/p' "$stage/remote-guide.html")"
        [[ "$remote_ticket" == /app/dsh-fnos/dsh/start?ticket=* ]] || { cat "$stage/remote-guide.html"; exit 1; }
        curl --silent --show-error --location --max-redirs 5 --unix-socket "$stage/app/guide.sock" \
          -H 'Host: remote.fnnas.example' -H 'X-Trim-IsAdmin: true' \
          -c "$stage/remote-cookies" -b "$stage/remote-cookies" \
          -D "$stage/remote-flow.headers" -o "$stage/remote-page.html" "http://localhost$remote_ticket"
        grep -q '<base href="/app/dsh-fnos/dsh/">' "$stage/remote-page.html" || { cat "$stage/remote-flow.headers" "$stage/remote-page.html"; exit 1; }
        grep -q '__FNOS_GATEWAY_PREFIX__' "$stage/remote-page.html" || { cat "$stage/remote-page.html"; exit 1; }
        asset="$(sed -n 's/.*src="\.\/\(assets\/[^\"]*\.js\)".*/\1/p' "$stage/remote-page.html" | head -n 1)"
        [[ -n "$asset" ]] || { cat "$stage/remote-page.html"; exit 1; }
        asset_status="$(curl --silent --show-error --unix-socket "$stage/app/guide.sock" \
          -H 'Host: remote.fnnas.example' -H 'X-Trim-IsAdmin: true' \
          -b "$stage/remote-cookies" -o "$stage/asset.js" -w '%{http_code}' \
          "http://localhost/app/dsh-fnos/dsh/$asset")"
        [[ "$asset_status" == 200 ]] || { cat "$stage/remote-flow.headers"; exit 1; }
        echo "dsh and fnOS gateway: ready (HTTPS $status, direct and remote ticket, HTML and JS asset OK)"
        exit 0
      fi
    fi
    if [[ "$mode" == safe ]]; then break; fi
  fi
  sleep 1
done

cat "$stage/data/state.json" 2>/dev/null || true
cat "$stage/supervisor.log" 2>/dev/null || true
cat "$stage/data/dsh.log" 2>/dev/null || true
cat "$stage/data/gateway.log" 2>/dev/null || true
exit 1
