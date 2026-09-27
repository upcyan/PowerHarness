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
import sys
import tarfile
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def die(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


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


def build_app_tgz(ref, app_dir, patch_script, out_path):
    src = tarfile.open(ref, "r:gz")
    members = src.getmembers()
    old_names = {m.name for m in members}

    src_files, src_dirs = rel_files(app_dir)
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

    with tarfile.open(out_path, "w:gz", compresslevel=9) as out:
        for m in members:
            if m.name == "runtime" or m.name.startswith("runtime/"):
                out.addfile(m, src.extractfile(m) if m.isfile() else None)
            elif m.name == "patch-dsh.mjs":
                out.addfile(fresh_member(m.name, patch_script),
                            open(patch_script, "rb"))
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


def build_fpk(app_tgz, fnos_dir, out_path):
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


def bump_manifest(fnos_dir, which="patch"):
    path = os.path.join(fnos_dir, "manifest")
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    idx = next((i for i, l in enumerate(lines)
                if l.split("=", 1)[0].strip() == "version"), None)
    if idx is None:
        die("fnos/manifest has no version field")
    old = lines[idx].split("=", 1)[1].strip()
    parts = old.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        die(f"cannot bump non-semantic version: {old}")
    if which == "major":
        parts = [str(int(parts[0]) + 1), "0", "0"]
    elif which == "minor":
        parts = [parts[0], str(int(parts[1]) + 1), "0"]
    else:
        parts = [parts[0], parts[1], str(int(parts[2]) + 1)]
    new = ".".join(parts)
    k = lines[idx].split("=", 1)[0]
    lines[idx] = f"{k.rstrip()}={new}\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.writelines(lines)
    print(f"version bumped: {old} -> {new}")
    return new


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reference", default=os.path.join(ROOT, "dist", "dsh-fnos.fpk"))
    ap.add_argument("--out", default=os.path.join(ROOT, "dist", "dsh-fnos.fpk"))
    ap.add_argument("--bump", choices=["patch", "minor", "major"],
                    help="increment version in fnos/manifest before packing")
    args = ap.parse_args()

    fnos = os.path.join(ROOT, "fnos")
    patch = os.path.join(ROOT, "scripts", "patch-dsh.mjs")
    if not os.path.isfile(args.reference):
        die(f"reference FPK not found: {args.reference}")
    if args.bump:
        bump_manifest(fnos, args.bump)

    with tempfile.TemporaryDirectory(prefix="dsh-fpk-repack.") as td:
        ref_app = os.path.join(td, "app.tgz")
        with tarfile.open(args.reference, "r:gz") as t:
            t.extract("app.tgz", td, filter="data")
        build_app_tgz(ref_app, os.path.join(fnos, "app"), patch,
                      os.path.join(td, "new-app.tgz"))
        digest = build_fpk(os.path.join(td, "new-app.tgz"), fnos, args.out)

    # verification pass
    with tarfile.open(args.out, "r:gz") as t:
        names = t.getnames()
        assert names[0] == "app.tgz", names[:3]
        man = t.extractfile("manifest").read().decode()
        with t.extractfile("app.tgz") as f:
            inner_md5 = hashlib.md5(f.read()).hexdigest()
        assert f"{'checksum':<27}= {inner_md5}" in man, man[-120:]
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
    print(f"OK {args.out}")
    print(f"  app.tgz md5 (manifest checksum): {digest}")
    print(f"  fpk sha256: {sha}")


if __name__ == "__main__":
    main()
