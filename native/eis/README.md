# Experimental preview rotation metadata adapter

This is a proposed native fix for the custom stream's HorizonSteady orientation
failure. It is not installed by Action Control and has not yet been tested in
QMMF's real capture pipeline. It does not flip pixels or choose a fixed angle.

DJI's recording node publishes `com.dji.camera.EnableIPEEisRotate` into CHI's
usecase pool for steady modes 3 and 6. The preview node does not publish that
flag. This adapter forwards the stock preview module's callbacks and mirrors
that publication before processing a preview request. It reads the actual
requested EIS mode; modes 3/6 enable native IPE rotation, modes 0/2/5 disable it.
Unknown/missing modes pass through unchanged. Existing matching flags do not
produce another write. It is still unproven that this publication alone makes
the preview output follow the horizon correctly.

The original preview module must be copied to
`/run/action-control-eis-rotation/original-eis-preview.so` before loading the
adapter. Its complete SHA-256 must match the inspected AC204 firmware. No vendor
binary is included here. The camera HAL is also fingerprinted because it assigns
the private vendor tag IDs; a mismatched HAL retains stock callbacks. The wrapper
only replaces the `ProcessRequest` and
`SetNodeInterface` callbacks; all other original callbacks remain intact.

ABI evidence comes from `ChiNodeEntry`, `DjiEISNodeProcRequest`,
`ChiPreviewEISNode::UpdateEISParamsFromPerFrameMeta` and
`ChiDjiEISNode::UpdateEISRotationEnableToGlobelPool` in the inspected firmware:

- callback table version 0, minimum 240 bytes; callbacks at offsets 64 and 72;
- request minimum 104 bytes; node pointer at 8 and frame number at 16;
- inspected node's framework session pointer at offset 48;
- metadata getter and setter use CHI's native interface; setter at offset 32;
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
