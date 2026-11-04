import { useEffect, useRef, useState } from "react";
import type Mpegts from "mpegts.js";
import { Maximize, Play, Square } from "lucide-react";
import { apiURL, errorText, useAPI } from "../api";
import type { MimoPreviewStatus } from "../types";
import { Card, Notice } from "../ui";
import { Button } from "./ui/button";

export function MimoPreview({ enabled }: { enabled: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [playback, setPlayback] = useState("Not connected");
  const [error, setError] = useState("");
  const [size, setSize] = useState("");
  const status = useAPI<MimoPreviewStatus>(
    "mimo_preview_status",
    undefined,
    connected ? 2000 : undefined,
  );

  useEffect(() => {
    if (!connected) return;
    if (!enabled) {
      setConnected(false);
      setPlayback("Native services not ready");
      return;
    }
    const controller = new AbortController();
    const element = video.current;
    let player: Mpegts.Player | undefined;
    const destroy = () => {
      controller.abort();
      if (player) {
        const current = player;
        player = undefined;
        current.destroy();
      }
      element?.removeAttribute("src");
      element?.load();
    };
    const fail = (message: string) => {
      if (controller.signal.aborted) return;
      destroy();
      setError(message);
      setPlayback("Preview disconnected");
      setConnected(false);
    };
    setPlayback("Waiting for Mimo video…");
    setError("");
    setSize("");
    void import("mpegts.js")
      .then(async ({ default: mpegts }) => {
        if (controller.signal.aborted || !element) return;
        if (!mpegts.getFeatureList().mseLivePlayback) {
          throw new Error(
            "This browser does not support live video playback. Use a browser with MediaSource support.",
          );
        }
        player = mpegts.createPlayer(
          {
            type: "mpegts",
            isLive: true,
            hasAudio: false,
            url: apiURL("mimo_preview_stream"),
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
          fail(
            `Unable to receive more video (${kind}: ${detail}). Keep Mimo on its live preview page, then reconnect.`,
          );
        });
        player.attachMediaElement(element);
        player.load();
        try {
          await player.play();
        } catch (error) {
          if (!controller.signal.aborted) {
            setPlayback("Waiting for manual playback");
            setError(
              `Browser autoplay did not start: ${errorText(error)}. You can click the play button in the video.`,
            );
          }
        }
      })
      .catch((error) => fail(errorText(error)));
    return destroy;
  }, [connected, attempt, enabled]);

  return (
    <Card title="Mimo preview relay">
      <p className="mb-4 text-sm leading-6 text-muted-foreground">
        Connect your phone to the camera in Mimo and keep live preview open to
        view the same video here without audio. Mimo may pause video when you
        switch back to the browser on your phone. Open this page on another
        device for best results.
      </p>
      <div className="relative aspect-video overflow-hidden rounded-lg bg-black">
        <video
          ref={video}
          muted
          playsInline
          controls={connected}
          className="h-full w-full object-contain"
          onPlaying={() => {
            if (connected) {
              setPlayback("Playing");
              setError("");
            }
          }}
          onWaiting={() => {
            if (connected) setPlayback("Waiting for video…");
          }}
          onPause={() => {
            if (connected) setPlayback("Playback paused");
          }}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget;
            if (element.videoWidth && element.videoHeight)
              setSize(`${element.videoWidth} × ${element.videoHeight}`);
          }}
        />
        {!connected && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-5 text-center text-sm text-white/70">
            {enabled
              ? "Connect to Mimo preview to show video here"
              : "Connect preview once native camera services are ready"}
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={!enabled}
          onClick={() => {
            setConnected(true);
            setAttempt((value) => value + 1);
          }}
        >
          <Play />
          {connected ? "Reconnect" : "Connect preview"}
        </Button>
        <Button
          variant="outline"
          disabled={!connected}
          onClick={() => {
            setConnected(false);
            setPlayback("Disconnected");
            setError("");
            setSize("");
          }}
        >
          <Square />
          Disconnect preview
        </Button>
        <Button
          variant="ghost"
          disabled={!connected || !size}
          onClick={() =>
            void video.current
              ?.requestFullscreen?.()
              .catch((error) => setError(errorText(error)))
          }
        >
          <Maximize />
          Fullscreen
        </Button>
      </div>
      <p aria-live="polite" className="mt-3 text-sm text-muted-foreground">
        {playback}
        {connected && size ? ` · ${size}` : ""}
        {connected && status.data?.state === "streaming"
          ? ` · ${status.data.clients} web clients`
          : ""}
      </p>
      {error && (
        <div className="mt-3">
          <Notice tone="warning">{error}</Notice>
        </div>
      )}
      <p className="mt-3 text-xs leading-5 text-muted-foreground">
        Disconnecting or leaving this page releases the relay for this browser.
        Native web preview without Mimo is still under investigation.
      </p>
    </Card>
  );
}
