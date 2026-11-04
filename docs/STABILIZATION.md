# DJI stabilization investigation

Known limitation: the custom stream remains upside down with an inverted camera
when HorizonSteady is selected. Native mode selection is confirmed, but full
horizon/orientation correction is not working end to end. No manual 180-degree
flip is installed to conceal this failure.

Livestreaming offers **Off**, **RockSteady**, **HorizonSteady** and
**HorizonBalancing**. Stabilized capture supports 720p, 1080p and 1440p in
Standard 8-bit at 30 fps. It works with microphone audio, neural noise reduction,
browser overlay burn-in and Studio's 2 fps camera preview. Horizon modes select
a narrower, corrected FOV automatically. Native camera recording settings,
wireless pairing and microphone gain are preserved.

The sender checks the inspected firmware assets before opening the graph.
Advanced image modes and 25 fps are rejected for stabilized capture. Mode
changes require stopping and restarting the stream. Physical motion quality,
full 360-degree behavior and calibrated sensor-to-microphone timing still need
separate measurement.

## Integrated frame and clock path

The sender configures DJI's full-resolution realtime EIS graph with 4096×3072
sensor mode 14 and a 2560×1440 preview surface. FastCV converts that linear GBM
surface to RGBA and scales it to the chosen output size. Overlays blend into the
CPU frame, then `videoconvert` produces NV12 for hardware HEVC. Studio's JPEG
branch is independent of the encoder and shows the camera before overlay burn-in.
Even 720p stabilized output uses this full sensor profile, so selecting a smaller
output does not switch the sensor into its low-power mode.

The RGBA conversion is deliberate: a same-format NV12 conversion could retain
native buffer references and stall the 1080p pipeline after startup. A two-frame leaky queue before conversion keeps slow CPU work from blocking
the native source; under load it drops raw frames before encoding. A bounded
reserve of 16 extra source buffers accommodates the converter, tee and encoder;
increasing that reserve alone did not fix the stall. The installed GPU
`qtivtransform` also crashed in a probe, so this path uses CPU FastCV conversion.

Steady/FOV metadata is applied after the first sensor frame. Output stays gated
for one second and until a complete HEVC keyframe arrives. Audio earlier than
that frame is dropped, preserving the common capture timestamps. Model delay
compensation remains upstream of this audio gate. On stop, audio is drained and
video is allowed to reach the captured audio endpoint before EOS. Inactive main
and proxy tracks are excluded from mux shutdown. No manual physical sync offset
has been added.

The setup was discovered as follows; the initial short probes below preceded
the integrated sender.

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

## Integration validation

The final 40-second 1440p run with the bounded source queue, RGBA conversion,
DJI neural audio, overlays and JPEG preview decoded fully and stopped normally.
It contained 1069 video frames over 37.82 seconds (~28.3 fps effective), with raw
frame drops under CPU load (largest video PTS gap ~100 ms). Audio timestamps
remained continuous at 21.333 ms. First PTS differed by 6.556 ms; video ended
204 ms after audio. Thus 30 fps is the configured target, not a sustained-rate
guarantee with all CPU processing enabled. Smaller outputs reduce this load.


- A 35-second local 1440p HorizonBalancing capture combined DJI neural audio,
  browser overlays and JPEG preview. Full decoding passed. Video packet spacing
  stayed 33.377–33.389 ms; audio stayed 21.333–21.334 ms. First PTS differed by
  10.689 ms and final packet ends by 54.034 ms.
- A received 1080p HorizonSteady SRT clip with RNNoise and overlays contained
  24.50 seconds of HEVC and 24.47 seconds of mono AAC. Full decoding passed;
  first PTS differed by 6.067 ms and final ends by 26.722 ms. The current Tailscale
  relay was tested at 2 Mbps video and 4000 ms SRT latency. A 6 Mbps / 1500 ms run
  lost packets on that relay and failed decoding; local capture at 6 Mbps passed.
- Browser checks verified the stabilization selector, incompatible mode/FPS
  constraints, live 640×360 Studio background and no JavaScript errors. An
  overlay text/color edit applied during streaming.
- RockSteady 720p video-only SRT was verified, followed by receiver disconnect.
  The sender reported the disconnect and native camera control recovered.
  Restart followed by cancellation during startup also recovered normally.
- Unit tests exercise startup keyframe selection, audio alignment, unknown PTS,
  delayed-video drain and rejected capture combinations. `go test -race ./...`
  and the TypeScript/Vite build pass.

These timestamp checks establish software continuity and bounded endpoints;
they do not establish physical lip-sync or performance while the camera moves.
Private camera clips, calibration files, firmware libraries and raw diagnostic
logs remain local research artifacts.

## November 4 physical check and follow-up investigation

A live 1080p30 HEVC/AAC SRT session with DJI neural audio and the Studio RTIRL
layer was inspected in ffplay. The user confirmed good perceived audio quality
and A/V sync. The camera picture was upside down while the browser overlay was
upright. This is an orientation failure before composition, not a rotated web
layer. This subjective sync check does not replace calibrated timing measures.

A short subsequent capture recorded the native smoother actually transitioning
to `smooth_mode: 0, steady_mode: 3, steady_submode: 0, fps: 30`. This confirms
that our HorizonSteady request reaches DJI's preview algorithm. It does not
establish correct gravity locking or 360-degree behavior.

Offline inspection identified a separate native video/offline EIS path and
`ChiDjiEISNode::UpdateEISRotationEnableToGlobelPool`. That method enables
`com.dji.camera.EnableIPEEisRotate` for modes 3 and 6. The inspected camera HAL's
vendor table places this BYTE/count-1 tag at `0x80b70020` (six entries after
`EISSteadyMode`, immediately before `FovCtrlMode`). This node publishes the flag
into CHI's usecase metadata pool; setting the same tag through ordinary source
session/request metadata is not proven equivalent.

Private, temporary trials found:

- Enabling the main/proxy tracks produced video and initialized video/offline
  smoothers, but those smoothers remained in mode 2 while the preview changed
  to mode 3. This did not correct the image. That probe timed out during drain;
  its independent cleanup restored native camera control.
- Supplying the IPE rotation tag through session metadata, then through session
  and video metadata at multiple initialization stages, still produced an
  upside-down preview. These trial settings were not installed in the streamer.
- A further all-track trial with early metadata failed during pipeline startup.
  The QMMF monitor generated a core dump, accompanied by a kernel allocation
  failure, and the service supervisor replaced QMMF. Native camera control and
  both GUIs recovered; the camera did not reboot. Hardware probes stopped after
  this failure. Do not treat this graph as a validated streaming path.

The next work is to understand the native video-request metadata and usecase
rotation/gravity path before changing production capture. Overlay composition
must remain downstream of the corrected camera output. The reverted software
rotation experiment is not part of the implementation.
