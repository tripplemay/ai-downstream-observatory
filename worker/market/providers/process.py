"""Internal bounded memory transport, with a kernel deadline across exec."""

import math
import os
import re
import selectors
import signal
import subprocess
import sys
import time


_LAUNCHER = (
    "import os,signal,sys;"
    "signal.signal(signal.SIGALRM,signal.SIG_DFL);"
    "signal.setitimer(signal.ITIMER_REAL,float(sys.argv[1]));"
    "os.execve(sys.argv[2],sys.argv[2:],os.environ)"
)


def child_argv(argv, timeout):
    return [sys.executable, "-I", "-c", _LAUNCHER, str(timeout), *argv]


def run_memory_process(argv, *, cwd, environment, error, timeout=30,
                       max_output=2 * 1024 * 1024, max_diagnostic=16 * 1024,
                       input_bytes=None, max_input=64 * 1024, exit_error_codes=None):
    """No disk capture. Callers supply fixed argv/env and a fixed error prefix."""
    if (isinstance(timeout, bool) or not isinstance(timeout, (int, float))
            or not math.isfinite(timeout) or not 0 < timeout <= 30):
        raise error("CALL_TIMEOUT_INVALID")
    if input_bytes is not None and (not isinstance(input_bytes, bytes) or len(input_bytes) > max_input):
        raise error("PROCESS_INPUT_LIMIT")
    if exit_error_codes is not None and (
            type(exit_error_codes) is not dict or len(exit_error_codes) > 64
            or any(type(code) is not int or not 2 <= code <= 125
                   or type(name) is not str or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", name, re.ASCII)
                   for code, name in exit_error_codes.items())):
        raise error("PROCESS_EXIT_MAPPING_INVALID")
    exit_error_codes = dict(exit_error_codes or {})
    process = None
    output, diagnostic = bytearray(), bytearray()
    deadline = time.monotonic() + timeout
    try:
        process = subprocess.Popen(child_argv(argv, timeout), cwd=cwd, env=environment,
                                   stdin=subprocess.DEVNULL if input_bytes is None else subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        offset = 0
        with selectors.DefaultSelector() as selector:
            for pipe, buffer, limit in ((process.stdout, output, max_output),
                                        (process.stderr, diagnostic, max_diagnostic)):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, (buffer, limit))
            if input_bytes is not None:
                if input_bytes:
                    os.set_blocking(process.stdin.fileno(), False)
                    selector.register(process.stdin, selectors.EVENT_WRITE, None)
                else:
                    process.stdin.close()
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise error("CALL_TIMEOUT")
                for key, _ in selector.select(min(remaining, 0.1)):
                    try:
                        if key.data is None:
                            offset += os.write(key.fd, input_bytes[offset:offset + 65536])
                            if offset == len(input_bytes):
                                selector.unregister(key.fileobj)
                                process.stdin.close()
                            continue
                        chunk = os.read(key.fd, 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    buffer, limit = key.data
                    buffer.extend(chunk)
                    if len(buffer) > limit:
                        raise error("PROCESS_OUTPUT_LIMIT")
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
        if process.returncode == -signal.SIGALRM:
            raise error("CALL_TIMEOUT")
        if process.returncode != 0:
            if process.returncode in exit_error_codes:
                raise error(exit_error_codes[process.returncode])
            message = diagnostic.decode("utf-8", errors="replace").lower()
            if re.search(r"\b401\b|unauthorized|authentication", message):
                raise error("AUTHENTICATION_FAILED")
            if re.search(r"\b403\b|permission|entitlement|not subscribed", message):
                raise error("PERMISSION_OR_ENTITLEMENT_FAILED")
            if re.search(r"\b429\b|rate.limit", message):
                raise error("RATE_LIMITED")
            raise error("PROVIDER_CALL_FAILED")
        return bytes(output)
    except subprocess.TimeoutExpired:
        raise error("CALL_TIMEOUT") from None
    except OSError:
        raise error("PROCESS_START_OR_IO_FAILED") from None
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()
