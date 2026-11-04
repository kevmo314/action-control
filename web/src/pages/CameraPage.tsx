import { useEffect, useRef, useState } from "react";
import type Mpegts from "mpegts.js";
import {
  Aperture,
  Camera,
  Copy,
  Download,
  Maximize,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Video,
} from "lucide-react";
import {
  apiURL,
  errorText,
  invalidate,
  post,
  responseValue,
  useAPI,
} from "../api";
import { useViewState } from "../lib/view-state";
import { MimoPreview } from "../components/mimo-preview";
import type {
  CameraPreset,
  CameraStatus,
  Config,
  NativeCameraStatus,
  NativeAction,
  NativeRecordingResult,
  NativeServiceState,
} from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, Notice, PageHeader, Spinner, formatBytes } from "../ui";
import { ConfirmButton } from "../dialogs";

const resolutions = [
  "320x240",
  "640x480",
  "800x600",
  "1280x720",
  "1920x1080",
  "2560x1440",
  "3840x2160",
  "7680x4320",
];
const qualityRates = [2, 6, 15, 999];

const nativeStateLabels: Record<NativeServiceState, string> = {
  running: "Service running",
  stopped: "Service stopped",
  failed: "Service failed to start",
  transitioning: "Switching services",
  degraded: "Some services are not running",
  unknown: "Service status unknown",
  unavailable: "Local mode",
};
const nativeServiceLabels: Record<string, string> = {
  "dji_camera3.service": "Native camera services",
  "dji_media.service": "Media service",
  "gui.service": "Main display UI",
  "sub_gui.service": "Secondary display UI",
  "dji_sw_uav.service": "Mimo communication service",
};

function nativeRecordingLabel(status: NativeCameraStatus) {
  if (status.recording === true) return "Recording";
  if (status.recording === false) return "Not recording";
  if (status.native_state.status === "ok")
    return `Unrecognized state (code ${status.native_state.record_state})`;
  if (status.native_state.status === "unsupported_firmware")
    return "Current firmware not supported yet";
  if (status.service_state === "unavailable")
    return "Unavailable in local mode";
  return "Unknown";
}

