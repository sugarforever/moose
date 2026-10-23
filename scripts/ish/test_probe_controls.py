#!/usr/bin/env python3
"""Regression tests for feasibility tooling failures, without claiming guest evidence."""
from pathlib import Path
import subprocess
import sys
import unittest

class AuditControls(unittest.TestCase):
    def test_runner_failure_is_not_reported_as_isolation(self):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('audit_guest_boundary.py')),
                                 '--runner', '/usr/bin/false', '--root', '/does-not-exist'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('INCONCLUSIVE', result.stderr)

if __name__ == '__main__':
    unittest.main()
