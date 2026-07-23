from __future__ import annotations

import unittest

from nco_scrapling.policy import ScrapeRequest
from nco_scrapling.runner import extract_fields


class FakeMatches:
    def __init__(self, values):
        self.values = values

    def getall(self):
        return self.values

    def __len__(self):
        return len(self.values)


class FakePage:
    def __init__(self, values):
        self.values = values
        self.calls = []

    def css(self, selector, **kwargs):
        self.calls.append((selector, kwargs))
        return FakeMatches(self.values[selector])


class ExtractionTests(unittest.TestCase):
    def request(self, **overrides):
        values = dict(
            url="https://example.com",
            engine="static",
            purpose="test extraction",
            authorization_confirmed=True,
            fields={"title": "h1::text"},
            allowed_domains=(),
            timeout_ms=30_000,
            max_items=2,
            max_output_chars=100,
            wait_selector=None,
            adaptive=True,
            auto_save=True,
            stealth_authorization=False,
        )
        values.update(overrides)
        return ScrapeRequest(**values)

    def test_extracts_bounded_values_and_passes_adaptive_options(self):
        page = FakePage({"h1::text": ["one", "two", "three"]})
        data, truncated = extract_fields(page, self.request())
        self.assertEqual(data, {"title": ["one", "two"]})
        self.assertTrue(truncated)
        _, options = page.calls[0]
        self.assertTrue(options["adaptive"])
        self.assertTrue(options["auto_save"])
        self.assertEqual(options["identifier"], "nco:title")

    def test_caps_total_output_characters(self):
        page = FakePage({"h1::text": ["abcdefghij"]})
        data, truncated = extract_fields(page, self.request(max_output_chars=5))
        self.assertEqual(data, {"title": ["abcde"]})
        self.assertTrue(truncated)


if __name__ == "__main__":
    unittest.main()

