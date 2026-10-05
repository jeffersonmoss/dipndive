import importlib.util
from pathlib import Path
import unittest
from urllib.error import HTTPError

WINDOWS_INSTALLER = Path(__file__).parents[1] / "clipboard-helper" / "install_windows.ps1"
WINDOWS_HELPER = Path(__file__).parents[1] / "clipboard-helper" / "windows_clipboard_helper.ps1"
WINDOWS_UNINSTALLER = Path(__file__).parents[1] / "clipboard-helper" / "uninstall_windows.ps1"
MAC_INSTALLER = Path(__file__).parents[1] / "clipboard-helper" / "install_mac.py"


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
            "https://example.com/\u200b",
            "https://example.com/a\\b",
            "http:foo",
            "x" * 2049,
            None,
        ):
            with self.subTest(value=value):
                self.assertFalse(helper.valid_url(value))
        self.assertTrue(helper.valid_url("http://remote.example/article"))

    def test_https_is_required_except_loopback_and_tailscale(self):
        for value in ("https://example.com:8443", "http://127.0.0.1:8443", "http://localhost:8443",
                      "http://thing-2.example.ts.net:8443"):
            self.assertTrue(helper.secure_base_url(value), value)
        for value in ("http://example.com:8443", "https://example.com/path?token=x", "http://evil.ts.net.evil.com"):
            self.assertFalse(helper.secure_base_url(value), value)

    def test_mac_redirects_are_refused(self):
        self.assertIsNone(helper.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://evil.example/"))

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

    def test_clipboard_write_retries_transient_contention(self):
        calls, sleeps = [], []

        def writer(value):
            calls.append(value)
            if len(calls) < 3:
                raise OSError("clipboard busy")

        self.assertTrue(helper.poll_once({}, clipboard_writer=writer, fetcher=lambda _: "https://example.com",
                                         sleeper=sleeps.append))
        self.assertEqual(calls, ["https://example.com"] * 3)
        self.assertEqual(sleeps, [helper.WRITE_RETRY_SECONDS] * 2)

    def test_401_reloads_config_and_logs_unauthorized(self):
        messages, loaded, sleeps = [], [], []
        logger = type("Logger", (), {"warning": lambda self, message, *args: messages.append(message % args)})()

        def fail(config):
            raise HTTPError("https://example.com", 401, "Unauthorized", {}, None)

        def load():
            loaded.append(True)
            return {"base_url": "https://new.example", "token": "new", "machine": "thing-1"}

        helper.run({}, fetcher=fail, config_loader=load, sleeper=sleeps.append, logger=logger,
                   stop=lambda: len(sleeps) >= 2)
        self.assertEqual(len(loaded), 2)
        self.assertEqual(messages, ["unauthorized; reloading config"])

    def test_windows_install_and_helper_security_contracts(self):
        installer = WINDOWS_INSTALLER.read_text()
        helper_text = WINDOWS_HELPER.read_text()
        uninstaller = WINDOWS_UNINSTALLER.read_text()
        self.assertIn("AllowStartIfOnBatteries", installer)
        self.assertIn("DontStopIfGoingOnBatteries", installer)
        self.assertIn("-RestartCount 3", installer)
        self.assertIn("Start-ScheduledTask", installer)
        self.assertIn("$env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'", installer)
        self.assertIn("AllowAutoRedirect = $false", helper_text)
        self.assertIn("UnauthorizedAccessException", helper_text)
        self.assertIn("Stop-ScheduledTask", uninstaller)

    def test_mac_installer_uses_copied_helper_stable_python_and_bounded_agent_settings(self):
        source = MAC_INSTALLER.read_text()
        self.assertIn('support / "mac_clipboard_helper.py"', source)
        self.assertIn('python = "/usr/bin/python3"', source)
        self.assertIn('"ThrottleInterval": 30', source)
        self.assertIn('"LANG": "en_US.UTF-8"', source)

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
