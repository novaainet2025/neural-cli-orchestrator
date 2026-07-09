"""macOS ``say`` command-line adapter."""

from __future__ import annotations

import platform
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

from adapters.base import BaseAdapter
from server.models import AdapterDescriptor, TtsSynthesisRequest


class MacSayAdapter(BaseAdapter):
    """Wraps macOS `/usr/bin/say` plus ``afconvert`` to emit WAV."""

    adapter_id = "mac_say"

    def describe(self) -> AdapterDescriptor:
        return AdapterDescriptor(
            adapter_id=self.adapter_id,
            label="macOS built-in speech (say)",
            streaming=False,
            formats=["audio/wav"],
        )

    def synthesize_stream(self, req: TtsSynthesisRequest) -> Iterator[bytes]:
        if platform.system() != "Darwin":
            raise RuntimeError("MacSayAdapter only runs on Darwin (macOS).")
        voice = req.voice or "Yuna"
        with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as aiff_fp:
            aiff_path = Path(aiff_fp.name)
        wav_path = aiff_path.with_suffix(".wav")
        try:
            say = subprocess.run(
                ["say", "-v", voice, "-o", str(aiff_path), req.text],
                check=False,
                capture_output=True,
                text=True,
            )
            if say.returncode != 0:
                err = (say.stderr or say.stdout or "").strip()
                raise RuntimeError(f"say failed (exit {say.returncode}): {err or 'unknown error'}")
            conv = subprocess.run(
                ["afconvert", "-f", "WAVE", "-d", "LEI16", str(aiff_path), str(wav_path)],
                check=False,
                capture_output=True,
                text=True,
            )
            if conv.returncode != 0:
                err = (conv.stderr or conv.stdout or "").strip()
                raise RuntimeError(f"afconvert failed (exit {conv.returncode}): {err or 'unknown error'}")
            yield wav_path.read_bytes()
        finally:
            aiff_path.unlink(missing_ok=True)
            wav_path.unlink(missing_ok=True)
