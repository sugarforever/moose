import unittest
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
class Package(unittest.TestCase):
 def test_package_is_ios_only(self):
  package=json.loads((ROOT/'package.json').read_text())
  self.assertEqual(package['name'],'moose-ish')
  self.assertTrue((ROOT/'MooseISH.podspec').exists())
  self.assertIn('MooseISH', (ROOT/'react-native.config.js').read_text())
 def test_vendor_is_not_committed(self):
  self.assertIn('vendor/', (ROOT/'.gitignore').read_text())
if __name__=='__main__': unittest.main()
