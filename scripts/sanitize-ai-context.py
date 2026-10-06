#!/usr/bin/env python3
"""Generalize private identifiers in the AI context files that ship in the FPK.

`fnos/app/AI-CONTEXT.md` and `fnos/app/CHANGELOG-AI.md` are written for an AI
assistant working on this project. They are genuinely useful on an installed
NAS — they carry the architecture notes, the debugging traps and the change
history — so they keep shipping inside the package.

But they are working notes, not user documentation: they name companion
repositories that are private, and they quote build-machine paths. A package
handed to another fnOS user should not carry either. This script rewrites the
staged copies only; the working copy on disk keeps the precise names, because
that is what makes the record useful to whoever maintains it here.

Two rules, matching the packer's existing stance in `bundle-plugins.py`:

  * only doc-ish text is rewritten — this script never touches code, so a
    future hunt for behavioural differences between source and bundle never
    has to ask "did the packer touch logic?";
  * a placeholder must preserve the *reason* a name was mentioned. Replacing
    every plugin with "plugin" would turn a precise root-cause note into a
    riddle, so the placeholders distinguish self-authored from third-party.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Names of companion projects that are not public. Verified against the
# hosting API: these repositories return 404 to an anonymous caller.
# `dsh-mimo-extension` is public but is ours too, so it is listed here rather
# than under third-party: the placeholder is about whose project it is, not
# about whether a stranger could already find it.
PRIVATE_PROJECTS = (
    "dsh-usage-cyanmod",
    "dsh-web-mobile-cyanmod",
    "dsh-plugin-proxy",
    "dsh-plugin-save-token",
    "dsh-mimo-extension",
)

# Third-party plugins that are not the point of the note; the note reads the
# same without naming them (one of them is public, but naming a random
# third-party package in our changelog buys nothing).
THIRD_PARTY_PLUGINS = (
    "dsh-glm-mode",
)

# Shorthand used for the mobile plugin throughout the notes. Replaced after the
# long forms so `dsh-web-mobile-cyanmod` is not mangled into a half name.
SHORTHANDS = (
    ("cyanmod", "<self-authored-plugin>"),
    ("usage-cyanmod", "<self-authored-plugin>"),
    ("mimo-extension", "<self-authored-plugin>"),
    # Another application on the same NAS. Its name is not ours to publish, and
    # the notes stay readable as "a companion app's data directory".
    ("zcode", "<other-app>"),
)

REPO_OWNER = "upcyan"

SELF_PLACEHOLDER = "<self-authored-plugin>"
THIRD_PLACEHOLDER = "<third-party-plugin>"

# Path roots. Matched generically (`/vol1/<uid>/…`) so this sanitizer never has
# to spell out one machine's directory layout.
PATH_RULES = (
    (re.compile(r"/vol1/\d+/[^\s`\"')\]]*"), "<local-workspace>"),
    (re.compile(r"/vol1/@appdata/[^\s`\"')\]]*"), "<local-appdata>"),
    (re.compile(r"/vol1/@appcenter/[^\s`\"')\]]*"), "<local-appcenter>"),
    (re.compile(r"/mnt/[^\s`\"')\]]*"), "<local-mount>"),
    (re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b"), "<lan-address>"),
)

# Text that only *describes* the sanitizer's rules. Rewriting these turns the
# rule documentation into nonsense (`<local-workspace>` explained as
# `<local-workspace>`), so they survive verbatim. They are patterns and
# examples, not paths that exist on any machine.
RULE_DOC_PATTERNS = (
    re.compile(r"/vol1/<uid>/…"),
    re.compile(r"`/vol1/\.\.\.`"),
    # The changelog describes this sanitizer's own rules; those examples appear
    # both bare and in backticks depending on the sentence.
    re.compile(r"`?/vol1/@appdata/\*`?"),
    re.compile(r"`?/vol1/@appcenter/\*`?"),
    re.compile(r"`?/mnt/\*`?"),
    re.compile(r'"/vol1/\\\|192\\\.168\\\."'),
    re.compile(r"<local-[a-z]+>"),
    re.compile(r"<lan-address>"),
)


def sanitize(text: str) -> str:
    """Rewrite private identifiers and local paths into placeholders.

    Longest names first: `dsh-web-mobile-cyanmod` contains `cyanmod`, and a
    naive short-name pass would leave a mangled `dsh-web-mobile-<…>` behind.
    Text that documents these very rules is shielded first, so the explanation
    does not collapse into "`<local-workspace>` means `<local-workspace>`".
    """
    shielded: list[str] = []

    def shield(match: re.Match[str]) -> str:
        shielded.append(match.group(0))
        return f"\x00{len(shielded) - 1}\x00"

    for pattern in RULE_DOC_PATTERNS:
        text = pattern.sub(shield, text)

    # Repo slugs (`owner/name`) first so the owner never survives on its own.
    # Classified by whose project it is: `upcyan/<our plugin>` must read as
    # self-authored, not third-party.
    def slug(match: re.Match[str]) -> str:
        name = match.group(1)
        if any(name == p or name.startswith(p) or p.startswith(name) for p in PRIVATE_PROJECTS):
            return SELF_PLACEHOLDER
        return THIRD_PLACEHOLDER

    text = re.sub(
        rf"\b{re.escape(REPO_OWNER)}/([A-Za-z0-9._-]+)",
        slug,
        text,
    )
    for name in sorted(PRIVATE_PROJECTS, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", SELF_PLACEHOLDER, text)
    for name, repl in SHORTHANDS:
        text = re.sub(rf"\b{re.escape(name)}\b", repl, text)
    for name in sorted(THIRD_PARTY_PLUGINS, key=len, reverse=True):
        text = re.sub(rf"\b{re.escape(name)}\b", THIRD_PLACEHOLDER, text)
    for pattern, repl in PATH_RULES:
        text = pattern.sub(repl, text)

    for index, original in enumerate(shielded):
        text = text.replace(f"\x00{index}\x00", original)
    return text


def sanitize_file(path: Path) -> bytes:
    original = path.read_bytes()
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError:
        raise SystemExit(f"{path}: not UTF-8; refusing to rewrite")
    updated = sanitize(text)
    if updated != text:
        path.write_text(updated, encoding="utf-8")
    return updated.encode("utf-8")


def shield_rule_docs(text: str) -> str:
    """Blank out text that only documents these rules.

    The changelog explains the packer's generalizations (`/vol1/@appdata/*` →
    `<local-appdata>`). Those examples look exactly like the leaks this guard
    hunts, so they are removed before scanning — otherwise the guard fires on
    its own documentation and the build fails for the wrong reason.
    """
    for pattern in RULE_DOC_PATTERNS:
        text = pattern.sub(" ", text)
    return text


def find_leaks(text: str) -> list[str]:
    """Return the private identifiers still present in `text`."""
    scanned = shield_rule_docs(text)
    names = list(PRIVATE_PROJECTS) + list(THIRD_PARTY_PLUGINS)
    names += [name for name, _ in SHORTHANDS]
    leaks = set()
    for name in names:
        if re.search(rf"\b{re.escape(name)}\b", scanned):
            leaks.add(name)
    if re.search(rf"\b{re.escape(REPO_OWNER)}\b", scanned):
        leaks.add(REPO_OWNER)
    # A surviving absolute local path means the sanitizer did not run — that is
    # the failure this guard exists for.
    for match in re.finditer(r"/vol1/(?:\d+|@app[a-z]+)/[^\s`\"')\]]*", scanned):
        leaks.add(match.group(0))
    for match in re.finditer(r"\b192\.168\.\d{1,3}\.\d{1,3}\b", scanned):
        leaks.add(match.group(0))
    return sorted(leaks)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("files", nargs="+", type=Path,
                        help="staged AI context files to rewrite in place")
    parser.add_argument("--check", action="store_true",
                        help="report remaining private identifiers instead of rewriting")
    args = parser.parse_args()

    if args.check:
        bad = False
        for path in args.files:
            leaks = find_leaks(path.read_text(encoding="utf-8"))
            if leaks:
                bad = True
                print(f"{path}: {len(leaks)} private identifier(s) remain: {leaks[:6]}", file=sys.stderr)
        return 1 if bad else 0

    for path in args.files:
        if not path.is_file():
            print(f"{path}: missing; refusing to continue", file=sys.stderr)
            return 1
        sanitize_file(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
