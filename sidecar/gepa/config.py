from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    repo_root: Path
    db_path: Path
    queue_file_path: Path
    target_agent_id: str
    openrouter_api_key: str | None
    openrouter_base_url: str
    openrouter_model: str
    critique_threshold: float
    max_refinement_attempts: int
    invocation_limit: int
    verification_limit: int
    benchmark_limit: int
    prompt_excerpt_limit: int
    dry_run: bool
    force_rule_based: bool


def load_settings() -> Settings:
    repo_root = Path(os.getenv("GEPA_REPO_ROOT", _repo_root())).resolve()
    db_path = Path(os.getenv("GEPA_DB_PATH", repo_root / "db" / "nco.db")).resolve()
    queue_file_path = Path(
        os.getenv(
            "GEPA_QUEUE_FILE_PATH",
            repo_root / "sidecar" / "gepa" / "approval_queue.jsonl",
        )
    ).resolve()
    return Settings(
        repo_root=repo_root,
        db_path=db_path,
        queue_file_path=queue_file_path,
        target_agent_id=os.getenv("GEPA_TARGET_AGENT_ID", "openrouter"),
        openrouter_api_key=os.getenv("OPENROUTER_API_KEY"),
        openrouter_base_url=os.getenv(
            "OPENROUTER_BASE_URL",
            "https://openrouter.ai/api/v1",
        ),
        openrouter_model=os.getenv(
            "GEPA_OPENROUTER_MODEL",
            "openai/gpt-oss-20b:free",
        ),
        critique_threshold=float(os.getenv("GEPA_CRITIQUE_THRESHOLD", "0.8")),
        max_refinement_attempts=int(os.getenv("GEPA_MAX_REFINEMENT_ATTEMPTS", "2")),
        invocation_limit=int(os.getenv("GEPA_INVOCATION_LIMIT", "50")),
        verification_limit=int(os.getenv("GEPA_VERIFICATION_LIMIT", "50")),
        benchmark_limit=int(os.getenv("GEPA_BENCHMARK_LIMIT", "20")),
        prompt_excerpt_limit=int(os.getenv("GEPA_PROMPT_EXCERPT_LIMIT", "280")),
        dry_run=os.getenv("GEPA_DRY_RUN", "0") == "1",
        force_rule_based=os.getenv("GEPA_FORCE_RULE_BASED", "0") == "1",
    )

