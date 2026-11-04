# Studio and processing controls

Studio stores up to four web URL or custom HTML/CSS/JavaScript sources, with
position, size, opacity, visibility and stacking order. The camera is the locked
background. During SRT streaming the editor shows a 640×360 JPEG camera feed
at 2 fps; idle or unavailable capture shows a placeholder. Browser-source
previews come from the camera renderer. Browser sources run as independent
pages, so they do not depend on iframe embedding permission. They have no browser
audio in the outgoing stream. Pages requiring login need a URL that works without
an interactive login. HTML uses a separate `data:` origin.

Enable **Burn scene into SRT**, save, and wait for **RENDERER READY** before
starting a stream. Studio renders saved browser sources even when burn-in is off.
Placement and opacity preview immediately; save URL/HTML changes to render them.
The preview is separate from the stream layer, so disabling burn-in clears the
stream even if a preview page stalls. Source changes apply after saving, including during a stream
started with overlays enabled. Disabling and saving clears the layer. A stream
started without overlays needs a restart to add the overlay layer.

The renderer captures transparent PNGs at up to 2 fps, composites sources on a
1280x720 canvas, and publishes the full layer atomically. GStreamer's
`gdkpixbufoverlay` scales/blends it before the Codec2 hardware HEVC encoder. The
camera video stays at its configured frame rate. This is suitable for clocks,
scoreboards and basic graphics; smooth browser video/animation is not a target
of this version. Browser CPU/memory and raw-frame blending cost grow with page
complexity and stream resolution.

The console requires a current frame from the saved scene revision before
handing off the sensor. A renderer failure is displayed in Studio. The sender
stops if the overlay file has not been updated for 15 seconds, then the console
restores the native camera. Layout saves use revision checks to prevent two
editors silently overwriting each other. The standalone camera deployment stores
layouts persistently beside the executable in `studio/scene.json` (mode 0600).
URLs and HTML can contain private tokens; they are not committed to the repo.

## Browser runtime

The optional renderer uses Chromium over a loopback-only CDP connection at
`127.0.0.1:9222`. The UI never exposes CDP or needs a browser on the viewer's device
for burn-in. For host development set `OSMO_BROWSER_URL` to your CDP endpoint.

Build on a host with Docker and Python 3.12+:

```sh
tools/build-camera-browser.sh /absolute/path/to/browser-build
adb shell mkdir -p /blackbox/upgrade/osmo-srt/browser/root
adb push /absolute/path/to/browser-build/browser-root.tar /blackbox/upgrade/osmo-srt/browser-root.tar
adb shell 'tar -xf /blackbox/upgrade/osmo-srt/browser-root.tar -C /blackbox/upgrade/osmo-srt/browser/root; rm /blackbox/upgrade/osmo-srt/browser-root.tar'
adb push tools/start-camera-browser.sh /blackbox/upgrade/osmo-srt/browser/start.sh
adb shell 'chmod 755 /blackbox/upgrade/osmo-srt/browser/start.sh; nohup /blackbox/upgrade/osmo-srt/browser/start.sh </dev/null >/tmp/osmo-browser.log 2>&1 &'
```

This uses signed aarch64 Alpine APKs and retains a SHA-256 package manifest. The
tested image was Alpine 3.24, Chromium headless shell 156.0.8078.79, about 629 MiB
unpacked. Rebuilding later can pick up newer packages from the same repository;
retain the manifest/APKs to reproduce a specific runtime.

The script uses a private mount namespace and chroot with its own musl runtime,
fonts and certificate store. Camera system libraries are not replaced. Chromium
uses `--no-sandbox` because this embedded environment cannot use Chromium's normal
sandbox; chroot/mount separation is not a security sandbox. Use browser sources
you trust. Network access is the camera's network, including its tailnet. CDP
must stay on loopback; do not add it to Tailscale Serve or USB forwarding for
normal operation. The updated console launcher starts the installed browser
runtime when available. Neither launcher adds a boot hook.

## Processing modes and verified limits

