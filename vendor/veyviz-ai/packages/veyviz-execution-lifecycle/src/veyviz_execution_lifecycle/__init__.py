"""Local tensor executor ownership; model and deployment policy stay outside."""

from .slot import ExecutorSlot, SlotError, SlotState, StaleExecutionError

__all__ = ["ExecutorSlot", "SlotError", "SlotState", "StaleExecutionError"]
