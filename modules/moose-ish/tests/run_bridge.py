#!/usr/bin/env python3
"""Compile the actual Objective-C bridge against the real macOS embedded core."""
import argparse
from pathlib import Path
import subprocess
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--core',type=Path,required=True,help='build_embedded.py --sdk macosx output')
a=p.parse_args(); here=Path(__file__).resolve().parent
binary=a.core/'bridge-harness'
subprocess.run(['clang','-fobjc-arc','-fblocks','-I'+str(here/'react'),'-I'+str(a.core/'include'),str(here/'bridge_harness.m'),str(a.core/'libMooseISHCore.a'),'-framework','Foundation','-lsqlite3','-lpthread','-o',str(binary)],check=True)
subprocess.run([str(binary),str(a.core/'root')],check=True,timeout=60)
