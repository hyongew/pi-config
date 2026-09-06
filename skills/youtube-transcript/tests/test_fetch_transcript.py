import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "fetch_transcript.py"
SPEC = importlib.util.spec_from_file_location("fetch_transcript", SCRIPT)
assert SPEC and SPEC.loader
fetch_transcript = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch_transcript)


class FetchTranscriptTests(unittest.TestCase):
    def test_metadata_forces_single_video(self):
        result = fetch_transcript.subprocess.CompletedProcess(
            [], 0, stdout=json.dumps({"id": "one", "title": "Video"}), stderr=""
        )
        with patch.object(fetch_transcript, "run_yt_dlp", return_value=result) as run:
            metadata = fetch_transcript.get_metadata("https://youtu.be/one?list=playlist")

        self.assertEqual(metadata["id"], "one")
        self.assertIn("--no-playlist", run.call_args.args[0])

    def test_metadata_rejects_multiple_videos(self):
        result = fetch_transcript.subprocess.CompletedProcess(
            [], 0, stdout='{"id":"one"}\n{"id":"two"}\n', stderr=""
        )
        with patch.object(fetch_transcript, "run_yt_dlp", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "multiple videos"):
                fetch_transcript.get_metadata("https://youtu.be/one")

    def test_subtitle_download_forces_single_video_and_rejects_multiple_files(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "one.json3").write_text("{}", encoding="utf-8")
            Path(directory, "two.json3").write_text("{}", encoding="utf-8")
            with patch.object(fetch_transcript, "run_yt_dlp") as run:
                with self.assertRaisesRegex(RuntimeError, "multiple videos"):
                    fetch_transcript.download_subtitle(
                        "https://youtu.be/one?list=playlist", "en", False, directory
                    )
            self.assertIn("--no-playlist", run.call_args.args[0])

    def test_language_selection_prefers_manual_english(self):
        info = {
            "subtitles": {"fr": [{}], "en-GB": [{}]},
            "automatic_captions": {"en": [{}]},
        }
        self.assertEqual(fetch_transcript.pick_english_lang(info), ("en-GB", False))

    def test_language_selection_falls_back_to_english_variant(self):
        info = {"subtitles": {"de": [{}]}, "automatic_captions": {"en-AU": [{}]}}
        self.assertEqual(fetch_transcript.pick_english_lang(info), ("en-AU", True))

    def test_caption_format_ignores_empty_segments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "captions.json3")
            with path.open("w", encoding="utf-8") as stream:
                json.dump(
                    {
                        "events": [
                            {"segs": [{"utf8": "Hello"}, {"utf8": "\n"}, {"utf8": " world "}]},
                            {"tStartMs": 1000},
                        ]
                    },
                    stream,
                )
            self.assertEqual(fetch_transcript.extract_transcript(str(path)), "Hello world")

    def test_malformed_caption_events_and_segments_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "malformed.json3")
            path.write_text(
                json.dumps({
                    "events": [
                        None,
                        {"segs": [None, "bad", {"utf8": 123}, {"utf8": "kept"}]},
                        "bad event",
                    ]
                }),
                encoding="utf-8",
            )
            self.assertEqual(fetch_transcript.extract_transcript(str(path)), "kept")

    def test_invalid_caption_root_is_a_clean_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "invalid.json3")
            path.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "invalid root structure"):
                fetch_transcript.extract_transcript(str(path))

    def test_transcript_truncation_is_bounded(self):
        clipped, truncated = fetch_transcript.limit_transcript("one two three four", 10)
        self.assertTrue(truncated)
        self.assertLessEqual(len(clipped), 10)
        self.assertTrue(clipped.endswith("…"))

    def test_short_transcript_is_not_truncated(self):
        self.assertEqual(fetch_transcript.limit_transcript("short", 10), ("short", False))


if __name__ == "__main__":
    unittest.main()
