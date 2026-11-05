import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watchdog', Path(__file__).with_name('watchdog.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class ReconnectTests(unittest.TestCase):
    def test_working_wifi_does_not_touch_radio_or_test_internet(self):
        calls = []
        def command(*args):
            calls.append(args)
            return 'Connected to aa:bb:cc:dd:ee:ff' if args[0] == 'iw' else '    inet 192.168.43.247/24 scope global wlan0'
        with patch.object(w, 'command', command):
            state, _ = w.tick(0)
        self.assertTrue(state.startswith('connected'))
        self.assertEqual([c[0] for c in calls], ['iw', 'ip'])

    def test_backoff_avoids_repeated_radio_changes(self):
        with patch.object(w, 'command', return_value='') as command:
            w.tick(w.time.monotonic() + 100)
        self.assertEqual(command.call_count, 1)

    def test_foreign_manager_is_not_killed(self):
        with patch.object(w, 'command', return_value='') as command, patch.object(w, 'daemon', return_value=-1):
            state, _ = w.tick(0)
        self.assertIn('another network manager', state)
        self.assertEqual(command.call_count, 2)
        self.assertFalse(any(c.args[:1] == ('ip',) for c in command.call_args_list))

    def test_missing_supplicant_restarts_from_private_profile(self):
        with patch.object(w, 'command', return_value='') as command, patch.object(w, 'daemon', return_value=0):
            w.tick(0)
        self.assertTrue(any(c.args[:1] == ('wpa_supplicant',) and w.PROFILE in c.args for c in command.call_args_list))

    def test_disconnected_existing_supplicant_is_reconnected(self):
        with patch.object(w, 'command', return_value=''), patch.object(w, 'daemon', return_value=42), patch.object(w, 'wpa', side_effect=['wpa_state=DISCONNECTED', 'OK', 'OK']) as control:
            w.tick(0)
        self.assertEqual(control.call_args.args, ('reconnect',))

    def test_address_filter_does_not_accept_apipa(self):
        self.assertEqual(w.ipv4_address(' inet 169.254.1.1/16 scope global wlan0'), '')
        self.assertEqual(w.ipv4_address(' inet 192.168.43.247/24 scope global wlan0'), '192.168.43.247')


if __name__ == '__main__':
    unittest.main()
