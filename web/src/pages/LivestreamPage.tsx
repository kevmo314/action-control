import { useEffect, useState } from "react";
import { Radio, Square, RefreshCw } from "lucide-react";
import { errorText, invalidate, post, useAPI } from "../api";
import { Card, Notice, PageHeader, Spinner, formatBytes } from "../ui";
import { ConfirmButton } from "../dialogs";
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

type StreamConfig = {
  address: string;
  stream_id: string;
  passphrase?: string;
  latency_ms: number;
  width: number;
  height: number;
  fps: number;
  bitrate_kbps: number;
  audio_source: string;
  image_mode?: string;
  stabilization?: string;
  wind_filter?: boolean;
  noise_reduction?: string;
};
type AudioSource = {
  name: string;
  description: string;
  wireless: boolean;
  muted: boolean;
  sample_spec: string;
  channel_map: string;
  active_port: string;
};
function microphoneLabel(source: AudioSource) {
  return source.name.includes("wireless-mic")
    ? "DJI wireless microphones"
    : source.name === "regular0"
      ? "Camera internal microphones"
      : source.description || source.name;
}
type StreamState = {
  available: boolean;
  reason: string;
  running: boolean;
  config: StreamConfig;
  status: {
    state: string;
    codec: string;
    bytes: number;
    started_at: string;
    updated_at: string;
    error?: string;
    audio_source?: string;
    audio_codec?: string;
    audio_processing?: {
      mode: string;
      compensated_delay_ms: number;
      average_ms: number;
      max_ms: number;
      frames: number;
    };
  };
};
const labels: Record<string, string> = {
  stopped: "Stopped",
  preparing: "Preparing camera",
  connecting: "Connecting to receiver",
  starting: "Starting hardware encoder",
  sending: "Sending",
  stopping: "Stopping",
  restoring: "Restoring camera",
  error: "Error",
};

