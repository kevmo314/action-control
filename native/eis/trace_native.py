"""Observe native DJI EIS state with temporary uprobes; never opens a camera.

ARM64 AC204 only. Stage at /run/action-control-eis-rotation/trace_native.py.
The private trace instance and exact owned events are removed on exit, with an
independent recovery timer for process/host failures. No pixels or settings are
changed. Raw traces contain native addresses and should remain private.
"""
import argparse
import hashlib
import os
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path("/run/action-control-eis-rotation")
TRACE = Path("/sys/kernel/tracing")
INSTANCE = TRACE / "instances/osmo_horizon"
GROUP = "osmo_horizon"
TIMER = "osmo-native-probes-cleanup"

PROBES = [('imu_mode',
  '/usr/lib/camera/components/com.dji.node.imu.so',
  998792,
  'node=%x19:x64 session=+8(%x19):x64 frame=%x20:u64 mode=+3080(%x19):u32 '
  'time_mode=+3084(%x19):u32'),
 ('smooth_init',
  '/usr/lib/libalgo_share.so',
  139184,
  'smooth=+16(%x1):u32 mode=+4(%x1):u32 submode=+8(%x1):u32 fov=+12(%x1):u32'),
 ('smooth_frame',
  '/usr/lib/libalgo_share.so',
  140448,
  'handle=%x0:x64 smooth=+0(%x0):u32 mode=+4(%x0):u32 gravity=+4(%x1):u32 lock=+8(%x1):u8 '
  'locked_side=+9(%x1):u8 shooting_side=+10(%x1):u8 shooting_lock=+11(%x1):u8'),
 ('gravity_select',
  '/usr/lib/libalgo_share.so',
  151680,
  'gravity=%x1:u32 lock=+0(%x0):u8 locked_side=+1(%x0):u8 shooting_side=+2(%x0):u8 '
  'shooting_lock=+3(%x0):u8'),
 ('smooth_output',
  '/usr/lib/libalgo_share.so',
  140956,
  'handle=%x20:x64 smooth=+0(%x20):u32 mode=+4(%x20):u32 valid=+0(%x19):u32 qw=+4(%x19):x32 '
  'qx=+8(%x19):x32 qy=+12(%x19):x32 qz=+16(%x19):x32'),
 ('record_mode',
  '/usr/lib/camera/components/com.dji.node.eis.so',
  1042480,
  'node=%x19:x64 session=+48(%x19):x64 frame=%x20:u64 mode=+4404(%x19):u32 fov=+4412(%x19):u32 '
  'special=+5044(%x19):u32'),
 ('ipe_startup',
  '/usr/lib/hw/camera.qcom.so',
  13723160,
  'node=%x20:x64 gate=+12604(%x23):u32 stabilization=+0x25b20(%x20):u32 width=+0x2e634(%x20):u32 '
  'height=+0x2e638(%x20):u32 fps=+0x29114(%x20):u32'),
 ('preview_mode',
  '/usr/lib/camera/components/com.dji.node.eis_preview.so',
  1029752,
  'node=%x19:x64 session=+48(%x19):x64 frame=%x20:u64 mode=+3188(%x19):u32 fov=+3196(%x19):u32'),
 ('record_rotation',
  '/usr/lib/camera/components/com.dji.node.eis.so',
  1041008,
  'node=%x0:x64 session=+48(%x0):x64 mode=%x1:u32'),
 ('ipe_config',
  '/usr/lib/hw/camera.qcom.so',
  13720968,
  'node=%x19:x64 normal=%x24:u32 enabled=+0x49324(%x19):u32 dynamic=+0x49330(%x19):u32 '
  'stabilization=+0x25b20(%x19):u32 width=+0x2e634(%x19):u32 height=+0x2e638(%x19):u32 '
  'fps=+0x29114(%x19):u32'),
 ('ipe_rotation',
  '/usr/lib/hw/camera.qcom.so',
  13813712,
  'node=%x20:x64 requested=%x22:u32 enabled=+0x49324(%x20):u32 dynamic=+0x49330(%x20):u32 '
  'output=+0(%x19):u32')]

