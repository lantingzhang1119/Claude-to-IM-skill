#!/usr/bin/env python3
"""
Lightweight secret scanner for staged changes or selected files.
Designed for local guardrails rather than full DLP coverage.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple


EXCLUDED_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
}
TEXT_EXTENSIONS = {
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".go",
    ".h",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsonl",
    ".jsx",
    ".m",
    ".md",
    ".py",
    ".rb",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
MAX_SCAN_BYTES = 2 * 1024 * 1024
PLACEHOLDER_MARKERS = (
    "redacted",
    "example",
    "dummy",
    "placeholder",
    "sample",
    "fake",
    "your-",
    "your_",
    "test-token",
    "test_key",
    "test-key",
    "xxx",
    "<token>",
    "<api",
    "not-a-real",
)


@dataclass(frozen=True)
class ScanRule:
    name: str
    pattern: re.Pattern[str]


RULES: Sequence[ScanRule] = (
    ScanRule(
        "telegram-bot-token",
        re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{20,}\b"),
    ),
    ScanRule(
        "openai-like-api-key",
        re.compile(r"\b(?:sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,})\b"),
    ),
    ScanRule(
        "github-personal-access-token",
        re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    ),
    ScanRule(
        "slack-bot-token",
        re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    ),
    ScanRule(
        "aws-access-key",
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    ),
    ScanRule(
        "x-auth-cookie-assignment",
        re.compile(r"(?i)\b(?:auth_token|ct0)\b\s*[:=]\s*[\"']?[A-Za-z0-9%._-]{8,}"),
    ),
    ScanRule(
        "generic-secret-assignment",
        re.compile(
            r"(?i)\b(?:api[_ -]?key|bot[_ -]?token|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret|password)\b"
            r"[^\n]{0,16}[:=]\s*[\"']?[A-Za-z0-9%._:/+=-]{16,}"
        ),
    ),
)


def _run_git(args: Sequence[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )


def _repo_root(start: Path) -> Path:
    proc = _run_git(["rev-parse", "--show-toplevel"], start)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "not a git repository")
    return Path(proc.stdout.strip())


def _staged_paths(repo_root: Path) -> List[str]:
    proc = _run_git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], repo_root)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "failed to list staged files")
    return [p for p in proc.stdout.split("\x00") if p]


def _read_staged_file(repo_root: Path, path: str) -> str:
    proc = _run_git(["show", f":{path}"], repo_root)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"failed to read staged file: {path}")
    return proc.stdout


def _looks_textual(path: Path) -> bool:
    if path.suffix.lower() in TEXT_EXTENSIONS:
        return True
    return path.name in {"Dockerfile", "Makefile", ".env", ".env.example"}


def _is_placeholder(candidate: str, line: str) -> bool:
    lowered_candidate = candidate.lower()
    lowered_line = line.lower()
    if any(marker in lowered_candidate for marker in PLACEHOLDER_MARKERS):
        return True
    if any(marker in lowered_line for marker in PLACEHOLDER_MARKERS):
        return True
    if "[redacted" in lowered_line:
        return True
    return False


def _scan_text(path_label: str, text: str) -> List[Tuple[str, int, str, str]]:
    findings: List[Tuple[str, int, str, str]] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for rule in RULES:
            for match in rule.pattern.finditer(line):
                candidate = match.group(0)
                if _is_placeholder(candidate, line):
                    continue
                findings.append((path_label, lineno, rule.name, candidate[:80]))
    return findings


def _iter_repo_files(repo_root: Path) -> Iterable[Path]:
    for path in repo_root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in EXCLUDED_DIRS for part in path.parts):
            continue
        if not _looks_textual(path):
            continue
        try:
            if path.stat().st_size > MAX_SCAN_BYTES:
                continue
        except OSError:
            continue
        yield path


def _scan_working_tree(repo_root: Path, inputs: Sequence[str]) -> List[Tuple[str, int, str, str]]:
    findings: List[Tuple[str, int, str, str]] = []
    paths: Iterable[Path]
    if inputs:
        paths = [Path(p).expanduser() for p in inputs]
    else:
        paths = _iter_repo_files(repo_root)
    for path in paths:
        resolved = path if path.is_absolute() else (repo_root / path)
        if not resolved.exists() or not resolved.is_file():
            continue
        if any(part in EXCLUDED_DIRS for part in resolved.parts):
            continue
        if not _looks_textual(resolved):
            continue
        try:
            text = resolved.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        findings.extend(_scan_text(str(resolved.relative_to(repo_root)), text))
    return findings


def _scan_staged(repo_root: Path) -> List[Tuple[str, int, str, str]]:
    findings: List[Tuple[str, int, str, str]] = []
    for rel_path in _staged_paths(repo_root):
        candidate = repo_root / rel_path
        if not _looks_textual(candidate):
            continue
        try:
            text = _read_staged_file(repo_root, rel_path)
        except RuntimeError:
            continue
        findings.extend(_scan_text(rel_path, text))
    return findings


def resolve_repo_root(start: Path | None = None) -> Path:
    """Public helper for sibling scripts."""
    return _repo_root((start or Path.cwd()).resolve())


def scan_repo(repo_root: Path, staged: bool = False, paths: Sequence[str] = ()) -> List[Tuple[str, int, str, str]]:
    """Run the same scanner logic programmatically."""
    return _scan_staged(repo_root) if staged else _scan_working_tree(repo_root, paths)


def main() -> int:
    parser = argparse.ArgumentParser(description="Local secret scanner for OpenClaw workspace")
    parser.add_argument("paths", nargs="*", help="Specific files to scan from the working tree")
    parser.add_argument("--staged", action="store_true", help="Scan staged git content instead of working tree files")
    parser.add_argument("--repo-root", default=None, help="Explicit repository root")
    args = parser.parse_args()

    cwd = Path.cwd()
    repo_root = Path(args.repo_root).expanduser().resolve() if args.repo_root else resolve_repo_root(cwd)

    try:
        findings = scan_repo(repo_root, staged=args.staged, paths=args.paths)
    except RuntimeError as exc:
        print(f"[secret-scan] error: {exc}", file=sys.stderr)
        return 2

    if not findings:
        print("[secret-scan] no obvious secrets detected.")
        return 0

    print("[secret-scan] possible secrets detected:")
    for path_label, lineno, rule_name, preview in findings:
        print(f"  - {path_label}:{lineno} [{rule_name}] {preview}")
    print("[secret-scan] block and rotate any real secret before committing.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
