"""Pydantic models shared by the all-tts hub and adapters."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class TtsSynthesisRequest(BaseModel):
    """Normalized synthesis input for any backend."""

    text: str = Field(..., min_length=1, max_length=5000)
    lang: str = Field(default="ko", min_length=2, max_length=8)
    voice: Optional[str] = Field(
        default=None,
        description="Backend-specific voice (e.g. macOS voice name, Edge short name, Melo speaker).",
    )
    rate_percent: Optional[int] = Field(
        default=None,
        ge=-90,
        le=100,
        description="Optional rate delta in percent (Edge-tts style: +10 => 10% faster).",
    )
    mime_hint: Literal[
        "audio/mpeg",
        "audio/wav",
        "audio/aiff",
        "application/octet-stream",
    ] = "application/octet-stream"


class AdapterDescriptor(BaseModel):
    """Metadata for a registered TTS adapter."""

    adapter_id: str
    label: str
    streaming: bool = True
    formats: list[str] = Field(default_factory=lambda: ["audio/wav"])


class MeloTtsHttpPayload(BaseModel):
    """JSON body for POST /api/tts on @@gentop/lib/tts (Melo dashboard)."""

    text: str
    lang: str = "ko"
    speaker: Optional[str] = None
    speed: Optional[float] = Field(default=None, ge=0.3, le=3.0)
    preset: Optional[str] = None
    ssml: bool = False
    code_switch: bool = False
    en_speaker: Optional[str] = None
    cs_pause_ms: int = 120
