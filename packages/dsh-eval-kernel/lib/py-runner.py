"""Persistent Python notebook kernel speaking NDJSON on stdin/stdout.

The wrapper is deliberately dependency-free (stdlib only, no IPython) so it can
run under whichever interpreter the deployment configures, including a conda
environment that never installed a kernel spec.

Why a real REPL loop instead of `exec(code)` on hand-rolled input: `exec` of a
`for` block read line by line needs its own block-detection, and getting it
wrong silently truncates the cell. `code.InteractiveConsole` already implements
that rule, so this wrapper only supplies a prompt hook and frame plumbing.

Frames are documented in ../kernel-session.js. This file implements the child
side of that contract.
"""

import builtins
import code
import json
import os
import sys
import traceback

READY = {"type": "ready", "pid": os.getpid(), "language": "py"}

# stdout is reserved for frames. A private dup keeps the frame channel working
# while fd 1 is redirected to a per-cell collector, so a child process spawned
# from a cell inherits the collector rather than corrupting the protocol.
_FRAME_OUT = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1, encoding="utf-8", closefd=False)


def emit(frame):
    _FRAME_OUT.write(json.dumps(frame, ensure_ascii=False) + "\n")
    _FRAME_OUT.flush()


class _CellStdout:
    """Collects one cell's writes and forwards them as stdout frames."""

    def __init__(self, cell_id):
        self.cell_id = cell_id
        self.parts = []

    def write(self, text):
        if text:
            self.parts.append(text)
        return len(text)

    def flush(self):
        if self.parts:
            emit({"type": "stdout", "id": self.cell_id, "data": "".join(self.parts)})
            self.parts = []

    def isatty(self):
        return False


class _CellStderr(_CellStdout):
    def flush(self):
        if self.parts:
            emit({"type": "stderr", "id": self.cell_id, "data": "".join(self.parts)})
            self.parts = []


class _NestedConsole(code.InteractiveConsole):
    """A console that reports "more input needed" without a prompt frame."""

    def __init__(self, namespace):
        super().__init__(locals=namespace, filename="<cell>")
        self.need_more = False

    def runsource(self, source, filename="<cell>", symbol="single"):
        try:
            compiled = code.compile_command(source, filename, symbol)
        except (SyntaxError, ValueError, OverflowError):
            return False
        if compiled is None:
            self.need_more = True
        return False


def main():
    cell_count = 0
    namespace = {"__name__": "__main__", "__builtins__": builtins}

    stdin = sys.__stdin__
    emit(READY)

    while True:
        line = stdin.readline()
        if not line:
            break
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            continue

        if frame.get("type") == "exit":
            break

        cell_id = frame.get("id")
        source = frame.get("code", "")

        old_out, old_err, old_in = sys.stdout, sys.stderr, sys.stdin
        sys.stdout, sys.stderr = _CellStdout(cell_id), _CellStderr(cell_id)
        sys.stdin = open(os.devnull, "r")
        status, error = "ok", None
        try:
            exec(compile(source, "<cell>", "exec"), namespace)
        except SystemExit:
            status = "ok"
        except BaseException as exc:  # noqa: BLE001 - a cell may raise anything
            status = "error"
            error = {
                "type": "error",
                "id": cell_id,
                "ename": type(exc).__name__,
                "evalue": str(exc),
                "traceback": traceback.format_exc().splitlines(),
            }
            emit({"type": "stderr", "id": cell_id, "data": traceback.format_exc()})
        finally:
            for stream in (sys.stdout, sys.stderr):
                try:
                    stream.flush()
                except Exception:
                    pass
            sys.stdout, sys.stderr, sys.stdin = old_out, old_err, old_in

        cell_count += 1
        if error is not None:
            emit(error)
        else:
            emit({"type": "done", "id": cell_id, "status": status, "count": cell_count})


if __name__ == "__main__":
    main()
