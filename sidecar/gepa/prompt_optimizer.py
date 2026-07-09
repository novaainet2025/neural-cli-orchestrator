from __future__ import annotations

import json
import re
from dataclasses import dataclass
from statistics import mean
from typing import Any
from urllib import error, request

from .config import Settings
from .db_client import (
    AgentPersona,
    BenchmarkRecord,
    InvocationRecord,
    ProposalRecord,
    VerificationRecord,
)


CORE_PRINCIPLE_MARKERS = (
    "VERIFY BEFORE CLAIM",
    "NO FABRICATION",
    "EVIDENCE TIERS",
    "TOOL DISCIPLINE",
    "COLLABORATION PROTOCOL",
    "SCOPE",
)


@dataclass(frozen=True)
class OptimizationInput:
    persona: AgentPersona
    invocations: list[InvocationRecord]
    verification_gates: list[VerificationRecord]
    benchmarks: list[BenchmarkRecord]


@dataclass(frozen=True)
class OptimizationResult:
    proposal: ProposalRecord | None
    critique_score: float
    critique_text: str
    attempts: int
    provider_mode: str
    analysis: dict[str, Any]


def _sanitize_text(raw: str | None, limit: int) -> str:
    if not raw:
        return ""
    text = re.sub(r"\s+", " ", raw).strip()
    text = re.sub(r"(?i)(user[_ -]?prompt|stdin)\s*:\s*.*", "[redacted user content]", text)
    return text[:limit]


