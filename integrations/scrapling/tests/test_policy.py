from __future__ import annotations

import socket
import unittest

from nco_scrapling.policy import PolicyError, ScrapeRequest, validate_target


def public_resolver(*_args, **_kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]


def private_resolver(*_args, **_kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]


class TargetPolicyTests(unittest.TestCase):
    def test_public_target_is_allowed(self):
        self.assertEqual(validate_target("https://example.com/x", resolver=public_resolver), "example.com")

    def test_private_and_local_targets_are_blocked(self):
        with self.assertRaisesRegex(PolicyError, "blocked"):
            validate_target("http://127.0.0.1")
        with self.assertRaisesRegex(PolicyError, "local hostname"):
            validate_target("http://service.internal")
        with self.assertRaisesRegex(PolicyError, "blocked"):
            validate_target("https://example.com", resolver=private_resolver)

    def test_domain_scope_includes_subdomains_but_not_suffix_tricks(self):
        self.assertEqual(
            validate_target(
                "https://news.example.com",
                ("example.com",),
                resolver=public_resolver,
            ),
            "news.example.com",
        )
        with self.assertRaisesRegex(PolicyError, "outside allowedDomains"):
            validate_target(
                "https://example.com.attacker.test",
                ("example.com",),
                resolver=public_resolver,
            )


class RequestPolicyTests(unittest.TestCase):
    def base_payload(self):
        return {
            "url": "https://example.com",
            "purpose": "public documentation indexing",
            "authorizationConfirmed": True,
            "fields": {"title": "h1::text"},
        }

    def test_authorization_is_required(self):
        payload = self.base_payload()
        payload["authorizationConfirmed"] = False
        with self.assertRaisesRegex(PolicyError, "authorizationConfirmed"):
            ScrapeRequest.from_payload(payload)

    def test_dynamic_browser_requires_explicit_domain_scope(self):
        payload = self.base_payload()
        payload["engine"] = "dynamic"
        with self.assertRaisesRegex(PolicyError, "allowedDomains"):
            ScrapeRequest.from_payload(payload)

    def test_stealth_requires_separate_authorization(self):
        payload = self.base_payload()
        payload.update({"engine": "stealth", "allowedDomains": ["example.com"]})
        with self.assertRaisesRegex(PolicyError, "stealthAuthorization"):
            ScrapeRequest.from_payload(payload)

    def test_auto_save_requires_adaptive_mode(self):
        payload = self.base_payload()
        payload["autoSave"] = True
        with self.assertRaisesRegex(PolicyError, "adaptive=true"):
            ScrapeRequest.from_payload(payload)


if __name__ == "__main__":
    unittest.main()