HASHES = {'/usr/lib/camera/components/com.dji.node.eis.so': '63a3c316164610930e67b980dac75133d19b6aa7aac20a9016939ea39b97bf91',
 '/usr/lib/camera/components/com.dji.node.eis_preview.so': 'c14c9d440dc2a006503d4b3a0807b5ba4d3ee43a40edeb8d6e6f8fd13dbb8c14',
 '/usr/lib/camera/components/com.dji.node.imu.so': 'd56838435564604837581651f06c8993885d6a60ee99aa082cccb74c4f8fcf36',
 '/usr/lib/hw/camera.qcom.so': '0439c2b5cc867ec914bc16d8ce85a49f6b849822abae780fae149133b3bb5953',
 '/usr/lib/libalgo_share.so': '00339ec9b61f61fac7a3531ab143b17f99369b57b70772e9e8db012e2d631c9f'}


def command(value):
    # O_APPEND is rejected by this firmware's tracefs. Commands append events
    # through the tracer API without truncating the shared control file.
    fd = os.open(str(TRACE / "uprobe_events"), os.O_WRONLY)
    try:
        os.write(fd, (value + "\n").encode())
    finally:
        os.close(fd)


def registered(name):
    prefix = "p:" + GROUP + "/" + name + " "
    return any(line.startswith(prefix) for line in
               (TRACE / "uprobe_events").read_text().splitlines())


def cleanup():
    if INSTANCE.exists():
        (INSTANCE / "tracing_on").write_text("0")
        for name, *_ in PROBES:
            enabled = INSTANCE / "events" / GROUP / name / "enable"
            if enabled.exists():
                enabled.write_text("0")
    for name, *_ in PROBES:
        if registered(name):
            command("-:" + GROUP + "/" + name)
    if INSTANCE.exists():
        INSTANCE.rmdir()


def interrupted(signum, frame):
    raise SystemExit("Trace interrupted; saving trace and removing owned probes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--seconds", type=int, default=8)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.cleanup:
        cleanup()
        return
    if not 1 <= args.seconds <= 45:
        parser.error("--seconds must be 1–45")
    if INSTANCE.exists() or any(registered(name) for name, *_ in PROBES):
        raise SystemExit("Owned probe names/instance already in use; refusing to replace them")
    for path, expected in HASHES.items():
        if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected:
            raise SystemExit("Uninspected firmware: " + path)
    override = Path("/run/systemd/system/qmmf-server.service.d/90-osmo-eis-rotation.conf")
    if override.exists():
        raise SystemExit("Observe stock modules with the EIS adapter inactive")
    output = args.output or ROOT / ("native-trace-%d.txt" % time.time_ns())
    if output.exists():
        raise SystemExit("Refusing to overwrite trace: " + str(output))
    subprocess.run(["systemd-run", "--unit=" + TIMER, "--on-active=90s",
                    "/usr/bin/python3", "-I", "-B", str(ROOT / "trace_native.py"),
                    "--cleanup"], check=True, timeout=10)
    subprocess.run(["systemctl", "is-active", "--quiet", TIMER + ".timer"],
                   check=True, timeout=5)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        INSTANCE.mkdir()
        (INSTANCE / "buffer_size_kb").write_text("256")
        for name, path, offset, fetch in PROBES:
            command("p:" + GROUP + "/" + name + " " + path + ":" + hex(offset) + " " + fetch)
            (INSTANCE / "events" / GROUP / name / "enable").write_text("1")
        (INSTANCE / "tracing_on").write_text("1")
        print("Native EIS probes enabled; observing for %d seconds." % args.seconds, flush=True)
        time.sleep(args.seconds)
    finally:
        try:
            # Retain diagnostics on interruptions and setup failures too.
            if INSTANCE.exists():
                (INSTANCE / "tracing_on").write_text("0")
                with output.open("x") as destination:
                    destination.write((INSTANCE / "trace").read_text())
                print("Private trace saved:", output, flush=True)
        finally:
            cleanup()
            subprocess.run(["systemctl", "stop", TIMER + ".timer"], check=True, timeout=10)
            print("Owned probes removed; camera services unchanged.", flush=True)


if __name__ == "__main__":
    main()
