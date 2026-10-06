#!/usr/bin/env python3
"""Read and bump the FPK version in fnos/manifest.

Both build paths need this and they must agree -- a version bumped by one
entry point and not the other is how a shipped FPK silently reuses the
version the app store already has, which makes fnOS treat it as "no update".

Usage:
    version.py show [--manifest PATH]          # print the current version
    version.py bump [which] [--manifest PATH]  # print the next version (no write)
    version.py set <version> [--manifest PATH] # write an explicit version

``--manifest`` defaults to fnos/manifest. The build scripts use it to stamp
the version into the *staged* copy, and only write the source manifest back
after a successful pack -- so a failed build never advances the version.

``bump`` only computes and prints; it never writes.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

DEFAULT_MANIFEST = Path(__file__).resolve().parent.parent / "fnos" / "manifest"
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
# The manifest is a flat `key=value` file; fnpack normalizes the padding, so
# the source keeps the bare form.
LINE_RE = re.compile(r"^(\s*version\s*)=(.*)$", re.MULTILINE)


def split_manifest_arg(argv: list[str]) -> tuple[list[str], Path]:
    """Pull an optional --manifest PATH out of argv.

    Kept out of argparse so the subcommands stay trivially composable from a
    shell script (``$(version.py bump patch --manifest "$stage/manifest")``).
    """
    rest: list[str] = []
    manifest = DEFAULT_MANIFEST
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--manifest":
            if index + 1 >= len(argv):
                raise SystemExit("error: --manifest needs a path")
            manifest = Path(argv[index + 1])
            index += 2
            continue
        if arg.startswith("--manifest="):
            manifest = Path(arg.split("=", 1)[1])
            index += 1
            continue
        rest.append(arg)
        index += 1
    return rest, manifest


def read(manifest: Path) -> str:
    try:
        text = manifest.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise SystemExit(f"error: manifest not found: {manifest}")
    match = LINE_RE.search(text)
    if not match:
        raise SystemExit(f"error: {manifest} has no version field")
    return match.group(2).strip()


def next_version(current: str, which: str = "patch") -> str:
    match = VERSION_RE.match(current.strip())
    if not match:
        raise SystemExit(f"error: cannot bump non-semantic version: {current!r}")
    major, minor, patch = (int(part) for part in match.groups())
    if which == "major":
        return f"{major + 1}.0.0"
    if which == "minor":
        return f"{major}.{minor + 1}.0"
    if which == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise SystemExit(f"error: unknown bump kind: {which!r} (patch|minor|major)")


def write(manifest: Path, version: str) -> None:
    version = version.strip()
    if not VERSION_RE.match(version):
        raise SystemExit(f"error: refusing to write non-semantic version: {version!r}")
    try:
        text = manifest.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise SystemExit(f"error: manifest not found: {manifest}")
    updated, count = LINE_RE.subn(lambda m: f"{m.group(1)}={version}\n", text, count=1)
    if count != 1:
        raise SystemExit(f"error: {manifest} has no version field")
    manifest.write_text(updated, encoding="utf-8", newline="\n")


def main(argv: list[str]) -> int:
    args, manifest = split_manifest_arg(argv[1:])
    if not args:
        raise SystemExit(__doc__.strip().splitlines()[0])
    command, rest = args[0], args[1:]
    if command == "show":
        print(read(manifest))
        return 0
    if command == "bump":
        which = rest[0] if rest else "patch"
        print(next_version(read(manifest), which))
        return 0
    if command == "set":
        if not rest:
            raise SystemExit("error: set needs a version")
        write(manifest, rest[0])
        print(rest[0])
        return 0
    raise SystemExit(f"error: unknown command: {command!r} (show|bump|set)")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
