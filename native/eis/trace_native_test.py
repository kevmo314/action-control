"""Check probe ownership and trace-control writes without accessing hardware."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import trace_native as tracer


class TraceControlTests(unittest.TestCase):
    def test_commands_never_truncate_shared_probe_control(self):
        with patch.object(os, "open", return_value=42) as opening:
            with patch.object(os, "write") as write, patch.object(os, "close") as close:
                tracer.command("-:osmo_horizon/preview_mode")
        self.assertEqual(opening.call_args.args[1], os.O_WRONLY)
        write.assert_called_once_with(42, b"-:osmo_horizon/preview_mode\n")
        close.assert_called_once_with(42)

    def test_cleanup_only_touches_owned_events_and_instance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instance = root / "instances/osmo_horizon"
            enabled = instance / "events/osmo_horizon/preview_mode/enable"
            enabled.parent.mkdir(parents=True)
            enabled.write_text("1")
            (instance / "tracing_on").write_text("1")
            (root / "tracing_on").write_text("1")
            (root / "uprobe_events").write_text(
                "p:osmo_horizon/preview_mode /camera:0x123\n"
                "p:someone_else/preview_mode /camera:0x123\n")
            with patch.object(tracer, "TRACE", root), patch.object(tracer, "INSTANCE", instance):
                with patch.object(tracer, "command") as command:
                    with patch.object(Path, "rmdir", autospec=True) as remove:
                        tracer.cleanup()
            self.assertEqual(enabled.read_text(), "0")
            self.assertEqual((instance / "tracing_on").read_text(), "0")
            self.assertEqual((root / "tracing_on").read_text(), "1")
            command.assert_called_once_with("-:osmo_horizon/preview_mode")
            remove.assert_called_once_with(instance)

    def test_similar_foreign_group_is_not_owned(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "uprobe_events").write_text(
                "p:foreign_osmo_horizon/preview_mode /camera:0x123\n")
            with patch.object(tracer, "TRACE", root):
                self.assertFalse(tracer.registered("preview_mode"))


if __name__ == "__main__":
    unittest.main()
