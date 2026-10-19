#!/usr/bin/env python3
"""Resolve public build context without publishing or rewriting private notes."""
import argparse
from pathlib import Path
import re
import shutil

NAMES = ('AI-CONTEXT.md', 'CHANGELOG-AI.md')

def resolve_context_sources(root, source_app, version=None):
    root, source_app = Path(root), Path(source_app)
    result = {}
    for name in NAMES:
        private = source_app / name
        if private.is_symlink():
            raise ValueError('Context source must not be a symbolic link: ' + name)
        source = private if private.exists() else root / 'scripts' / 'public-context' / name
        if source.is_symlink() or not source.is_file():
            raise ValueError('Required private or public context source missing: ' + name)
        data = source.read_bytes()
        if not data.strip():
            raise ValueError('Existing context source is empty: ' + name)
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError as error:
            raise ValueError('Context source is not UTF-8: ' + name) from error
        if name == 'CHANGELOG-AI.md' and version is not None:
            if not re.search(r'^## \[' + re.escape(version) + r'\](?:\s|$)', text, re.M):
                raise ValueError('CHANGELOG-AI.md has no entry for version ' + version)
        result[name] = str(source)
    return result

def stage_context(root, source_app, stage_app, version=None):
    sources = resolve_context_sources(root, source_app, version)
    target = Path(stage_app)
    if target.is_symlink():
        raise ValueError('Context staging directory must not be a symbolic link')
    target.mkdir(parents=True, exist_ok=True)
    if target.resolve() == Path(source_app).resolve():
        raise ValueError('Context staging must not rewrite the source directory')
    # Validate all targets before changing any stage member.
    for name in sources:
        destination = target / name
        if destination.is_symlink() or (destination.exists() and
                (not destination.is_file() or destination.stat().st_nlink != 1)):
            raise ValueError('Context staging target must be an unshared regular file')
        if destination.exists() and any(destination.samefile(path) for path in sources.values()):
            raise ValueError('Context staging must not overwrite any source file')
    for name, source in sources.items():
        destination = target / name
        shutil.copyfile(source, destination)
        destination.chmod(0o644)
    return sources

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('source_app', type=Path)
    parser.add_argument('stage_app', type=Path)
    parser.add_argument('--version')
    args = parser.parse_args()
    try:
        stage_context(args.root, args.source_app, args.stage_app, args.version)
    except (OSError, ValueError) as error:
        parser.exit(1, str(error) + '\n')

if __name__ == '__main__':
    main()
