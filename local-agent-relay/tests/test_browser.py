import unittest

from codex_relay.browser import _click_selector_js, _click_text_js, _parse_chrome_output, _type_js, extract_urls, normalize_url, task_needs_browser


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


if __name__ == "__main__":
    unittest.main()
