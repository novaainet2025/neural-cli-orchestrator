"""Abstract base class for TTS adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterator
from typing import ClassVar

from server.models import AdapterDescriptor, TtsSynthesisRequest


class BaseAdapter(ABC):
    """Pluggable TTS backend. Implement :meth:`synthesize_stream` for audio chunks."""

    adapter_id: ClassVar[str]

    def __init_subclass__(cls, **kwargs: object) -> None:
        super().__init_subclass__(**kwargs)
        aid = getattr(cls, "adapter_id", "")
        if not isinstance(aid, str) or not aid.strip():
            raise TypeError(f"{cls.__name__} must define non-empty str adapter_id")

    def describe(self) -> AdapterDescriptor:
        return AdapterDescriptor(
            adapter_id=self.adapter_id,
            label=self.__class__.__doc__.split("\n", 1)[0].strip()
            if self.__class__.__doc__
            else self.adapter_id,
            streaming=True,
        )

    @abstractmethod
    def synthesize_stream(self, req: TtsSynthesisRequest) -> Iterator[bytes]:
        """Yield encoded audio fragments (full file in one chunk is allowed)."""

    def synthesize_all(self, req: TtsSynthesisRequest) -> bytes:
        return b"".join(self.synthesize_stream(req))
