"""Remove this experiment's exact runtime override and restore stock services.

Default is a read-only preflight. --apply is reserved for an approved trial's
independent systemd recovery timer. This never changes GUI services or storage.
"""
import argparse
import ctypes as C
import errno
from pathlib import Path
import subprocess

ROOT = Path("/run/action-control-eis-rotation")
OVERRIDE = Path("/run/systemd/system/qmmf-server.service.d/90-osmo-eis-rotation.conf")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    expected = (ROOT / "trial-qmmf.conf").read_bytes()
    # Serialize timer and manual recovery without making the lock persistent.
    with (ROOT / "rollback.lock").open("a") as lock:
        # The camera's minimal Python omits the fcntl extension.
        flock = C.CDLL(None, use_errno=True).flock
        flock.argtypes = [C.c_int, C.c_int]
        flock.restype = C.c_int
        while flock(lock.fileno(), 2) != 0:  # LOCK_EX; closing releases it
            code = C.get_errno()
            if code != errno.EINTR:
                raise OSError(code, "cannot lock EIS rollback")
        if not OVERRIDE.exists():
            print("No EIS trial override; no services changed.")
            return
        if OVERRIDE.is_symlink() or OVERRIDE.read_bytes() != expected:
            raise SystemExit("Refusing to remove an unrecognized service override")
        if not args.apply:
            print("Owned override recognized; --apply would restore stock camera services.")
            return
        # Remove the experiment even if the camera's stop operation fails. This
        # ensures any later service start uses stock configuration.
        try:
            subprocess.run(["systemctl", "stop", "dji_camera3.service"],
                           check=True, timeout=45)
        finally:
            OVERRIDE.unlink()
            subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=15)
            try:
                subprocess.run(["systemctl", "restart", "qmmf-server.service"],
                               check=True, timeout=45)
            finally:
                subprocess.run(["systemctl", "start", "dji_camera3.service"],
                               check=True, timeout=45)
        print("EIS trial override removed; stock camera services restored.")


if __name__ == "__main__":
    main()
