import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "clipboard-helper" / "mac_clipboard_helper.py"
SPEC = importlib.util.spec_from_file_location("mac_clipboard_helper", MODULE_PATH)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


class ClipboardHelperTests(unittest.TestCase):
    def test_accepts_only_http_urls_without_whitespace_or_controls(self):
        self.assertTrue(helper.valid_url("https://example.com/path?q=one"))
        self.assertTrue(helper.valid_url("http://localhost:8765/"))
        for value in (
            "ftp://example.com/file",
            "https:///missing-host",
            "https://example.com/a b",
            "https://example.com/a\n",
            "https://example.com/\x00",
            "x" * 2049,
            None,
        ):
            with self.subTest(value=value):
                self.assertFalse(helper.valid_url(value))

    def test_extract_url_accepts_expected_mailbox_shapes(self):
        self.assertEqual(helper.extract_url({"url": "https://example.com/"}), "https://example.com/")
        self.assertEqual(helper.extract_url("https://example.com/"), "https://example.com/")
        self.assertIsNone(helper.extract_url({"url": "file:///tmp/private"}))
        self.assertIsNone(helper.extract_url({"other": "https://example.com/"}))

    def test_poll_once_injects_clipboard_writer_and_copies_only_the_url(self):
        copied = []
        config = {"base_url": "https://companion.example", "token": "not-used", "machine": "thing-2"}
        result = helper.poll_once(config, clipboard_writer=copied.append,
                                  fetcher=lambda supplied: "https://source.example/article")
        self.assertTrue(result)
        self.assertEqual(copied, ["https://source.example/article"])

    def test_regular_poll_interval_is_two_seconds(self):
        sleeps = []
        logger = type("Logger", (), {"warning": lambda *args: None})()
        helper.run({}, fetcher=lambda config: None, sleeper=sleeps.append,
                   stop=lambda: len(sleeps) >= 1, logger=logger)
        self.assertEqual(sleeps, [2])

    def test_poll_once_does_not_copy_an_invalid_mailbox_item(self):
        copied = []
        result = helper.poll_once({}, clipboard_writer=copied.append,
                                  fetcher=lambda supplied: "javascript:alert(1)")
        self.assertFalse(result)
        self.assertEqual(copied, [])

    def test_network_errors_back_off_to_thirty_seconds_without_logging_error_details(self):
        sleeps = []

        class Logger:
            def __init__(self):
                self.messages = []

            def warning(self, message, *args):
                self.messages.append(message % args)

        logger = Logger()

        def fail_fetch(config):
            raise RuntimeError("https://secret.example/?token=secret")

        def sleeper(seconds):
            sleeps.append(seconds)

        helper.run({}, fetcher=fail_fetch, sleeper=sleeper, logger=logger,
                   stop=lambda: len(sleeps) >= 7)
        self.assertEqual(sleeps, [2, 4, 8, 16, 30, 30, 30])
        self.assertEqual(logger.messages, ["poll failed (RuntimeError)"] * 7)
        self.assertNotIn("secret", " ".join(logger.messages))


if __name__ == "__main__":
    unittest.main()
