"""Local decoded-frame transport; no native decoder or source authority."""

from .receiver import FrameReceiver
from .worker import serve_frames

__all__ = ["FrameReceiver", "serve_frames"]
