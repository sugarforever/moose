#!/usr/bin/env python3
"""Fail closed if unmodified iSH can mount a controlled host directory.

Only a newly created temporary sentinel is read. No app/user data is inspected.
A failure is an integration blocker, not an expected-safe test pass.
"""
import argparse
from pathlib import Path
import subprocess
import tempfile

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--runner', required=True, type=Path)
p.add_argument('--root', required=True, type=Path)
a = p.parse_args()
with tempfile.TemporaryDirectory(prefix='moose-ish-boundary-') as directory:
    sentinel = b'controlled-host-sentinel'
    Path(directory, 'marker').write_bytes(sentinel)
    result = subprocess.run([str(a.runner.resolve()), str(a.root.resolve()), '/', '--',
        '/bin/sh', '-c', 'printf "MOOSE_AUDIT_READY\\n"; mkdir -p /workspace/.mount-boundary || exit 92; '
        'if mount -t real "$1" /workspace/.mount-boundary; then cat /workspace/.mount-boundary/marker; '
        'else printf "MOOSE_AUDIT_DENIED\\n"; exit 17; fi',
        'audit', directory], env={}, capture_output=True, timeout=10)
    if not result.stdout.startswith(b'MOOSE_AUDIT_READY\n'):
        raise SystemExit('INCONCLUSIVE: guest did not confirm readiness')
    if sentinel in result.stdout:
        raise SystemExit('BLOCKED: guest mounted a host directory outside its root; do not expose this kernel to models')
    if result.returncode != 17 or result.stdout != b'MOOSE_AUDIT_READY\nMOOSE_AUDIT_DENIED\n':
        raise SystemExit('INCONCLUSIVE: guest did not confirm a completed mount-denial probe')
    print('Mount probe denied; this single check does not establish complete isolation')
