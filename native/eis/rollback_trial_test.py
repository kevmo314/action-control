"""Verify recovery ownership and service restoration without camera access."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import rollback_trial as recovery


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.override = root / "override.conf"
        (root / "trial-qmmf.conf").write_bytes(b"owned trial\n")
        self.override.write_bytes(b"owned trial\n")
        self.addCleanup(patch.stopall)
        patch.object(recovery, "ROOT", root).start()
        patch.object(recovery, "OVERRIDE", self.override).start()
        self.run = patch.object(subprocess, "run").start()

    def invoke(self, apply=True):
        with patch.object(sys, "argv", ["recovery"] + (["--apply"] if apply else [])):
            with contextlib.redirect_stdout(io.StringIO()):
                recovery.main()

    def test_dry_run_changes_no_services(self):
        self.invoke(apply=False)
        self.assertTrue(self.override.exists())
        self.run.assert_not_called()

    def test_missing_override_changes_no_services(self):
        self.override.unlink()
        self.invoke()
        self.run.assert_not_called()

    def test_unrecognized_override_is_preserved(self):
        self.override.write_bytes(b"someone else's configuration\n")
        with self.assertRaises(SystemExit):
            self.invoke()
        self.assertTrue(self.override.exists())
        self.run.assert_not_called()

    def test_success_restores_only_camera_services(self):
        self.invoke()
        self.assertFalse(self.override.exists())
        self.assertEqual([call.args[0] for call in self.run.call_args_list], [
            ["systemctl", "stop", "dji_camera3.service"],
            ["systemctl", "daemon-reload"],
            ["systemctl", "restart", "qmmf-server.service"],
            ["systemctl", "start", "dji_camera3.service"],
        ])

    def test_failed_stop_still_removes_override_and_restores_services(self):
        self.run.side_effect = [subprocess.CalledProcessError(1, "stop"), None, None, None]
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke()
        self.assertFalse(self.override.exists())
        self.assertEqual(self.run.call_args.args[0], ["systemctl", "start", "dji_camera3.service"])


if __name__ == "__main__":
    unittest.main()
