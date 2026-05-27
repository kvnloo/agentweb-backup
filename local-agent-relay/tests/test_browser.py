import asyncio
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from codex_relay.browser import _click_selector_js, _click_text_js, _parse_chrome_output, _scroll_via_cdp, _type_js, extract_urls, load_page_with_playwright, normalize_url, task_needs_browser


class BrowserTests(unittest.TestCase):
    def test_normalize_url_adds_https(self):
        self.assertEqual(normalize_url("linkedin.com"), "https://linkedin.com")

    def test_extract_urls(self):
        self.assertEqual(extract_urls("open linkedin.com, then example.com/test."), ["https://linkedin.com", "https://example.com/test"])

    def test_task_needs_browser_requires_url_and_browser_word(self):
        self.assertTrue(task_needs_browser("open browser and load linkedin.com"))
        self.assertFalse(task_needs_browser("summarize linkedin.com config in the repo"))

    def test_parse_chrome_output(self):
        title, final_url, text = _parse_chrome_output(
            "Title\n---CODEX_RELAY_URL---\nhttps://example.com/\n---CODEX_RELAY_TEXT---\nHello"
        )
        self.assertEqual(title, "Title")
        self.assertEqual(final_url, "https://example.com/")
        self.assertEqual(text, "Hello")

    def test_click_text_js_contains_search_text(self):
        self.assertIn("Like", _click_text_js("Like"))

    def test_click_selector_js_contains_selector(self):
        self.assertIn("button.primary", _click_selector_js("button.primary", 1))

    def test_type_js_contains_text(self):
        self.assertIn("hello", _type_js("hello"))

    def test_scroll_via_cdp_returns_none_when_cdp_unavailable(self):
        """_scroll_via_cdp returns None when port 9222 is not reachable."""
        import urllib.request
        with patch.object(urllib.request, "urlopen", side_effect=Exception("connection refused")):
            result = _scroll_via_cdp(count=3, max_chars=40000)
        self.assertIsNone(result)

    def test_scroll_via_cdp_scrolls_and_returns_page(self):
        """_scroll_via_cdp calls evaluate N times and returns a BrowserPage."""
        scroll_calls: list[str] = []

        mock_page = MagicMock()
        mock_page.url = "https://example.com/feed"
        mock_page.evaluate = lambda js: scroll_calls.append(js) or ("post content " * 10 if "innerText" in js else None)
        mock_page.title = MagicMock(return_value="Example Feed")

        mock_ctx = MagicMock()
        mock_ctx.pages = [mock_page]
        mock_browser = MagicMock()
        mock_browser.contexts = [mock_ctx]

        import urllib.request
        import time as _time_module
        with patch.object(urllib.request, "urlopen", return_value=MagicMock()):
            with patch("playwright.sync_api.sync_playwright") as mock_pw_cls:
                mock_pw = MagicMock()
                mock_pw.chromium.connect_over_cdp.return_value = mock_browser
                mock_pw_cls.return_value.__enter__ = MagicMock(return_value=mock_pw)
                mock_pw_cls.return_value.__exit__ = MagicMock(return_value=False)
                with patch.object(_time_module, "sleep", return_value=None):
                    result = _scroll_via_cdp(count=3, max_chars=40000)

        scroll_evals = [c for c in scroll_calls if "scrollBy" in c]
        self.assertEqual(len(scroll_evals), 3)
        self.assertIsNotNone(result)
        self.assertEqual(result.final_url, "https://example.com/feed")


if __name__ == "__main__":
    unittest.main()
