#!/usr/bin/env python
"""Fetch a YouTube title and English captions through local yt-dlp."""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlparse


DEFAULT_MAX_CHARS = 30_000
MAX_MAX_CHARS = 120_000
COMMAND_TIMEOUT = 120
ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
}


def configure_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def yt_dlp_command() -> list[str]:
    executable = os.environ.get("YT_DLP_PATH", "yt-dlp")
    if shutil.which(executable) is None:
        raise RuntimeError(
            "yt-dlp is not installed or not on PATH. "
            "Install it locally, then retry."
        )
    return [executable]


def validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in ALLOWED_HOSTS:
        raise RuntimeError("URL must be a youtube.com, youtu.be, or YouTube Music link")


def run_yt_dlp(args: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            [*yt_dlp_command(), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"yt-dlp timed out after {COMMAND_TIMEOUT}s") from exc

    if result.returncode:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(f"yt-dlp failed: {detail[-1000:] or 'unknown error'}")
    return result


def get_metadata(url: str) -> dict:
    result = run_yt_dlp(
        ["--dump-json", "--no-playlist", "--no-warnings", "--skip-download", url]
    )
    raw = result.stdout.lstrip()
    try:
        metadata, end = json.JSONDecoder().raw_decode(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("yt-dlp returned invalid metadata") from exc
    if raw[end:].strip():
        raise RuntimeError("yt-dlp returned metadata for multiple videos")
    if not isinstance(metadata, dict):
        raise RuntimeError("yt-dlp returned invalid metadata")
    return metadata


def pick_english_lang(info: dict) -> tuple[str, bool] | None:
    subtitles = info.get("subtitles") or {}
    automatic = info.get("automatic_captions") or {}
    preferred = ["en", "en-US", "en-GB"]

    for source, is_auto in ((subtitles, False), (automatic, True)):
        for language in preferred:
            if language in source:
                return language, is_auto
        for language in source:
            if language.startswith("en"):
                return language, is_auto
    return None


def download_subtitle(url: str, language: str, is_auto: bool, outdir: str) -> str:
    flag = "--write-auto-subs" if is_auto else "--write-subs"
    run_yt_dlp(
        [
            "--skip-download",
            "--no-playlist",
            "--no-warnings",
            "--sub-format",
            "json3",
            "--sub-langs",
            language,
            flag,
            "-o",
            os.path.join(outdir, "%(id)s.%(ext)s"),
            url,
        ]
    )
    matches = glob.glob(os.path.join(outdir, "*.json3"))
    if len(matches) == 0:
        raise RuntimeError("yt-dlp did not produce a JSON3 subtitle file")
    if len(matches) > 1:
        raise RuntimeError("yt-dlp produced subtitles for multiple videos")
    return matches[0]


def extract_transcript(path: str) -> str:
    with open(path, "r", encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict):
        raise RuntimeError("JSON3 subtitle data has an invalid root structure")

    parts: list[str] = []
    events = data.get("events", [])
    if not isinstance(events, list):
        raise RuntimeError("JSON3 subtitle data has invalid events")
    for event in events:
        if not isinstance(event, dict):
            continue
        segments = event.get("segs", []) or []
        if not isinstance(segments, list):
            continue
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            text = segment.get("utf8", "")
            if isinstance(text, str) and text.strip() and text != "\n":
                parts.append(text.strip())
    return " ".join(parts)


def limit_transcript(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    suffix = "…"
    budget = max_chars - len(suffix)
    clipped = text[:budget]
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0].rstrip()
    if not clipped:
        clipped = text[:budget]
    return f"{clipped}{suffix}", True


def main() -> int:
    configure_output()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument(
        "--max-chars",
        type=int,
        default=DEFAULT_MAX_CHARS,
        help=f"Maximum transcript characters (default: {DEFAULT_MAX_CHARS}, maximum: {MAX_MAX_CHARS})",
    )
    args = parser.parse_args()

    if not 1 <= args.max_chars <= MAX_MAX_CHARS:
        parser.error(f"--max-chars must be between 1 and {MAX_MAX_CHARS}")

    try:
        validate_url(args.url)
        print("Fetching YouTube metadata...", file=sys.stderr)
        info = get_metadata(args.url)
        title = info.get("title") or "Unknown title"
        selected = pick_english_lang(info)
        if selected is None:
            raise RuntimeError(f"No English captions found for: {title}")

        language, is_auto = selected
        with tempfile.TemporaryDirectory(prefix="yt-transcript-") as tmpdir:
            print(
                f"Fetching {'auto-generated ' if is_auto else ''}captions ({language})...",
                file=sys.stderr,
            )
            subtitle = download_subtitle(args.url, language, is_auto, tmpdir)
            transcript, truncated = limit_transcript(
                extract_transcript(subtitle), args.max_chars
            )

        output = {
            "title": title,
            "url": args.url,
            "language": language,
            "auto_generated": is_auto,
            "truncated": truncated,
            "transcript": transcript,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (OSError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"youtube transcript: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
