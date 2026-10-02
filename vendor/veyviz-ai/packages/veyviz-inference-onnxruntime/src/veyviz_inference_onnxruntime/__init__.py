"""Explicit ONNX Runtime CPU adapter."""

from .runtime import OnnxCpuExecutor
from .supervised import SupervisedOnnxCpuExecutor

__all__ = ["OnnxCpuExecutor", "SupervisedOnnxCpuExecutor"]