export function LivestreamPage() {
  const stream = useAPI<StreamState>("livestream", undefined, 1000);
  const microphones = useAPI<{ sources: AudioSource[] }>(
    "livestream/audio",
    undefined,
    3000,
  );
  const [draft, setDraft] = useState<StreamConfig>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!stream.data) return;
    // Active controls describe the actual sender, including streams started in
    // another tab or through the API. Only keep local edits while idle.
    if (stream.data.running || !dirty) {
      setDraft({ ...stream.data.config, passphrase: "" });
      if (stream.data.running) setDirty(false);
    }
  }, [stream.data, dirty]);
  const active = stream.data?.running ?? false;
  const stabilized = !!draft?.stabilization && draft.stabilization !== "off";
  const stabilizationLabels: Record<string, string> = {
    off: "Off",
    rocksteady: "RockSteady",
    horizonsteady: "HorizonSteady",
    horizonbalancing: "HorizonBalancing",
  };
  const disabled = busy || active;
  const update = (change: Partial<StreamConfig>) => {
    setDraft((c) => (c ? { ...c, ...change } : c));
    setDirty(true);
  };
  const start = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await post("livestream", {
        action: "start",
        config: draft,
        takeover_native: true,
      });
      update({ passphrase: "" });
      await invalidate("livestream");
      setDirty(false);
    } catch (e) {
      setError(errorText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setError("");
    try {
      await post("livestream", { action: "stop" });
      await invalidate("livestream");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const st = stream.data?.status;
  const sources = microphones.data?.sources ?? [];
  const noiseMode =
    draft?.noise_reduction || (draft?.wind_filter ? "highpass" : "off");
  const wirelessPreferred = sources.some((source) =>
    source.name.includes("wireless-mic"),
  );
  const neuralAvailable =
    draft?.audio_source === "regular0" ||
    (draft?.audio_source === "auto" && !wirelessPreferred);
  const selectMicrophone = (audio_source: string) => {
    const acceptsNeural =
      audio_source === "regular0" ||
      (audio_source === "auto" && !wirelessPreferred);
    update({
      audio_source,
      ...(!acceptsNeural && ["dji", "rnnoise"].includes(noiseMode)
        ? { noise_reduction: "off", wind_filter: false }
        : {}),
    });
  };
  const selected = sources.find((s) => s.name === st?.audio_source);
  return (
    <>
      <PageHeader
        title="Livestreaming"
        description="Send camera video and microphone audio to an SRT receiver."
        actions={
          <Button variant="outline" onClick={() => invalidate("livestream")}>
            <RefreshCw />
            Refresh
          </Button>
        }
      />
      {stream.isPending ? (
        <Spinner />
      ) : stream.isError ? (
        <Notice tone="error">{stream.error.message}</Notice>
      ) : (
        <>
          {!stream.data.available && (
            <div className="mb-4">
              <Notice tone="warning">{stream.data.reason}</Notice>
            </div>
          )}
          {(error || st?.error) && (
            <div className="mb-4">
              <Notice tone="error">{error || st?.error}</Notice>
            </div>
          )}
          <Card title="Stream status">
            <div className="flex flex-wrap items-center gap-3">
              <Badge
                variant={st?.state === "error" ? "destructive" : "secondary"}
              >
                {labels[st?.state ?? "stopped"] ?? st?.state}
              </Badge>
              <span className="text-sm text-muted-foreground">
                H.265 / HEVC · MPEG-TS over SRT ·{" "}
                {st?.audio_codec || "Audio selected below"}
              </span>
            </div>
            <dl className="mt-5 grid gap-5 sm:grid-cols-3">
              <div>
                <dt className="text-sm text-muted-foreground">
                  Data handed to SRT
                </dt>
                <dd className="mt-1 text-xl font-semibold">
                  {formatBytes(st?.bytes ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Destination</dt>
                <dd className="mt-1 break-all">
                  {stream.data.config.address || "Not configured"}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">Capture</dt>
                <dd className="mt-1">
                  {stream.data.config.width} × {stream.data.config.height} ·{" "}
                  {stream.data.config.fps} fps
                  <span className="block text-sm text-muted-foreground">
                    {
                      stabilizationLabels[
                        stream.data.config.stabilization || "off"
                      ]
                    }
                  </span>
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-muted-foreground">
              Microphone:{" "}
              {st?.audio_source && st.audio_source !== "none"
                ? selected
                  ? microphoneLabel(selected)
                  : st.audio_source
                : "Off / not started"}
              {selected?.muted ? " · Muted on the camera" : ""}
            </p>
            <p className="mt-4 text-xs text-muted-foreground">
              Sending means encoded video is being handed to SRT. Check your
              receiver to confirm playback. Closing this page keeps the stream
              running; restarting the console stops it.
            </p>
          </Card>
          {draft && (
            <div className="mt-5">
              <div className="mb-5">
                <Card
                  title="Microphone"
                  description="DJI wireless microphones use the camera’s existing pairing, gain, mute, and channel settings."
                >
                  <Label htmlFor="stream-microphone">Audio input</Label>
                  <Select
                    value={draft.audio_source || "none"}
                    disabled={disabled}
                    onValueChange={selectMicrophone}
                  >
                    <SelectTrigger
                      id="stream-microphone"
                      className="mt-1 w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">
                        Auto: prefer connected DJI wireless microphones
                      </SelectItem>
                      <SelectItem value="none">Off (video only)</SelectItem>
                      {sources.map((source) => (
                        <SelectItem key={source.name} value={source.name}>
                          {microphoneLabel(source)}
                          {source.muted ? " (muted)" : ""}
                        </SelectItem>
                      ))}
                      {draft.audio_source &&
                        !["none", "auto"].includes(draft.audio_source) &&
                        !sources.some((s) => s.name === draft.audio_source) && (
                          <SelectItem value={draft.audio_source} disabled>
                            Disconnected input: {draft.audio_source}
                          </SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                  <p className="mt-3 text-sm text-muted-foreground">
                    AAC-LC · 48 kHz · Stereo · 128 kbps. Auto selects once when
                    the stream starts. A disconnected or rerouted microphone
                    stops the stream; it does not switch to another input.
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Pair DJI microphones in the camera settings before starting.
                    The stereo channel mapping is preserved for wireless inputs.
                    Connecting or changing microphones requires stopping and
                    starting the stream.
                  </p>
                  {microphones.isError && (
                    <div className="mt-3">
                      <Notice tone="warning">
                        {microphones.error.message}
                      </Notice>
                    </div>
                  )}
                  {!sources.some((s) => s.name.includes("wireless-mic")) && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      No DJI wireless microphone detected.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    Internal microphone capture has been tested on this camera.
                    DJI wireless capture still needs verification with a
                    connected transmitter.
                  </p>
                </Card>
              </div>
              <Card
                title="SRT destination"
                description="Start an SRT listener on your receiver, then enter its hostname or IP and port. The camera connects as the caller."
              >
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="srt-address">Receiver address</Label>
                    <Input
                      id="srt-address"
                      placeholder="192.168.1.10:9000"
                      value={draft.address}
                      disabled={disabled}
                      onChange={(e) => update({ address: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="srt-stream-id">Stream ID (optional)</Label>
                    <Input
                      id="srt-stream-id"
                      autoComplete="off"
                      value={draft.stream_id}
                      disabled={disabled}
                      onChange={(e) => update({ stream_id: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="srt-passphrase">
                      SRT passphrase (optional)
                    </Label>
                    <Input
                      id="srt-passphrase"
                      type="password"
                      autoComplete="new-password"
                      placeholder="10–79 bytes, or leave empty"
                      value={draft.passphrase ?? ""}
                      disabled={disabled}
                      onChange={(e) => update({ passphrase: e.target.value })}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Enter again for each start. Never stored in browser
                      storage.
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="srt-latency">Latency (ms)</Label>
                    <Input
                      id="srt-latency"
                      type="number"
                      min={20}
                      max={8000}
                      value={draft.latency_ms}
                      disabled={disabled}
                      onChange={(e) =>
                        update({ latency_ms: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="stream-resolution">Resolution</Label>
                    <Select
                      value={`${draft.width}x${draft.height}`}
                      disabled={disabled}
                      onValueChange={(v) => {
                        const [width, height] = v.split("x").map(Number);
                        update({ width, height });
                      }}
                    >
                      <SelectTrigger id="stream-resolution" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1280x720">1280 × 720</SelectItem>
                        <SelectItem value="1920x1080">1920 × 1080</SelectItem>
                        <SelectItem value="2560x1440">2560 × 1440</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="stream-fps">Frame rate</Label>
                    <Select
                      value={String(draft.fps)}
                      disabled={disabled}
                      onValueChange={(v) => update({ fps: Number(v) })}
                    >
                      <SelectTrigger id="stream-fps" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="25" disabled={stabilized}>
                          25 fps
                        </SelectItem>
                        <SelectItem value="30">30 fps</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="stream-bitrate">Video bitrate (kbps)</Label>
                    <Input
                      id="stream-bitrate"
                      type="number"
                      min={500}
                      max={30000}
                      step={500}
                      value={draft.bitrate_kbps}
                      disabled={disabled}
                      onChange={(e) =>
                        update({ bitrate_kbps: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="stream-stabilization">Stabilization</Label>
                    <Select
                      value={draft.stabilization || "off"}
                      disabled={disabled}
                      onValueChange={(stabilization) =>
                        update(
                          stabilization === "off"
                            ? { stabilization }
                            : {
                                stabilization,
                                fps: 30,
                                image_mode: "standard",
                              },
                        )
                      }
                    >
                      <SelectTrigger
                        id="stream-stabilization"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="rocksteady">RockSteady</SelectItem>
                        <SelectItem value="horizonsteady">
                          HorizonSteady
                        </SelectItem>
                        <SelectItem value="horizonbalancing">
                          HorizonBalancing
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      DJI stabilization supports Standard 8-bit at 30 fps.
                      Horizon modes use a narrower, corrected field of view.
                      Starting waits briefly for stabilization to settle.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="stream-image-mode">Image mode</Label>
                    <Select
                      value={draft.image_mode || "standard"}
                      disabled={disabled}
                      onValueChange={(image_mode) => update({ image_mode })}
                    >
                      <SelectTrigger id="stream-image-mode" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">
                          Standard · 8-bit
                        </SelectItem>
                        <SelectItem value="10bit" disabled={stabilized}>
                          10-bit · Rec. 709
                        </SelectItem>
                        <SelectItem value="dlogm" disabled={stabilized}>
                          D-Log M · experimental
                        </SelectItem>
                        <SelectItem value="shdr" disabled={stabilized}>
                          Sensor HDR · experimental
                        </SelectItem>
                        <SelectItem value="lowlight" disabled={stabilized}>
                          Low light · experimental
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Advanced modes require 1080p30. 10-bit / D-Log M require
                      Main 10 support and browser overlays disabled.
                      Experimental processing is still being verified.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="stream-wind">Noise reduction</Label>
                    <Select
                      disabled={disabled || draft.audio_source === "none"}
                      value={noiseMode}
                      onValueChange={(noise_reduction) =>
                        update({ noise_reduction, wind_filter: false })
                      }
                    >
                      <SelectTrigger id="stream-wind" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="highpass">
                          Wind rumble · 180 Hz high-pass
                        </SelectItem>
                        <SelectItem value="dji" disabled={!neuralAvailable}>
                          DJI neural · internal mic
                        </SelectItem>
                        <SelectItem value="rnnoise" disabled={!neuralAvailable}>
                          RNNoise small · internal mic
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {(active ||
                      draft.audio_source === "none" ||
                      !neuralAvailable) && (
                      <p className="text-xs text-muted-foreground">
                        {active
                          ? "Showing the running stream’s noise reduction. Stop the stream to change it."
                          : draft.audio_source === "none"
                            ? "Choose an audio input above to enable noise reduction."
                            : "Select the camera’s internal microphones to use a neural mode. Wireless channels support Off or Wind rumble."}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Neural modes process the internal mic in mono and
                      compensate their audio delay (DJI: 128 ms, RNNoise: 20
                      ms). Wireless mic channels, pairing, and gain are
                      preserved.
                    </p>
                    {active && st?.audio_processing?.mode && (
                      <p className="text-xs text-muted-foreground">
                        {st.audio_processing.mode}:{" "}
                        {st.audio_processing.average_ms.toFixed(2)} ms per block
                        · {st.audio_processing.compensated_delay_ms} ms delay
                        compensated
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-4 rounded-lg border p-3 text-xs text-muted-foreground">
                  Manage browser overlays in{" "}
                  <a className="underline" href="#/studio">
                    Studio
                  </a>
                  .
                </div>
                <div className="mt-5">
                  <Notice>
                    Starting temporarily hands the sensor from native camera
                    recording to the streamer. The camera must be idle. Stopping
                    restores the native camera service.
                  </Notice>
                </div>
                <div className="mt-5 flex flex-wrap gap-3">
                  <ConfirmButton
                    variant="default"
                    title="Start SRT livestream?"
                    description="The camera will temporarily stop native camera recording services and send hardware-encoded H.265 video to the receiver. Other camera controls are unavailable while streaming. Stop the stream to restore native camera operation."
                    disabled={
                      disabled ||
                      !stream.data.available ||
                      !draft.address.trim()
                    }
                    onConfirm={start}
                  >
                    <Radio />
                    Start livestream
                  </ConfirmButton>
                  <Button
                    variant="outline"
                    disabled={busy || !active}
                    onClick={() => void stop()}
                  >
                    <Square />
                    {busy && active ? "Stopping…" : "Stop livestream"}
                  </Button>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}
