# DJI stabilization investigation

HorizonSteady now corrects the camera image through DJI's recording EIS path,
before browser overlays are composited. A crooked/inverted camera produced an
upright preview and received SRT picture; the user confirmed the alignment.
No software rotation or vendor-library patch is used. See the November 5 fix
below for the initialization sequence and verification scope.

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
sensor mode 14 and 2560×1440 native surfaces. Horizon modes consume the
main recording surface while preview remains active to feed the delayed IMU
solver. RockSteady consumes preview. FastCV converts the selected linear GBM
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

Horizon steady/FOV metadata is seeded into the initial request before camera
open, so the recording smoother starts in the requested mode. Per-request
metadata is also applied after the first sensor frame. Output stays gated
for one second and until a complete HEVC keyframe arrives. Audio earlier than
that frame is dropped, preserving the common capture timestamps. Model delay
compensation remains upstream of this audio gate. On stop, audio is drained and
video is allowed to reach the captured audio endpoint before EOS. Inactive
tracks are excluded from mux shutdown. No manual physical sync offset
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
`DjiCommonRealtimeEISPreview` alongside `DjiCommonOfflineEISVideo`. These first probes consumed realtime preview. The corrected horizon path
below instead consumes main video and keeps realtime preview active for IMU;
it still uses neither DJI's recording service nor its livestream service.

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

At this stage, the unresolved work was the native video-request metadata and
usecase rotation/gravity path. The November 5 fix below supersedes that state. Overlay composition
must remain downstream of the corrected camera output. The reverted software
rotation experiment is not part of the implementation.

### Rotation consumer and initialization gates

Further offline inspection of the fingerprinted HAL found two separate gates:

- `CamX::IPENode::ConfigureEISRotationEnable` (`0xd15b60`) runs during
  `ProcessingNodeInitialize`. It reads `IsNormalVideo` with the static metadata
  mask, checks stabilization bit 2, video width at most 2688, height at most
  1512, and FPS at most 120. When those checks pass it enables both EIS rotation
  and dynamic rotation control. These are internal video dimensions, before
  the custom streamer's final scaling. Our configured 2560×1440, 30 fps fits
  those numeric checks; this does not prove the other gates pass at runtime.
- `CamX::IPENode::GetlEisRotationEnableInfo` (`0xd2c740`) reads
  `EnableIPEEisRotate` from the usecase pool during frame processing. It applies
  that flag only if dynamic rotation control was enabled during initialization.
  Publishing the per-frame flag cannot bypass an unsuccessful startup gate.

The HAL vendor table defines `IsNormalVideo` as BYTE/count-1 at `0x80b7003a`.
The inspected override's `InitializeOverrideSession` computes it around
`0x18e92c`–`0x18eadc` and writes it into camera metadata. The classification
depends on operation mode and other configuration state. We have not yet read
the effective classification or IPE enable state for the custom capture graph;
do not substitute the requested EIS mode as proof of either.

The experimental adapter and controlled trial are described in
[`native/eis/README.md`](../native/eis/README.md). Native callback-factory and
metadata-helper smoke checks pass in isolated processes on the camera, and
host tests cover mode mapping, ABI layout and recovery. None of those checks
establish correct horizon behavior. The adapter remains outside the running
QMMF service except during an explicitly approved, bounded trial.

### November 5 approved native adapter trial

The first real QMMF adapter trial completed and restored stock services. DJI's
metadata setter returned success for the usecase rotation flag, but the local
production-streamer capture still showed an upside-down camera image and an
upright browser overlay. A 12-second bounded run yielded 200 HEVC frames at
1280×720 over 6.676 seconds (startup is included in the run limit); a complete
sequential FFmpeg decode with `-xerror` passed. This rules out an obvious
metadata-write rejection but does not establish that IPE's rotation gate was
enabled, or that preview smoothing implements the recording path's gravity
correction.

Mode 0/3 publications with opposite rotation flags were interleaved in the
adapter log. Without session/node identities this is not proof of a shared-pool
race. Native gate logs were not retained for the capture PID; the available
logcat ring had already moved past the trial. A follow-up diagnostic should
collect those messages live and identify sessions before changing mode policy.

Native status and video settings matched the saved preflight after recovery.
QMMF and camera services are back on the stock module, both GUI PIDs stayed the
same, the boot ID did not change, and the temporary override/timer are inactive.
The adapter is not enabled persistently and is not a validated stabilization fix.

### November 5 native function instrumentation

The camera has kernel uprobe support. Temporary probes in a private trace
instance observed stock DJI functions without replacing their libraries.
Registration used verified ELF file offsets and full module fingerprints;
cleanup removed only owned events and the private instance. The observer is
[`native/eis/trace_native.py`](../native/eis/trace_native.py).

A guarded native settings exercise changed 1080p from 48 to 30 fps, selected
HS, HB and RS, then restored the exact original format/EIS setting. It opened
no recording and changed no service PID. All 3,285 trace events were retained:

| Native setting | Preview node mode/FOV | Preview IPE rotation |
| --- | --- | --- |
| RS | 2 / 1 | disabled |
| HS | 3 / 2 | disabled |
| HB | 6 / 2 | disabled |

The recording-node rotation publisher was not called during that preview-only
exercise. This scopes the observation to native preview; it says nothing about
a real native recorded clip.

