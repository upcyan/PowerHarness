#!/usr/bin/env python3
"""Build the bundled plugin tarballs that ship inside the FPK.

The FPK carries the plugins this deployment depends on, so a fresh install
starts with the same set instead of needing link: targets, a private GitHub
repo, or a local tgz. What ships is plugin *code* only:

  * packed with npm's own `files` semantics (the same rules `npm pack` uses),
    so a package's declared entry points and assets come along while anything
    it does not publish -- caches, saved state, logs -- stays behind;
  * credentials, sessions, workspaces and other per-user data never live in a
    plugin directory in the first place, and are explicitly excluded anyway;
  * `node_modules/` is excluded: the profile resolves shared dependencies from
    the DSH runtime and its fallback layer, so shipping them would duplicate
    (and potentially shadow) the core's own copies.

Usage:
    python3 scripts/bundle-plugins.py <source-profile> <out-dir> [--only NAME ...]
    python3 scripts/bundle-plugins.py --list <out-dir>

``<source-profile>`` is a profile directory to read the installed plugins from
(typically a live profile, or the app's own runtime for a build machine).
Output is one `<name>-<version>.tgz` per plugin plus a `bundled-plugins.json`
index that the installer reads at first start.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

# Anything matching these never enters a bundle, whatever the package says.
# Kept in sync with the installer's own exclusion list.
EXCLUDED_DIRS = {
    "node_modules", ".git", ".cache", ".npm", ".pnpm",
    "sessions", "session", "workspace", "workspaces", "logs", "log",
    "tmp", "temp", ".tmp", "coverage", ".nyc_output", "state", "data",
}
EXCLUDED_FILES = {
    ".credentials.yaml", "credentials.yaml", ".netrc", ".npmrc",
    "codebuddy-auth.json", ".openai-codex-auth.json", "settings.yaml",
    "state.json", ".anonymous-user-id", "cookies.json", "token.json",
    "auth.json", ".env",
}
# Credentials often arrive as a family (`.env`, `.env.local`, `.env.production`)
# or as a key file, so match on shape rather than enumerating every name. A
# name-only list is what let `.env.local` and `id_rsa` through the first time;
# the test suite pins each of these cases now.
EXCLUDED_PATTERNS = (
    re.compile(r"^\.env(\..+)?$"),                    # .env, .env.local, .env.production
    re.compile(r"^\.?credentials(\.|$)", re.I),       # credentials, .credentials.yaml
    re.compile(r"\.(pem|key|p12|pfx|jks|keystore)$", re.I),
    re.compile(r"^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$"),
    re.compile(r"^\.?(netrc|npmrc|pgpass|htpasswd)$", re.I),
)
EXCLUDED_SUFFIXES = (".log", ".pid", ".sock", ".sqlite", ".sqlite3", ".db")


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def read_manifest(profile: Path) -> dict:
    manifest = profile / "package.json"
    if not manifest.is_file():
        die(f"not a dsh profile (no package.json): {profile}")
    return json.loads(manifest.read_text(encoding="utf-8"))


def installed_plugins(profile: Path) -> list[str]:
    """Names of every declared dependency that is actually present.

    The declared spec is deliberately not returned: for a `link:` dependency it
    is the build machine's absolute path, and shipping it inside the FPK leaks
    a local directory into every package we hand out.
    """
    manifest = read_manifest(profile)
    found: list[str] = []
    for name in sorted((manifest.get("dependencies") or {})):
        package_dir = profile / "node_modules" / Path(*name.split("/"))
        if (package_dir / "package.json").is_file():
            found.append(name)
    return found


def package_version(package_dir: Path) -> str:
    try:
        return json.loads((package_dir / "package.json").read_text(encoding="utf-8")).get("version", "0.0.0")
    except Exception:
        return "0.0.0"


def safe_member(name: str) -> bool:
    """Reject absolute/traversing paths and anything that looks like data.

    Two layers: an exact-name list for the files this project knows about, and
    pattern rules for the shapes credentials usually take. The patterns matter
    because a name list only ever covers what someone thought of -- `.env.local`
    and `id_rsa` both slipped through a name-only version.
    """
    if not name or name.startswith("/") or os.path.isabs(name):
        return False
    parts = [p for p in Path(name).parts if p not in (".", "")]
    if any(p == ".." for p in parts):
        return False
    if any(part in EXCLUDED_DIRS for part in parts[:-1]):
        return False
    if parts and parts[-1] in EXCLUDED_DIRS:
        return False
    leaf = parts[-1] if parts else ""
    if leaf in EXCLUDED_FILES:
        return False
    if any(pattern.search(leaf) for pattern in EXCLUDED_PATTERNS):
        return False
    if leaf.lower().endswith(EXCLUDED_SUFFIXES):
        return False
    return True


def sanitize_text(data: bytes, name: str) -> bytes:
    """Generalize local-machine paths inside bundled text files.

    Self-authored plugins keep development notes in their README/docs with the
    build machine's absolute paths (a per-user workspace under `/vol1/<uid>/…`,
    `/vol1/@appdata/dsh-fnos/...`) and LAN addresses. None of that belongs in a
    package handed to other fnOS clients: it leaks the local layout, and the
    examples cannot work on another machine anyway. Only doc-ish text files are
    rewritten; code is left byte-identical so a future hunt for behavioural
    differences between source and bundle never has to ask "did the packer
    touch logic?".
    """
    if not name.endswith((".md", ".txt", ".yml", ".yaml", ".json")):
        return data
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return data
    replacements = (
        # absolute paths anchored at well-known local roots → placeholder.
        # The per-user root is matched generically (`/vol1/<uid>/…`) so this
        # sanitizer never has to spell out one machine's directory layout.
        (re.compile(r"/vol1/\d+/[^\s`\"')\]]*"), "<local-workspace>"),
        (re.compile(r"/vol1/@appdata/[^\s`\"')\]]*"), "<local-appdata>"),
        (re.compile(r"/vol1/@appcenter/[^\s`\"')\]]*"), "<local-appcenter>"),
        (re.compile(r"/mnt/[^\s`\"')\]]*"), "<local-mount>"),
        # LAN addresses → documentation placeholder
        (re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"), "<lan-address>"),
    )
    for pattern, repl in replacements:
        text = pattern.sub(repl, text)
    return text.encode("utf-8")


def npm_pack(package_dir: Path, out_dir: Path) -> Path:
    """Pack a package using npm's own `files` semantics.

    npm already implements "which files does this package publish" correctly,
    including the `files` allowlist, .npmignore, and the always-included
    package.json/README/LICENSE. Re-implementing that here would drift from
    what `npm publish` produces, so the real tool does the work and the result
    is filtered afterwards as a second line of defence.
    """
    npm = os.environ.get("FNOS_NPM_BIN", "npm")
    with tempfile.TemporaryDirectory(prefix="dsh-plugin-pack.") as staging:
        try:
            subprocess.run(
                [npm, "pack", "--pack-destination", staging, "--ignore-scripts", "--no-audit", "--no-fund"],
                cwd=package_dir, check=True, capture_output=True, text=True,
            )
        except FileNotFoundError:
            die("npm is required to bundle plugins")
        except subprocess.CalledProcessError as error:
            die(f"npm pack failed for {package_dir.name}: {(error.stderr or error.stdout or '').strip()}")
        produced = sorted(Path(staging).glob("*.tgz"))
        if len(produced) != 1:
            die(f"npm pack produced {len(produced)} archives for {package_dir.name}")

        # Re-filter: npm honours `files`, this drops anything sensitive that a
        # package without a `files` allowlist would otherwise publish.
        target = out_dir / produced[0].name
        dropped: list[str] = []
        with tarfile.open(produced[0], "r:gz") as src, tarfile.open(target, "w:gz", compresslevel=9) as dst:
            for member in src.getmembers():
                name = member.name[2:] if member.name.startswith("./") else member.name
                if not safe_member(name):
                    dropped.append(name)
                    continue
                if member.isdir():
                    continue
                if not member.isfile():
                    dropped.append(name)
                    continue
                data = src.extractfile(member).read()
                data = sanitize_text(data, name)
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                info.mtime = member.mtime
                dst.addfile(info, io.BytesIO(data))
        if dropped:
            print(f"    excluded {len(dropped)} entr{'y' if len(dropped) == 1 else 'ies'}: "
                  f"{', '.join(sorted(dropped)[:5])}{' …' if len(dropped) > 5 else ''}")
        return target


def digest(path: Path) -> str:
    h = hashlib.sha512()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return "sha512-" + base64.b64encode(h.digest()).decode()


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("profile", nargs="?", help="profile directory to read installed plugins from")
    parser.add_argument("out", nargs="?", help="directory to write the bundled tarballs into")
    parser.add_argument("--only", action="append", default=None,
                        help="restrict to these package names (repeatable)")
    parser.add_argument("--list", action="store_true",
                        help="print the index of the out directory instead of building")
    args = parser.parse_args(argv[1:])

    if args.list:
        out_dir = args.profile or args.out
        if not out_dir:
            die("--list needs the out directory")
        index = Path(out_dir) / "bundled-plugins.json"
        if not index.is_file():
            die(f"no index at {index}")
        data = json.loads(index.read_text(encoding="utf-8"))
        for entry in data.get("plugins", []):
            print(f"  {entry['name']:38} {entry['version']:12} {entry['file']}")
        return 0

    if not args.profile or not args.out:
        parser.error("need <source-profile> and <out-dir>")

    profile = Path(args.profile).resolve()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    # A stale bundle would silently ship yesterday's code.
    for old in out_dir.glob("*.tgz"):
        old.unlink()

    want = set(args.only) if args.only else None
    entries: list[dict] = []
    print(f"bundling plugins from {profile}")
    for name in installed_plugins(profile):
        if want is not None and name not in want:
            continue
        package_dir = profile / "node_modules" / Path(*name.split("/"))
        version = package_version(package_dir)
        print(f"  {name}@{version}")
        archive = npm_pack(package_dir, out_dir)
        entries.append({
            "name": name,
            "version": version,
            "file": archive.name,
            "integrity": digest(archive),
        })

    if want is not None:
        missing = want - {e["name"] for e in entries}
        if missing:
            die(f"requested plugins not installed in {profile}: {', '.join(sorted(missing))}")

    index = {
        "schema": 1,
        # The installer only uses these on a brand-new profile; existing
        # profiles keep whatever the user chose.
        "note": "Written into a profile only on first install. Later upgrades never re-add a plugin the user removed.",
        "plugins": entries,
    }
    (out_dir / "bundled-plugins.json").write_text(
        json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(entries)} bundle(s) + bundled-plugins.json to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
