#!/usr/bin/env python3
"""Assert simulator guest execution AND survival of its UIKit host."""
import argparse
import os
import plistlib
from pathlib import Path
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--device', default='booted')
a = p.parse_args()
bundle = 'dev.moose.ishprobe'
def sim(*args, check=True):
    return subprocess.run(['xcrun', 'simctl', *args], check=check, capture_output=True, text=True).stdout.strip()

def launch():
    data = Path(sim('get_app_container', a.device, bundle, 'data')) / 'Documents' / 'probe'
    (data / 'exit.plist').unlink(missing_ok=True)
    launched = sim('launch', a.device, bundle)
    pid = int(launched.rsplit(':', 1)[1])
    deadline = time.monotonic() + 20
    while not (data / 'exit.plist').exists():
        if time.monotonic() > deadline:
            raise AssertionError('guest did not finish in 20s')
        time.sleep(0.1)
    with (data / 'exit.plist').open('rb') as f:
        assert plistlib.load(f)['exitCode'] == 7
    output = (data / 'stdout').read_text()
    assert 'cwd=/workspace env=explicit arg=literal; $(false)\n' in output, output
    assert 'pipeline\n' in output, output
    assert (data / 'stderr').read_text() == 'stderr-probe\n'
    time.sleep(0.5)
    os.kill(pid, 0)  # PID 1's guest exit must not kill the UIKit host.
    return output

sim('terminate', a.device, bundle, check=False)
launch()
sim('terminate', a.device, bundle)
assert 'reopened=persistent' in launch()
print('PASS: native shell, streams, status, fork/pipeline, host survival, persistent reopen')
