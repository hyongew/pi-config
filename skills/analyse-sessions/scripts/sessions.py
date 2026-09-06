"""Shared library for analyzing pi agent session logs.

A session is a JSONL file under ~/.pi/agent/sessions/<encoded-cwd>--/. The
subagents extension stores subagent transcripts under
~/.pi/agent/sessions/subagents/<parent-id>__<agent>__<run-id>.jsonl.

This module provides:
- Path discovery and subagent detection
- A one-pass SessionSummary that aggregates cost / tokens / errors / models
- Generic Filters dataclass with from_args() + argparse helpers
- Date parsing for absolute (YYYY-MM-DD, ISO) and relative (7d/2w/3h/30m) values

All scripts in this skill import from here.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Iterator, Optional


def _configure_windows_output() -> None:
    """Keep Unicode output usable from PowerShell and redirected commands."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


_configure_windows_output()


_agent_dir = Path(
    os.path.expanduser(
        os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent")
    )
)
_session_dir = os.environ.get("PI_CODING_AGENT_SESSION_DIR")
SESSIONS_ROOT = Path(os.path.expanduser(_session_dir)) if _session_dir else _agent_dir / "sessions"
SUBAGENT_ROOTS = [
    SESSIONS_ROOT / "subagents",
    _agent_dir / "sessions" / "subagents",
    _agent_dir / "subagents-sessions",  # legacy extension location
]


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

_REL_RE = re.compile(r"^(\d+)(d|w|h|m)$")


def parse_date(value: str, *, end_of_day: bool = False) -> datetime:
    """Parse a CLI date value to an aware UTC datetime.

    Accepts:
      - relative: '7d', '2w', '3h', '30m'  (ago, from now)
      - ISO date: '2026-05-21'
      - ISO datetime: '2026-05-21T14:30:00' or '2026-05-21 14:30:00'
    """
    value = value.strip()
    if not value:
        raise ValueError("invalid date: value is empty")
    m = _REL_RE.match(value)
    if m:
        try:
            n, unit = int(m.group(1)), m.group(2)
            delta = {
                "d": timedelta(days=n),
                "w": timedelta(weeks=n),
                "h": timedelta(hours=n),
                "m": timedelta(minutes=n),
            }[unit]
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"invalid date '{value}'") from exc
        return datetime.now(timezone.utc) - delta

    is_date_only = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value))
    try:
        # Normalize ' ' -> 'T' for ISO parsing
        normalized = value.replace(" ", "T")
        if "T" not in normalized:
            normalized = normalized + "T00:00:00"
        # Tolerate trailing 'Z'
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        dt = datetime.fromisoformat(normalized)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(
            f"invalid date '{value}'; use YYYY-MM-DD, an ISO datetime, or a relative value such as 7d"
        ) from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    result = dt.astimezone(timezone.utc)
    if end_of_day and is_date_only:
        result += timedelta(days=1) - timedelta(microseconds=1)
    return result


def ts_from_ms(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)


def ts_from_iso(s: str) -> datetime:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s).astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Path discovery & session shape
# ---------------------------------------------------------------------------


def is_subagent_path(path: Path) -> bool:
    """Recognize the current flat subagent store and the legacy nested store."""
    for root in SUBAGENT_ROOTS:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            continue
    try:
        rel = path.relative_to(SESSIONS_ROOT)
    except ValueError:
        return False
    return len(rel.parts) > 2


def parent_session_id_from_path(path: Path) -> Optional[str]:
    """For a subagent transcript, return the parent session's UUID."""
    if not is_subagent_path(path):
        return None
    rel = None
    for root in SUBAGENT_ROOTS:
        try:
            rel = path.relative_to(root)
            if root.name == "subagents":
                fields = path.stem.split("__", 2)
                return fields[0] if fields and fields[0] != "unknown" else None
            break
        except ValueError:
            continue
    if rel is None:
        rel = path.relative_to(SESSIONS_ROOT)
    if len(rel.parts) < 2:
        return None
    # parts[1] is '<timestamp>_<uuid>'
    name = rel.parts[1]
    # uuid is after the first '_'
    if "_" in name:
        return name.split("_", 1)[1]
    return name


def iter_session_files(include_subagents: bool = False) -> Iterator[Path]:
    """Yield all session JSONL files, optionally including subagent transcripts."""
    seen: set[Path] = set()
    for root in [SESSIONS_ROOT, *SUBAGENT_ROOTS]:
        if not root.exists():
            continue
        for path in root.rglob("*.jsonl"):
            if path in seen:
                continue
            seen.add(path)
            if not include_subagents and is_subagent_path(path):
                continue
            yield path


# ---------------------------------------------------------------------------
# Session summary (one pass per file)
# ---------------------------------------------------------------------------