function nativeVideoSettingsLabel(status: NativeCameraStatus) {
  const v = status.native_state.video_settings;
  if (status.native_state.status !== "ok" || !v) return "—";
  const parts = [
    v.resolution_label ||
      (v.resolution !== null ? `Resolution ${v.resolution}` : null),
    v.fps_label ? `${v.fps_label}fps` : v.fps !== null ? `${v.fps}fps` : null,
    v.codec !== null ? `Codec ${v.codec}` : null,
    v.eis_label ? `Stabilization ${v.eis_label}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

export function CameraPage() {
  const native = useAPI<NativeCameraStatus>(
    "native_camera_status",
    undefined,
    5000,
  );
  const capture = useAPI<CameraStatus>("camera_status", undefined, 3000);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [nativeAction, setNativeAction] = useState<NativeAction | null>(null);
  const [nativeResult, setNativeResult] =
    useState<NativeRecordingResult | null>(null);
  const [nativeError, setNativeError] = useState("");
  const nativeBusy = useRef(false);

  async function runNative(action: NativeAction) {
    if (nativeBusy.current) return;
    nativeBusy.current = true;
    setNativeAction(action);
    setNativeResult(null);
    setNativeError("");
    try {
      // getRandomValues also works over the camera's plain HTTP connection.
      const requestID = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const endpoint =
        action === "capture"
          ? "native_capture"
          : action === "mode_photo" || action === "mode_video"
            ? "native_mode"
            : "native_recording";
      setNativeResult(
        await post<NativeRecordingResult>(endpoint, {
          action,
          request_id: requestID,
        }),
      );
    } catch (error) {
      setNativeError(
        `Incomplete native response: ${errorText(error)}. Check the current camera state before proceeding.`,
      );
    } finally {
      await invalidate("native_camera_status");
      nativeBusy.current = false;
      setNativeAction(null);
    }
  }

  useEffect(() => {
    if (capture.data && capture.data.state !== "stopped") setAdvancedOpen(true);
  }, [capture.data?.state]);

  return (
    <>
      <PageHeader
        title="Camera"
        description="Use native camera recording controls and relay live video from Mimo."
        actions={
          <Button
            variant="outline"
            disabled={native.isFetching || capture.isFetching}
            onClick={() =>
              void invalidate("native_camera_status", "camera_status")
            }
          >
            <RefreshCw />
            Refresh status
          </Button>
        }
      />
      {capture.data?.reboot_required && (
        <div className="mb-4">
          <Notice tone="warning">
            Native services have been affected. A full reboot is required even
            after stopping independent capture.
            <a
              href="#/system?section=maintenance"
              className="ml-2 underline underline-offset-4"
            >
              Go to reboot
            </a>
          </Notice>
        </div>
      )}
      <Card title="Native camera">
        {native.isPending ? (
          <Spinner />
        ) : native.isError ? (
          <Notice tone="warning">
            Cannot read native service status: {native.error.message}
          </Notice>
        ) : (
          <>
            <Badge
              variant={
                native.data.service_state === "running"
                  ? "default"
                  : "secondary"
              }
            >
              {nativeStateLabels[native.data.service_state]}
            </Badge>
            {native.data.reason && (
              <p className="mt-3 text-sm text-muted-foreground">
                {native.data.reason}
              </p>
            )}
            <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  Native recording status
                </dt>
                <dd className="mt-1">{nativeRecordingLabel(native.data)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Native operating mode</dt>
                <dd className="mt-1">
                  {native.data.native_state.status === "ok" &&
                  native.data.native_state.workmode !== null
                    ? `Code ${native.data.native_state.workmode}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Capture mode</dt>
                <dd className="mt-1">
                  {native.data.native_state.status === "ok" &&
                  native.data.native_state.mode_profile !== null
                    ? `Code ${native.data.native_state.mode_profile}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Video settings</dt>
                <dd className="mt-1">
                  {nativeVideoSettingsLabel(native.data)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Web preview</dt>
                <dd className="mt-1">Connect to Mimo video below</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              {native.data.native_state.status === "ok"
                ? `Native camera state · Last read ${new Date(native.data.native_state.observed_at!).toLocaleTimeString()} · Refreshes every 5 seconds`
                : "Native recording status is temporarily unavailable. Retrying automatically."}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button
                disabled={
                  nativeAction !== null ||
                  !native.data.control_available ||
                  !native.data.recording_controls.start
                }
                onClick={() => void runNative("start_recording")}
              >
                <Play />
                {nativeAction === "start_recording"
                  ? "Requesting start…"
                  : "Start recording"}
              </Button>
              <Button
                variant="outline"
                disabled={
                  nativeAction !== null ||
                  !native.data.control_available ||
                  !native.data.recording_controls.stop
                }
                onClick={() => void runNative("stop_recording")}
              >
                <Square />
                {nativeAction === "stop_recording"
                  ? "Requesting stop…"
                  : "Stop recording"}
              </Button>
              <Button
                variant="outline"
                disabled={
                  nativeAction !== null ||
                  !native.data.control_available ||
                  !native.data.capture_controls.capture
                }
                onClick={() => void runNative("capture")}
              >
                <Camera />
                {nativeAction === "capture"
                  ? "Requesting photo…"
                  : "Take photo"}
              </Button>
              <Button
                variant="outline"
                disabled={
                  nativeAction !== null ||
                  !native.data.control_available ||
                  !native.data.mode_controls.photo
                }
                onClick={() => void runNative("mode_photo")}
              >
                <Aperture />
                {nativeAction === "mode_photo"
                  ? "Switching…"
                  : "Switch to photo"}
              </Button>
              <Button
                variant="outline"
                disabled={
                  nativeAction !== null ||
                  !native.data.control_available ||
                  !native.data.mode_controls.video
                }
                onClick={() => void runNative("mode_video")}
              >
                <Video />
                {nativeAction === "mode_video"
                  ? "Switching…"
                  : "Switch to video"}
              </Button>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Uses the current camera settings. Recordings and photos are saved
              by the camera. Photos can only be taken while the camera is idle.
            </p>
            {nativeResult && (
              <div className="mt-4">
                <Notice
                  tone={
                    nativeResult.outcome === "confirmed" ||
                    nativeResult.outcome === "already"
                      ? "success"
                      : "warning"
                  }
                >
                  <span className="block">{nativeResult.message}</span>
                  <span className="mt-1 block text-xs opacity-80">
                    Last operation ·{" "}
                    {new Date(nativeResult.completed_at).toLocaleTimeString()}
                  </span>
                  {nativeResult.reason && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer">
                        View operation details
                      </summary>
                      <p className="mt-1">{nativeResult.reason}</p>
                    </details>
                  )}
                </Notice>
              </div>
            )}
            {nativeError && (
              <div className="mt-4">
                <Notice tone="warning">{nativeError}</Notice>
              </div>
            )}
            {native.data.services.length > 0 && (
              <details className="mt-5 rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  View native service details
                </summary>
                <dl className="mt-4 space-y-3 text-sm">
                  {native.data.services.map((service) => (
                    <div
                      key={service.unit}
                      className="flex flex-wrap justify-between gap-2"
                    >
                      <dt>
                        {nativeServiceLabels[service.unit] ?? service.unit}
                      </dt>
                      <dd className="text-muted-foreground">
                        {nativeStateLabels[service.state]}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-4 text-xs text-muted-foreground">
                  A running Mimo communication service does not mean a phone is
                  connected.
                </p>
                {native.data.native_state.reason && (
                  <p className="mt-3 break-words text-xs text-muted-foreground">
                    Recording status: {native.data.native_state.reason}
                  </p>
                )}
              </details>
            )}
          </>
        )}
      </Card>
      <div className="mt-6">
        <MimoPreview
          enabled={
            native.data?.service_state === "running" &&
            capture.data?.state === "stopped" &&
            !capture.data?.reboot_required
          }
        />
      </div>
      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        className="mt-6 rounded-xl border bg-card p-5"
      >
        <summary className="cursor-pointer font-medium">
          Advanced: independent capture
        </summary>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Independent capture interrupts native capture, displays, and the Mimo
          connection. Reboot the camera to restore native functionality.
          Expanding this section only shows settings. Camera takeover happens
          when capture starts.
        </p>
        {advancedOpen && (
          <div className="mt-5">
            <IndependentCapture />
          </div>
        )}
      </details>
    </>
  );
}

function IndependentCapture() {
  const status = useAPI<CameraStatus>("camera_status", undefined, 2000);
  const config = useAPI<Config>("config");
  const presets = useAPI<{ last_success: CameraPreset | null }>(
    "camera_presets",
  );
  const health = useAPI<{ device: boolean }>("health", undefined, 5000);
  const [draft, setDraft] = useViewState<Config | null>("camera.draft", null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(true),
    [attempt, setAttempt] = useState(0);
  const [playback, setPlayback] = useState("Preview not connected"),
    [playbackError, setPlaybackError] = useState("");
  const video = useRef<HTMLVideoElement>(null),
    form = useRef<HTMLFormElement>(null),
    address = useRef<HTMLInputElement>(null);
  const advanced = useRef<HTMLDetailsElement>(null);
  const running = status.data?.running === true;
  const hardware = health.data?.device === true && !health.isError;
  const transition =
    status.data?.state === "starting" || status.data?.state === "stopping";
  const hostname =
    location.hostname.includes(":") && !location.hostname.startsWith("[")
      ? `[${location.hostname}]`
      : location.hostname;
  const url = `tcp://${hostname}:${status.data?.ext_port ?? draft?.cam_ext_port ?? 8554}`;

  useEffect(() => {
    if (config.data) setDraft((current) => current ?? config.data!);
  }, [config.data]);
  useEffect(() => {
    if (!running || !preview) {
      setPlayback("Preview not connected");
      setPlaybackError("");
      return;
    }
    const controller = new AbortController();
    let player: Mpegts.Player | undefined;
    const destroy = () => {
      controller.abort();
      if (player) {
        player.destroy();
        player = undefined;
      }
    };
    void import("mpegts.js")
      .then(async ({ default: mpegts }) => {
        if (controller.signal.aborted || !video.current) return;
        const features = mpegts.getFeatureList();
        if (!features.mseLivePlayback)
          throw new Error(
            "This browser does not support live MPEG-TS playback. Use an external TCP player.",
          );
        player = mpegts.createPlayer(
          {
            type: "mpegts",
            isLive: true,
            hasAudio: false,
            url: apiURL("camera_stream"),
          },
          {
            enableWorker: false,
            enableStashBuffer: false,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 1.5,
            liveBufferLatencyMinRemain: 0.5,
            autoCleanupSourceBuffer: true,
          },
        );
        player.on(mpegts.Events.ERROR, (kind: string, detail: string) => {
          if (!controller.signal.aborted) {
            setPlayback("Preview error");
            setPlaybackError(
              `${kind}: ${detail}. This error does not mean capture has stopped.`,
            );
            destroy();
          }
        });
        player.attachMediaElement(video.current);
        player.load();
        try {
          await player.play();
        } catch (e) {
          if (!controller.signal.aborted) {
            setPlayback("Waiting for manual playback");
            setPlaybackError(
              `Browser playback did not start: ${errorText(e)}. You can click the video play button.`,
            );
          }
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setPlayback("Preview unavailable");
          setPlaybackError(errorText(e));
          destroy();
        }
      });
    return destroy;
  }, [running, preview, attempt]);

  async function control(name: string, data: unknown = {}) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await post(name, data);
      await invalidate(
        "camera_status",
        "native_camera_status",
        "config",
        "sysinfo",
        "camera_presets",
      );
    } catch (e) {
      setError(
        `${errorText(e)}. If disconnected, refresh capture status before repeating any operation.`,
      );
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function preset(patch: Partial<Config>) {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, ...patch };
      next.cam_bitrate = Math.min(
        1000,
        Math.max(
          0.5,
          Math.round(
            qualityRates[next.cam_quality] *
              Math.max(
                0.3,
                Math.min(10, (next.cam_w * next.cam_h) / (1920 * 1080)),
              ) *
              10,
          ) / 10,
        ),
      );
      return next;
    });
  }
  async function snapshot() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(apiURL("camera_snapshot"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) await responseValue(response);
      const object = URL.createObjectURL(await response.blob()),
        link = document.createElement("a");
      link.href = object;
      link.download = `snapshot-${new Date().toISOString().replaceAll(":", "-")}.jpg`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(object), 1000);
      setNotice("Snapshot sent to the browser for download.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const knownState = Boolean(status.data) && !status.isError;
  const lastSuccess = presets.data?.last_success;
  const common = draft ? `${draft.cam_w}x${draft.cam_h}@${draft.cam_fps}` : "";
  const commonPresets = [
    {
      value: "1280x720@30",
      label: "720p · 30 fps",
      width: 1280,
      height: 720,
      bitrate: 4.4,
    },
    {
      value: "1920x1080@30",
      label: "1080p · 30 fps",
      width: 1920,
      height: 1080,
      bitrate: 6,
    },
  ];
  const captureState = status.isPending
    ? "Reading"
    : status.isError
      ? "Unknown status"
      : running
        ? "Running"
        : transition
          ? "Switching"
          : status.data?.state === "error"
            ? "Failed"
            : "Stopped";

  return (
    <div className="pb-24 md:pb-0">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Independent capture</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            These settings and status apply only to capture managed by Action
            Control.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void status.refetch()}
          disabled={status.isFetching}
        >
          <RefreshCw />
          Refresh independent capture status
        </Button>
      </div>
      {status.isError && (
        <div className="mb-4">
          <Notice tone="warning">
            Capture status unknown: {status.error.message}. Check the status
            after reconnecting.
          </Notice>
        </div>
      )}
      {(error || status.data?.error) && (
        <div className="mb-4">
          <Notice tone="error">{error || status.data?.error}</Notice>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card title="Live preview">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge
              variant={running && !status.isError ? "default" : "secondary"}
            >
              Independent capture: {captureState}
            </Badge>
            <Badge variant="secondary">Browser: {playback}</Badge>
            {running && !status.isError && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {Math.floor(status.data!.uptime_sec / 60)} min{" "}
                {Math.floor(status.data!.uptime_sec % 60)} sec
              </span>
            )}
          </div>
          <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-zinc-950">
            <video
              ref={video}
              className="h-full w-full object-contain"
              controls={running && preview}
              muted
              playsInline
              autoPlay
              onPlaying={() => {
                setPlayback("Playing");
                setPlaybackError("");
              }}
              onPause={() => {
                if (running && preview) setPlayback("Preview paused");
              }}
              onWaiting={() => {
                if (running && preview) setPlayback("Buffering preview");
              }}
              onError={() => {
                if (running && preview)
                  setPlaybackError(
                    video.current?.error?.message ||
                      "This browser cannot decode the current video.",
                  );
              }}
            />
            {(!running || !preview) && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
                <Camera className="size-10" />
                <p className="text-sm">
                  {status.isError
                    ? "Waiting for device status to recover"
                    : running
                      ? "Preview closed · Capture continues on device"
                      : "Show video after capture starts"}
                </p>
              </div>
            )}
          </div>
          <div className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-2 border-t bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur md:static md:mt-4 md:border-0 md:bg-transparent md:p-0 md:shadow-none [&_button]:min-h-11">
            <ConfirmButton
              variant="default"
              disabled={
                !hardware ||
                !knownState ||
                !draft ||
                config.isError ||
                busy ||
                running ||
                transition
              }
              title="Take over the camera and start independent capture?"
              description="Stops native camera, display, and Mimo communication services. A full reboot may be needed to restore native functionality, even if capture fails to start or is stopped later."
              onConfirm={async () => {
                if (!draft || !form.current)
                  throw new Error("Capture settings are not ready.");
                if (!form.current.checkValidity()) {
                  if (advanced.current) advanced.current.open = true;
                  form.current.reportValidity();
                  throw new Error("Check the capture settings.");
                }
                await control("camera_start", {
                  width: draft.cam_w,
                  height: draft.cam_h,
                  fps: draft.cam_fps,
                  ext_port: draft.cam_ext_port,
                  bitrate: draft.cam_bitrate,
                  quality: draft.cam_quality,
                  confirm: true,
                  takeover_native: true,
                });
              }}
            >
              <Play />
              Start independent capture
            </ConfirmButton>
            <Button
              variant="outline"
              disabled={
                !hardware ||
                !knownState ||
                busy ||
                transition ||
                status.data?.state === "stopped"
              }
              onClick={() => void control("camera_stop").catch(() => {})}
            >
              <Square />
              Stop independent capture
            </Button>
            <span className="ml-auto text-xs text-muted-foreground md:ml-1">
              {!hardware ? "Camera not connected" : captureState}
            </span>
          </div>
          {playbackError && (
            <div className="mt-4">
              <Notice tone="warning">{playbackError}</Notice>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!running}
              onClick={() => {
                setPreview(true);
                setAttempt((n) => n + 1);
              }}
            >
              <Play />
              {preview && playback === "Playing"
                ? "Reconnect"
                : "Connect preview"}
            </Button>
            <Button
              variant="ghost"
              disabled={!running || !preview}
              onClick={() => setPreview(false)}
            >
              Close preview
            </Button>
            <Button
              variant="outline"
              disabled={!running || busy || !hardware}
              onClick={() => void snapshot()}
            >
              <Download />
              Snapshot
            </Button>
            <Button
              variant="ghost"
              disabled={!running || !preview}
              onClick={() => {
                if (video.current?.requestFullscreen)
                  void video.current
                    .requestFullscreen()
                    .catch((cause) => setError(errorText(cause)));
                else
                  setError("This browser does not support fullscreen video.");
              }}
            >
              <Maximize />
              Fullscreen
            </Button>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-4 border-t pt-5 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Capture settings</dt>
              <dd className="mt-1 font-mono">
                {status.data
                  ? `${status.data.width} × ${status.data.height}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Configured frame rate</dt>
              <dd className="mt-1 font-mono">{status.data?.fps ?? "—"} fps</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Average output bitrate</dt>
              <dd className="mt-1 font-mono">
                {running
                  ? `${(status.data!.bitrate_kbps / 1000).toFixed(2)} Mbps`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Output / clients</dt>
              <dd className="mt-1 font-mono">
                {formatBytes(status.data?.bytes_sent)} /{" "}
                {status.data?.clients ?? "—"}
              </dd>
            </div>
          </dl>
        </Card>
        <Card
          title="Capture settings"
          description="Choose a preset first, then adjust detailed settings if needed."
        >
          {config.isError ? (
            <Notice tone="error">{config.error.message}</Notice>
          ) : !draft ? (
            <Spinner />
          ) : (
            <form
              ref={form}
              onSubmit={(event) => event.preventDefault()}
              className="space-y-4"
            >
              <fieldset
                disabled={busy || running || transition}
                className="space-y-4 disabled:opacity-60"
              >
                <div>
                  <Label htmlFor="capture-profile">Presets</Label>
                  <Select
                    value={
                      commonPresets.some((item) => item.value === common)
                        ? common
                        : "custom"
                    }
                    onValueChange={(value) => {
                      const preset = commonPresets.find(
                        (item) => item.value === value,
                      );
                      if (preset)
                        setDraft({
                          ...draft,
                          cam_w: preset.width,
                          cam_h: preset.height,
                          cam_fps: 30,
                          cam_quality: 1,
                          cam_bitrate: preset.bitrate,
                        });
                      else if (advanced.current) advanced.current.open = true;
                    }}
                  >
                    <SelectTrigger id="capture-profile" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {commonPresets.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                      <SelectItem value="custom">Custom settings</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Availability depends on whether capture starts successfully
                    on this device.
                  </p>
                </div>
                {lastSuccess && (
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">Last successful capture</p>
                    <p className="mt-1 text-muted-foreground">
                      {lastSuccess.config.cam_w} × {lastSuccess.config.cam_h} ·{" "}
                      {lastSuccess.config.cam_fps} fps
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(lastSuccess.saved_at).toLocaleString("en-US")}
                      {!lastSuccess.firmware_match
                        ? " · Firmware match unconfirmed; revalidation required"
                        : ""}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => {
                        setDraft({ ...draft, ...lastSuccess.config });
                        setNotice(
                          "Settings from the last successful capture loaded. Start capture to apply them.",
                        );
                      }}
                    >
                      <RotateCcw />
                      Use these settings
                    </Button>
                  </div>
                )}
                <details ref={advanced} className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Advanced and experimental settings
                  </summary>
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                    Untested resolution and frame rate combinations may fail to
                    start. The bitrate reference adjusts quality; actual output
                    is shown below the preview.
                  </p>
                  <div className="mt-4 space-y-4">
                    <div>
                      <Label htmlFor="camera-preset">Resolution</Label>
                      <Select
                        value={
                          resolutions.includes(`${draft.cam_w}x${draft.cam_h}`)
                            ? `${draft.cam_w}x${draft.cam_h}`
                            : "custom"
                        }
                        onValueChange={(value) => {
                          if (value !== "custom") {
                            const [cam_w, cam_h] = value.split("x").map(Number);
                            preset({ cam_w, cam_h });
                          }
                        }}
                      >
                        <SelectTrigger id="camera-preset" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="custom">Custom</SelectItem>
                          {resolutions.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value.replace("x", " × ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="camera-width">Width</Label>
                        <Input
                          id="camera-width"
                          type="number"
                          required
                          min={320}
                          max={7680}
                          step={2}
                          value={draft.cam_w}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              cam_w: Number(event.target.value),
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="camera-height">Height</Label>
                        <Input
                          id="camera-height"
                          type="number"
                          required
                          min={240}
                          max={4320}
                          step={2}
                          value={draft.cam_h}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              cam_h: Number(event.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="camera-fps">
                          Configured frame rate
                        </Label>
                        <Input
                          id="camera-fps"
                          type="number"
                          required
                          min={1}
                          max={240}
                          value={draft.cam_fps}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              cam_fps: Number(event.target.value),
                            })
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor="camera-port">TCP port</Label>
                        <Input
                          id="camera-port"
                          type="number"
                          required
                          min={1024}
                          max={65535}
                          value={draft.cam_ext_port}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              cam_ext_port: Number(event.target.value),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor="camera-quality">Quality reference</Label>
                      <Select
                        value={String(draft.cam_quality)}
                        onValueChange={(value) =>
                          preset({ cam_quality: Number(value) })
                        }
                      >
                        <SelectTrigger id="camera-quality" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["Low", "Normal", "High", "Very high"].map(
                            (label, i) => (
                              <SelectItem key={i} value={String(i)}>
                                {label}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="camera-bitrate">
                        Bitrate reference (Mbps)
                      </Label>
                      <Input
                        id="camera-bitrate"
                        type="number"
                        required
                        min={0.5}
                        max={1000}
                        step={0.1}
                        value={draft.cam_bitrate}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            cam_bitrate: Number(event.target.value),
                          })
                        }
                      />
                    </div>
                  </div>
                </details>
              </fieldset>
              {running && (
                <p className="text-xs text-muted-foreground">
                  Stop capture to change settings.
                </p>
              )}
            </form>
          )}
        </Card>
      </div>
      <details className="mt-6 rounded-xl border bg-card p-5">
        <summary className="cursor-pointer font-medium">
          External players and connection help
        </summary>
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Use a player that supports TCP MPEG-TS / H.264. The video port is
            open only during capture.
          </p>
          <Notice tone="warning">
            The TCP video port has no authentication or encryption. Use only on
            a trusted LAN. When using ADB forwarding, also forward the video
            port shown below.
          </Notice>
          <div>
            <Label htmlFor="tcp-address">Playback URL</Label>
            <div className="flex gap-2">
              <Input
                ref={address}
                id="tcp-address"
                readOnly
                value={url}
                className="font-mono"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                variant="outline"
                aria-label="Copy playback URL"
                onClick={async () => {
                  try {
                    if (!navigator.clipboard)
                      throw new Error("clipboard unavailable");
                    await navigator.clipboard.writeText(url);
                    setNotice("Playback URL copied.");
                  } catch {
                    address.current?.focus();
                    address.current?.select();
                    setNotice(
                      "Address selected. Use the system copy menu or Ctrl/Cmd+C.",
                    );
                  }
                }}
              >
                <Copy />
              </Button>
            </div>
          </div>
          {["127.0.0.1", "localhost", "[::1]", "::1"].includes(
            location.hostname,
          ) && (
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
              adb forward tcp:
              {status.data?.ext_port ?? draft?.cam_ext_port ?? 8554} tcp:
              {status.data?.ext_port ?? draft?.cam_ext_port ?? 8554}
            </pre>
          )}
        </div>
      </details>
    </div>
  );
}
