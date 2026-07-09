from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

from .config import Settings, load_settings
from .db_client import DatabaseClient
from .prompt_optimizer import OptimizationInput, PromptOptimizer

try:
    from apscheduler.schedulers.blocking import BlockingScheduler
except Exception:  # pragma: no cover - optional dependency
    BlockingScheduler = None


def run_once(settings: Settings) -> dict[str, Any]:
    db = DatabaseClient(settings)
    optimizer = PromptOptimizer(settings)

    persona = db.fetch_agent_persona(settings.target_agent_id)
    invocations = db.fetch_invocations(settings.target_agent_id, settings.invocation_limit)
    verification_gates = db.fetch_verification_gates(
        settings.target_agent_id, settings.verification_limit
    )
    benchmarks = db.fetch_benchmarks(settings.target_agent_id, settings.benchmark_limit)

    optimization = optimizer.optimize(
        OptimizationInput(
            persona=persona,
            invocations=invocations,
            verification_gates=verification_gates,
            benchmarks=benchmarks,
        )
    )

    stored: dict[str, Any] | None = None
    if optimization.proposal is not None:
        stored = db.store_proposal(optimization.proposal, dry_run=settings.dry_run)

    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "agent_id": settings.target_agent_id,
        "proposal_created": optimization.proposal is not None,
        "storage": stored,
        "provider_mode": optimization.provider_mode,
        "critique_score": optimization.critique_score,
        "critique_text": optimization.critique_text,
        "attempts": optimization.attempts,
        "counts": {
            "invocations": len(invocations),
            "verification_gates": len(verification_gates),
            "benchmarks": len(benchmarks),
        },
        "analysis": optimization.analysis,
    }
    if optimization.proposal is not None:
        summary["proposal_preview"] = {
            "rationale": optimization.proposal.rationale,
            "new_prompt_suffix": optimization.proposal.new_prompt[-500:],
            "source": optimization.proposal.source,
        }
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GEPA sidecar pilot scheduler")
    parser.add_argument("--once", action="store_true", help="run a single batch")
    parser.add_argument("--interval-seconds", type=int, default=900)
    parser.add_argument("--dry-run", action="store_true", help="avoid DB queue inserts")
    args = parser.parse_args(argv)

    settings = load_settings()
    if args.dry_run:
        settings = Settings(**{**asdict(settings), "dry_run": True})

    if args.once or BlockingScheduler is None:
        result = run_once(settings)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0 if result["proposal_created"] else 2

    scheduler = BlockingScheduler(timezone="UTC")
    scheduler.add_job(lambda: print(json.dumps(run_once(settings), ensure_ascii=True)), "interval", seconds=args.interval_seconds)
    print(
        json.dumps(
            {
                "event": "scheduler_started",
                "interval_seconds": args.interval_seconds,
                "apscheduler_available": True,
            },
            ensure_ascii=True,
        )
    )
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        return 0
    finally:
        time.sleep(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())

