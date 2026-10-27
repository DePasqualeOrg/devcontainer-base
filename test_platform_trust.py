"""Trust selection regressions; run in the development image."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('image_trust', Path(__file__).with_name('configure-platform-trust.py'))
trust = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trust)


class DistributionPolicyTests(unittest.TestCase):
    def test_exclusion_preserves_other_anchors_comments_and_previous_choices(self):
        original = '# packaged roots\nmozilla/blocked.crt\nmozilla/blocked.crt.old\n!mozilla/disabled.crt\nmozilla/retained.crt\n'
        expected = '# packaged roots\n!mozilla/blocked.crt\nmozilla/blocked.crt.old\n!mozilla/disabled.crt\nmozilla/retained.crt\n'
        self.assertEqual(trust.disabled_configuration(original, {'mozilla/blocked.crt'}), expected)
        self.assertEqual(trust.disabled_configuration(expected, {'mozilla/blocked.crt'}), expected)

    def test_unrelated_configuration_is_unchanged(self):
        original = '# no matching packaged root\n!mozilla/other.crt\nmozilla/retained.crt'
        self.assertEqual(trust.disabled_configuration(original, {'mozilla/absent.crt'}), original)

    def test_empty_or_partial_certificate_data_fails_closed(self):
        for data in (b'', b'-----BEGIN CERTIFICATE-----\nYWJj\n', b'-----END CERTIFICATE-----'):
            with self.assertRaises(ValueError):
                trust.fingerprints(data)


if __name__ == '__main__':
    unittest.main()
