from __future__ import annotations

import argparse
from importlib import metadata
import json
import sys
from typing import Any

from . import __version__
from .policy import AdapterError, ScrapeRequest
from .runner import execute


MAX_INPUT_BYTES = 256 * 1024


def _capabilities() -> dict[str, Any]:
    try:
        scrapling_version = metadata.version("scrapling")
        installed = True
    except metadata.PackageNotFoundError:
        scrapling_version = None
        installed = False
    return {
        "ok": True,
        "adapterVersion": __version__,
        "scrapling": {
            "installed": installed,
            "version": scrapling_version,
            "pinnedVersion": "0.4.11",
            "upstreamCommit": "07a548362ff904a2837f503ed9d9f6b9dcef0195",
            "license": "BSD-3-Clause",
        },
        "engines": {
            "static": installed,
            "dynamic": installed,
            "stealth": installed and __import__("os").environ.get("NCO_SCRAPLING_ENABLE_STEALTH") == "1",
        },
        "guardrails": [
            "public-http-targets-only",
            "robots-txt-fail-closed",
            "explicit-authorization",
            "browser-domain-scope",
            "no-cloudflare-or-captcha-solving",
            "untrusted-content-label",
        ],
    }


def _print(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="NCO Scrapling adapter")
    parser.add_argument("--capabilities", action="store_true")
    args = parser.parse_args()
    if args.capabilities:
        _print(_capabilities())
        return 0

    try:
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise AdapterError("INPUT_TOO_LARGE", f"request exceeds {MAX_INPUT_BYTES} bytes")
        payload = json.loads(raw.decode("utf-8"))
        request = ScrapeRequest.from_payload(payload)
        _print(execute(request))
        return 0
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        _print({"ok": False, "error": {"code": "INVALID_JSON", "message": str(exc)}})
        return 2
    except AdapterError as exc:
        _print({"ok": False, "error": {"code": exc.code, "message": str(exc)}})
        return 2
    except Exception as exc:
        _print({"ok": False, "error": {"code": "INTERNAL_ERROR", "message": str(exc)}})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

