"""Installer must keep credentials off argv and generate valid device code."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

path = Path(__file__).parents[2] / 'tools/install-wifi-watchdog.py'
spec = importlib.util.spec_from_file_location('installer', path)
i = importlib.util.module_from_spec(spec)
spec.loader.exec_module(i)


class InstallerTests(unittest.TestCase):
    def test_private_payload_uses_stdin_and_device_program_compiles(self):
        with patch.object(sys, 'argv', [str(path), '--serial', 'camera-test', '--ssid', 'Example AP']), patch.object(i.getpass, 'getpass', return_value='example-passphrase'), patch.object(i.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0)) as run:
            i.main()
        call = run.call_args
        self.assertNotIn('example-passphrase', str(call.args))
        self.assertNotIn('example-passphrase', call.kwargs['input'])
        self.assertEqual(call.args[0][-1], '-')
        compile(call.kwargs['input'], '<device-installer>', 'exec')
        self.assertIn('# BEGIN OSMO WIFI WATCHDOG', call.kwargs['input'])

    def test_failed_transport_has_short_error_without_dumping_payload(self):
        with patch.object(sys, 'argv', [str(path), '--serial', 'camera-test', '--ssid', 'Example AP']), patch.object(i.getpass, 'getpass', return_value='example-passphrase'), patch.object(i.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)):
            with self.assertRaises(SystemExit) as raised:
                i.main()
        self.assertNotIn('example-passphrase', str(raised.exception))
        self.assertNotIn('psk', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
