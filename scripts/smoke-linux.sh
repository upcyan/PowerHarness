#!/usr/bin/env bash
set -euo pipefail

# ── 隔离硬闸门 ──────────────────────────────────────────────────────────────
# 本脚本 spawn 真正的 supervisor，而 supervisor 的 resolveDshHomePath() 会把
# `/opt/dsh/home` 指向它自己的 dataDir。dataDir 是 mktemp 建的临时目录 ⇒
# 在生产环境直接跑本脚本，会把**生产桥接改指到 /tmp**：
#   · 当下服务照常（链接目标可达），故障延迟到 /tmp 被清理时才爆发；
#   · 之后核心每次 mkdir/open 都 ENOENT（表现像核心坏了，实为死链）。
#
# 这不是假设，而是第二次发生：
#   · 2026-10-03 `node --test tests/*.cjs` 通配符跑到 supervisor.test.cjs
#     → 桥接改指 /tmp/dsh-fnos-heal-XXX → 数小时后进 safe mode（见 INCIDENT-P23）。
#   · 2026-10-07 本脚本被直接运行 → 桥接改指 /tmp/dsh-fnos-smoke.XXX →
#     /tmp 清理后死链，生产核心所有写入 ENOENT（见 P27）。
#
# supervisor.test.cjs 的整改结论是"不能指望调用者记得先读文档"，于是它自己
# 检查隔离状态。本脚本照做：没有测试专用的 /opt/dsh 绑定、或生产挂载仍可写，
# 就**拒绝运行**（退出码 2），而不是把风险留给下一次 /tmp 清理。
require_isolation() {
  local mounts
  mounts="$(cat /proc/self/mountinfo)"
  # 测试夹具会把一个私有目录 bind 到 /opt/dsh，同时把仓库、appdata、appcenter
  # 与 /opt 挂成只读。五者缺一都不算隔离。
  if ! grep -qE ' /opt/dsh( |$)' <<<"$mounts"; then
    echo "拒绝运行：/opt/dsh 没有测试专用绑定 —— 直接运行会把生产桥接改指到临时目录。" >&2
    echo "  请改用：python3 pwtest/powerharness/supervisor-integration-isolated.py --suite smoke" >&2
    exit 2
  fi
  local dir
  # 注意路径要与隔离夹具实际挂载的一致：被只读挂载的是本脚本所在的仓库根
  # （$root = …/fnos/PowerHarness），不是它的父目录。
  for dir in "$root" "/vol1/@appdata/dsh-fnos" "/vol1/@appcenter/dsh-fnos" "/opt"; do
    # mountinfo 第 6 个字段是挂载选项；只读挂载含 "ro"。
    if ! awk -v t="$dir" '$5==t {print $6}' <<<"$mounts" | grep -q 'ro'; then
      echo "拒绝运行：$dir 不是只读挂载 —— 隔离不完整，可能误写生产数据。" >&2
      echo "  请改用：python3 pwtest/powerharness/supervisor-integration-isolated.py --suite smoke" >&2
      exit 2
    fi
  done
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_tree=''
if [[ "${1:-}" == --app-tree ]]; then
  [[ $# -eq 2 && -d "$2/runtime" ]] || { echo "--app-tree requires one installed candidate app directory" >&2; exit 2; }
  app_tree="$(realpath -- "$2")"
  package=''
else
  package="${1:-$root/dist/dsh-fnos.fpk}"
fi
stage="$(mktemp -d "${TMPDIR:-/tmp}/dsh-fnos-smoke.XXXXXXXX")"
stage="$(realpath -- "$stage")"
stage_parent="$(realpath -- "${TMPDIR:-/tmp}")"
pid=''
cleanup() {
  if [[ -n "$pid" ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  local resolved
  resolved="$(realpath -m -- "${stage:?}")" || return 1
  [[ "$resolved" == "$stage_parent"/dsh-fnos-smoke.* && "$resolved" != "$stage_parent" ]] || { echo "refusing unsafe smoke cleanup" >&2; return 1; }
  rm -rf -- "$resolved"
}
trap cleanup EXIT

require_isolation

mkdir -p "$stage/app" "$stage/data" "$stage/etc"
if [[ -n "$app_tree" ]]; then
  # Validate the exact staged dependency tree before creating any FPK.
  cp -a "$app_tree/." "$stage/app/"
else
  tar -xOf "$package" app.tgz | tar -xzf - -C "$stage/app"
fi
cd "$stage/app/runtime"
node -e 'const {createRequire}=require("node:module"); const r=createRequire(process.cwd()+"/node_modules/@deepseek-ai/dsh/package.json"); for(const name of ["node-pty", "koffi", "sharp"]) { r(name); console.log(`${name}: OK`) }'
pnpm_bin="$stage/app/runtime/node_modules/.bin/pnpm"
[[ -x "$pnpm_bin" ]] || { echo "Bundled pnpm is missing or not executable" >&2; exit 1; }
pnpm_version="$("$pnpm_bin" --version)"
[[ "$pnpm_version" == 10.34.5 ]] || { echo "Unexpected pnpm version: $pnpm_version" >&2; exit 1; }
pnpm_store="$(PNPM_HOME="$stage/data/pnpm-home" npm_config_store_dir="$stage/data/pnpm-store" "$pnpm_bin" store path)"
[[ "$pnpm_store" == "$stage/data/pnpm-store"* ]] || { echo "pnpm store escaped application data: $pnpm_store" >&2; exit 1; }
echo "private pnpm $pnpm_version: OK"

# Execute the actual packaged adapter/helper, not the development-tree binary.
node - "$stage/app" "$stage/data" <<'JS'
const assert = require('node:assert/strict'), path = require('node:path');
const [app, data] = process.argv.slice(2);
const plugins = require(path.join(app, 'plugins.js'));
const code = 'console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups().sort((a,b)=>a-b),cwd:process.cwd(),marker:process.env.FNOS_SMOKE_CLI,args:process.argv.slice(1)}))';
(async () => {
  const result = await plugins.runCli(process.execPath, ['-e', code, '--', 'literal with spaces'], {
    cwd: data, env: {...process.env, DSH_HOME:path.join(data,'dsh-home'), FNOS_SMOKE_CLI:'isolated'},
    logFile:path.join(data,'cli-smoke.log'), timeoutMs:3000,
  });
  assert.equal(result.closed,true); assert.equal(result.code,0);
  assert.deepEqual(JSON.parse(result.text), {uid:process.getuid(),gid:process.getgid(),groups:process.getgroups().sort((a,b)=>a-b),cwd:data,marker:'isolated',args:['literal with spaces']});
  assert.equal(plugins.cliOperationStatus().length,0);
  console.log('packaged CLI subreaper: closed receipt, identity/cwd/env/argv OK');
})().catch(error=>{console.error(error);process.exitCode=1});
JS

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
        # `__FNOS_GATEWAY_PREFIX__` lives inside plugin-url-compat.js, which the
        # page pulls in as an *external* script — the HTML can only assert the
        # reference. The prefix logic itself has to be checked in the served
        # script, which also proves the route is reachable (it is denied by
        # default for non-allowlisted plugin paths).
        grep -q 'src="/app/dsh-fnos/dsh/__fnos-plugin-url-compat\.js"' "$stage/remote-page.html" \
          || { cat "$stage/remote-page.html"; exit 1; }
        compat_status="$(curl --silent --show-error --unix-socket "$stage/app/guide.sock" \
          -H 'Host: remote.fnnas.example' -H 'X-Trim-IsAdmin: true' \
          -b "$stage/remote-cookies" -o "$stage/compat.js" -w '%{http_code}' \
          "http://localhost/app/dsh-fnos/dsh/__fnos-plugin-url-compat.js")"
        [[ "$compat_status" == 200 ]] || { cat "$stage/remote-flow.headers"; exit 1; }
        grep -q '__FNOS_GATEWAY_PREFIX__' "$stage/compat.js" || { cat "$stage/compat.js"; exit 1; }
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