@dataclass
class SessionSummary:
    path: Path
    id: str = ""
    cwd: str = ""
    started_at: Optional[datetime] = None
    last_at: Optional[datetime] = None
    is_subagent: bool = False
    parent_session_id: Optional[str] = None

    models: set = field(default_factory=set)
    providers: set = field(default_factory=set)

    user_count: int = 0
    assistant_count: int = 0
    tool_result_count: int = 0
    error_count: int = 0
    tool_call_count: int = 0

    cost_total: float = 0.0
    cost_input: float = 0.0
    cost_output: float = 0.0
    cost_cache_read: float = 0.0
    cost_cache_write: float = 0.0

    tok_input: int = 0
    tok_output: int = 0
    tok_cache_read: int = 0
    tok_cache_write: int = 0

    first_user_prompt: str = ""
    user_prompt_concat: str = ""  # for --grep

    @property
    def message_count(self) -> int:
        return self.user_count + self.assistant_count + self.tool_result_count

    @property
    def short_id(self) -> str:
        return self.id[:8] if self.id else ""

    @property
    def project_label(self) -> str:
        return self.cwd or "?"


def summarize_session(path: Path) -> Optional[SessionSummary]:
    """Single-pass scan; returns None if the file is unreadable / empty."""
    s = SessionSummary(path=path)
    s.is_subagent = is_subagent_path(path)
    s.parent_session_id = parent_session_id_from_path(path)

    try:
        f = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return None

    user_chunks: list[str] = []
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            t = rec.get("type")
            if t == "session":
                s.id = rec.get("id", "") if isinstance(rec.get("id", ""), str) else ""
                s.cwd = rec.get("cwd", "") if isinstance(rec.get("cwd", ""), str) else ""
                ts = rec.get("timestamp")
                if ts:
                    try:
                        s.started_at = ts_from_iso(ts)
                        s.last_at = s.started_at
                    except (TypeError, ValueError, OverflowError):
                        pass
            elif t == "model_change":
                if isinstance(rec.get("modelId"), str) and rec.get("modelId"):
                    s.models.add(rec["modelId"])
                if isinstance(rec.get("provider"), str) and rec.get("provider"):
                    s.providers.add(rec["provider"])
            elif t == "message":
                m = rec.get("message") or {}
                if not isinstance(m, dict):
                    continue
                role = m.get("role")
                # Track last timestamp from any message
                mts = m.get("timestamp")
                if isinstance(mts, (int, float)):
                    try:
                        s.last_at = ts_from_ms(int(mts))
                    except (TypeError, ValueError, OverflowError):
                        pass

                if role == "user":
                    s.user_count += 1
                    text = _extract_text(m.get("content"))
                    if text:
                        if not s.first_user_prompt:
                            s.first_user_prompt = text
                        user_chunks.append(text)
                elif role == "assistant":
                    s.assistant_count += 1
                    if isinstance(m.get("model"), str) and m.get("model"):
                        s.models.add(m["model"])
                    if isinstance(m.get("provider"), str) and m.get("provider"):
                        s.providers.add(m["provider"])
                    _accumulate_usage(s, m.get("usage"))
                    for c in m.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "toolCall":
                            s.tool_call_count += 1
                elif role == "toolResult":
                    s.tool_result_count += 1
                    if m.get("isError"):
                        s.error_count += 1

    if not s.id:
        # No session header — bail.
        return None
    s.user_prompt_concat = "\n".join(user_chunks)
    return s


def _extract_text(content) -> str:
    if not isinstance(content, list):
        return ""
    out = []
    for c in content:
        if isinstance(c, dict) and c.get("type") == "text":
            t = c.get("text")
            if isinstance(t, str) and t:
                out.append(t)
    return "\n".join(out)


def _accumulate_usage(s: SessionSummary, usage) -> None:
    if not isinstance(usage, dict):
        return
    cost = usage.get("cost") or {}
    if not isinstance(cost, dict):
        cost = {}

    def number(value, kind):
        try:
            return kind(value or 0)
        except (TypeError, ValueError, OverflowError):
            return kind(0)

    s.cost_total += number(cost.get("total"), float)
    s.cost_input += number(cost.get("input"), float)
    s.cost_output += number(cost.get("output"), float)
    s.cost_cache_read += number(cost.get("cacheRead"), float)
    s.cost_cache_write += number(cost.get("cacheWrite"), float)
    s.tok_input += number(usage.get("input"), int)
    s.tok_output += number(usage.get("output"), int)
    s.tok_cache_read += number(usage.get("cacheRead"), int)
    s.tok_cache_write += number(usage.get("cacheWrite"), int)


# ---------------------------------------------------------------------------
# Record iteration (used by show_session / search / prompts)
# ---------------------------------------------------------------------------


def iter_records(path: Path) -> Iterator[dict]:
    try:
        f = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                yield record


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


