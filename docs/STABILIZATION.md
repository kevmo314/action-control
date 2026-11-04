# DJI stabilization investigation

On the connected AC204, custom capture can now reach DJI's real EIS/IMU graph
and deliver hardware HEVC frames. This is a capture prototype, not yet an option
in the Go sender or web UI. Moving-camera stabilization, horizon-lock accuracy,
overlay compatibility and audio timing on this new graph still need validation.

## What selects the graph

The generic `djiqmmfsrc eis=true` flag chooses Qualcomm's `PreviewEISDGV26` graph,
which fails on this firmware because its Chromatix tuning is absent. DJI's own
camera process uses a different combination of stream roles, memory types,
properties, metadata and activation order.

A temporary logger captured the native GStreamer property writes. Reading the
properties back is insufficient: several getters return default values even
when a different value was just written. The logger was removed after capture;
no firmware files or persistent service settings were changed.

The successful 720p30 prototype does the following:

1. Create three source pads with roles `1` (preview), `2` (main video), and `3`
   (proxy video). All three use NV12 GPU buffers (`memory:GBM`); preview and main
   declare `compression=ubwc`, while proxy is uncompressed.
2. Open the camera with pipeline state READY. Apply vendor properties **after**
   opening: early setters can fail with "Camera is not owned by this client".
   The inspected native idle profile uses `lowpower-lv-enable=true`,
   `pick-sensormode=4883` (`0x1313`), `max-hal-requests=8` and
   `eis-algo-params=<5,-265,1,0>`.
3. Move the pipeline to PAUSED to configure the tracks, then deactivate main and
   proxy source pads with `gst_pad_set_active(pad, false)`. Keep preview active.
4. Enter PLAYING, then apply steady/FOV request metadata once capture requests
   are active. Writing per-frame metadata before requests exist fails with
   "No active requests present". This prototype applies it after the first
   encoded sample, so it contains a startup mode transition.
5. Encode the active preview output with `djicamc2venc` into HEVC / MPEG-TS.

All three configured tracks cause the HAL to select its advanced use case.
Activating just preview lets the feature graph run `DjiLowpowerPreview`, including
`com.dji.node.imu` and `com.dji.node.eis_preview`. Activating all three against
that graph fails with `WalkAllExtSinkLinks ... numEnabledSinkLinks 2/3`; QMMF
then enters an error path and can restart. Merely setting the steady tag on a
single ordinary preview stream does not add an EIS node.

With low-power preview disabled, the prototype also reached
`DjiCommonRealtimeEISPreview` alongside `DjiCommonOfflineEISVideo`. Realtime
preview is the useful output for streaming; the existence of an offline graph
does not mean the streamer should use DJI's recording or livestream service.

## Mode and field-of-view mapping

These values are from the inspected native mode conversion and algorithm
calibration, not the public camera-service EIS enum:

| Mode | `EISSteadyMode` | Tested `FovCtrlMode` | Result |
| --- | --- | --- | --- |
| RockSteady | 2 | 1 | 720p HEVC, 146 decoded frames / 4.90 s; DJI EIS reports steady mode 2 |
| HorizonSteady | 3 | 2 | 720p HEVC, 236 decoded frames / 7.91 s; EIS reports steady mode 3 and linear lens |
| RockSteady+ | 5 | 1 | Native mapping identified; capture not yet tested |
| HorizonBalancing | 6 | 2 | 720p HEVC, 236 decoded frames / 7.91 s; EIS reports steady mode 6 and linear lens |

`com.dji.camera.EISSteadyMode` is vendor tag `0x80b7001a`, type BYTE.
`com.dji.camera.FovCtrlMode` is `0x80b70021`, also BYTE. The prototype also passes
face-detection mode off explicitly. It does not change native user settings.

FOV zero is treated as the default (1); it does **not** select linear output.
The native `eis_dlens_convert` table maps FOV 2 to linear. Horizon modes must use
a supported linear or narrow crop. With FOV 1 (fisheye), their crop ratio is zero
and the stock algorithm asserts in `eis2_mesh_calc_proc_inner`. This was observed
in a temporary capture; the native camera recovered after service restoration.

The stock normal-lens calibration defines crop ratios of 0.728 for LINEAR /
ROLL_FREE and 0.8235 for LINEAR / ROLL_CORR. FISHEYE has no entries for either
horizon mode. These are algorithm calibration ratios, not measured output FOV.

## Evidence and remaining work

The successful captures include decoded real camera images with visibly different
crops. Logs show IMU motion estimation and per-request mode changes inside DJI's
node. This establishes that these are native processed frames, beyond merely
setting an advertised property. It does not establish stabilization quality,
full 360-degree behavior or calibration under motion.

A full-graph **1440p30 HorizonBalancing** run then produced **895 decoded frames
over 29.91 seconds**, with no reported error in a full `ffmpeg -xerror` decode.
Reapplying `pick-sensormode=3598` (`0x0e0e`) after READY selected actual
4096×3072 sensor mode 14, feeding a 2560×1440 EIS output. This is stronger
evidence than encoded dimensions alone. The effective runtime IMU timing was
-267 at the observed ~29.95 fps; blindly assuming the initial -320 value would
misdescribe the running graph. Audio and overlays were not included in this test.

An earlier full-graph 1080p RockSteady run produced 296 decoded frames over
9.91 seconds. Its source still selected 2048×1536 sensor mode 19, so encoded
resolution alone is not proof of the desired sensor mode or detail after crop.
The exact sensor-selection property must be applied after READY as well.

The short prototype stops separately from the production sender. Its first
version truncated the final TS access unit. The successful 1440p version first
deactivates the live source pad, then sends EOS to the encoder and drains its
appsink. Full decoding passes; seeking directly into inter frames can still
produce reference warnings until the next IDR. Integration should withhold
output until a complete keyframe after the startup mode transition.

Before enabling these modes in Livestreaming:

- Gate the native recipe to inspected firmware/library hashes and compatible
  sensor mode, frame rate, output size and FOV combinations.
- Configure and activate pads in the correct order, and establish request
  metadata before releasing usable encoded output.
- Preserve an uncompressed output/conversion path for browser overlay blending
  and the JPEG Studio preview; the current CPU overlay path cannot simply be
  applied to a compressed UBWC surface.
- Verify audio timestamps, stop/failure recovery and sustained capture on the new
  graph, then measure motion/horizon behavior separately.

Private camera clips, calibration files, firmware libraries and raw diagnostic
logs remain local research artifacts.
