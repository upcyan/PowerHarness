#!/usr/bin/env python3
"""Repack the dsh-fnos FPK on Windows without WSL or fnpack.

Reuses the Linux runtime (app/runtime/node_modules, including prebuilt
linux-x64 native modules) from a reference FPK and rebuilds the
application layer from fnos/. Aborts unless the reference runtime matches
the current package.json / package-lock.json and patch-dsh.mjs.

FPK layout produced (verified against an fnpack 1.2.3 build):
  <fpk> = tar.gz of [app.tgz, cmd/, config/, ICON.PNG, ICON_256.PNG,
                     manifest(+checksum), wizard/]
  app.tgz = tar.gz of fnos/app contents (runtime/ carried over)
  manifest.checksum = MD5 of app.tgz
"""
import argparse
import hashlib
import io
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def extract_member(archive, name, dest):
    """Extract one member of a trusted archive, refusing unsafe paths.

    tarfile's `filter=` argument (the 3.12+ way to get this safety) does not
    exist on 3.11, so the check is done explicitly to keep this script usable
    on the Python that ships with fnOS-adjacent build machines.
    """
    member = archive.getmember(name)
    if member.name != name or os.path.isabs(member.name) or ".." in member.name.split("/"):
        die(f"refusing to extract unsafe member: {member.name}")
    archive.extract(member, dest)


def rel_files(base):
    files, dirs = {}, set()
    for r, ds, fs in os.walk(base):
        rel = os.path.relpath(r, base).replace("\\", "/")
        if rel != ".":
            dirs.add(rel)
        for f in fs:
            name = f"{rel}/{f}" if rel != "." else f
            files[name] = os.path.join(r, f)
    return files, dirs


def fresh_member(name, path, mode=0o644, mtime=None):
    st = os.stat(path)
    m = tarfile.TarInfo(name)
    m.type = tarfile.REGTYPE
    m.mode = mode
    m.size = st.st_size
    m.mtime = int(mtime if mtime is not None else st.st_mtime)
    m.uid = m.gid = 0
    m.uname = m.gname = "root"
    return m


def build_app_tgz(ref, app_dir, patch_script, out_path, extra_dirs=None):
    src = tarfile.open(ref, "r:gz")
    members = src.getmembers()
    old_names = {m.name for m in members}

    src_files, src_dirs = rel_files(app_dir)
    # Build-generated directories (the bundled plugin tarballs) are layered on
    # top of the source tree so they ship without being written into fnos/app.
    for prefix, directory in (extra_dirs or {}).items():
        extra_files, extra_dirs = rel_files(directory)
        for rel, absolute in extra_files.items():
            src_files[f"{prefix}/{rel}"] = absolute
        for rel in extra_dirs:
            src_dirs.add(f"{prefix}/{rel}")
        src_dirs.add(prefix)
    if "runtime" not in old_names:
        die("reference FPK has no app/runtime; a full Linux build is required")

    # guards: runtime must match current lockfile and patch script
    for name, repo in (
        ("runtime/package.json", os.path.join(ROOT, "package.json")),
        ("runtime/package-lock.json", os.path.join(ROOT, "package-lock.json")),
    ):
        m = src.extractfile(name) if name in old_names else None
        old = m.read() if m else b""
        with open(repo, "rb") as f:
            cur = f.read()
        if old != cur:
            die(f"{name} differs from {repo}; full Linux rebuild required")
    pm = src.extractfile("patch-dsh.mjs") if "patch-dsh.mjs" in old_names else None
    with open(patch_script, "rb") as f:
        cur_patch = f.read()
    if pm is None or pm.read() != cur_patch:
        die("patch-dsh.mjs differs from reference runtime; full Linux rebuild required")
    # The frontend compatibility shim is read by patch-dsh.mjs at build time from
    # its own directory; keep it consistent with the reference too.
    compat_repo = os.path.join(os.path.dirname(patch_script), "legacy-compat.js")
    cm = src.extractfile("legacy-compat.js") if "legacy-compat.js" in old_names else None
    with open(compat_repo, "rb") as f:
        cur_compat = f.read()
    if cm is None or cm.read() != cur_compat:
        die("legacy-compat.js differs from reference runtime; full Linux rebuild required")

    with tarfile.open(out_path, "w:gz", compresslevel=9) as out:
        for m in members:
            if m.name == "runtime" or m.name.startswith("runtime/"):
                out.addfile(m, src.extractfile(m) if m.isfile() else None)
            elif m.name == "patch-dsh.mjs":
                out.addfile(fresh_member(m.name, patch_script),
                            open(patch_script, "rb"))
            elif m.name == "legacy-compat.js":
                out.addfile(fresh_member(m.name, compat_repo),
                            open(compat_repo, "rb"))
            elif m.isfile() and m.name in src_files:
                out.addfile(fresh_member(m.name, src_files[m.name]),
                            open(src_files[m.name], "rb"))
            elif m.isdir() and m.name in src_dirs:
                dm = tarfile.TarInfo(m.name)
                dm.type = tarfile.DIRTYPE
                dm.mode = 0o755
                dm.mtime = m.mtime
                dm.uid = dm.gid = 0
                dm.uname = dm.gname = "root"
                out.addfile(dm)
            # else: file removed from fnos/app -> dropped
        # files added since the reference build
        for name in sorted(set(src_files) - old_names):
            parent = os.path.dirname(name)
            if parent and parent not in old_names and parent not in src_dirs:
                continue  # unreachable in practice
            out.addfile(fresh_member(name, src_files[name]),
                        open(src_files[name], "rb"))
    src.close()