| Mode | Current support |
| --- | --- |
| Standard | 720p, 1080p, 1440p; hardware HEVC Main |
| 10-bit Rec. 709 | 1080p30, HEVC Main 10; verified 177 decoded frames in ~5.94 s |
| D-Log M | Experimental: DJI `bt709-dlogm` P010 capture, Main 10; 177 frames / ~5.94 s; color response not calibrated |
| Sensor HDR | Experimental: `shdr` + `shdr-enable`; valid 8-bit output, 178 frames / ~5.97 s; dynamic range improvement not verified |
| Low light | Experimental: `op-mode=lowlight` + `viull-enable`; valid 8-bit output, 177 frames / ~5.94 s; processing effect not verified in a dark scene |
| Wind rumble filter | 180 Hz four-pole Chebyshev high-pass before AAC, applied only to the selected input; not DJI neural wind removal |
| DJI neural wind reduction | Internal mic, mono 48 kHz; 1024-sample blocks, 128 ms model delay compensated in PTS; firmware hashes checked |
| RNNoise small | Internal mic, mono 48 kHz; 480-sample blocks, 20 ms model delay compensated in PTS; optional sidecar library |
| RockSteady / Horizon correction | RockSteady, HorizonSteady, HorizonBalancing; Standard 8-bit, 30 fps, 720p / 1080p / 1440p; compatible with audio, browser overlays and JPEG preview |

Advanced modes are limited to 1080p30 pending further testing. Browser overlays
are limited to 8-bit modes: P010 + `gdkpixbufoverlay` produced only 29 frames before
stalling in a six-second test, so the combination is rejected before handoff.
The microphone's existing pairing, mute, gain and channel map are not changed by
the filter. No connected DJI transmitter was available for wireless validation.

### Stabilization findings