An instrumented production-streamer handoff showed its graph creates three IPE
nodes. The node with stabilization value 12 had rotation/dynamic control enabled;
the value-10 preview node and value-0 node had both disabled. All used normal
video classification, 2560×1440 and 30 fps. The active preview capture still used
the disabled rotation path. QMMF and both GUIs kept their original PIDs.

An isolated, undeployed Go build then consumed the linear main/recording output
instead of preview, deactivating the other two outputs. That branch received
mode 3/FOV 2, DJI's recording publisher enabled the usecase rotation flag, and
IPE reported requested/enabled/dynamic/output all equal to one. The picture
remained inverted. A further 3,221-event trace explained another mismatch:
the node mode was 3, but the processing smoother remained smooth mode 2,
steady mode 2. Smooth mode 1 was initialized with steady mode 2 and no mode-1
processing call was observed during that bounded capture. The active target
quaternions stayed near identity. This is evidence of an incomplete algorithm
transition, not proof of missing IMU hardware data or a faulty native algorithm.

Offline code inspection found `IsFirstReqOfVideo` (BYTE/count-1,
`0x80b70042`) feeds a separate recording-filter initialization path.
`DjiRecordStatus` is INT32/count-1 at `0x80b70011`. An isolated follow-up combining
recording status with a brief first-request hint stalled: 37 encoder-side frames
were seen, none passed the startup gate, and the sender stopped after its
10-second no-output deadline. QMMF's PID changed unexpectedly during recovery.
No failure trace was retained because that private harness saved only after a
successful child process; the public observer now saves in `finally`.
The failure cannot be attributed to either metadata field independently, and
the hint must not be treated as a validated request sequence.

Hardware experiments stopped after that failure. Native camera control and
original settings were restored, both GUI PIDs and boot ID remained unchanged,
the calibration hash matched, and all probes/timers were removed. Production
capture and the web UI were not replaced by either experimental binary. The
next investigation is DJI's first-video-request/algorithm lifecycle and how
to synchronize the solver mode with request metadata without repeatedly
reinitializing filters during capture.

### November 5 initial metadata and recording-path fix

Two independent startup problems caused the inverted picture:

1. Preview's IPE node had rotation disabled. The main recording node had it
   enabled, so horizon output must come from `video_1` (role 2).
2. Updating steady mode after the first frame changed node metadata but left
   the recording smoother initialized as RockSteady. Pre-PLAYING writes to the
   public `video-metadata` property were overwritten by source startup defaults.

The sender now seeds BYTE-valued `EISSteadyMode=3` and `FovCtrlMode=2` into
its own source's initial metadata before opening the camera. The inspected
source serializes GstStructure buckets by namespace and typed field name.
Its empty `org.quic.camera.anr_tuning` bucket is replaced with `com.dji.camera`
on that source object; the source retains ownership and frees it on destruction.
The private context offsets, expected state and empty bucket are guarded by
full firmware fingerprints and runtime checks. Firmware, calibration and
persistent native settings are unchanged. HorizonBalancing seeds mode 6 using
the same mechanism; that constructor is tested, but its corrected output still
needs a separate physical check.

Main video uses linear GBM NV12. Preview (`video_0`, role 1) stays active into
a fakesink: the delayed recording solver needs its realtime IMU producer. Only
proxy (`video_2`) is deactivated. FastCV copies corrected main frames before
Studio JPEG extraction and browser composition. RockSteady retains its
previous preview path. There is no first-video-request pulse, native recording
status override, QMMF adapter or manual image flip in this implementation.

An isolated startup-serializer smoke check verified both BYTE/count-1 tags.
Camera-side Go constructor tests verified HS/HB values without opening the
camera. A bounded 720p local capture then yielded 263 frames over 8.779 seconds
and passed a full sequential FFmpeg decode. Native probes observed 338 calls
with smooth mode 1 / steady mode 3, rather than the previous steady mode 2.
The picture was upright from the inverted camera.

An integrated 1080p30 SRT run combined AAC, DJI neural processing, Studio JPEG
preview and the saved browser overlay. Both camera-only preview and decoded
SRT showed the corrected camera image; the browser layer remained upright.
The user confirmed alignment with the camera left crooked. An eight-second
trace retained 240 recording-solver calls at smooth mode 1 / steady mode 3,
240 recording-node requests at mode 3 / FOV 2, and enabled IPE rotation on the
recording path. QMMF retained its PID and both native GUIs remained running.
The received clip contained 2,551 HEVC frames over 85.157 seconds at 1920×1080
and 84.949 seconds of AAC. Full sequential video/audio decoding with
`ffmpeg -xerror` passed. Initial audio PTS followed video by 14 ms; final packet
ends differed by about 193 ms. These are software timestamps, not a new
physical sync measurement. The stream stopped normally and native control
recovered. Host race tests for stream configuration, capture and controller pass.

SRT packets were transported over a temporary USB datagram relay because the
camera's Tailscale peer was offline; no exit-node route was needed.

This verifies static gravity alignment and the integrated composition path,
not stabilization quality during motion, a complete 360-degree roll sweep,
or new 1440p performance on the corrected recording branch. Earlier tests in
this document predate the correction and do not prove those properties.
