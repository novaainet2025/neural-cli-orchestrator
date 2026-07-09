"""Auto-discover :class:`~adapters.base.BaseAdapter` implementations under ``adapters/``."""

from __future__ import annotations

import importlib
import pkgutil
from typing import Type

import adapters as adapters_pkg
from adapters.base import BaseAdapter


def iter_adapter_classes() -> list[Type[BaseAdapter]]:
    """Import every adapters submodule (except ``base``) and collect subclasses."""
    discovered: list[Type[BaseAdapter]] = []
    prefix = adapters_pkg.__name__ + "."
    mod: object
    name: str
    for _finder, name, is_pkg in pkgutil.iter_modules(adapters_pkg.__path__, prefix):
        if is_pkg or name.endswith("base"):
            continue
        try:
            mod = importlib.import_module(name)
        except ImportError:
            continue
        for obj in vars(mod).values():
            if isinstance(obj, type) and issubclass(obj, BaseAdapter) and obj is not BaseAdapter:
                discovered.append(obj)
    return sorted(discovered, key=lambda cls: cls.adapter_id)


def build_registry(
    instantiate: dict[str, dict[str, object]] | None = None,
) -> dict[str, BaseAdapter]:
    """Return ``adapter_id`` → adapter instance."""
    instantiate = instantiate or {}
    out: dict[str, BaseAdapter] = {}
    for cls in iter_adapter_classes():
        kwargs = instantiate.get(cls.adapter_id)
        instance = cls(**kwargs) if kwargs else cls()
        out[cls.adapter_id] = instance
    return out
