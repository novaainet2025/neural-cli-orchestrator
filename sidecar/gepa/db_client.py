from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .config import Settings


@dataclass(frozen=True)
class InvocationRecord:
    id: str
    task_id: str | None
    status: str
    created_at: str
    error: str | None
    result_summary: str | None
    model: str | None
    prompt: str | None


@dataclass(frozen=True)
class VerificationRecord:
    id: str
    task_id: str
    gate_level: str
    status: str
    detail_json: str | None
    created_at: str


@dataclass(frozen=True)
class BenchmarkRecord:
    id: int
    test_name: str
    score: float
    passed: int
    output_preview: str | None
    duration_ms: int
    created_at: str


@dataclass(frozen=True)
class AgentPersona:
    agent_id: str
    agent_name: str
    role: str
    model: str | None
    persona_json: dict[str, Any]


@dataclass(frozen=True)
class ProposalRecord:
    agent_id: str
    old_prompt: str
    new_prompt: str
    rationale: str
    critique_score: float
    critique_text: str
    source: str


class DatabaseClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _ro_connect(self) -> sqlite3.Connection:
        uri = f"file:{self.settings.db_path}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    def _rw_connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.settings.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        conn.execute("PRAGMA journal_mode = WAL")
        return conn

    def fetch_agent_persona(self, agent_id: str) -> AgentPersona:
        with self._ro_connect() as conn:
            row = conn.execute(
                """
                SELECT id, name, role, model, persona_json
                FROM agents
                WHERE id = ?
                """,
                (agent_id,),
            ).fetchone()
        if row is None:
            raise ValueError(f"unknown agent_id: {agent_id}")
        persona_json = json.loads(row["persona_json"] or "{}")
        return AgentPersona(
            agent_id=row["id"],
            agent_name=row["name"],
            role=row["role"],
            model=row["model"],
            persona_json=persona_json,
        )

    def fetch_invocations(self, agent_id: str, limit: int) -> list[InvocationRecord]:
        with self._ro_connect() as conn:
            rows = conn.execute(
                """
                SELECT id, target_task_id, status, created_at, error, result_summary, model, prompt
                FROM agent_invocations
                WHERE target_agent_id = ?
                ORDER BY datetime(created_at) DESC
                LIMIT ?
                """,
                (agent_id, limit),
            ).fetchall()
        return [
            InvocationRecord(
                id=row["id"],
                task_id=row["target_task_id"],
                status=row["status"],
                created_at=row["created_at"],
                error=row["error"],
                result_summary=row["result_summary"],
                model=row["model"],
                prompt=row["prompt"],
            )
            for row in rows
        ]

    def fetch_verification_gates(self, agent_id: str, limit: int) -> list[VerificationRecord]:
        with self._ro_connect() as conn:
            rows = conn.execute(
                """
                SELECT vg.id, vg.task_id, vg.gate_level, vg.status, vg.detail_json, vg.created_at
                FROM verification_gates vg
                JOIN agent_invocations ai ON ai.target_task_id = vg.task_id
                WHERE ai.target_agent_id = ?
                ORDER BY datetime(vg.created_at) DESC
                LIMIT ?
                """,
                (agent_id, limit),
            ).fetchall()
        return [
            VerificationRecord(
                id=row["id"],
                task_id=row["task_id"],
                gate_level=row["gate_level"],
                status=row["status"],
                detail_json=row["detail_json"],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def fetch_benchmarks(self, agent_id: str, limit: int) -> list[BenchmarkRecord]:
        with self._ro_connect() as conn:
            rows = conn.execute(
                """
                SELECT id, test_name, score, passed, output_preview, duration_ms, created_at
                FROM benchmark_results
                WHERE agent_id = ?
                ORDER BY datetime(created_at) DESC
                LIMIT ?
                """,
                (agent_id, limit),
            ).fetchall()
        return [
            BenchmarkRecord(
                id=row["id"],
                test_name=row["test_name"],
                score=row["score"],
                passed=row["passed"],
                output_preview=row["output_preview"],
                duration_ms=row["duration_ms"],
                created_at=row["created_at"],
            )
            for row in rows
        ]

    def queue_table_exists(self) -> bool:
        with self._ro_connect() as conn:
            row = conn.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'agent_evolution_queue'
                """
            ).fetchone()
        return row is not None

    def store_proposal(self, proposal: ProposalRecord, dry_run: bool) -> dict[str, Any]:
        if self.queue_table_exists() and not dry_run:
            return self._insert_queue_row(proposal)
        return self._append_queue_file(proposal)

    def _insert_queue_row(self, proposal: ProposalRecord) -> dict[str, Any]:
        with self._rw_connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO agent_evolution_queue (
                    agent_id,
                    old_prompt,
                    new_prompt,
                    rationale,
                    critique_score,
                    critique_text,
                    status
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending_approval')
                """,
                (
                    proposal.agent_id,
                    proposal.old_prompt,
                    proposal.new_prompt,
                    proposal.rationale,
                    proposal.critique_score,
                    proposal.critique_text,
                ),
            )
            conn.commit()
        return {
            "storage": "sqlite",
            "row_id": cursor.lastrowid,
            "path": str(self.settings.db_path),
        }

    def _append_queue_file(self, proposal: ProposalRecord) -> dict[str, Any]:
        path = self.settings.queue_file_path
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "status": "pending_approval",
            **asdict(proposal),
        }
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=True) + "\n")
        return {
            "storage": "file",
            "row_id": None,
            "path": str(path),
        }