The source's generic `eis=true` chooses Qualcomm's `PreviewEISDGV26` pipeline,
not DJI's RockSteady node. On this firmware it fails with `TuningData Chromatix
is NULL` / `EISDGV26 Get Chromatix data failed. Algo not initilized`. Supplying
DJI's observed frame delay and IMU timing still selects that failing pipeline.
Changing just the video pad role still produces ordinary `Preview` frames.

Further investigation reproduced DJI's three configured stream roles, GBM/UBWC
buffers and preview-only activation order. The prototype now reaches
`DjiLowpowerPreview` and outputs HEVC with native RockSteady, HorizonSteady and
HorizonBalancing modes. Horizon modes require the linear FOV mapping; an
unsupported fisheye combination causes the stock algorithm to assert.
The Go sender and web UI now integrate these modes. The production path uses
the full-resolution realtime graph and a FastCV RGBA copy before CPU overlays
and preview. Startup waits for the mode to settle and an independently decodable
video frame; audio starts on that same capture timeline. See
[native graph setup and verification](STABILIZATION.md).

### Internal microphone and timing

The inspected PulseAudio `regular0` source advertises four S24_32LE channels,
but its buffers contain three signed-16 microphone lanes and a metadata lane.
Implicit PulseAudio conversion made capture roughly 48 dB too quiet. Capture
now requests that native format, excludes metadata, normalizes the PCM, and
mixes the three microphones before optional processing. This adapter is gated
by the inspected PulseAudio module hash and handset-mic format/route. Pairing,
input gain and mute are unchanged; source/port/format changes stop the stream.
Wireless inputs retain their original path and are rejected for neural modes.
This is a software mix, not DJI's full microphone-array beamformer/AGC chain.

DJI mode calls the stock `dji_audio_nn_*` API in the sender process. RNNoise uses
a separately built small-model ARM64 library. Both discard initial delayed
output, subtract their measured algorithmic delay from audio PTS/DTS, and push
zero-input blocks before EOS to recover the audio tail. No Python process is
needed for streaming. The UI reports processing mean/max cost and compensation.

Audio uses `provide-clock=false`, following the common GStreamer pipeline clock
with the installed source's default `skew` clock-slaving behavior. Video uses
HEVC with no B frames. AAC and HEVC timestamps are retained in the same MPEG-TS
and SRT connection. Encoder buffering changes delivery latency; content still
uses its capture timeline. SRT does not measure physical audio/video alignment.

A received ~41-second 720p30 DJI-neural recording after the PCM fix contained
1920 consecutive AAC packets, spaced 21.333 ms, with no audio timestamp gaps.
The first audio PTS was 50.378 ms after the first video PTS; their last packet
ends were 22.423 ms apart. A prior shorter DJI run started within 5.4 ms, so
startup alignment varies; these checks establish timestamp continuity, not a
calibrated sensor-to-speaker offset. Unit tests cover one minute of both model
timelines, warmup removal, timestamp underflow, and tail duration. Physical
lip-sync, long-term clock drift and wireless-mic latency remain unmeasured.

For the same 7.54-second recorded internal-mic input, native processing averaged
0.71 ms / 1024-sample block for DJI (~3.3% of one CPU) and 0.44 ms / 480-sample
block for RNNoise small (~4.4%). Peak process RSS was about 46 / 20 MiB. During
live HEVC + JPEG preview, DJI averaged 3.69 ms per block, max 10.10 ms, against a
21.33 ms block budget. These are compute measurements, not speech quality scores.
The room recording has no clean reference, so PESQ/STOI scores are not asserted.
`tools/probe-audio-processors.py` compares both native processors on a saved mono
S16LE/48 kHz input; its output retains algorithmic delay for offline alignment.
Real room recordings and proprietary firmware files stay outside this repo.

## Verification on the connected camera

An approximately 89-second received SRT recording contained 2560x1440 HEVC at
30000/1001 fps and stereo 48 kHz AAC with the wind filter enabled. Decoded frames
showed a live JavaScript clock, followed by changed text, color and position after
a scene save during streaming. Native camera control recovered after stopping.
Browser URL loading, drag/resize, layer ordering, and saved-layout reload were
verified. Stopping Chromium during a stream triggered the stale-frame watchdog
and restored native camera controls; restarting Chromium restored rendering.
Desktop and 390-pixel mobile Studio UI were exercised without JavaScript errors
or horizontal overflow. A separate Go sender test verified 1080p30 Main 10
with internal AAC audio and the wind filter. Test clips and proprietary firmware libraries are local
research artifacts, not repository assets.

## Rear display preview and temporary screen test

Studio's **Rear screen preview** reads the rear GUI graphics plane at most once
per two seconds, on demand while the panel is open. It uses a separate bounded
Python process, read-only process memory and DMA mappings, and exact firmware
fingerprints. It never pauses the GUI, changes display properties, or restarts a
service. Unsupported firmware and unstable captures return an unavailable state.
The preview has a 180-degree rotation button. The native camera picture uses a
separate plane and is not included in this preview.

The native plugin also has an experimental `ac_mode=screen` that draws a green
`OSMO SRT - REAR SCREEN TEST` panel with a counter on the GUI thread. This is a
rendering test, not livestream telemetry. It is not installed by the web preview.
On this firmware, DJI's USB connection modal is in a separate dialog layer and
covers the application's widgets. Moving the widget within the application does
not place it above the modal.

During the November 4 device trial, the modal's visibility bit was temporarily
cleared in RAM after validating the executable fingerprint, class, bounds, PID
and original flags. This exposed the test panel without restarting the GUI or
changing USB/ADB state. Dirty-region rendering can leave portions of the old
USB page visible until a full repaint. This experiment is not an automatic
feature of the server. Its saved original value can be restored on that same
process with:

```sh
python3 -I -B /run/action-control-ui-screen/restore-usb-modal.py
```

The trial's plugin and service configuration override are under `/run` only.
Its automatic rollback timer was cancelled at the user's request because rollback
would restart the GUI. Do not restart camera services to iterate on this trial.
The web endpoint was tested on-device at 712×400; display scanout matched the
captured GUI buffer and native frame presentation continued. Physical screen
confirmation remains a separate check.