class OpenRouterPilotProvider:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def is_enabled(self) -> bool:
        return bool(self.settings.openrouter_api_key) and not self.settings.force_rule_based

    def propose(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = {
            "model": self.settings.openrouter_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a GEPA sidecar pilot. Return JSON with keys "
                        "new_prompt, rationale, critique_score, critique_text."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(payload, ensure_ascii=True),
                },
            ],
            "response_format": {"type": "json_object"},
        }
        req = request.Request(
            f"{self.settings.openrouter_base_url}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.settings.openrouter_api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=30) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except error.URLError as exc:
            raise RuntimeError(f"openrouter request failed: {exc}") from exc
        content = raw["choices"][0]["message"]["content"]
        return json.loads(content)


class RuleBasedDraftGenerator:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def build(self, data: OptimizationInput) -> tuple[str, str, dict[str, Any]]:
        original_prompt = str(data.persona.persona_json.get("systemPrompt", "")).strip()
        completed = sum(1 for item in data.invocations if item.status == "completed")
        failed = sum(1 for item in data.invocations if item.status == "failed")
        pending = sum(1 for item in data.invocations if item.status in {"pending", "running"})
        verifier_fail = sum(1 for item in data.verification_gates if item.status == "fail")
        verifier_skip = sum(1 for item in data.verification_gates if item.status == "skip")
        low_bench = [item for item in data.benchmarks if item.passed == 0 or item.score < 60]
        low_bench_names = ", ".join(sorted({item.test_name for item in low_bench[:5]})) or "none"
        failed_examples = [
            _sanitize_text(item.error or item.result_summary, self.settings.prompt_excerpt_limit)
            for item in data.invocations
            if item.status == "failed"
        ]
        completed_examples = [
            _sanitize_text(item.result_summary, self.settings.prompt_excerpt_limit)
            for item in data.invocations
            if item.status == "completed"
        ]
        failure_examples = failed_examples + completed_examples
        failure_examples = [item for item in failure_examples if item][:3]

        additions = [
            "7) FAILURE CONTAINMENT: when evidence is missing, block completion, say 'unverified', and name the exact check still required.",
            "8) TASK CLOSURE: do not stop at partial analysis; either implement and verify, or return 'question:' / 'error:' with the blocking evidence.",
            "9) VERIFIER AWARENESS: when code or config changes are requested, explicitly run the narrowest relevant verification command before 'done:'.",
            "10) LOW-SIGNAL OUTPUT AVOIDANCE: avoid one-word replies, generic acknowledgements, and question-only responses when the task already specifies an implementation target.",
            "11) APPROVAL BOUNDARY: never auto-apply self-generated prompt mutations; only enqueue them for explicit approval.",
        ]
        if verifier_skip:
            additions.append(
                "12) GATE COVERAGE: if a verifier is skipped or unavailable, say so explicitly and compensate with the strongest available local check."
            )
        if low_bench:
            additions.append(
                f"13) BENCHMARK RECOVERY: prioritize concrete implementation detail over abstract explanation for weak benchmark patterns ({low_bench_names})."
            )

        new_prompt = original_prompt.rstrip()
        if new_prompt and not new_prompt.endswith("\n"):
            new_prompt += "\n"
        new_prompt += "\n" + "\n".join(additions)

        rationale_bits = [
            f"recent invocations completed={completed}, failed={failed}, pending_or_running={pending}",
            f"verification gates fail={verifier_fail}, skip={verifier_skip}",
            f"low benchmarks={low_bench_names}",
        ]
        if failure_examples:
            rationale_bits.append("examples=" + " | ".join(failure_examples))
        rationale = "; ".join(rationale_bits)
        analysis = {
            "completed": completed,
            "failed": failed,
            "pending_or_running": pending,
            "verification_fail": verifier_fail,
            "verification_skip": verifier_skip,
            "low_benchmark_count": len(low_bench),
            "low_benchmark_names": sorted({item.test_name for item in low_bench}),
            "failure_examples": failure_examples,
        }
        return new_prompt, rationale, analysis


class SelfCorrectionGate:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def evaluate(
        self,
        original_prompt: str,
        proposed_prompt: str,
        analysis: dict[str, Any],
    ) -> tuple[float, str]:
        score = 0.55
        notes: list[str] = []

        preserved = [marker for marker in CORE_PRINCIPLE_MARKERS if marker in proposed_prompt]
        score += min(0.25, len(preserved) * 0.04)
        notes.append(f"preserved_core_markers={len(preserved)}/{len(CORE_PRINCIPLE_MARKERS)}")

        if "FAILURE CONTAINMENT" in proposed_prompt:
            score += 0.08
            notes.append("adds failure containment guidance")
        if "VERIFIER AWARENESS" in proposed_prompt:
            score += 0.06
            notes.append("adds verifier-aware execution rule")
        if "LOW-SIGNAL OUTPUT AVOIDANCE" in proposed_prompt:
            score += 0.05
            notes.append("discourages low-signal replies")
        if "APPROVAL BOUNDARY" in proposed_prompt:
            score += 0.04
            notes.append("keeps approval gate explicit")
        if analysis.get("low_benchmark_count", 0) > 0 and "BENCHMARK RECOVERY" in proposed_prompt:
            score += 0.06
            notes.append("responds to low benchmark evidence")

        if original_prompt and len(proposed_prompt) > len(original_prompt):
            score += 0.03
            notes.append("extends rather than replaces the original prompt")
        if "automatic" in proposed_prompt.lower() and "approval" in proposed_prompt.lower():
            notes.append("mentions approval boundary")

        final_score = min(0.99, round(score, 2))
        critique = "; ".join(notes)
        return final_score, critique


class PromptOptimizer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provider = OpenRouterPilotProvider(settings)
        self.rule_based = RuleBasedDraftGenerator(settings)
        self.gate = SelfCorrectionGate(settings)

    def optimize(self, data: OptimizationInput) -> OptimizationResult:
        original_prompt = str(data.persona.persona_json.get("systemPrompt", "")).strip()
        if not original_prompt:
            raise ValueError("persona.systemPrompt is missing")

        candidate_prompt = ""
        rationale = ""
        analysis: dict[str, Any] = {}
        provider_mode = "rule_based"
        attempts = 0

        if self.provider.is_enabled() and not self.settings.dry_run:
            try:
                llm_result = self.provider.propose(self._build_provider_payload(data))
                candidate_prompt = str(llm_result.get("new_prompt", "")).strip()
                rationale = str(llm_result.get("rationale", "")).strip()
                analysis = {"provider_response": llm_result}
                provider_mode = "openrouter"
            except Exception as exc:
                provider_mode = f"rule_based_fallback:{exc}"

        if not candidate_prompt:
            candidate_prompt, rationale, analysis = self.rule_based.build(data)

        while attempts <= self.settings.max_refinement_attempts:
            attempts += 1
            critique_score, critique_text = self.gate.evaluate(
                original_prompt=original_prompt,
                proposed_prompt=candidate_prompt,
                analysis=analysis,
            )
            if critique_score >= self.settings.critique_threshold:
                proposal = ProposalRecord(
                    agent_id=data.persona.agent_id,
                    old_prompt=original_prompt,
                    new_prompt=candidate_prompt,
                    rationale=rationale,
                    critique_score=critique_score,
                    critique_text=critique_text,
                    source=provider_mode,
                )
                return OptimizationResult(
                    proposal=proposal,
                    critique_score=critique_score,
                    critique_text=critique_text,
                    attempts=attempts,
                    provider_mode=provider_mode,
                    analysis=analysis,
                )
            candidate_prompt = self._refine(candidate_prompt, critique_text)

        return OptimizationResult(
            proposal=None,
            critique_score=critique_score,
            critique_text=critique_text,
            attempts=attempts,
            provider_mode=provider_mode,
            analysis=analysis,
        )

    def _build_provider_payload(self, data: OptimizationInput) -> dict[str, Any]:
        return {
            "agent_id": data.persona.agent_id,
            "original_prompt": data.persona.persona_json.get("systemPrompt", ""),
            "invocations": [
                {
                    "status": item.status,
                    "error": _sanitize_text(item.error, self.settings.prompt_excerpt_limit),
                    "result_summary": _sanitize_text(
                        item.result_summary, self.settings.prompt_excerpt_limit
                    ),
                }
                for item in data.invocations[:10]
            ],
            "verification_gates": [
                {
                    "gate_level": item.gate_level,
                    "status": item.status,
                    "detail_json": _sanitize_text(
                        item.detail_json, self.settings.prompt_excerpt_limit
                    ),
                }
                for item in data.verification_gates[:10]
            ],
            "benchmarks": [
                {
                    "test_name": item.test_name,
                    "score": item.score,
                    "passed": item.passed,
                }
                for item in data.benchmarks[:10]
            ],
        }

    def _refine(self, candidate_prompt: str, critique_text: str) -> str:
        refinement_lines = []
        if "verifier-aware" not in critique_text.lower():
            refinement_lines.append(
                "13) VERIFICATION ESCALATION: prefer direct file, DB, or command evidence over self-report when deciding completion."
            )
        if "low-signal" not in critique_text.lower():
            refinement_lines.append(
                "14) RESPONSE QUALITY FLOOR: if the task names target files or commands, address those directly instead of asking broad clarifying questions."
            )
        if not refinement_lines:
            refinement_lines.append(
                "15) APPROVAL GATE: never auto-apply prompt mutations; only enqueue them for explicit approval."
            )
        return candidate_prompt.rstrip() + "\n" + "\n".join(refinement_lines)
