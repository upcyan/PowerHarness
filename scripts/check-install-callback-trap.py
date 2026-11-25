#!/usr/bin/env python3
"""CI/read-only gate: fnOS install_callback must survive a failing child command.

fnOS treats a non-zero exit from `cmd/install_callback` as "install failed" and
shows the popup "无法安装". Two defects in that script made *every* install fail
regardless of the package:

  1) `trap migrate_error ERR` calls a handler that uses `${1}`. Under `set -u`
     the trap itself explodes with "unbound variable" and swallows the real
     error. Real-machine proof: the last line of /var/log/apps/dsh-fnos.log was
     "install_callback: line 15: 1: unbound variable" for the shipped 0.3.106
     and 0.3.107 packages alike.
  2) `set +e` does NOT disarm an ERR trap (measured: the trap still fires on a
     failing command), so the `rc == 2` branch ("data/backup directory not
     authorised yet" - a normal, expected path) was never reached and the
     script exited 1.

The fix is `trap 'migrate_error "..."' ERR` plus `cmd || init_rc=$?`.
This gate refuses to pack a package that still carries either defect, so a
future edit cannot silently reintroduce them.

Usage: check-install-callback-trap.py <install_callback> [<install_callback> ...]
"""
import re
import subprocess
import sys
from pathlib import Path

BARE_TRAP = re.compile(r"^\s*trap\s+migrate_error\s+ERR\s*$", re.M)
TRAP_WITHOUT_ARG = re.compile(r"^\s*trap\s+migrate_error\b", re.M)
TRAP_WITH_ARG = re.compile(r"^\s*trap\s+'migrate_error", re.M)
INIT_CALL = re.compile(r"^\s*node\s+.*install-options-cli\.js.*\binit\b", re.M)
CAPTURED_RC = re.compile(r"\|\|\s*init_rc=\$\?")


def check(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        return [f"{path}: cannot read ({error})"]

    failures: list[str] = []
    if BARE_TRAP.search(text):
        failures.append(
            f"{path}: ERR trap calls migrate_error without arguments; "
            "${1} under set -u makes the trap explode (unbound variable)"
        )
    elif TRAP_WITHOUT_ARG.search(text) and not TRAP_WITH_ARG.search(text):
        failures.append(
            f"{path}: ERR trap for migrate_error must pass its argument "
            "(trap 'migrate_error \"...\"' ERR)"
        )
    if INIT_CALL.search(text) and not CAPTURED_RC.search(text):
        failures.append(
            f"{path}: init exit code must be captured with '|| init_rc=$?'; "
            "set +e does not disarm the ERR trap, so the rc==2 branch is unreachable"
        )
    if re.search(r"^\s*init_rc=\$\?\s*$", text, re.M) and CAPTURED_RC.search(text):
        failures.append(
            f"{path}: a bare 'init_rc=$?' after the capture overwrites it with 0"
        )

    syntax = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
    if syntax.returncode != 0:
        failures.append(f"{path}: bash -n failed: {syntax.stderr.strip()}")
    return failures


def main(argv: list[str]) -> int:
    paths = [Path(item) for item in argv[1:]]
    if not paths:
        print("usage: check-install-callback-trap.py <install_callback> [...]", file=sys.stderr)
        return 2
    failures: list[str] = []
    for path in paths:
        failures.extend(check(path))
    if failures:
        print("INSTALL CALLBACK TRAP BLOCK:\n" + "\n".join(failures), file=sys.stderr)
        return 1
    print(f"install_callback trap gate: PASS ({len(paths)} script(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
