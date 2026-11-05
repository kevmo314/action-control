# Experimental preview rotation metadata adapter

This is a proposed native fix for the custom stream's HorizonSteady orientation
failure. It is not installed by Action Control. A bounded QMMF capture trial
accepted its metadata writes but still produced an upside-down camera picture.
It does not flip pixels or choose a fixed angle.

DJI's recording node publishes `com.dji.camera.EnableIPEEisRotate` into CHI's
usecase pool for steady modes 3 and 6. The preview node does not publish that
flag. This adapter forwards the stock preview module's callbacks and mirrors
that publication before processing a preview request. It reads the actual
requested EIS mode; modes 3/6 enable native IPE rotation, modes 0/2/5 disable it.
Unknown/missing modes pass through unchanged. Existing matching flags do not
produce another write. Publication alone did not correct the preview in the
tested graph; this is an investigation tool, not a working HorizonSteady fix.

The original preview module must be copied to
`/run/action-control-eis-rotation/original-eis-preview.so` before loading the
adapter. Its complete SHA-256 must match the inspected AC204 firmware. No vendor
binary is included here. The camera HAL is also fingerprinted because it assigns
the private vendor tag IDs. The native metadata helper is fingerprinted too;
a mismatch retains stock callbacks. The wrapper
only replaces the `ProcessRequest` and
`SetNodeInterface` callbacks; all other original callbacks remain intact.

ABI evidence comes from `ChiNodeEntry`, `DjiEISNodeProcRequest`,
`ChiPreviewEISNode::UpdateEISParamsFromPerFrameMeta` and
`ChiDjiEISNode::UpdateEISRotationEnableToGlobelPool` in the inspected firmware:

- callback table version 0, minimum 240 bytes; callbacks at offsets 64 and 72;
- request minimum 104 bytes; node pointer at 8 and frame number at 16;
- inspected node's framework session pointer at offset 48;
- metadata getter and setter use CHI's native interface; setter at offset 32;
- interface tables must be at least 384 bytes, as required by stock initialization;
- input steady tag `0x88b7001a`; usecase rotation tag `0x84b70020`;
- native tag-data and metadata-info structs are 48 and 56 bytes, respectively.

`tools/build-eis-rotation.sh` runs the host metadata/callback tests and builds an
AArch64 shared object. It uses an installed `aarch64-linux-gnu-gcc` (override with
`ACTION_EIS_CC`) or the local `osmo-audio-cross` Ubuntu 22.04 cross-compiler image.
The host tests cover exact metadata layouts, session/tag/payload forwarding,
mode selection, unchanged and missing flags, and forwarding of original calls.

`factory_smoke.py` is an isolated camera-side factory smoke check that verifies
only callback offsets 64/72 differ from the stock table. It does not create a
capture graph, restart a service, or establish correct image orientation. It loads the adapter before
the stock reference, matching the framework's load order. Real validation still requires
a temporary QMMF service override and a controlled restart; prior instructions
from the user prohibit doing that without renewed approval. The stock library
on the filesystem and both GUI services should remain untouched.

`trial-qmmf.conf` is the proposed runtime service override, staged for review
only. It binds the adapter over the preview module inside QMMF's mount namespace,
disables automatic QMMF restarts, and disables core dumps for the trial. It is
not copied into systemd's configuration by any build or smoke check.

Once a controlled service restart is approved, preflight must confirm native
recording/capture are idle, the custom streamer is stopped, and firmware hashes
still match. Save the current service PIDs and boot ID. Install only this file
at `/run/systemd/system/qmmf-server.service.d/90-osmo-eis-rotation.conf`, stop
`dji_camera3`, reload units, restart `qmmf-server`, then start `dji_camera3`.
Validate native camera health before running a short preview capture; check the
adapter's metadata return codes and the actual picture. A successful metadata
write alone does not prove horizon correction.

Rollback removes only that exact owned drop-in, reloads units, and restarts
QMMF/camera services to return them to the stock module. A bounded rollback
must be scheduled independently before installing the override, so a lost host
connection cannot leave the experiment active. This can require a second
camera-service restart and must be included in the user's approval. Neither
activation nor rollback should restart `gui` or `sub_gui`, reboot the device,
modify its storage mounts, or change persistent firmware.

`rollback_trial.py` implements this recovery and refuses to remove a changed or
unrecognized drop-in. With no arguments it only checks; `--apply` performs the
recovery. Stage it and `trial-qmmf.conf` alongside the adapter before a trial.
After approval, schedule it with a transient systemd timer **before** installing
the override (for example, `systemd-run --unit=osmo-eis-trial-rollback
--on-active=120s /usr/bin/python3 -I -B
/run/action-control-eis-rotation/rollback_trial.py --apply`). Check that the
timer is active before touching the service configuration. The adapter and
factory smoke check alone do not schedule this timer.

The November 5 approved live trial used the production `osmo-stream` capture
path for a 12-second bounded run, saving local HEVC/MPEG-TS instead of sending
SRT. It produced 200 decoded 1280×720 frames over 6.676 seconds, with the existing
browser overlay after stabilization. The camera remained upside down and the
overlay upright. Flag publications returned zero (success), including requests
for modes 0 and 3 with opposite values. The current logs lack session/node IDs,
so they do not establish whether those requests shared a usecase pool. Do not
infer that their interleaving caused the failure.

The independent recovery timer was armed before activation. The trial restored
the stock QMMF/camera services, verified native idle status and unchanged camera
settings, then cancelled recovery. Both GUI PIDs and the boot ID were unchanged.
The stock module is active again; the runtime drop-in is absent. Private clips
and native logs remain local. Runtime stderr now goes to a private trial log so
metadata results survive service restoration.

`metadata_smoke.py` separately checks the real camera-side native metadata
getter using a fake framework callback. It verifies the 56/48-byte layouts,
session, frame, metadata type, vendor tag, camera ID and returned data pointer.
This check passed without opening a capture graph or changing services.
