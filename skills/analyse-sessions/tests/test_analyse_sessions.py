import contextlib
import argparse
import io
import json
import sys
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime, timezone
from pathlib import Path


SCRIPTS = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import cost  # noqa: E402
import search  # noqa: E402
import sessions  # noqa: E402
import show_session  # noqa: E402


class AnalyseSessionsTests(unittest.TestCase):
    def test_new_subagent_store_is_discovered_and_linked(self):
        path = Path.home() / ".pi" / "agent" / "sessions" / "subagents" / (
            "parent-id__worker__run-id.jsonl"
        )
        self.assertTrue(sessions.is_subagent_path(path))
        self.assertEqual(sessions.parent_session_id_from_path(path), "parent-id")

    def test_invalid_date_is_a_clean_value_error(self):
        with self.assertRaisesRegex(ValueError, "invalid date"):
            sessions.parse_date("not-a-date")

    def test_limit_must_be_positive(self):
        with self.assertRaises(argparse.ArgumentTypeError):
            sessions.positive_int("0")
        with self.assertRaises(argparse.ArgumentTypeError):
            sessions.positive_int("-1")

    def test_until_date_includes_the_entire_day(self):
        until = sessions.parse_date("2026-09-04", end_of_day=True)
        self.assertEqual(until, datetime(2026, 9, 4, 23, 59, 59, 999999, tzinfo=timezone.utc))

    def test_malformed_records_are_ignored(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False, encoding="utf-8") as stream:
            json.dump({"type": "session", "id": "session-id", "cwd": "C:/work"}, stream)
            stream.write("\n")
            stream.write("[]\n")
            json.dump({"type": "message", "message": "not a dict"}, stream)
            stream.write("\n")
            json.dump({"type": "message", "message": {"role": "assistant", "content": ["bad"], "usage": {"cost": "bad"}}}, stream)
            stream.write("\n")
            path = Path(stream.name)
        try:
            summary = sessions.summarize_session(path)
        finally:
            path.unlink()
        self.assertIsNotNone(summary)
        self.assertEqual(summary.id, "session-id")
        self.assertEqual(summary.assistant_count, 1)
        self.assertEqual(summary.cost_total, 0)

    def test_shared_text_extractor_ignores_non_string_text(self):
        self.assertEqual(sessions._extract_text([{"type": "text", "text": 123}, {"type": "text", "text": "ok"}]), "ok")

    def test_cost_window_uses_session_end_time(self):
        start = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)
        end = datetime(2026, 9, 5, 18, tzinfo=timezone.utc)
        summary = sessions.SessionSummary(path=Path("session.jsonl"), started_at=start, last_at=end)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            cost.print_grand_total([summary])
        self.assertIn(cost.S.fmt_short_ts(end), output.getvalue())

    def test_cost_group_limit_applies_to_json_groups(self):
        groups = {
            "2026-09-03": {"cost": 1},
            "2026-09-04": {"cost": 2},
        }
        self.assertEqual(list(cost.limit_groups(groups, "day", 1)), ["2026-09-03"])

    def test_search_thinking_is_opt_in(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False, encoding="utf-8") as stream:
            json.dump({"type": "session", "id": "session-id"}, stream)
            stream.write("\n")
            json.dump({"type": "message", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "secret needle"}]}}, stream)
            stream.write("\n")
            path = Path(stream.name)
        try:
            summary = sessions.SessionSummary(path=path, id="session-id")
            matcher = lambda text: "needle" in text
            finditer = lambda text: [search._SubMatch(0, 6)]
            self.assertEqual(search._search_session(summary, "both", matcher, finditer, 5, 1, 100, False), [])
            self.assertEqual(len(search._search_session(summary, "both", matcher, finditer, 5, 1, 100, True)), 1)
        finally:
            path.unlink()

    def test_show_session_omits_thinking_by_default(self):
        args = Namespace(include_thinking=False, max_thinking=600, max_assistant_text=4000)
        message = {"content": [{"type": "thinking", "thinking": "private thought"}, {"type": "text", "text": "answer"}]}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            show_session._render_assistant(message, "00:00:00", args)
        self.assertNotIn("private thought", output.getvalue())
        self.assertIn("answer", output.getvalue())

    def test_show_session_handles_non_dict_usage(self):
        args = Namespace(include_thinking=False, max_thinking=600, max_assistant_text=4000)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            show_session._render_assistant({"model": "test", "usage": "bad", "content": []}, "00:00:00", args)
        self.assertIn("Assistant (test)", output.getvalue())


if __name__ == "__main__":
    unittest.main()
