#!/usr/bin/env python3
"""Acceptance tests against a real iSH executable; never substitutes host sh."""
import argparse
import os
from pathlib import Path
import subprocess
import unittest
from host_runner import execute, OutputLimit

parser = argparse.ArgumentParser()
parser.add_argument('--runner', required=True, type=Path)
parser.add_argument('--root', required=True, type=Path)
args, rest = parser.parse_known_args()

class GuestTests(unittest.TestCase):
    def run_guest(self, *argv, timeout=15, cwd='/workspace', variables=()):
        # Empty host environment deliberately prevents secret inheritance.
        return execute([str(args.runner.resolve()), str(args.root.resolve()), cwd,
                        *variables, '--', *argv], timeout=timeout)

    def test_argv_cwd_env_streams_and_exit(self):
        result = self.run_guest('/bin/sh', '-c',
            'printf "%s|%s|%s" "$PWD" "$PROBE" "$1"; printf error >&2; exit 7',
            'probe', 'literal; $(false)', variables=('PROBE=value with spaces',))
        self.assertEqual(result.stdout, b'/workspace|value with spaces|literal; $(false)')
        self.assertEqual(result.stderr, b'error')
        self.assertEqual(result.returncode, 7)

    def test_real_fork_pipeline_and_persistent_files(self):
        first = self.run_guest('/bin/sh', '-c',
            'printf persistent > saved; (printf child | cat) & wait; cat saved')
        self.assertEqual((first.returncode, first.stdout), (0, b'childpersistent'))
        second = self.run_guest('/bin/cat', '/workspace/saved')
        self.assertEqual((second.returncode, second.stdout), (0, b'persistent'))

    def test_no_inherited_host_credentials(self):
        result = self.run_guest('/bin/sh', '-c', 'printf "%s" "$HOME$OPENAI_API_KEY$ANTHROPIC_API_KEY"')
        self.assertEqual((result.returncode, result.stdout), (0, b''))

    def test_host_harness_timeout(self):
        # This terminates the standalone host process. It is NOT mobile cancellation.
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_guest('/bin/sh', '-c', 'while :; do :; done', timeout=0.5)

    def test_streams_arrive_before_process_exit(self):
        observed = []
        result = execute([str(args.runner.resolve()), str(args.root.resolve()), '/', '--',
            '/bin/sh', '-c', 'printf first; sleep 1; printf second >&2'],
            on_output=lambda stream, chunk, process: observed.append((stream, chunk, process.poll())))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(any(stream == 'stdout' and b'first' in chunk and status is None
                            for stream, chunk, status in observed))
        self.assertTrue(any(stream == 'stderr' and b'second' in chunk
                            for stream, chunk, _ in observed))

    def test_output_flood_is_bounded(self):
        with self.assertRaises(OutputLimit):
            execute([str(args.runner.resolve()), str(args.root.resolve()), '/', '--',
                     '/bin/sh', '-c', 'yes flood'], max_bytes=65536)

    def test_oversized_argv_rejected_without_crash(self):
        result = self.run_guest('/bin/echo', 'x' * 40000)
        self.assertEqual(result.returncode, 70)
        self.assertIn(b'boot failed', result.stderr)

    def test_invalid_cwd_fails(self):
        self.assertNotEqual(self.run_guest('/bin/true', cwd='/does-not-exist').returncode, 0)

unittest.main(argv=[__file__, *rest])
