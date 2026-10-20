"""Bounded streaming capture for the standalone HOST feasibility executable.

Killing this process terminates all guest threads. This mechanism cannot be used
inside Moose: native per-command process-group cancellation remains unimplemented.
"""
import os
import selectors
import subprocess
import time


class OutputLimit(RuntimeError):
    pass


def execute(argv, *, timeout=15, max_bytes=1024 * 1024, on_output=None):
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    total = 0
    deadline = time.monotonic() + timeout
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, env={}) as process:
        try:
            with selectors.DefaultSelector() as selector:
                for stream in output:
                    descriptor = getattr(process, stream)
                    os.set_blocking(descriptor.fileno(), False)
                    selector.register(descriptor, selectors.EVENT_READ, stream)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    for key, _ in selector.select(min(remaining, 0.1)):
                        chunk = os.read(key.fd, min(16384, max_bytes - total + 1))
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        total += len(chunk)
                        if total > max_bytes:
                            raise OutputLimit(f'guest output exceeded {max_bytes} bytes')
                        output[key.data].extend(chunk)
                        if on_output:
                            on_output(key.data, chunk, process)
                status = process.wait(timeout=max(0.001, deadline - time.monotonic()))
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    return subprocess.CompletedProcess(argv, status, bytes(output['stdout']), bytes(output['stderr']))
