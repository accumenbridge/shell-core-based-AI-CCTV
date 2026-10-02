"""Fixed recording decoder executable, owned by SupervisedRecordingSource."""

from __future__ import annotations

import sys
from pathlib import Path

from veyviz_media import SourceReadError
from veyviz_media_transport import serve_frames as serve
from veyviz_process_supervision import integer, read_message, write_message

from .source import PyAvRecordingSource


def main() -> None:
    directory = Path(sys.argv[1])
    try:
        config = read_message(directory / "config.json")
        path, digest = config.get("path"), config.get("sha256")
        if not isinstance(path, str) or not isinstance(digest, str):
            raise SourceReadError("recording path and digest required")
        source = PyAvRecordingSource(
            Path(path),
            expected_sha256=digest,
            max_file_bytes=integer(config, "max_file_bytes", minimum=1, maximum=1 << 40),
            max_frame_bytes=integer(config, "max_frame_bytes", minimum=1, maximum=64 * 1024 * 1024),
            snapshot_directory=directory,
            remove_snapshot_on_close=False,
        )
    except Exception as exc:
        write_message(
            directory, "reply.json", {"request_id": 0, "status": "failed", "reason": str(exc)[:1024]}
        )
        return
    try:
        serve(directory, source)
    finally:
        # A shutdown failure must not overwrite a published request reply.
        source.close()


if __name__ == "__main__":
    main()
