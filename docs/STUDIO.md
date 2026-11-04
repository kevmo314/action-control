# Studio and processing controls

Studio stores up to four web URL or custom HTML/CSS/JavaScript sources, with
position, size, opacity, visibility and stacking order. The camera is the locked
background. The editor currently uses a placeholder for camera video; its browser
source preview comes from the camera renderer. Browser sources run as independent
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
| RockSteady / Horizon correction | Not available in custom capture yet; see below |

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
Changing the video pad to main-video type without the generic flag produces
frames through the ordinary `Preview` graph, without a DJI EIS node. The native
camera instead uses DJI graphs with `com.dji.node.eis_preview`, an IMU node,
steady mode, crop/lens configuration and calibrated IMU timing (observed timing
varies by mode). Enabling the generic flag is therefore deliberately not offered
as RockSteady or Horizon correction. Those require integration of DJI's graph
selection and metadata setup; a successful bitstream alone would not verify them.

DJI's APU has its own neural wind-noise functions, but the current PulseAudio
capture path does not own an APU processing instance. The standard filter is
exposed under its actual name rather than claiming to activate that processing.

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