def build_fpk(app_tgz, fnos_dir, out_path, version=None):
    with open(app_tgz, "rb") as f:
        digest = hashlib.md5(f.read()).hexdigest()
    # fnpack normalizes the manifest to aligned "key<pad>27 = value" lines
    with open(os.path.join(fnos_dir, "manifest"), "r", encoding="utf-8") as f:
        norm = []
        for line in f:
            line = line.rstrip("\r\n")
            if not line.strip():
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                # `version` is stamped here rather than in the source file, so
                # a build that dies before packing leaves the manifest alone.
                if version is not None and k.strip() == "version":
                    v = f" {version}"
                norm.append(f"{k.strip():<27}= {v.strip()}")
            else:
                norm.append(line)
    norm.append(f"{'checksum':<27}= {digest}")
    manifest = ("\n".join(norm) + "\n").encode()

    entries = []  # (name, kind, path|bytes, mode)
    entries.append(("app.tgz", "f", app_tgz, 0o644))
    skip = {"app"}
    for r, ds, fs in os.walk(fnos_dir):
        rel = os.path.relpath(r, fnos_dir).replace("\\", "/")
        if rel == ".":
            ds[:] = [d for d in ds if d not in skip]
        if rel != ".":
            entries.append((rel, "d", None, 0o755))
        for f_ in fs:
            name = f"{rel}/{f_}" if rel != "." else f_
            path = os.path.join(r, f_)
            if name == "manifest":
                entries.append((name, "b", manifest, 0o644))
            else:
                mode = 0o755 if rel == "cmd" else 0o644
                entries.append((name, "f", path, mode))
    entries.sort(key=lambda e: e[0].lower())

    with tarfile.open(out_path, "w:gz", compresslevel=9) as out:
        for name, kind, payload, mode in entries:
            m = tarfile.TarInfo(name)
            m.mode = mode
            m.uid = m.gid = 0
            m.uname = m.gname = "root"
            m.mtime = int(time.time())
            if kind == "d":
                m.type = tarfile.DIRTYPE
                m.mode = 0o755
                out.addfile(m)
            elif kind == "b":
                m.type = tarfile.REGTYPE
                m.size = len(payload)
                out.addfile(m, io.BytesIO(payload))
            else:
                st = os.stat(payload)
                m.type = tarfile.REGTYPE
                m.size = st.st_size
                m.mtime = int(st.st_mtime)
                out.addfile(m, open(payload, "rb"))
    return digest


def manifest_version(fnos_dir):
    script = os.path.join(ROOT, "scripts", "version.py")
    manifest = os.path.join(fnos_dir, "manifest")
    try:
        return subprocess.run([sys.executable, script, "show", "--manifest", manifest],
                              check=True, capture_output=True, text=True).stdout.strip()
    except subprocess.CalledProcessError as error:
        die(f"cannot read version: {(error.stderr or error.stdout or '').strip()}")


def next_manifest_version(fnos_dir, which="patch"):
    """Compute (but do not write) the next version.

    Delegates to scripts/version.py so this path and build-linux.sh share one
    implementation -- two bump implementations that disagree is exactly how a
    shipped FPK ends up reusing a version the app store already has.
    """
    script = os.path.join(ROOT, "scripts", "version.py")
    manifest = os.path.join(fnos_dir, "manifest")
    try:
        return subprocess.run([sys.executable, script, "bump", which, "--manifest", manifest],
                              check=True, capture_output=True, text=True).stdout.strip()
    except subprocess.CalledProcessError as error:
        die(f"cannot bump version: {(error.stderr or error.stdout or '').strip()}")