@dataclass
class Filters:
    since: Optional[datetime] = None
    until: Optional[datetime] = None
    cwd_substrs: list = field(default_factory=list)
    model_substrs: list = field(default_factory=list)
    provider: Optional[str] = None
    session_id: Optional[str] = None  # exact or prefix
    include_subagents: Optional[bool] = None  # tri-state; script default if None
    limit: Optional[int] = None
    min_cost: Optional[float] = None
    min_messages: Optional[int] = None
    errors_only: bool = False
    grep: Optional[str] = None  # substring on user text, case-insensitive

    def matches(self, s: SessionSummary) -> bool:
        if self.session_id:
            if not (s.id == self.session_id or s.id.startswith(self.session_id)):
                return False
        if self.since and s.started_at and s.started_at < self.since:
            return False
        if self.until and s.started_at and s.started_at > self.until:
            return False
        if self.cwd_substrs:
            cwd_low = (s.cwd or "").lower()
            if not any(sub.lower() in cwd_low for sub in self.cwd_substrs):
                return False
        if self.model_substrs:
            joined = " ".join(s.models).lower()
            if not any(sub.lower() in joined for sub in self.model_substrs):
                return False
        if self.provider and self.provider not in s.providers:
            return False
        if self.min_cost is not None and s.cost_total < self.min_cost:
            return False
        if self.min_messages is not None and s.message_count < self.min_messages:
            return False
        if self.errors_only and s.error_count == 0:
            return False
        if self.grep:
            if self.grep.lower() not in s.user_prompt_concat.lower():
                return False
        return True


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def add_filter_args(p: argparse.ArgumentParser, *, subagents_default: bool) -> None:
    """Attach the shared filter flags to a parser.

    subagents_default: whether subagent sessions are included when the user
    passes neither --include-subagents nor --no-subagents.
    """
    p.add_argument("--since", metavar="WHEN", help="Lower bound: YYYY-MM-DD, ISO datetime, or relative (7d/2w/3h/30m).")
    p.add_argument("--until", metavar="WHEN", help="Upper bound, same formats as --since; date-only values include the entire day.")
    p.add_argument("--cwd", action="append", default=[], metavar="SUBSTR",
                   help="Substring(s) matched against session cwd. Repeatable; any match wins.")
    p.add_argument("--model", action="append", default=[], metavar="SUBSTR",
                   help="Substring(s) matched against model id. Repeatable; any match wins.")
    p.add_argument("--provider", metavar="NAME",
                   help="Restrict by provider, for example llamacpp, openai, or anthropic.")
    p.add_argument("--session", metavar="ID", help="Session id or prefix.")
    sub = p.add_mutually_exclusive_group()
    sub.add_argument("--include-subagents", dest="include_subagents",
                     action="store_const", const=True, default=None,
                     help=f"Include subagent transcripts. Default: {'on' if subagents_default else 'off'}.")
    sub.add_argument("--no-subagents", dest="include_subagents",
                     action="store_const", const=False,
                     help="Exclude subagent transcripts.")
    p.add_argument("--limit", type=positive_int, help="Cap the number of items returned (must be positive).")
    p.add_argument("--min-cost", type=float, metavar="USD",
                   help="Drop sessions whose total cost is below this.")
    p.add_argument("--min-messages", type=int, metavar="N",
                   help="Drop sessions with fewer messages than N.")
    p.add_argument("--errors-only", action="store_true",
                   help="Only sessions where at least one toolResult.isError is true.")
    p.add_argument("--grep", metavar="SUBSTR",
                   help="Case-insensitive substring match on the user prompts of the session.")


def filters_from_args(args: argparse.Namespace, *, subagents_default: bool) -> Filters:
    f = Filters()
    if getattr(args, "since", None):
        f.since = parse_date(args.since)
    if getattr(args, "until", None):
        f.until = parse_date(args.until, end_of_day=True)
    f.cwd_substrs = list(getattr(args, "cwd", []) or [])
    f.model_substrs = list(getattr(args, "model", []) or [])
    f.provider = getattr(args, "provider", None)
    f.session_id = getattr(args, "session", None)
    inc = getattr(args, "include_subagents", None)
    f.include_subagents = subagents_default if inc is None else inc
    f.limit = getattr(args, "limit", None)
    f.min_cost = getattr(args, "min_cost", None)
    f.min_messages = getattr(args, "min_messages", None)
    f.errors_only = bool(getattr(args, "errors_only", False))
    f.grep = getattr(args, "grep", None)
    return f


def load_summaries(filters: Filters) -> list:
    """Discover, summarize, and filter sessions. Sorted newest first."""
    out: list = []
    for path in iter_session_files(include_subagents=bool(filters.include_subagents)):
        s = summarize_session(path)
        if s is None:
            continue
        if filters.matches(s):
            out.append(s)
    out.sort(key=lambda x: x.started_at or datetime.min.replace(tzinfo=timezone.utc),
             reverse=True)
    if filters.limit:
        out = out[: filters.limit]
    return out


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def fmt_money(x: float) -> str:
    if x == 0:
        return "$0.00"
    if x < 0.01:
        return f"${x:.4f}"
    return f"${x:,.2f}"


def fmt_short_ts(dt: Optional[datetime]) -> str:
    if not dt:
        return "?"
    return dt.astimezone().strftime("%Y-%m-%d %H:%M")


def truncate(text: str, n: int, suffix: str = "…") -> str:
    if not text:
        return ""
    if len(text) <= n:
        return text
    return text[: max(0, n - len(suffix))] + suffix


def stderr(*a, **kw):
    print(*a, file=sys.stderr, **kw)
