#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(realpath -e -- "${1:-$root/fnos/app}")"
[[ -d "$output" ]] || { echo "CLI helper output must be an existing directory" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo "CLI helper requires Linux x86_64" >&2; exit 1; }
command -v cc >/dev/null || { echo "C compiler with static libc is required" >&2; exit 1; }
cc -std=c11 -O2 -static -Wall -Wextra -Werror -fstack-protector-strong \
  -D_FORTIFY_SOURCE=2 -Wl,-z,relro,-z,now \
  "$root/fnos/native/cli-supervisor.c" -o "$output/cli-supervisor"
chmod 0755 "$output/cli-supervisor"
python3 - "$root/fnos/native/cli-supervisor.c" "$output" <<'PY'
import hashlib, json, pathlib, sys
source, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
digest = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
(output / 'cli-supervisor.json').write_text(json.dumps({
    'protocol': 1, 'sourceSha256': digest(source),
    'binarySha256': digest(output / 'cli-supervisor'),
}, indent=2) + '\n')
PY