def write_manifest_version(fnos_dir, version):
    script = os.path.join(ROOT, "scripts", "version.py")
    manifest = os.path.join(fnos_dir, "manifest")
    try:
        subprocess.run([sys.executable, script, "set", version, "--manifest", manifest],
                       check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as error:
        die(f"cannot write version: {(error.stderr or error.stdout or '').strip()}")


def bundle_plugins(out_dir, source):
    """Generate the bundled plugin tarballs into out_dir.

    Written to a scratch directory rather than into fnos/app: the generated
    files are build output, and leaving them in the source tree would make
    every later run pick up a stale copy (and dirty the repository).
    """
    if not source:
        print("note: no plugin source profile given; building without bundled plugins")
        return None
    if not os.path.isfile(os.path.join(source, "package.json")):
        die(f"plugin source profile has no package.json: {source}")
    script = os.path.join(ROOT, "scripts", "bundle-plugins.py")
    os.makedirs(out_dir, exist_ok=True)
    try:
        subprocess.run([sys.executable, script, source, out_dir], check=True)
    except subprocess.CalledProcessError as error:
        die(f"bundling plugins failed: {(error.stderr or error.stdout or '').strip()}")
    return out_dir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", default=os.path.join(ROOT, "dist", "dsh-fnos.fpk"))
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "dsh-fnos.fpk"))
    ap.add_argument("--bump", choices=["patch", "minor", "major"],
                    help="increment version in fnos/manifest before packing")
    ap.add_argument("--plugins-from", default=os.environ.get("DSH_BUNDLE_PLUGINS_FROM"),
                    help="profile directory to read bundled plugins from")
    args = ap.parse_args()

    fnos = os.path.join(ROOT, "fnos")
    patch = os.path.join(ROOT, "scripts", "patch-dsh.mjs")
    if not os.path.isfile(args.reference):
        die(f"reference FPK not found: {args.reference}")

    current_version = manifest_version(fnos)
    target_version = next_manifest_version(fnos, args.bump) if args.bump else current_version

    with tempfile.TemporaryDirectory(prefix="dsh-fpk-repack.") as td:
        ref_app = os.path.join(td, "app.tgz")
        with tarfile.open(args.reference, "r:gz") as t:
            extract_member(t, "app.tgz", td)
        bundled_dir = bundle_plugins(os.path.join(td, "plugins-bundled"), args.plugins_from)
        extra = {"plugins-bundled": bundled_dir} if bundled_dir else None
        build_app_tgz(ref_app, os.path.join(fnos, "app"), patch,
                      os.path.join(td, "new-app.tgz"), extra_dirs=extra)
        digest = build_fpk(os.path.join(td, "new-app.tgz"), fnos, args.out,
                           version=target_version)

    # verification pass
    with tarfile.open(args.out, "r:gz") as t:
        names = t.getnames()
        assert names[0] == "app.tgz", names[:3]
        man = t.extractfile("manifest").read().decode()
        with t.extractfile("app.tgz") as f:
            inner_md5 = hashlib.md5(f.read()).hexdigest()
        assert f"{'checksum':<27}= {inner_md5}" in man, man[-120:]
        # The stamped version must be the one we asked for, not a stale read.
        assert f"{'version':<27}= {target_version}" in man, man[:300]
        with t.extractfile("app.tgz") as f:
            with tarfile.open(fileobj=f, mode="r:gz") as inner:
                inner_names = inner.getnames()
                assert "runtime/node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.4.node" in inner_names
                assert "docker-access.js" in inner_names
                assert "config/privilege" not in inner_names
    with open(args.out, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    sha_path = args.out + ".sha256"
    with open(sha_path, "w", newline="\n") as f:
        f.write(f"{sha}  {os.path.basename(args.out)}\n")

    # Record the new version only now that the package exists and verified.
    if target_version != current_version:
        write_manifest_version(fnos, target_version)
        print(f"version bumped: {current_version} -> {target_version}")
    else:
        print(f"version: {current_version} (unchanged)")
    print(f"OK {args.out}")
    print(f"  app.tgz md5 (manifest checksum): {digest}")
    print(f"  fpk sha256: {sha}")


if __name__ == "__main__":
    main()
