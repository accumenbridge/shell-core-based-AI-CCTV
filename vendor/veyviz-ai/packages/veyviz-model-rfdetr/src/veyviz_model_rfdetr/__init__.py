"""Pinned RF-DETR-small person task adapter, independent of native execution."""

from .persons import LARGE_MODEL_SHA256, MODEL_SHA256, RfDetrLargePersonAdapter, RfDetrSmallPersonAdapter

__all__ = ["MODEL_SHA256", "LARGE_MODEL_SHA256", "RfDetrSmallPersonAdapter", "RfDetrLargePersonAdapter"]
