from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import re
import socket
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import urlsplit


MAX_FIELDS = 50
MAX_SELECTOR_LENGTH = 512
MAX_PURPOSE_LENGTH = 500
MAX_AUTHORIZATION_REFERENCE_LENGTH = 256
MAX_ALLOWED_DOMAINS = 50
MAX_OUTPUT_CHARS = 5_000_000
FIELD_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
BLOCKED_HOST_SUFFIXES = (".local", ".internal", ".localhost", ".home.arpa")
SUPPORTED_ENGINES = frozenset({"static", "dynamic", "stealth"})


class AdapterError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class PolicyError(AdapterError):
    pass


def _require_bool(payload: Mapping[str, Any], key: str, default: bool = False) -> bool:
    value = payload.get(key, default)
    if not isinstance(value, bool):
        raise PolicyError("INVALID_REQUEST", f"{key} must be a boolean")
    return value


def _bounded_int(
    payload: Mapping[str, Any],
    key: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    value = payload.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise PolicyError("INVALID_REQUEST", f"{key} must be an integer")
    if value < minimum or value > maximum:
        raise PolicyError(
            "INVALID_REQUEST",
            f"{key} must be between {minimum} and {maximum}",
        )
    return value


def normalize_domain(value: str) -> str:
    domain = value.strip().rstrip(".").lower()
    if "://" in domain:
        parsed = urlsplit(domain)
        domain = (parsed.hostname or "").rstrip(".").lower()
    domain = domain.removeprefix("[").removesuffix("]")
    if not domain or "/" in domain or "@" in domain:
        raise PolicyError("INVALID_SCOPE", f"invalid allowed domain: {value!r}")
    try:
        return ipaddress.ip_address(domain.split("%", 1)[0]).compressed
    except ValueError:
        pass
    if ":" in domain:
        raise PolicyError("INVALID_SCOPE", f"invalid allowed domain: {value!r}")
    try:
        return domain.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise PolicyError("INVALID_SCOPE", f"invalid allowed domain: {value!r}") from exc


def host_matches_scope(host: str, domains: Iterable[str]) -> bool:
    normalized_host = normalize_domain(host)
    return any(
        normalized_host == domain or normalized_host.endswith(f".{domain}")
        for domain in domains
    )


def _assert_global_ip(value: str) -> None:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError as exc:
        raise PolicyError("TARGET_DNS_INVALID", f"invalid resolved address: {value}") from exc
    if not address.is_global:
        raise PolicyError(
            "TARGET_NOT_PUBLIC",
            f"private, loopback, link-local, or reserved address is blocked: {address}",
        )


Resolver = Callable[..., list[tuple[Any, ...]]]


def validate_target(
    url: str,
    allowed_domains: Iterable[str] = (),
    resolver: Resolver = socket.getaddrinfo,
) -> str:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise PolicyError("INVALID_URL", f"invalid URL: {exc}") from exc

    if parsed.scheme not in {"http", "https"}:
        raise PolicyError("INVALID_URL", "only http and https URLs are allowed")
    if parsed.username is not None or parsed.password is not None:
        raise PolicyError("INVALID_URL", "credentials in URLs are not allowed")
    if not parsed.hostname:
        raise PolicyError("INVALID_URL", "URL hostname is required")

    host = normalize_domain(parsed.hostname)
    if host == "localhost" or host.endswith(BLOCKED_HOST_SUFFIXES):
        raise PolicyError("TARGET_NOT_PUBLIC", f"local hostname is blocked: {host}")

    scope = tuple(normalize_domain(item) for item in allowed_domains)
    if scope and not host_matches_scope(host, scope):
        raise PolicyError("TARGET_OUT_OF_SCOPE", f"hostname is outside allowedDomains: {host}")

    try:
        _assert_global_ip(host)
        return host
    except PolicyError as exc:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise exc

    try:
        answers = resolver(host, port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except OSError as exc:
        raise PolicyError("TARGET_DNS_FAILED", f"could not resolve target hostname: {host}") from exc
    addresses = {answer[4][0] for answer in answers if len(answer) > 4 and answer[4]}
    if not addresses:
        raise PolicyError("TARGET_DNS_FAILED", f"target hostname had no addresses: {host}")
    for address in addresses:
        _assert_global_ip(address)
    return host


@dataclass(frozen=True)
class ScrapeRequest:
    url: str
    engine: str
    purpose: str
    authorization_confirmed: bool
    authorization_reference: str
    fields: dict[str, str]
    allowed_domains: tuple[str, ...]
    timeout_ms: int
    max_items: int
    max_output_chars: int
    wait_selector: str | None
    adaptive: bool
    auto_save: bool
    stealth_authorization: bool

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "ScrapeRequest":
        if not isinstance(payload, Mapping):
            raise PolicyError("INVALID_REQUEST", "request body must be a JSON object")

        url = payload.get("url")
        if not isinstance(url, str) or not url.strip() or len(url) > 4_096:
            raise PolicyError("INVALID_REQUEST", "url is required and must be at most 4096 characters")

        purpose = payload.get("purpose")
        if not isinstance(purpose, str) or len(purpose.strip()) < 3:
            raise PolicyError("INVALID_REQUEST", "purpose is required (at least 3 characters)")
        purpose = purpose.strip()
        if len(purpose) > MAX_PURPOSE_LENGTH:
            raise PolicyError(
                "INVALID_REQUEST",
                f"purpose must be at most {MAX_PURPOSE_LENGTH} characters",
            )

        authorization_confirmed = _require_bool(payload, "authorizationConfirmed")
        if not authorization_confirmed:
            raise PolicyError(
                "AUTHORIZATION_REQUIRED",
                "authorizationConfirmed=true is required for the target and intended use",
            )

        authorization_reference = payload.get("authorizationReference")
        if (
            not isinstance(authorization_reference, str)
            or len(authorization_reference.strip()) < 3
            or len(authorization_reference.strip()) > MAX_AUTHORIZATION_REFERENCE_LENGTH
        ):
            raise PolicyError(
                "AUTHORIZATION_REFERENCE_REQUIRED",
                f"authorizationReference is required (3-{MAX_AUTHORIZATION_REFERENCE_LENGTH} characters)",
            )

        engine = payload.get("engine", "static")
        if not isinstance(engine, str) or engine not in SUPPORTED_ENGINES:
            raise PolicyError(
                "INVALID_REQUEST",
                f"engine must be one of: {', '.join(sorted(SUPPORTED_ENGINES))}",
            )

        raw_fields = payload.get("fields")
        if not isinstance(raw_fields, Mapping) or not raw_fields:
            raise PolicyError("INVALID_REQUEST", "fields must contain at least one CSS selector")
        if len(raw_fields) > MAX_FIELDS:
            raise PolicyError("INVALID_REQUEST", f"fields supports at most {MAX_FIELDS} selectors")
        fields: dict[str, str] = {}
        for raw_name, raw_selector in raw_fields.items():
            if not isinstance(raw_name, str) or not FIELD_NAME_RE.fullmatch(raw_name):
                raise PolicyError("INVALID_REQUEST", f"invalid field name: {raw_name!r}")
            if (
                not isinstance(raw_selector, str)
                or not raw_selector.strip()
                or len(raw_selector) > MAX_SELECTOR_LENGTH
            ):
                raise PolicyError(
                    "INVALID_REQUEST",
                    f"selector for {raw_name!r} must be 1-{MAX_SELECTOR_LENGTH} characters",
                )
            fields[raw_name] = raw_selector.strip()

        raw_domains = payload.get("allowedDomains", [])
        if not isinstance(raw_domains, list) or not all(isinstance(item, str) for item in raw_domains):
            raise PolicyError("INVALID_REQUEST", "allowedDomains must be an array of domain names")
        if len(raw_domains) > MAX_ALLOWED_DOMAINS:
            raise PolicyError(
                "INVALID_REQUEST",
                f"allowedDomains supports at most {MAX_ALLOWED_DOMAINS} domains",
            )
        allowed_domains = tuple(dict.fromkeys(normalize_domain(item) for item in raw_domains))
        if engine in {"dynamic", "stealth"} and not allowed_domains:
            raise PolicyError(
                "EXPLICIT_SCOPE_REQUIRED",
                "dynamic and stealth engines require allowedDomains to constrain browser requests",
            )
        target_host = normalize_domain(urlsplit(url.strip()).hostname or "")
        if engine in {"dynamic", "stealth"} and target_host not in allowed_domains:
            raise PolicyError(
                "EXPLICIT_SCOPE_REQUIRED",
                "dynamic and stealth allowedDomains must include the exact target hostname",
            )

        wait_selector = payload.get("waitSelector")
        if wait_selector is not None and (
            not isinstance(wait_selector, str)
            or not wait_selector.strip()
            or len(wait_selector) > MAX_SELECTOR_LENGTH
        ):
            raise PolicyError(
                "INVALID_REQUEST",
                f"waitSelector must be 1-{MAX_SELECTOR_LENGTH} characters",
            )

        adaptive = _require_bool(payload, "adaptive")
        auto_save = _require_bool(payload, "autoSave")
        if auto_save and not adaptive:
            raise PolicyError("INVALID_REQUEST", "autoSave requires adaptive=true")

        stealth_authorization = _require_bool(payload, "stealthAuthorization")
        if engine == "stealth" and not stealth_authorization:
            raise PolicyError(
                "STEALTH_AUTHORIZATION_REQUIRED",
                "stealth engine requires stealthAuthorization=true and operator enablement",
            )

        request = cls(
            url=url.strip(),
            engine=engine,
            purpose=purpose,
            authorization_confirmed=authorization_confirmed,
            authorization_reference=authorization_reference.strip(),
            fields=fields,
            allowed_domains=allowed_domains,
            timeout_ms=_bounded_int(payload, "timeoutMs", 30_000, 1_000, 120_000),
            max_items=_bounded_int(payload, "maxItems", 100, 1, 1_000),
            max_output_chars=_bounded_int(
                payload,
                "maxOutputChars",
                1_000_000,
                1_000,
                MAX_OUTPUT_CHARS,
            ),
            wait_selector=wait_selector.strip() if isinstance(wait_selector, str) else None,
            adaptive=adaptive,
            auto_save=auto_save,
            stealth_authorization=stealth_authorization,
        )
        validate_target(request.url, request.allowed_domains)
        return request
