#!/usr/bin/env python3
"""Offline A/B benchmark for the NCO Scrapling stage 5 evaluation.

The baseline is a minimal lxml selector implementation, not a pre-existing NCO
web-scraping service. The candidate is Scrapling 0.4.11's Selector. Both parse
the same generated HTML and perform the same four field extractions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import resource
import statistics
import subprocess
import sys
import time
from importlib import metadata
from pathlib import Path
from typing import Callable


ENGINE_BASELINE = "baseline_lxml"
ENGINE_CANDIDATE = "candidate_scrapling"
ENGINES = (ENGINE_BASELINE, ENGINE_CANDIDATE)
SELECTORS = {
    "title": "h1::text",
    "names": ".item .name::text",
    "links": ".item a::attr(href)",
    "descriptions": ".item .description::text",
}


def build_fixture(items: int) -> tuple[str, dict[str, list[str]]]:
    cards: list[str] = []
    names: list[str] = []
    links: list[str] = []
    descriptions: list[str] = []
    for index in range(items):
        name = f"Item {index:04d}"
        link = f"/items/{index:04d}"
        description = f"Public description {index:04d}"
        names.append(name)
        links.append(link)
        descriptions.append(description)
        cards.append(
            "<article class=\"item\">"
            f"<h2 class=\"name\">{name}</h2>"
            f"<a href=\"{link}\">Details</a>"
            f"<p class=\"description\">{description}</p>"
            "</article>"
        )
    body = "".join(cards)
    document = (
        "<!doctype html><html><head><title>Fixture</title></head><body>"
        "<main><h1>Public catalogue</h1>"
        f"{body}</main></body></html>"
    )
    return document, {
        "title": ["Public catalogue"],
        "names": names,
        "links": links,
        "descriptions": descriptions,
    }


def baseline_extractor(document: str) -> Callable[[], dict[str, list[str]]]:
    from lxml import html

    def extract() -> dict[str, list[str]]:
        root = html.fromstring(document)
        return {
            "title": [node.text_content() for node in root.cssselect("h1")],
            "names": [node.text_content() for node in root.cssselect(".item .name")],
            "links": [
                value
                for node in root.cssselect(".item a")
                if (value := node.get("href")) is not None
            ],
            "descriptions": [
                node.text_content() for node in root.cssselect(".item .description")
            ],
        }

    return extract


def candidate_extractor(document: str) -> Callable[[], dict[str, list[str]]]:
    from scrapling.parser import Selector

    def extract() -> dict[str, list[str]]:
        root = Selector(document, url="https://benchmark.invalid/catalogue")
        return {name: root.css(selector).getall() for name, selector in SELECTORS.items()}

    return extract


def percentile(values: list[float], percent: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = (len(ordered) - 1) * percent
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def peak_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def failure_checks(engine: str) -> dict[str, bool]:
    if engine == ENGINE_BASELINE:
        from lxml import html

        root = html.fromstring("<html><body><p>ok</p></body></html>")
        missing_is_empty = root.cssselect(".missing") == []
        try:
            root.cssselect("[")
        except Exception:
            invalid_selector_rejected = True
        else:
            invalid_selector_rejected = False
    else:
        from scrapling.parser import Selector

        root = Selector("<html><body><p>ok</p></body></html>")
        missing_is_empty = root.css(".missing").getall() == []
        try:
            root.css("[")
        except Exception:
            invalid_selector_rejected = True
        else:
            invalid_selector_rejected = False
    return {
        "missingSelectorReturnsEmpty": missing_is_empty,
        "invalidSelectorRejected": invalid_selector_rejected,
    }


def run_child(engine: str, iterations: int, items: int, warmups: int) -> dict[str, object]:
    document, expected = build_fixture(items)
    extractor = (
        baseline_extractor(document)
        if engine == ENGINE_BASELINE
        else candidate_extractor(document)
    )
    for _ in range(warmups):
        extractor()

    latencies_ms: list[float] = []
    errors = 0
    field_matches = 0
    field_checks = iterations * len(expected)
    digest = ""
    cpu_start = time.process_time()
    wall_start = time.perf_counter()
    for _ in range(iterations):
        operation_start = time.perf_counter()
        try:
            actual = extractor()
            field_matches += sum(actual.get(name) == values for name, values in expected.items())
            if actual != expected:
                errors += 1
            digest = hashlib.sha256(
                json.dumps(actual, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        except Exception:
            errors += 1
        latencies_ms.append((time.perf_counter() - operation_start) * 1_000)
    wall_seconds = time.perf_counter() - wall_start
    cpu_seconds = time.process_time() - cpu_start

    return {
        "engine": engine,
        "iterations": iterations,
        "itemsPerDocument": items,
        "fieldChecks": field_checks,
        "fieldMatches": field_matches,
        "accuracyPct": round(field_matches / field_checks * 100, 6),
        "errors": errors,
        "errorRatePct": round(errors / iterations * 100, 6),
        "latencyMs": {
            "mean": round(statistics.fmean(latencies_ms), 6),
            "p50": round(percentile(latencies_ms, 0.50), 6),
            "p95": round(percentile(latencies_ms, 0.95), 6),
            "max": round(max(latencies_ms), 6),
        },
        "throughputOpsPerSec": round(iterations / wall_seconds, 6),
        "cpuSeconds": round(cpu_seconds, 6),
        "peakRssBytes": peak_rss_bytes(),
        "outputSha256": digest,
        "failureChecks": failure_checks(engine),
    }


def run_process(
    script: Path,
    engine: str,
    iterations: int,
    items: int,
    warmups: int,
) -> dict[str, object]:
    command = [
        sys.executable,
        str(script),
        "--child",
        "--engine",
        engine,
        "--iterations",
        str(iterations),
        "--items",
        str(items),
        "--warmups",
        str(warmups),
    ]
    started = time.perf_counter()
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    process_wall_ms = (time.perf_counter() - started) * 1_000
    if completed.returncode != 0:
        return {
            "engine": engine,
            "processWallMs": round(process_wall_ms, 6),
            "processExitCode": completed.returncode,
            "processError": completed.stderr[-2_000:],
        }
    payload = json.loads(completed.stdout)
    payload["processWallMs"] = round(process_wall_ms, 6)
    payload["processExitCode"] = completed.returncode
    return payload


def median_metric(samples: list[dict[str, object]], *path: str) -> float:
    values: list[float] = []
    for sample in samples:
        value: object = sample
        for key in path:
            value = value[key]  # type: ignore[index]
        values.append(float(value))
    return round(statistics.median(values), 6)


def summarize(
    cold: list[dict[str, object]],
    warm: list[dict[str, object]],
) -> dict[str, dict[str, object]]:
    summary: dict[str, dict[str, object]] = {}
    for engine in ENGINES:
        cold_engine = [sample for sample in cold if sample["engine"] == engine]
        warm_engine = [sample for sample in warm if sample["engine"] == engine]
        summary[engine] = {
            "coldProcessWallMsMedian": median_metric(cold_engine, "processWallMs"),
            "warmLatencyP50MsMedian": median_metric(warm_engine, "latencyMs", "p50"),
            "warmLatencyP95MsMedian": median_metric(warm_engine, "latencyMs", "p95"),
            "warmThroughputOpsPerSecMedian": median_metric(
                warm_engine, "throughputOpsPerSec"
            ),
            "warmCpuSecondsMedian": median_metric(warm_engine, "cpuSeconds"),
            "peakRssBytesMedian": int(median_metric(warm_engine, "peakRssBytes")),
            "accuracyPctMin": min(float(sample["accuracyPct"]) for sample in warm_engine),
            "errorRatePctMax": max(float(sample["errorRatePct"]) for sample in warm_engine),
            "allFailureChecksPassed": all(
                all(bool(result) for result in sample["failureChecks"].values())  # type: ignore[union-attr]
                for sample in warm_engine
            ),
        }
    baseline = summary[ENGINE_BASELINE]
    candidate = summary[ENGINE_CANDIDATE]
    summary["candidateVsBaseline"] = {
        "coldLatencyRatio": round(
            float(candidate["coldProcessWallMsMedian"])
            / float(baseline["coldProcessWallMsMedian"]),
            6,
        ),
        "warmLatencyP50Ratio": round(
            float(candidate["warmLatencyP50MsMedian"])
            / float(baseline["warmLatencyP50MsMedian"]),
            6,
        ),
        "throughputRatio": round(
            float(candidate["warmThroughputOpsPerSecMedian"])
            / float(baseline["warmThroughputOpsPerSecMedian"]),
            6,
        ),
        "peakRssRatio": round(
            float(candidate["peakRssBytesMedian"])
            / float(baseline["peakRssBytesMedian"]),
            6,
        ),
    }
    return summary


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--engine", choices=ENGINES)
    parser.add_argument("--iterations", type=int, default=50)
    parser.add_argument("--items", type=int, default=500)
    parser.add_argument("--warmups", type=int, default=5)
    parser.add_argument("--repetitions", type=int, default=7)
    args = parser.parse_args()

    if args.child:
        if not args.engine:
            parser.error("--engine is required with --child")
        print(
            json.dumps(
                run_child(args.engine, args.iterations, args.items, args.warmups),
                sort_keys=True,
            )
        )
        return 0

    script = Path(__file__).resolve()
    cold: list[dict[str, object]] = []
    warm: list[dict[str, object]] = []
    for repeat in range(args.repetitions):
        order = ENGINES if repeat % 2 == 0 else tuple(reversed(ENGINES))
        for engine in order:
            cold_sample = run_process(script, engine, 1, args.items, 0)
            cold_sample["repeat"] = repeat + 1
            cold.append(cold_sample)
        for engine in reversed(order):
            warm_sample = run_process(
                script, engine, args.iterations, args.items, args.warmups
            )
            warm_sample["repeat"] = repeat + 1
            warm.append(warm_sample)

    result = {
        "schemaVersion": 1,
        "scope": {
            "networkUsed": False,
            "fixture": "generated public catalogue HTML",
            "baseline": "minimal lxml 6.1.1 reference; no pre-existing NCO equivalent",
            "candidate": "Scrapling Selector 0.4.11",
            "fields": SELECTORS,
            "itemsPerDocument": args.items,
            "warmIterationsPerRepeat": args.iterations,
            "repetitions": args.repetitions,
        },
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "logicalCpuCount": os.cpu_count(),
            "scrapling": metadata.version("scrapling"),
            "lxml": metadata.version("lxml"),
        },
        "command": (
            f"{sys.executable} {script} --repetitions {args.repetitions} "
            f"--iterations {args.iterations} --items {args.items}"
        ),
        "coldSamples": cold,
        "warmSamples": warm,
        "summary": summarize(cold, warm),
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
