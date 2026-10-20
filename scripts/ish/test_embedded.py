#!/usr/bin/env python3
"""Run real same-kernel host suite and optionally the UIKit simulator suite."""
import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--core',required=True,type=Path,help='macosx build output')
    parser.add_argument('--simulator',type=Path,help='iphonesimulator build output')
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='moose-ish-core-test-') as temp:
        roots=[]
        for name in ['a','b']:
            root=Path(temp)/name
            shutil.copytree(args.core/'root',root)
            roots.append(root/'data')
        subprocess.run([str(args.core/'moose-ish-core-test'),*map(str,roots)],check=True,timeout=60)
        # Separate process opens the persisted same fakefs, demonstrating reopen.
        subprocess.run([str(args.core/'moose-ish-exec'),str(roots[0]),'/workspace','--','/bin/sh','-c',"test \"$(cat state)\" = first"],check=True,timeout=20)
    if args.simulator:
        app=args.simulator/'MooseISHEmbeddedTest.app'
        bundle='dev.moose.ishembeddedtest'
        subprocess.run(['xcrun','simctl','install','booted',str(app)],check=True)
        subprocess.run(['xcrun','simctl','terminate','booted',bundle],capture_output=True)
        container=Path(subprocess.check_output(['xcrun','simctl','get_app_container','booted',bundle,'data'],text=True).strip())
        result=container/'Documents/embedded/result.plist'
        result.unlink(missing_ok=True)
        subprocess.run(['xcrun','simctl','launch','booted',bundle],check=True)
        deadline=time.monotonic()+60
        while not result.exists() and time.monotonic()<deadline: time.sleep(.25)
        if not result.exists(): raise RuntimeError('Simulator did not produce result; inspect crash logs')
        data=plistlib.loads(result.read_bytes())
        if data!={'exitCode':0,'hostAlive':True}: raise RuntimeError(data)
        print('PASS UIKit host alive after same-kernel integration suite')

if __name__=='__main__': main()
